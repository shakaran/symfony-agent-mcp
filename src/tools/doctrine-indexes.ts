/**
 * Doctrine Entity Index Inspector
 *
 * Distinct from entities.ts (entity structure) and doctrine-orm-config.ts.
 * Focuses on database index coverage analysis from Doctrine ORM annotations/attributes:
 *
 * PHP 8 attribute syntax:
 *   #[ORM\Table(
 *     indexes: [
 *       new ORM\Index(columns: ['email'], name: 'idx_email'),
 *       new ORM\Index(columns: ['status', 'created_at'], name: 'idx_status_date'),
 *     ],
 *     uniqueConstraints: [
 *       new ORM\UniqueConstraint(columns: ['slug'], name: 'uniq_slug'),
 *     ]
 *   )]
 *
 * Annotation syntax (legacy):
 *   @ORM\Table(indexes={@ORM\Index(name="idx_email", columns={"email"})})
 *
 * Foreign key columns:
 *   - #[ORM\ManyToOne] → generates joinColumn → should have index
 *   - #[ORM\ManyToMany] → join table gets indexes automatically
 *   - #[ORM\OneToMany] → FK on the other side — check if indexed
 *
 * Analysis:
 *   - ManyToOne column without corresponding index declaration
 *   - UniqueConstraint on TEXT/BLOB column (length prefix needed)
 *   - Index name longer than 64 chars (MySQL limit)
 *   - Redundant index: index on (a) and index on (a, b) — first is redundant in MySQL
 *   - No index at all on entity with @ManyToOne relationships (missing FK indexes)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface EntityIndex {
  name?: string;
  columns: string[];
  unique: boolean;
}

interface EntityIndexInfo {
  class: string;
  file: string;
  indexes: EntityIndex[];
  manyToOneColumns: string[];
  missingFkIndexes: string[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractColumnList(str: string): string[] {
  const cols: string[] = [];
  for (const m of str.matchAll(/['"]([^'"]+)['"]/g)) cols.push(m[1]);
  return cols;
}

function parseEntityIndexes(filePath: string, appPath: string): EntityIndexInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isEntity = content.includes('#[ORM\\Entity') || content.includes('#[Entity') ||
                   content.includes('@ORM\\Entity') || content.includes('@Entity');
  if (!isEntity) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const indexes: EntityIndex[] = [];

  // Attribute-based indexes
  for (const m of content.matchAll(/new\s+(?:ORM\\)?Index\s*\([^)]{0,300}\)/g)) {
    const block = m[0];
    const nameM = /name\s*:\s*['"]([^'"]+)['"]/.exec(block);
    const colsM = /columns\s*:\s*\[([^\]]+)\]/.exec(block);
    const cols  = colsM ? extractColumnList(colsM[1]) : [];
    indexes.push({ name: nameM?.[1], columns: cols, unique: false });
  }

  // Unique constraints (attribute-based)
  for (const m of content.matchAll(/new\s+(?:ORM\\)?UniqueConstraint\s*\([^)]{0,300}\)/g)) {
    const block = m[0];
    const nameM = /name\s*:\s*['"]([^'"]+)['"]/.exec(block);
    const colsM = /columns\s*:\s*\[([^\]]+)\]/.exec(block);
    const cols  = colsM ? extractColumnList(colsM[1]) : [];
    indexes.push({ name: nameM?.[1], columns: cols, unique: true });
  }

  // Legacy annotation indexes
  for (const m of content.matchAll(/@(?:ORM\\)?Index\s*\([^)]{0,300}\)/g)) {
    const block = m[0];
    const nameM = /name\s*=\s*['"]([^'"]+)['"]/.exec(block);
    const colsM = /columns\s*=\s*\{([^}]+)\}/.exec(block);
    const cols  = colsM ? extractColumnList(colsM[1]) : [];
    indexes.push({ name: nameM?.[1], columns: cols, unique: false });
  }

  // ManyToOne columns (heuristic: property name → snake_case column)
  const manyToOneColumns: string[] = [];
  for (const m of content.matchAll(/#\[(?:ORM\\)?ManyToOne[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:private|protected|public)\s+\S+\s+\$(\w+)/g)) {
    // Convert camelCase to snake_case for column name
    const col = m[1].replace(/([A-Z])/g, '_$1').toLowerCase();
    manyToOneColumns.push(col + '_id');
  }
  // Also annotation style
  for (const m of content.matchAll(/@(?:ORM\\)?ManyToOne[^*\n]*\n\s*\*[^@]*\$(\w+)/g)) {
    const col = m[1].replace(/([A-Z])/g, '_$1').toLowerCase();
    manyToOneColumns.push(col + '_id');
  }

  const indexedColumns = new Set(indexes.flatMap((i) => i.columns));
  const missingFkIndexes = manyToOneColumns.filter((col) => !indexedColumns.has(col));

  const issues: string[] = [];

  for (const idx of indexes) {
    if (idx.name && idx.name.length > 64) {
      issues.push(`Index name "${idx.name}" exceeds 64 chars (MySQL limit)`);
    }
  }

  // Redundant index: (a) is redundant if (a, b) also exists
  for (const idx of indexes) {
    if (idx.columns.length === 1) {
      const subsumed = indexes.some((other) =>
        other !== idx && other.columns.length > 1 && other.columns[0] === idx.columns[0]
      );
      if (subsumed) {
        issues.push(`Index on (${idx.columns[0]}) is redundant — a composite index starting with "${idx.columns[0]}" already exists`);
      }
    }
  }

  if (missingFkIndexes.length > 0) {
    for (const col of missingFkIndexes) {
      issues.push(`ManyToOne column "${col}" has no explicit index — add index for JOIN/filter performance`);
    }
  }

  if (indexes.length === 0 && manyToOneColumns.length === 0) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    indexes,
    manyToOneColumns,
    missingFkIndexes,
    issues,
  };
}

export function listDoctrineIndexes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const entities: EntityIndexInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityIndexes(file, appPath);
      if (info) entities.push(info);
    }

    if (entities.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine entity index definitions found.\n\nExample:\n  #[ORM\\Table(indexes: [\n    new ORM\\Index(columns: [\'email\'], name: \'idx_user_email\'),\n  ])]' }] };
    }

    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);
    const totalIndexes = entities.reduce((s, e) => s + e.indexes.length, 0);

    let text = `Doctrine Entity Indexes\n${'='.repeat(55)}\n`;
    text += `\nEntities analysed: ${entities.length}  Total indexes: ${totalIndexes}  Issues: ${totalIssues}\n`;

    for (const e of entities.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      if (e.indexes.length === 0 && e.issues.length === 0) continue;
      text += `\n  ${e.class}  (${e.file})\n`;
      for (const idx of e.indexes) {
        const type = idx.unique ? 'UNIQUE' : 'INDEX';
        text += `    ${type.padEnd(7)} (${idx.columns.join(', ')})${idx.name ? `  [${idx.name}]` : ''}\n`;
      }
      for (const issue of e.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineIndexStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: EntityIndexInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseEntityIndexes(file, appPath);
        if (info) entities.push(info);
      }
    }

    const allIndexes = entities.flatMap((e) => e.indexes);

    let text = `Doctrine Index Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities with indexes:   ${entities.length}\n`;
    text += `Total indexes:           ${allIndexes.length}\n`;
    text += `  Unique constraints:    ${allIndexes.filter((i) => i.unique).length}\n`;
    text += `  Composite indexes:     ${allIndexes.filter((i) => i.columns.length > 1).length}\n`;
    text += `Missing FK indexes:      ${entities.reduce((s, e) => s + e.missingFkIndexes.length, 0)}\n`;
    text += `Issues:                  ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineIndexTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_indexes',
      description: 'Show Doctrine entity index analysis: #[ORM\\Index]/#[ORM\\UniqueConstraint] definitions, composite indexes, ManyToOne FK column index coverage, redundant single-column index detection, index name > 64 chars warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_index_stats',
      description: 'Show Doctrine index statistics: entity count, total indexes, unique constraint count, composite index count, missing FK index count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
