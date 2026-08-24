// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Migrations Deep Analysis
 *
 * Goes beyond migration status to analyse migration content:
 *   - SQL statement count per migration
 *   - Destructive operations (DROP TABLE, DROP COLUMN, TRUNCATE, ALTER + DROP)
 *   - Large migrations (many statements)
 *   - Irreversible migrations (no down() or empty down())
 *   - Migration file size
 *   - Table names affected per migration
 *
 * Pure static analysis — reads migration PHP files without executing them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'safe';

interface MigrationAnalysis {
  version: string;
  file: string;
  sizeBytes: number;
  upStatements: number;
  downStatements: number;
  hasDown: boolean;
  destructiveOps: string[];
  affectedTables: string[];
  riskLevel: RiskLevel;
  riskReasons: string[];
}

// ─── Destructive pattern detection ────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string; severity: RiskLevel }> = [
  { re: /DROP\s+TABLE\b/i,                 label: 'DROP TABLE',          severity: 'critical' },
  { re: /TRUNCATE\b/i,                     label: 'TRUNCATE',            severity: 'critical' },
  { re: /DROP\s+COLUMN\b/i,               label: 'DROP COLUMN',         severity: 'high'     },
  { re: /DROP\s+INDEX\b/i,                label: 'DROP INDEX',          severity: 'medium'   },
  { re: /DROP\s+FOREIGN\s+KEY\b/i,        label: 'DROP FOREIGN KEY',    severity: 'medium'   },
  { re: /ALTER\s+TABLE[^;]+DROP\b/i,      label: 'ALTER TABLE … DROP',  severity: 'high'     },
  { re: /DELETE\s+FROM\b/i,               label: 'DELETE FROM (data)',  severity: 'high'     },
  { re: /UPDATE\s+\w+\s+SET\b/i,         label: 'UPDATE (data change)', severity: 'medium'  },
];

function extractSqlBlock(content: string, method: 'up' | 'down'): string {
  // Match function body for up() or down()
  const re = new RegExp(
    `public\\s+function\\s+${method}\\s*\\([^)]*\\)\\s*(?::\\s*void)?\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}`,
    'g'
  );
  const m = re.exec(content);
  return m ? m[1] : '';
}

