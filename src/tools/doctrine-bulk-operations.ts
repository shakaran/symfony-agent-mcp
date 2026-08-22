/**
 * Doctrine Bulk Operations Inspector
 *
 * Distinct from doctrine-query-builder.ts (QueryBuilder patterns), doctrine-dbal-transactions.ts
 * (transaction handling), and repository-analyzer.ts (N+1 detection). Focuses on bulk data
 * operations and batch processing patterns:
 *
 * - Scans src/ PHP for: $connection->executeStatement(, executeQuery() with INSERT/UPDATE/DELETE,
 *   $em->clear() in loop, batchSize pattern ($i % 100 === 0), $em->flush() in loop,
 *   createQueryBuilder()->update(), createQueryBuilder()->delete()
 * - Detects: bulk insert/update via DBAL vs ORM, batch flush patterns, DQL UPDATE/DELETE
 *
 * Warnings:
 *   - $em->flush() inside foreach loop (N flushes instead of batch)
 *   - DQL UPDATE without WHERE clause (updates all rows)
 *   - INSERT in loop via DBAL without transaction (each INSERT autocommit)
 *   - $em->clear() without re-fetching required entities (entity detach)
 *   - Missing $em->clear() in large batch (memory leak)
 *   - Batch without transaction wrapping (partial failure leaves DB inconsistent)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DoctrineBulkInfo {
  file: string;
  class: string;
  hasLoopFlush: boolean;
  hasBatchPattern: boolean;
  hasDqlUpdate: boolean;
  hasTransaction: boolean;
  hasClearInLoop: boolean;
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

function parseBulkOperationFile(filePath: string): DoctrineBulkInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasBulkCode = content.includes('->flush(') ||
    content.includes('->clear(') ||
    content.includes('executeStatement(') ||
    content.includes('->update()') ||
    content.includes('->delete()') ||
    content.includes('batchSize') ||
    content.includes('BATCH_SIZE');

  if (!hasBulkCode) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasLoopKeywords = content.includes('foreach') || content.includes('for (') ||
    content.includes('for(') || content.includes('while (') || content.includes('while(');

  const hasFlush = content.includes('->flush(');
  const hasClear = content.includes('->clear(');

  const hasLoopFlush = hasLoopKeywords && hasFlush && (
    (content.indexOf('foreach') < content.indexOf('->flush(')) ||
    (content.indexOf('for (') > 0 && content.indexOf('for (') < content.indexOf('->flush(')) ||
    (content.indexOf('while (') > 0 && content.indexOf('while (') < content.indexOf('->flush('))
  );

  const hasClearInLoop = hasLoopKeywords && hasClear;

  const hasBatchPattern = content.includes('% 100') || content.includes('%100') ||
    content.includes('% 50') || content.includes('% 200') ||
    content.includes('batchSize') || content.includes('BATCH_SIZE') ||
    content.includes('$i % ');

  const hasDqlUpdateBuilder = content.includes("->update(") && content.includes('->set(') &&
    content.includes('->getQuery(');
  const hasDqlDeleteBuilder = content.includes("->delete(") && content.includes('->getQuery(');
  const hasDqlUpdate = hasDqlUpdateBuilder || hasDqlDeleteBuilder ||
    content.includes('UPDATE ') || content.includes('DELETE FROM ');

  const hasTransaction = content.includes('beginTransaction') ||
    content.includes('wrapInTransaction') ||
    content.includes('transactional(') ||
    content.includes('->getConnection()->beginTransaction');

  const hasDbalInsert = content.includes('executeStatement(') &&
    (content.includes('INSERT') || content.includes('insert'));

  const issues: string[] = [];

  if (hasLoopFlush && !hasBatchPattern) {
    issues.push('$em->flush() appears inside a loop without batch pattern — N flush calls instead of one; flush every N items using $i % BATCH_SIZE === 0');
  }

  if (hasClearInLoop && !hasBatchPattern) {
    issues.push('$em->clear() in loop without batch control — entities are detached; re-fetch any references needed after clear()');
  }

  if (hasDqlUpdate) {
    const hasDqlWhere = content.includes('->where(') || content.includes('WHERE ');
    if (!hasDqlWhere) {
      issues.push('DQL UPDATE/DELETE without WHERE clause detected — may update/delete all rows in the table');
    }
    issues.push('DQL UPDATE/DELETE bypasses lifecycle events (preUpdate/postUpdate/preRemove/postRemove) — ensure no business logic depends on those events');
  }

  if (hasDbalInsert && !hasTransaction) {
    issues.push('DBAL INSERT in loop without transaction wrapping — each INSERT is an autocommit; wrap bulk inserts in a single transaction for atomicity and performance');
  }

  if (hasBatchPattern && !hasClear) {
    issues.push('Batch flush pattern without $em->clear() — without clearing the identity map memory grows unbounded for large datasets');
  }

  if (hasBatchPattern && !hasTransaction) {
    issues.push('Batch operation without transaction wrapping — partial batch failure leaves database in inconsistent state');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasLoopFlush,
    hasBatchPattern,
    hasDqlUpdate,
    hasTransaction,
    hasClearInLoop,
    issues,
  };
}

export function listDoctrineBulkOperations(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineBulkInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseBulkOperationFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine bulk operation patterns found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine Bulk Operations Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const withIssues = results.filter((r) => r.issues.length > 0);
    const clean = results.filter((r) => r.issues.length === 0);

    if (withIssues.length > 0) {
      text += `\nFiles with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        const flags: string[] = [];
        if (r.hasLoopFlush) flags.push('loop-flush');
        if (r.hasBatchPattern) flags.push('batch');
        if (r.hasDqlUpdate) flags.push('DQL-update');
        if (r.hasTransaction) flags.push('transaction');
        if (r.hasClearInLoop) flags.push('clear-in-loop');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (clean.length > 0) {
      text += `\nClean bulk operations (${clean.length}):\n`;
      for (const r of clean) {
        const flags: string[] = [];
        if (r.hasBatchPattern) flags.push('batch');
        if (r.hasTransaction) flags.push('transaction');
        if (r.hasDqlUpdate) flags.push('DQL-update');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
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

export function getDoctrineBulkOperationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineBulkInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseBulkOperationFile(file);
      if (info) results.push(info);
    }

    let text = `Doctrine Bulk Operations Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total files with bulk patterns:  ${results.length}\n`;
    text += `  With flush-in-loop:            ${results.filter((r) => r.hasLoopFlush).length}\n`;
    text += `  With batch pattern:            ${results.filter((r) => r.hasBatchPattern).length}\n`;
    text += `  With DQL UPDATE/DELETE:        ${results.filter((r) => r.hasDqlUpdate).length}\n`;
    text += `  With transaction:              ${results.filter((r) => r.hasTransaction).length}\n`;
    text += `  With clear-in-loop:            ${results.filter((r) => r.hasClearInLoop).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineBulkOperationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_bulk_operations',
      description: 'Show Doctrine bulk operation patterns: flush-in-loop, batch flush (% BATCH_SIZE), DQL UPDATE/DELETE, DBAL bulk INSERT; warns on flush in loop (use batching), DQL UPDATE/DELETE without WHERE (mass update risk), DQL bypasses lifecycle events, DBAL INSERT without transaction, batch without clear() (memory leak), batch without transaction (partial failure risk)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_bulk_operation_stats',
      description: 'Show Doctrine bulk operation statistics: total files, flush-in-loop count, batch pattern count, DQL update count, transaction coverage, clear-in-loop count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
