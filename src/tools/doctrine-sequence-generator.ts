/**
 * Doctrine Sequence Generator Inspector
 *
 * Scans entity PHP files for #[SequenceGenerator] or @SequenceGenerator.
 * Checks doctrine.yaml orm.database_platform for PostgreSQL detection.
 * Warns about missing allocationSize, wrong platform usage, missing initialValue.
 *
 * Pure static analysis only.
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

interface SequenceInfo {
  file: string;
  class: string;
  sequenceName: string;
  allocationSize: number;
  initialValue: number;
  platform: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassFromContent(content: string): string | null {
  const m = /class\s+(\w{1,120})\b/.exec(content);
  return m ? m[1] : null;
}

function detectDatabasePlatform(appPath: string): string {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];

  for (const candidate of candidates) {
    const raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    if (!raw) continue;

    const doctrineSection = raw['doctrine'] as Record<string, unknown> | undefined ?? raw;
    const dbal = doctrineSection['dbal'] as Record<string, unknown> | undefined ?? {};
    const orm = doctrineSection['orm'] as Record<string, unknown> | undefined ?? {};

    // Check driver in dbal
    const driver = String(dbal['driver'] ?? dbal['url'] ?? '').toLowerCase();
    if (driver.includes('pgsql') || driver.includes('postgres')) return 'postgresql';
    if (driver.includes('mysql') || driver.includes('mariadb')) return 'mysql';
    if (driver.includes('sqlite')) return 'sqlite';
    if (driver.includes('sqlsrv') || driver.includes('mssql')) return 'mssql';

    // Check databasePlatformVersion or platform in ORM
    const platform = String(orm['database_platform'] ?? '').toLowerCase();
    if (platform.includes('postgres') || platform.includes('pgsql')) return 'postgresql';
    if (platform.includes('mysql')) return 'mysql';
    if (platform.includes('sqlite')) return 'sqlite';

    // Check DATABASE_URL env reference
    if (driver.includes('postgres') || driver.includes('pgsql')) return 'postgresql';
  }

  // Fallback: check .env for DATABASE_URL
  const envPath = path.join(appPath, '.env');
  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    if (/DATABASE_URL\s*=\s*postgresql/.test(envContent) || /DATABASE_URL\s*=\s*pgsql/.test(envContent)) return 'postgresql';
    if (/DATABASE_URL\s*=\s*mysql/.test(envContent) || /DATABASE_URL\s*=\s*mariadb/.test(envContent)) return 'mysql';
    if (/DATABASE_URL\s*=\s*sqlite/.test(envContent)) return 'sqlite';
  } catch { /* skip */ }

  return 'unknown';
}

function extractSequenceGenerators(content: string, filePath: string, platform: string): SequenceInfo[] {
  const infos: SequenceInfo[] = [];
  const className = extractClassFromContent(content) ?? path.basename(filePath, '.php');

  // Match PHP 8 attribute: #[SequenceGenerator(sequenceName: 'foo', allocationSize: 1, initialValue: 1)]
  const attrPattern = /#\[(?:\w+\\){0,10}SequenceGenerator\s*\(([^)]{0,400})\)/g;
  // Match annotation: @SequenceGenerator(sequenceName="foo_seq", allocationSize=1, initialValue=1)
  const annotPattern = /@(?:\w+\\){0,5}SequenceGenerator\s*\(([^)]{0,400})\)/g;

  const blocks: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = attrPattern.exec(content)) !== null) blocks.push(m[1]);
  while ((m = annotPattern.exec(content)) !== null) blocks.push(m[1]);

  for (const block of blocks) {
    const nameMatch = /sequenceName\s*[=:]\s*['"]?(\w{1,120})['"]?/.exec(block);
    const allocMatch = /allocationSize\s*[=:]\s*(\d{1,6})/.exec(block);
    const initMatch = /initialValue\s*[=:]\s*(\d{1,9})/.exec(block);

    const sequenceName = nameMatch ? nameMatch[1] : '(unnamed)';
    const allocationSize = allocMatch ? parseInt(allocMatch[1], 10) : 1;
    const initialValue = initMatch ? parseInt(initMatch[1], 10) : 1;

    const issues: string[] = [];

    if (allocationSize <= 1) {
      issues.push(`allocationSize is ${allocationSize} — each INSERT requires a separate sequence query; use allocationSize > 1 (e.g. 50) for bulk inserts`);
    }

    if (platform === 'mysql' || platform === 'sqlite') {
      issues.push(`SequenceGenerator is used on platform "${platform}" — sequences are only supported by PostgreSQL and Oracle; this annotation will be ignored`);
    }

    if (!initMatch) {
      issues.push(`initialValue not explicitly set (defaults to 1) — may conflict with seeded/existing data`);
    }

    infos.push({ file: path.relative(path.dirname(filePath), filePath), class: className, sequenceName, allocationSize, initialValue, platform, issues });
  }

  return infos;
}

function scanSequenceGenerators(appPath: string): SequenceInfo[] {
  const results: SequenceInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);
  const platform = detectDatabasePlatform(appPath);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('SequenceGenerator')) continue;

    const infos = extractSequenceGenerators(content, file, platform);
    for (const info of infos) {
      results.push({ ...info, file: path.relative(appPath, file) });
    }
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineSequenceGenerators(appPath: string): McpToolResult {
  try {
    const infos = scanSequenceGenerators(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine SequenceGenerator usages found in src/.\n\nExample (PostgreSQL):\n  #[ORM\\Id]\n  #[ORM\\GeneratedValue(strategy: \'SEQUENCE\')]\n  #[ORM\\SequenceGenerator(sequenceName: \'user_id_seq\', allocationSize: 50, initialValue: 1)]\n  private int $id;',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Sequence Generators\n${'='.repeat(50)}\n`;
    text += `Total: ${infos.length}  |  Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n${info.file}  (${info.class})\n`;
      text += `  sequenceName:   ${info.sequenceName}\n`;
      text += `  allocationSize: ${info.allocationSize}\n`;
      text += `  initialValue:   ${info.initialValue}\n`;
      text += `  platform:       ${info.platform}\n`;
      for (const issue of info.issues) {
        text += `  ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning Doctrine sequence generators: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineSequenceStats(appPath: string): McpToolResult {
  try {
    const infos = scanSequenceGenerators(appPath);

    const withSmallAllocation = infos.filter(i => i.allocationSize <= 1).length;
    const withMissingInit = infos.filter(i => i.initialValue === 1).length;
    const onWrongPlatform = infos.filter(i => i.platform === 'mysql' || i.platform === 'sqlite').length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    const platforms = [...new Set(infos.map(i => i.platform))];

    const text = [
      'Doctrine Sequence Generator Statistics',
      '='.repeat(45),
      `Total sequence generators:    ${infos.length}`,
      `With allocationSize <= 1:     ${withSmallAllocation}`,
      `With default initialValue:    ${withMissingInit}`,
      `On incompatible platform:     ${onWrongPlatform}`,
      `Detected platforms:           ${platforms.join(', ') || 'unknown'}`,
      `Total issues:                 ${totalIssues}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing Doctrine sequence generator stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getDoctrineSequenceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_doctrine_sequence_generators',
      description: 'List all Doctrine SequenceGenerator usages and warn about small allocationSize, wrong platform (MySQL/SQLite), or missing initialValue.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_doctrine_sequence_stats',
      description: 'Get statistics about Doctrine sequence generator configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
