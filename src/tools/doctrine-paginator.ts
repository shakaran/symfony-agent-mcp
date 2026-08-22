import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PaginatorUsage {
  file: string;
  class?: string;
  paginatorCount: number;
  hasFetchJoin: boolean;
  hasSetMaxResults: boolean;
  hasSetFirstResult: boolean;
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

function parsePaginatorUsage(filePath: string, appPath: string): PaginatorUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('Paginator') || !content.includes('Doctrine')) return null;
  if (content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const paginatorCount = [...content.matchAll(/new\s+Paginator\s*\(/g)].length;
  if (paginatorCount === 0) return null;
  const hasFetchJoin = /new\s+Paginator\s*\([^,)]+,\s*true/.test(content);
  const hasSetMaxResults = content.includes('->setMaxResults(');
  const hasSetFirstResult = content.includes('->setFirstResult(');
  const issues: string[] = [];
  if (!hasSetMaxResults) issues.push('Paginator without setMaxResults() — unbounded query; always set page size');
  if (!hasSetFirstResult) issues.push('Paginator without setFirstResult() — always starts at first record; set page offset');
  if (hasFetchJoin && !hasSetMaxResults) issues.push('Paginator with fetchJoinCollection=true but no setMaxResults — count query can be expensive with JOIN');
  return { file: path.relative(appPath, filePath), class: classM?.[1], paginatorCount, hasFetchJoin, hasSetMaxResults, hasSetFirstResult, issues };
}

export function listDoctrinePaginators(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: PaginatorUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parsePaginatorUsage(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No Doctrine Paginator usage found.\n\nExample:\n  use Doctrine\\ORM\\Tools\\Pagination\\Paginator;\n  $query = $em->createQuery(...)->setMaxResults(20)->setFirstResult($page * 20);\n  $paginator = new Paginator($query, fetchJoinCollection: true);\n  $total = count($paginator);' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Doctrine Paginator\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const fj = u.hasFetchJoin ? '  fetchJoin:true' : '';
      const limits = [u.hasSetMaxResults ? '✓ maxResults' : '⚠ no maxResults', u.hasSetFirstResult ? '✓ firstResult' : '⚠ no firstResult'].join('  ');
      text += `\n  ${u.class ?? '(file)'}  count: ${u.paginatorCount}${fj}  ${limits}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrinePaginatorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: PaginatorUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parsePaginatorUsage(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Doctrine Paginator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\n  With fetchJoin: ${usages.filter((u) => u.hasFetchJoin).length}\n  With setMaxResults: ${usages.filter((u) => u.hasSetMaxResults).length}\n  With setFirstResult: ${usages.filter((u) => u.hasSetFirstResult).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrinePaginatorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_paginators', description: 'Show Doctrine Paginator usage: fetchJoinCollection flag, setMaxResults/setFirstResult presence, unbounded query warning, missing offset warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_paginator_stats', description: 'Show Doctrine Paginator statistics: file count, fetchJoin count, setMaxResults/setFirstResult adoption, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
