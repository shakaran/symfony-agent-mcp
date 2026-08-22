/**
 * Doctrine DBAL Transaction Inspector
 *
 * Distinct from doctrine-dbal-schema-manager.ts (schema changes), repository-analyzer.ts (N+1),
 * and migrations-analysis.ts (migration quality). Focuses on transaction patterns:
 *
 * - Scans src/ PHP for: beginTransaction(), commit(), rollBack(), wrapInTransaction(),
 *   $em->getConnection()->beginTransaction(), setTransactionIsolation()
 * - Detects: beginTransaction without try/catch/rollBack, nested beginTransaction,
 *   transactional() wrapper usage
 *
 * Warnings:
 *   - beginTransaction without corresponding rollBack in catch (partial commit risk)
 *   - nested beginTransaction without isTransactionActive() check
 *   - rollBack in catch without re-throw (exception swallowed)
 *   - wrapInTransaction vs manual transaction (prefer wrapInTransaction)
 *   - setTransactionIsolation SERIALIZABLE in high-concurrency code (deadlock risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DbalTransactionInfo {
  file: string;
  class: string;
  hasBeginTransaction: boolean;
  hasRollback: boolean;
  hasWrapInTransaction: boolean;
  hasTryCatch: boolean;
  isNested: boolean;
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

function parseTransactionFile(filePath: string): DbalTransactionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasTransactionCode = content.includes('beginTransaction') ||
    content.includes('wrapInTransaction') ||
    content.includes('transactional(') ||
    content.includes('setTransactionIsolation');

  if (!hasTransactionCode) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasBeginTransaction = content.includes('beginTransaction()') || content.includes('beginTransaction ();');
  const hasCommit = content.includes('->commit()') || content.includes('->commit ();');
  const hasRollback = content.includes('rollBack()') || content.includes('rollback()') ||
    content.includes('rollBack ();') || content.includes('rollback ();');
  const hasWrapInTransaction = content.includes('wrapInTransaction') || content.includes('transactional(');
  const hasTryCatch = content.includes('try {') || content.includes('try{');

  const beginCount = (content.match(/beginTransaction\s*\(\s*\)/g) ?? []).length;
  const isNested = beginCount > 1;

  const hasIsTransactionActive = content.includes('isTransactionActive');
  const hasSerializable = content.includes('SERIALIZABLE') || content.includes('serializable');
  const hasIsolation = content.includes('setTransactionIsolation');

  const issues: string[] = [];

  if (hasBeginTransaction && !hasRollback && !hasWrapInTransaction) {
    issues.push('beginTransaction() without rollBack() in catch — partial commit risk on exception');
  }

  if (hasBeginTransaction && hasTryCatch && !hasRollback) {
    issues.push('try/catch around beginTransaction but no rollBack() — exception leaves transaction open');
  }

  if (isNested && !hasIsTransactionActive) {
    issues.push(`${beginCount} beginTransaction() calls without isTransactionActive() check — Doctrine does not support true nested transactions`);
  }

  if (hasRollback && hasTryCatch) {
    const catchBlocks = content.split('catch');
    for (let i = 1; i < catchBlocks.length && i < 10; i++) {
      const block = catchBlocks[i] ?? '';
      const hasThrow = block.includes('throw ') || block.includes('throw;');
      if (block.includes('rollBack') && !hasThrow && i === catchBlocks.length - 1) {
        issues.push('rollBack() in catch without re-throw — exception may be silently swallowed');
      }
    }
  }

  if (hasBeginTransaction && hasCommit && !hasWrapInTransaction) {
    issues.push('Manual beginTransaction/commit pattern — prefer wrapInTransaction() for automatic rollback on exception');
  }

  if (hasIsolation && hasSerializable) {
    issues.push('SERIALIZABLE isolation level — highest contention; consider READ_COMMITTED for better concurrency');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasBeginTransaction,
    hasRollback,
    hasWrapInTransaction,
    hasTryCatch,
    isNested,
    issues,
  };
}

export function listDbalTransactions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalTransactionInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseTransactionFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL transaction usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `DBAL Transaction Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const wrappers = results.filter((r) => r.hasWrapInTransaction);
    const manual = results.filter((r) => r.hasBeginTransaction && !r.hasWrapInTransaction);
    const nested = results.filter((r) => r.isNested);

    if (wrappers.length > 0) {
      text += `\nUsing wrapInTransaction (${wrappers.length}) — preferred pattern:\n`;
      for (const r of wrappers) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (manual.length > 0) {
      text += `\nManual transactions (${manual.length}):\n`;
      for (const r of manual) {
        const rollback = r.hasRollback ? ' [rollBack]' : ' [NO rollBack]';
        const tc = r.hasTryCatch ? ' [try/catch]' : '';
        const nst = r.isNested ? ' [nested]' : '';
        text += `  ${r.class.padEnd(45)} (${r.file})${rollback}${tc}${nst}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (nested.length > 0) {
      text += `\nNested transactions (${nested.length}) — requires savepoint support:\n`;
      for (const r of nested) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
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

export function getDbalTransactionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DbalTransactionInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseTransactionFile(file);
      if (info) results.push(info);
    }

    let text = `DBAL Transaction Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with transactions:     ${results.length}\n`;
    text += `  Using wrapInTransaction:   ${results.filter((r) => r.hasWrapInTransaction).length}\n`;
    text += `  Manual beginTransaction:   ${results.filter((r) => r.hasBeginTransaction).length}\n`;
    text += `  With rollBack:             ${results.filter((r) => r.hasRollback).length}\n`;
    text += `  With try/catch:            ${results.filter((r) => r.hasTryCatch).length}\n`;
    text += `  Nested transactions:       ${results.filter((r) => r.isNested).length}\n`;
    text += `Issues:                      ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDbalTransactionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_dbal_transactions',
      description: 'Show DBAL transaction patterns: beginTransaction/commit/rollBack/wrapInTransaction usage; detects nested transactions, missing rollBack in catch, exception swallowing; warns on manual transaction patterns (prefer wrapInTransaction), SERIALIZABLE isolation in high-concurrency code',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_dbal_transaction_stats',
      description: 'Show DBAL transaction statistics: total files, wrapInTransaction count, manual beginTransaction count, rollBack coverage, try/catch coverage, nested transaction count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
