/**
 * Symfony Doctrine Migration Rollback Inspector
 *
 * Scans migrations/**\/*.php for:
 *   - function down(Schema $schema) / function down( presence
 *   - Empty or comment-only down() method bodies
 *   - doctrine_migrations.yaml transactional config
 *
 * Flags: empty down() bodies, migrations without any down() method,
 *        schema-dropping in down() without data preservation.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MigrationRollbackInfo {
  file: string;
  version: string;
  hasDown: boolean;
  downImplemented: boolean;
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function extractVersion(fileName: string): string {
  // Doctrine migration filenames: Version20230101120000.php or Version2023010112000.php
  const m = /Version(\d+)/.exec(fileName);
  if (m) return m[1];
  return path.basename(fileName, '.php');
}

function extractDownBody(content: string): string | null {
  // Match: public function down(Schema $schema): void { ... }
  // or: public function down(Schema $schema) { ... }
  const downM = /function\s+down\s*\(\s*(?:Schema\s+)?\$schema[^)]{0,50}\)[^{]{0,50}\{/.exec(content);
  if (!downM) return null;

  const start = downM.index + downM[0].length - 1;
  let depth = 1;
  let i = start + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }
  return content.slice(start + 1, i - 1);
}

function isBodyImplemented(body: string): boolean {
  // Strip comments and whitespace
  const stripped = body
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  return stripped.length > 0;
}

function analyzeMigrationFile(filePath: string, appPath: string): MigrationRollbackInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must be a migration class
  if (!content.includes('AbstractMigration') && !content.includes('Migration') && !content.includes('function up(')) return null;
  if (content.includes('namespace Doctrine\\')) return null;

  const fileName = path.basename(filePath);
  const version = extractVersion(fileName);
  const downBody = extractDownBody(content);
  const hasDown = downBody !== null;
  const downImplemented = hasDown && isBodyImplemented(downBody!);
  const issues: string[] = [];

  if (!hasDown) {
    issues.push('No down() method — migration cannot be rolled back');
  } else if (!downImplemented) {
    issues.push('down() method is empty or contains only comments — rollback will silently do nothing');
  } else {
    // Check for schema-dropping without data preservation
    if (/dropTable\s*\(/.test(downBody!) && !downBody!.includes('INSERT') && !downBody!.includes('backup')) {
      issues.push('down() drops table(s) without data preservation — rolling back will cause data loss');
    }

    // Check for dropColumn without data preservation
    if (/dropColumn\s*\(/.test(downBody!) || /removeColumn\s*\(/.test(downBody!)) {
      if (!downBody!.includes('INSERT') && !downBody!.includes('SELECT') && !downBody!.includes('backup')) {
        issues.push('down() removes column(s) without data migration — data in those columns will be lost on rollback');
      }
    }

    // Check for throw new NotImplementedException or similar
    if (/throw\s+new\s+\w*Exception/.test(downBody!)) {
      issues.push('down() throws an exception — migration is intentionally non-reversible; document this explicitly');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    version,
    hasDown,
    downImplemented,
    issues,
  };
}

function checkMigrationsYaml(appPath: string): string[] {
  const issues: string[] = [];
  const yamlPath = path.join(appPath, 'config', 'packages', 'doctrine_migrations.yaml');
  const resolved = path.resolve(yamlPath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep)) return issues;
  let content = '';
  try { content = fs.readFileSync(yamlPath, 'utf-8'); } catch { return issues; }

  if (!content.includes('transactional')) {
    issues.push('doctrine_migrations.yaml: transactional not configured — consider setting transactional: true to wrap each migration in a transaction for atomic rollback');
  } else if (/transactional:\s*false/.test(content)) {
    issues.push('doctrine_migrations.yaml: transactional: false — migrations run outside transactions, partial failure cannot be automatically rolled back');
  }

  return issues;
}

function findMigrationsDir(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'migrations'),
    path.join(appPath, 'src', 'Migrations'),
    path.join(appPath, 'app', 'Migrations'),
    path.join(appPath, 'DoctrineMigrations'),
  ];
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function buildMigrationRollbackInfos(appPath: string): MigrationRollbackInfo[] {
  const migrationsDir = findMigrationsDir(appPath);
  const results: MigrationRollbackInfo[] = [];

  if (!migrationsDir) return results;

  const yamlIssues = checkMigrationsYaml(appPath);

  for (const file of collectPhpFiles(migrationsDir, migrationsDir)) {
    const info = analyzeMigrationFile(file, appPath);
    if (info) {
      // Append yaml-level issues to first migration (as context)
      if (results.length === 0 && yamlIssues.length > 0) {
        info.issues.push(...yamlIssues);
      }
      results.push(info);
    }
  }

  return results.sort((a, b) => b.version.localeCompare(a.version));
}

export function listSymfonyDoctrineMigrationRollback(appPath: string): McpToolResult {
  try {
    const infos = buildMigrationRollbackInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine migration files found in migrations/ (or src/Migrations/).' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    const noDown = infos.filter((i) => !i.hasDown).length;
    const emptyDown = infos.filter((i) => i.hasDown && !i.downImplemented).length;

    let text = `Symfony Doctrine Migration Rollback Analysis\n${'='.repeat(55)}\n\n`;
    text += `Migrations found: ${infos.length}  With issues: ${withIssues.length}\n`;
    text += `  No down() method:    ${noDown}\n`;
    text += `  Empty down() body:   ${emptyDown}\n\n`;

    for (const info of infos.filter((i) => i.issues.length > 0)) {
      text += `  Version: ${info.version}  (${info.file})\n`;
      text += `    hasDown: ${info.hasDown}  implemented: ${info.downImplemented}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
    }

    if (withIssues.length === 0) {
      text += 'All migrations have implemented down() methods.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineMigrationRollbackStats(appPath: string): McpToolResult {
  try {
    const infos = buildMigrationRollbackInfos(appPath);

    const noDown = infos.filter((i) => !i.hasDown).length;
    const emptyDown = infos.filter((i) => i.hasDown && !i.downImplemented).length;
    const implemented = infos.filter((i) => i.hasDown && i.downImplemented).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Doctrine Migration Rollback Statistics\n${'='.repeat(50)}\n\n`;
    text += `Total migrations: ${infos.length}\n`;
    text += `  down() implemented:     ${implemented}\n`;
    text += `  down() empty/comments:  ${emptyDown}\n`;
    text += `  no down() method:       ${noDown}\n`;
    text += `Total issues:             ${totalIssues}\n`;

    if (infos.length > 0) {
      const rollbackReady = Math.round((implemented / infos.length) * 100);
      text += `Rollback-ready:           ${rollbackReady}%\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineMigrationRollbackTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_doctrine_migration_rollback',
      description: 'List Symfony Doctrine migration rollback readiness: detects missing down() methods, empty/comment-only down() bodies, data-loss risks (dropTable without backup), intentional exceptions, and transactional config in doctrine_migrations.yaml',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_doctrine_migration_rollback_stats',
      description: 'Show Symfony Doctrine migration rollback statistics: implemented/empty/missing down() counts, rollback-ready percentage, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
