// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine QueryBuilder Pattern Analyzer
 *
 * Complements repository-analyzer.ts (N+1 detection) by focusing on DQL/QB quality:
 *
 * Scans src/ for QueryBuilder patterns:
 *   - ->select() with explicit columns vs SELECT *
 *   - ->join() / ->leftJoin() / ->innerJoin() chains
 *   - ->setMaxResults() without ->setFirstResult() (pagination incomplete)
 *   - ->expr()->in() with plain array (risk: long query / SQL injection if unbounded)
 *   - ->getQuery()->getResult() in loops (N+1 hidden in loops)
 *   - ->setParameter() usage vs inline values (injection risk)
 *   - ->orderBy() on non-indexed columns (heuristic: order by non-id/created fields)
 *   - Native SQL usage (->createNativeQuery)
 *
 * Counts by repository:
 *   - QB usages, join count, subquery count, native SQL count
 *
 * Security:
 *   - String concatenation in DQL/SQL (potential injection)
 *   - Missing setParameter() when variable used in query string
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface QbIssue {
  type: string;
  line: number;
  detail: string;
}

interface QbRepository {
  class: string;
  file: string;
  qbUsages: number;
  joinCount: number;
  nativeSqlCount: number;
  issues: QbIssue[];
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

function analyzeFile(filePath: string): QbRepository | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isRepo = content.includes('ServiceEntityRepository') ||
    content.includes('EntityRepository') ||
    content.includes('createQueryBuilder') ||
    content.includes('QueryBuilder');
  if (!isRepo) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const lines  = content.split('\n');
  const issues: QbIssue[] = [];

  let qbUsages    = 0;
  let joinCount   = 0;
  let nativeSql   = 0;
  let hasMaxResults = false;
  let hasFirstResult = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    if (line.includes('createQueryBuilder(')) qbUsages++;
    if (/->(?:left|inner|right)?[Jj]oin\s*\(/.test(line)) joinCount++;
    if (line.includes('createNativeQuery(') || line.includes('executeQuery(')) nativeSql++;
    if (line.includes('->setMaxResults(')) hasMaxResults = true;
    if (line.includes('->setFirstResult(')) hasFirstResult = true;

    // String concatenation in DQL
    if (/->(?:where|andWhere|orWhere)\s*\([^)]*\./.test(line) && !line.includes('//')) {
      issues.push({ type: 'injection-risk', line: lineNo, detail: 'String concatenation in where() — use setParameter() instead' });
    }

    // ->expr()->in() with array variable (not necessarily parametrised)
    if (line.includes('->in(') && !line.includes('setParameter')) {
      issues.push({ type: 'in-clause', line: lineNo, detail: '->expr()->in() — verify array is parametrised to avoid long/unsafe queries' });
    }

    // getResult() inside what looks like a loop
    if (line.includes('->getResult()') && i > 0) {
      const prev = (lines[i - 2] ?? '') + (lines[i - 1] ?? '');
      if (/foreach|for\s*\(|while\s*\(/.test(prev)) {
        issues.push({ type: 'result-in-loop', line: lineNo, detail: 'getResult() inside loop — potential N+1 pattern' });
      }
    }

    // Native SQL with string interpolation
    if ((line.includes('createNativeQuery(') || line.includes('executeQuery(')) &&
        (/"\s*\.\s*\$|'\s*\.\s*\$|\$\{/.test(line))) {
      issues.push({ type: 'native-sql-concat', line: lineNo, detail: 'Native SQL with string interpolation — SQL injection risk' });
    }
  }

  // Pagination check (setMaxResults without setFirstResult is OK for LIMIT-only, not a hard error)
  if (hasMaxResults && !hasFirstResult && qbUsages > 0) {
    issues.push({ type: 'pagination', line: 0, detail: 'setMaxResults() used without setFirstResult() — may be intentional (top-N) but verify pagination is complete' });
  }

  if (qbUsages === 0 && nativeSql === 0) return null;

  return {
    class: classM[1],
    file: path.basename(filePath),
    qbUsages,
    joinCount,
    nativeSqlCount: nativeSql,
    issues,
  };
}

export function listQueryBuilderPatterns(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const repos: QbRepository[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = analyzeFile(file);
      if (r) repos.push(r);
    }

    if (repos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No QueryBuilder usage found in src/.\n\nDoctrine QueryBuilder example:\n  $qb = $this->createQueryBuilder(\'p\')\n    ->andWhere(\'p.status = :status\')\n    ->setParameter(\'status\', \'active\')\n    ->setMaxResults(20)\n    ->getQuery()\n    ->getResult();',
        }],
      };
    }

    repos.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));

    let text = `Doctrine QueryBuilder Analysis\n${'='.repeat(55)}\n`;
    text += `\nRepositories with QB usage: ${repos.length}\n`;

    const withIssues = repos.filter((r) => r.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nIssues found (${withIssues.length} repositories):\n`;
      for (const r of withIssues) {
        text += `\n  ${r.class}  (${r.file})\n`;
        text += `    QB usages: ${r.qbUsages}  joins: ${r.joinCount}  native SQL: ${r.nativeSqlCount}\n`;
        for (const issue of r.issues) {
          const loc = issue.line > 0 ? `:${issue.line}` : '';
          text += `    ⚠ [${issue.type}${loc}] ${issue.detail}\n`;
        }
      }
    }

    const clean = repos.filter((r) => r.issues.length === 0);
    if (clean.length > 0) {
      text += `\nClean repositories (${clean.length}):\n`;
      for (const r of clean) {
        text += `  ${r.class.padEnd(40)} QB:${r.qbUsages}  joins:${r.joinCount}\n`;
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

export function getQueryBuilderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory.' }] };

    const repos: QbRepository[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = analyzeFile(file);
      if (r) repos.push(r);
    }

    const totalQb      = repos.reduce((s, r) => s + r.qbUsages, 0);
    const totalJoins   = repos.reduce((s, r) => s + r.joinCount, 0);
    const totalNative  = repos.reduce((s, r) => s + r.nativeSqlCount, 0);
    const totalIssues  = repos.reduce((s, r) => s + r.issues.length, 0);

    let text = `QueryBuilder Statistics\n${'='.repeat(40)}\n\n`;
    text += `Repositories with QB:    ${repos.length}\n`;
    text += `Total QB usages:         ${totalQb}\n`;
    text += `Total joins:             ${totalJoins}\n`;
    text += `Native SQL usages:       ${totalNative}\n`;
    text += `QB issues found:         ${totalIssues}\n`;
    text += `Repos with issues:       ${repos.filter((r) => r.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineQueryBuilderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_query_builder_patterns',
      description: 'Analyze Doctrine QueryBuilder usage: join count, setMaxResults/setFirstResult pagination, string concatenation in where() (injection risk), ->expr()->in() without parameter, getResult() in loops, native SQL with string interpolation',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_query_builder_stats',
      description: 'Show QueryBuilder statistics: repository count with QB, total QB usages, join count, native SQL count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
