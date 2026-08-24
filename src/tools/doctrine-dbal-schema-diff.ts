// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DBAL Schema Diff Inspector
 *
 * Detects DBAL schema comparison patterns and migration diff analysis.
 * Pure static analysis — reads PHP migration and source files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DbalSchemaDiffInfo {
  file: string;
  hasSchemaDiff: boolean;
  destructiveChanges: string[];
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

function parseSchemaDiffFile(filePath: string): DbalSchemaDiffInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSchemaDiff = content.includes('SchemaDiff') ||
    content.includes('compareSchemas') ||
    content.includes('introspectSchema') ||
    content.includes('SchemaComparator') ||
    content.includes('createComparator');

  const isMigration = content.includes('extends AbstractMigration') ||
    filePath.includes('/migrations/') ||
    filePath.includes('/Migration');

  const hasDropTable = /DROP\s+TABLE\s+/i.test(content);
  const hasRenameColumn = /RENAME\s+COLUMN\s+/i.test(content);
  const hasChangeColumn = /\bCHANGE\s+\w{1,80}\s+/i.test(content);
  const hasDropColumn = /DROP\s+COLUMN\s+/i.test(content);
  const hasDropColumnAddColumn = hasDropColumn && content.includes('ADD COLUMN');

  const destructiveChanges: string[] = [];

  if (hasDropTable) {
    const tableMatches = content.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?(\w{1,80})[`"']?/gi) ?? [];
    for (const m of tableMatches) destructiveChanges.push(m.trim());
  }

  if (hasRenameColumn) {
    const renameMatches = content.match(/RENAME\s+COLUMN\s+\w{1,80}\s+TO\s+\w{1,80}/gi) ?? [];
    for (const m of renameMatches) destructiveChanges.push(m.trim());
  }

  if (hasChangeColumn) {
    destructiveChanges.push('CHANGE COLUMN (column type modification)');
  }

  if (!hasSchemaDiff && !isMigration) return null;
  if (!hasSchemaDiff && destructiveChanges.length === 0) return null;

  const issues: string[] = [];

  if (isMigration && hasSchemaDiff) {
    // Check if down() is implemented
    const hasDown = content.includes('function down(') && !content.includes('throw new') &&
      content.split('function down(')[1]?.includes('->') === true;
    if (!hasDown) {
      issues.push('Schema diff migration without proper down() reverse migration — rollback not possible');
    }
  }

  if (hasDropTable && isMigration) {
    issues.push('DROP TABLE in migration — ensure data backup exists before running; this is irreversible');
  }

  if (hasDropColumnAddColumn) {
    issues.push('DROP COLUMN + ADD COLUMN pattern detected — use RENAME COLUMN to preserve data instead of drop-and-add');
  }

  if (hasSchemaDiff && !isMigration) {
    const isInTest = content.includes('TestCase') || filePath.includes('/tests/') || filePath.includes('/Test');
    if (!isInTest) {
      issues.push('Schema comparison (compareSchemas/introspectSchema) in production code — expensive schema introspection query; avoid in hot paths');
    }
  }

  if (hasSchemaDiff && content.includes('introspectSchema') && content.includes('createIndex')) {
    issues.push('Schema diff modifies column that likely has an index — index must be dropped first or the migration will fail');
  }

  return {
    file: path.basename(filePath),
    hasSchemaDiff,
    destructiveChanges,
    issues,
  };
}

export function listDbalSchemaDiffs(appPath: string): McpToolResult {
  try {
    const results: DbalSchemaDiffInfo[] = [];

    for (const dir of ['src', 'migrations']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseSchemaDiffFile(file);
        if (info) results.push(info);
      }
    }

    results.sort((a, b) => a.file.localeCompare(b.file));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL schema diff usage or destructive migration changes found.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `DBAL Schema Diff Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const withDiff = results.filter((r) => r.hasSchemaDiff);
    const destructive = results.filter((r) => r.destructiveChanges.length > 0);

    if (withDiff.length > 0) {
      text += `\nFiles using schema comparison (${withDiff.length}):\n`;
      for (const r of withDiff) {
        text += `  ${r.file}\n`;
        for (const issue of r.issues.filter((i) => i.includes('compareSchemas') || i.includes('introspect'))) {
          text += `    ⚠ ${issue}\n`;
        }
      }
    }

    if (destructive.length > 0) {
      text += `\nDestructive migrations (${destructive.length}):\n`;
      for (const r of destructive) {
        text += `  ${r.file}\n`;
        for (const change of r.destructiveChanges) text += `    - ${change}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalSchemaDiffStats(appPath: string): McpToolResult {
  try {
    const results: DbalSchemaDiffInfo[] = [];

    for (const dir of ['src', 'migrations']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseSchemaDiffFile(file);
        if (info) results.push(info);
      }
    }

    let text = `DBAL Schema Diff Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files analyzed:           ${results.length}\n`;
    text += `  With schema diff API:   ${results.filter((r) => r.hasSchemaDiff).length}\n`;
    text += `  With DROP TABLE:        ${results.filter((r) => r.destructiveChanges.some((c) => /DROP TABLE/i.test(c))).length}\n`;
    text += `  With RENAME COLUMN:     ${results.filter((r) => r.destructiveChanges.some((c) => /RENAME COLUMN/i.test(c))).length}\n`;
    text += `Total issues:             ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalSchemaDiffTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_dbal_schema_diffs',
      description: 'Detect DBAL schema comparison patterns and migration diff analysis: SchemaDiff, SchemaComparator::compareSchemas(), Comparator::compareSchemas(), introspectSchema(), SchemaManager::createComparator(); scans migration files for DROP TABLE, RENAME COLUMN, CHANGE (destructive changes); warns on missing down(), DROP TABLE without backup, RENAME via drop+add, schema comparison in production, index-affected column changes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_dbal_schema_diff_stats',
      description: 'Statistics for DBAL schema diffs: total files, schema diff API usage count, DROP TABLE count, RENAME COLUMN count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
