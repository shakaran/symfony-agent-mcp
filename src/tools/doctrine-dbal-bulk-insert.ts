/**
 * Doctrine DBAL Bulk Insert Inspector
 *
 * Detects DBAL-level bulk insert patterns (distinct from ORM bulk which uses EntityManager).
 * Pure static analysis — reads PHP source files only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DbalBulkInsertInfo {
  file: string;
  className: string;
  insertType: 'insert-loop' | 'execute-statement' | 'query-builder';
  hasTransaction: boolean;
  hasPreparedStatement: boolean;
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

function parseBulkInsertFile(filePath: string): DbalBulkInsertInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasInsert = content.includes("->insert(") ||
    content.includes('executeStatement') ||
    (content.includes('INSERT') && content.includes('QueryBuilder'));

  if (!hasInsert) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasLoopInsert = (content.includes('->insert(') || content.includes('->executeStatement(')) &&
    (content.includes('foreach') || content.includes('for (') || content.includes('for(') || content.includes('while ('));

  const hasExecuteStatement = content.includes('executeStatement') &&
    (content.includes('INSERT INTO') || content.includes("INSERT\n") || content.includes("'INSERT"));

  const hasQueryBuilderInsert = content.includes('QueryBuilder') &&
    (content.includes("'INSERT'") || content.includes('"INSERT"') ||
      content.includes('->insert(') && content.includes('->values('));

  if (!hasLoopInsert && !hasExecuteStatement && !hasQueryBuilderInsert) return null;

  let insertType: 'insert-loop' | 'execute-statement' | 'query-builder';
  if (hasLoopInsert) insertType = 'insert-loop';
  else if (hasExecuteStatement) insertType = 'execute-statement';
  else insertType = 'query-builder';

  const hasTransaction = content.includes('beginTransaction') ||
    content.includes('wrapInTransaction') ||
    content.includes('transactional(');

  // Prepared statement: uses ? or :named params consistently
  const hasPreparedStatement = content.includes('->prepare(') ||
    (content.includes('executeStatement') && (content.includes("', [") || content.includes("', array(")));

  const issues: string[] = [];

  if (hasLoopInsert && !hasTransaction) {
    issues.push('$connection->insert() inside loop without transaction — each insert is auto-committed, causing severe performance overhead');
  }

  if (hasExecuteStatement && content.includes('INSERT') && !hasPreparedStatement) {
    const hasConcatInsert = content.includes('. $') || content.includes('.$') ||
      content.includes('sprintf(') || content.includes('"{$') || content.includes('"$');
    if (hasConcatInsert) {
      issues.push('executeStatement("INSERT INTO...") with string concatenation and no parameterization — SQL injection risk if user data is involved');
    }
  }

  const hasBatchLimit = content.includes('% ') || content.includes('%$') ||
    content.includes('BATCH_SIZE') || content.includes('batchSize') ||
    content.includes('batch_size');
  if ((hasLoopInsert || hasExecuteStatement) && !hasBatchLimit) {
    issues.push('Bulk insert without batch size limit — may exhaust memory for large datasets');
  }

  if (hasQueryBuilderInsert && (content.includes('. $') || content.includes('.$'))) {
    issues.push('INSERT via QueryBuilder with string concatenation — use ->setParameter() to prevent SQL injection');
  }

  return {
    file: path.basename(filePath),
    className: classM[1],
    insertType,
    hasTransaction,
    hasPreparedStatement,
    issues,
  };
}

export function listDbalBulkInserts(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalBulkInsertInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseBulkInsertFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.className.localeCompare(b.className));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL bulk insert patterns found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `DBAL Bulk Insert Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const tx = r.hasTransaction ? ' [tx]' : ' [no-tx]';
      const ps = r.hasPreparedStatement ? ' [prepared]' : '';
      text += `\n  ${r.className.padEnd(45)} [${r.insertType}]${tx}${ps}\n`;
      text += `    file: ${r.file}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalBulkInsertStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalBulkInsertInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseBulkInsertFile(file);
      if (info) results.push(info);
    }

    let text = `DBAL Bulk Insert Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total bulk inserts:        ${results.length}\n`;
    text += `  insert-loop:             ${results.filter((r) => r.insertType === 'insert-loop').length}\n`;
    text += `  execute-statement:       ${results.filter((r) => r.insertType === 'execute-statement').length}\n`;
    text += `  query-builder:           ${results.filter((r) => r.insertType === 'query-builder').length}\n`;
    text += `  With transaction:        ${results.filter((r) => r.hasTransaction).length}\n`;
    text += `  With prepared statement: ${results.filter((r) => r.hasPreparedStatement).length}\n`;
    text += `Total issues:              ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalBulkInsertTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_dbal_bulk_inserts',
      description: 'Detect DBAL-level bulk insert patterns: $connection->executeStatement() in loops, $connection->insert() in loops, QueryBuilder INSERT, beginTransaction/commit wrapping inserts; warns on insert loop without transaction (auto-commit overhead), executeStatement without parameterization (injection risk), missing batch size limit, QueryBuilder string concatenation',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_dbal_bulk_insert_stats',
      description: 'Statistics for DBAL bulk inserts: total count, insert-loop/execute-statement/query-builder breakdown, transaction coverage, prepared statement coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
