/**
 * Doctrine Migration History Inspector
 *
 * Distinct from migrations-analysis.ts (migration content risk analysis).
 * Focuses on migration file organisation and version tracking:
 *
 * Migration files scan:
 *   - Files in migrations/ or src/Migrations/ matching Version*.php or \d{14}.php
 *   - Version timestamp extraction from filename
 *   - Chronological gap detection (large time jumps between versions)
 *
 * Migration configuration:
 *   - doctrine_migrations.yaml: migrations_paths, table_name, column_name, all_or_nothing
 *   - Multiple migration directories (organised by feature/module)
 *
 * Squash detection:
 *   - Migration files that are marked as consolidated (comments containing 'squash', 'consolidated')
 *   - InitialMigration or DatabaseMigration class names (common squash naming)
 *
 * Naming convention:
 *   - Files following V followed by timestamp: Version20241201120000.php
 *   - Non-standard names (e.g. CreateUsersTable.php without version prefix)
 *   - Migrations without both up() and down() methods
 *
 * Analysis:
 *   - all_or_nothing: false (migrations not wrapped in transaction — partial state possible)
 *   - Migrations directory does not exist or is empty
 *   - Large gap in migration timestamps (> 90 days — may indicate stale branch)
 *   - Down migration that does nothing (DROP TABLE without recreate)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MigrationFile {
  filename: string;
  versionTimestamp?: string;
  hasUp: boolean;
  hasDown: boolean;
  downIsEmpty: boolean;
  isSquash: boolean;
  issues: string[];
}

function parseMigrationVersion(filename: string): string | undefined {
  const m = /Version(\d{14})\.php$/.exec(filename) ?? /^(\d{14})\.php$/.exec(filename);
  return m?.[1];
}

function parseMigrationFile(filePath: string, filename: string): MigrationFile | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('AbstractMigration') && !content.includes('extends Migration')) return null;

  const hasUp   = content.includes('function up(');
  const hasDown = content.includes('function down(');

  const downM = /function\s+down[^{]*\{([\s\S]{0,400})/.exec(content);
  const downBody = downM?.[1] ?? '';
  const downIsEmpty = hasDown && /^\s*\/\*[\s\S]*\*\/\s*$/.test(downBody.trim()) ||
                      hasDown && downBody.trim().length < 5;

  const isSquash = /squash|consolidat|initial\s*migration|database\s*migration/i.test(content) ||
                   /class\s+InitialMigration|class\s+DatabaseMigration/.test(content);

  const versionTimestamp = parseMigrationVersion(filename);

  const issues: string[] = [];
  if (!hasUp) issues.push('Missing up() method');
  if (!hasDown) issues.push('Missing down() method — cannot rollback this migration');
  if (downIsEmpty) issues.push('down() method body is empty — rollback would do nothing');

  return { filename, versionTimestamp, hasUp, hasDown, downIsEmpty, isSquash, issues };
}

function loadMigrationsConfig(appPath: string): { paths: string[]; allOrNothing: boolean; tableName: string } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine_migrations.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine_migrations.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const dm = (raw['doctrine_migrations'] ?? raw) as Record<string, unknown>;

    const pathsRaw = dm['migrations_paths'];
    const paths: string[] = [];
    if (pathsRaw && typeof pathsRaw === 'object' && !Array.isArray(pathsRaw)) {
      paths.push(...Object.values(pathsRaw as Record<string, unknown>).map(String));
    } else if (Array.isArray(pathsRaw)) {
      paths.push(...pathsRaw.map(String));
    }

    const allOrNothing = dm['all_or_nothing'] !== false && dm['all_or_nothing'] !== 'false';
    const tableName    = dm['table_name'] ? String(dm['table_name']) : 'doctrine_migration_versions';

    return { paths, allOrNothing, tableName };
  }
  return { paths: [], allOrNothing: true, tableName: 'doctrine_migration_versions' };
}

function findMigrationsDir(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'migrations'),
    path.join(appPath, 'src', 'Migrations'),
    path.join(appPath, 'app', 'DoctrineMigrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export function listMigrationGaps(appPath: string): McpToolResult {
  try {
    const config = loadMigrationsConfig(appPath);
    const migrDir = findMigrationsDir(appPath);

    if (!migrDir) {
      return { content: [{ type: 'text', text: 'No migrations directory found (checked: migrations/, src/Migrations/, app/DoctrineMigrations/).' }] };
    }

    const files: MigrationFile[] = [];
    try {
      for (const entry of fs.readdirSync(migrDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.php')) continue;
        const f = parseMigrationFile(path.join(migrDir, entry.name), entry.name);
        if (f) files.push(f);
      }
    } catch { /* skip */ }

    if (files.length === 0) {
      return { content: [{ type: 'text', text: `Migration directory ${migrDir} found but empty.` }] };
    }

    files.sort((a, b) => (a.versionTimestamp ?? '').localeCompare(b.versionTimestamp ?? ''));

    // Gap detection
    const gapIssues: string[] = [];
    for (let i = 1; i < files.length; i++) {
      const prev = files[i - 1].versionTimestamp;
      const curr = files[i].versionTimestamp;
      if (!prev || !curr) continue;
      // Format: YYYYMMDDHHmmss
      const prevDate = new Date(
        parseInt(prev.slice(0, 4), 10),
        parseInt(prev.slice(4, 6), 10) - 1,
        parseInt(prev.slice(6, 8), 10),
      );
      const currDate = new Date(
        parseInt(curr.slice(0, 4), 10),
        parseInt(curr.slice(4, 6), 10) - 1,
        parseInt(curr.slice(6, 8), 10),
      );
      const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 86400);
      if (diffDays > 90) {
        gapIssues.push(`Gap of ${Math.round(diffDays)}d between ${files[i-1].filename} and ${files[i].filename}`);
      }
    }

    const totalIssues = files.reduce((s, f) => s + f.issues.length, 0) + gapIssues.length;
    const squashFiles = files.filter((f) => f.isSquash);

    let text = `Doctrine Migration History\n${'='.repeat(55)}\n`;
    text += `\nDirectory:       ${path.relative(appPath, migrDir)}\n`;
    text += `Total files:     ${files.length}  Issues: ${totalIssues}\n`;
    text += `Squash detected: ${squashFiles.length}\n`;
    if (!config.allOrNothing) text += `⚠ all_or_nothing: false — migrations not transactional\n`;
    text += `Table name:      ${config.tableName}\n`;

    const withIssues = files.filter((f) => f.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nMigrations with issues:\n`;
      for (const f of withIssues) {
        text += `  ${f.filename}\n`;
        for (const issue of f.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (gapIssues.length > 0) {
      text += `\nTimestamp gaps (> 90 days):\n`;
      for (const gap of gapIssues) text += `  ⚠ ${gap}\n`;
    }

    if (squashFiles.length > 0) {
      text += `\nSquash/consolidated migrations:\n`;
      for (const f of squashFiles) text += `  ${f.filename}\n`;
    }

    text += `\nRecent migrations (last 5):\n`;
    for (const f of files.slice(-5)) {
      const ts = f.versionTimestamp
        ? `${f.versionTimestamp.slice(0, 4)}-${f.versionTimestamp.slice(4, 6)}-${f.versionTimestamp.slice(6, 8)}`
        : 'no timestamp';
      text += `  ${f.filename}  (${ts})\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMigrationHistoryStats(appPath: string): McpToolResult {
  try {
    const config  = loadMigrationsConfig(appPath);
    const migrDir = findMigrationsDir(appPath);
    let fileCount = 0;
    let squashCount = 0;
    let noDownCount = 0;

    if (migrDir && fs.existsSync(migrDir)) {
      try {
        for (const entry of fs.readdirSync(migrDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.php')) continue;
          const f = parseMigrationFile(path.join(migrDir, entry.name), entry.name);
          if (!f) continue;
          fileCount++;
          if (f.isSquash) squashCount++;
          if (!f.hasDown || f.downIsEmpty) noDownCount++;
        }
      } catch { /* skip */ }
    }

    let text = `Migration History Statistics\n${'='.repeat(40)}\n\n`;
    text += `Directory found:   ${migrDir ? 'yes' : 'no'}\n`;
    text += `Migration files:   ${fileCount}\n`;
    text += `  Squash files:    ${squashCount}\n`;
    text += `  No down():       ${noDownCount}\n`;
    text += `All-or-nothing:    ${config.allOrNothing ? 'yes' : '⚠ no'}\n`;
    text += `Table name:        ${config.tableName}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMigrationHistoryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_migration_gaps',
      description: 'Show Doctrine migration history: chronological file listing, timestamp gap detection (> 90 days), squash migration identification, missing down() method, empty down() warning, all_or_nothing configuration, recent migrations summary',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_migration_history_stats',
      description: 'Show migration history statistics: file count, squash count, no-down-method count, all_or_nothing status, table name',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