function countSqlStatements(block: string): number {
  // Count addSql() calls or raw SQL statements ending with ;
  const addSqlCount = (block.match(/->addSql\s*\(/g) ?? []).length;
  if (addSqlCount > 0) return addSqlCount;
  // Fallback: count semicolons inside string literals
  return (block.match(/['"]\s*;\s*['"]/g) ?? []).length;
}

function extractAffectedTables(block: string): string[] {
  const tables = new Set<string>();

  // FROM table_name, INTO table_name, TABLE table_name, JOIN table_name
  const patterns = [
    /(?:FROM|INTO|TABLE|JOIN|UPDATE)\s+[`"']?(\w+)[`"']?/gi,
    /->addSql\s*\(\s*['"](?:CREATE|ALTER|DROP)\s+TABLE\s+[`"']?(\w+)[`"']?/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(block)) !== null) {
      const t = m[1].toLowerCase();
      if (!['from', 'table', 'into', 'join', 'on', 'where', 'set', 'index', 'key'].includes(t)) {
        tables.add(m[1]);
      }
    }
  }

  return [...tables].slice(0, 10);
}

// ─── Migration file parsing ────────────────────────────────────────────────

function analyzeMigration(filePath: string): MigrationAnalysis | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must look like a Doctrine migration
  if (!content.includes('AbstractMigration') && !content.includes('Migration')) return null;

  const versionM = /Version(\d+)/.exec(path.basename(filePath)) ??
                   /class\s+Version(\d+)/.exec(content);
  const version = versionM ? versionM[1] : path.basename(filePath, '.php');

  const upBlock = extractSqlBlock(content, 'up');
  const downBlock = extractSqlBlock(content, 'down');

  const upStatements = countSqlStatements(upBlock);
  const downStatements = countSqlStatements(downBlock);

  const hasDown = downBlock.trim().length > 20 && downStatements > 0;

  // Detect destructive operations in up()
  const destructiveOps: string[] = [];
  const riskReasons: string[] = [];
  let maxSeverity: RiskLevel = 'safe';

  const severityOrder: RiskLevel[] = ['critical', 'high', 'medium', 'low', 'safe'];

  for (const { re, label, severity } of DESTRUCTIVE_PATTERNS) {
    if (re.test(upBlock)) {
      destructiveOps.push(label);
      riskReasons.push(label);
      if (severityOrder.indexOf(severity) < severityOrder.indexOf(maxSeverity)) {
        maxSeverity = severity;
      }
    }
  }

  if (!hasDown) {
    riskReasons.push('No rollback (empty down())');
    if (maxSeverity === 'safe') maxSeverity = 'low';
  }

  if (upStatements > 10) {
    riskReasons.push(`Large migration: ${upStatements} statements`);
    if (maxSeverity === 'safe') maxSeverity = 'low';
  }

  return {
    version,
    file: path.basename(filePath),
    sizeBytes: fs.statSync(filePath).size,
    upStatements,
    downStatements,
    hasDown,
    destructiveOps,
    affectedTables: extractAffectedTables(upBlock),
    riskLevel: maxSeverity,
    riskReasons,
  };
}

function findMigrationDir(appPath: string): string | null {
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

function loadMigrationAnalyses(appPath: string): MigrationAnalysis[] {
  const dir = findMigrationDir(appPath);
  if (!dir) return [];

  const analyses: MigrationAnalysis[] = [];

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.php')) continue;
      const a = analyzeMigration(path.join(dir, entry.name));
      if (a) analyses.push(a);
    }
  } catch { /* skip */ }

  return analyses.sort((a, b) => a.version.localeCompare(b.version));
}

// ─── Tool functions ────────────────────────────────────────────────────────

const RISK_ICON: Record<RiskLevel, string> = {
  critical: '[CRITICAL]',
  high:     '[HIGH]    ',
  medium:   '[MEDIUM]  ',
  low:      '[LOW]     ',
  safe:     '[OK]      ',
};

export function analyzeMigrations(appPath: string): McpToolResult {
  try {
    const migrations = loadMigrationAnalyses(appPath);

    if (migrations.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No migration files found.\n\nExpected: migrations/ or src/Migrations/\n\nCreate: php bin/console doctrine:migrations:generate',
        }],
      };
    }

    const risky = migrations.filter((m) => m.riskLevel !== 'safe');
    const noDown = migrations.filter((m) => !m.hasDown);

    let text = `Migration Analysis  (${migrations.length} total, ${risky.length} with risks)\n${'='.repeat(65)}\n`;

    if (risky.length > 0) {
      text += `\nMigrations with risks:\n`;
      for (const m of risky) {
        text += `\n  ${RISK_ICON[m.riskLevel]} ${m.version}  (${m.file})\n`;
        for (const reason of m.riskReasons) {
          text += `    • ${reason}\n`;
        }
        if (m.affectedTables.length > 0) {
          text += `    Tables: ${m.affectedTables.join(', ')}\n`;
        }
      }
    } else {
      text += `\n✓ No destructive operations detected.\n`;
    }

    if (noDown.length > 0) {
      text += `\nMigrations without rollback (${noDown.length}):\n`;
      for (const m of noDown) text += `  ${m.version}\n`;
    }

    text += `\nAll migrations:\n`;
    text += `  ${'Version'.padEnd(20)} Stmts  Risk        Tables\n`;
    text += `  ${'-'.repeat(65)}\n`;
    for (const m of migrations) {
      const tables = m.affectedTables.slice(0, 3).join(', ');
      text += `  ${m.version.padEnd(20)} ${String(m.upStatements).padStart(4)}   ${RISK_ICON[m.riskLevel]}  ${tables}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDestructiveMigrations(appPath: string): McpToolResult {
  try {
    const migrations = loadMigrationAnalyses(appPath);
    const destructive = migrations.filter((m) => m.destructiveOps.length > 0);

    if (destructive.length === 0) {
      return {
        content: [{ type: 'text', text: `No destructive operations (DROP/TRUNCATE/DELETE) found in ${migrations.length} migrations.` }],
      };
    }

    let text = `Destructive Migrations (${destructive.length})\n${'='.repeat(55)}\n\n`;

    for (const m of destructive) {
      text += `  ${RISK_ICON[m.riskLevel]} ${m.version}  (${m.file})\n`;
      text += `    Operations: ${m.destructiveOps.join(', ')}\n`;
      if (m.affectedTables.length > 0) text += `    Tables:     ${m.affectedTables.join(', ')}\n`;
      if (!m.hasDown) text += `    ⚠ No rollback available\n`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMigrationAnalysisStats(appPath: string): McpToolResult {
  try {
    const migrations = loadMigrationAnalyses(appPath);

    if (migrations.length === 0) {
      return { content: [{ type: 'text', text: 'No migrations found.' }] };
    }

    const totalStatements = migrations.reduce((s, m) => s + m.upStatements, 0);
    const noDown = migrations.filter((m) => !m.hasDown).length;
    const destructive = migrations.filter((m) => m.destructiveOps.length > 0).length;

    const bySeverity: Partial<Record<RiskLevel, number>> = {};
    for (const m of migrations) {
      bySeverity[m.riskLevel] = (bySeverity[m.riskLevel] ?? 0) + 1;
    }

    let text = `Migration Analysis Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total migrations:    ${migrations.length}\n`;
    text += `Total SQL stmts:     ${totalStatements}\n`;
    text += `Without rollback:    ${noDown}\n`;
    text += `Destructive ops:     ${destructive}\n`;

    text += `\nBy risk level:\n`;
    const levels: RiskLevel[] = ['critical', 'high', 'medium', 'low', 'safe'];
    for (const level of levels) {
      const count = bySeverity[level] ?? 0;
      if (count > 0) text += `  ${level.padEnd(12)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getMigrationAnalysisTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'analyze_migrations',
      description: 'Deep analysis of Doctrine migration files: SQL statement count, risk level, tables affected, missing rollback, destructive operations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_destructive_migrations',
      description: 'List only migrations containing DROP TABLE, DROP COLUMN, TRUNCATE, or DELETE FROM with their risk level and rollback availability',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_migration_analysis_stats',
      description: 'Show migration analysis statistics: total count, SQL statements, missing rollbacks, destructive operations by risk level',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
