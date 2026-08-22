/**
 * Symfony Paginator Inspector
 *
 * Distinct from api-platform-pagination.ts (API Platform specific) and repository-analyzer.ts
 * (N+1 detection). Focuses on pagination library detection and usage patterns:
 *
 * - Checks composer.json for: babdev/pagerfanta-bundle, pagerfanta/core, knplabs/knp-paginator-bundle
 * - Scans src/ PHP for: Pagerfanta, KNP PaginatorInterface, QueryBuilder setFirstResult/setMaxResults,
 *   DoctrinePaginator
 * - Detects page size values (static vs dynamic), max page size limits
 *
 * Warnings:
 *   - Manual pagination without total count
 *   - Page size from user input without max limit
 *   - Missing DISTINCT in paginated count query
 *   - DoctrinePaginator with fetchJoinCollection: true on large datasets
 *   - No pagination on endpoint returning collections
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PaginatorInfo {
  library: string;
  file: string;
  class: string;
  pageSize?: number;
  hasMaxPageSizeLimit: boolean;
  hasDistinctCount: boolean;
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

interface LibraryPresence {
  pagerfanta: boolean;
  knpPaginator: boolean;
  doctrinePaginator: boolean;
  manual: boolean;
}

function checkComposerLibraries(appPath: string): LibraryPresence {
  const result: LibraryPresence = {
    pagerfanta: false,
    knpPaginator: false,
    doctrinePaginator: false,
    manual: false,
  };
  try {
    const composerPath = path.join(appPath, 'composer.json');
    const content = fs.readFileSync(composerPath, 'utf-8');
    result.pagerfanta = content.includes('pagerfanta') || content.includes('babdev/pagerfanta');
    result.knpPaginator = content.includes('knp-paginator') || content.includes('knplabs/knp-paginator');
    result.doctrinePaginator = content.includes('doctrine/orm') || content.includes('doctrine/doctrine-bundle');
  } catch { /* skip */ }
  return result;
}

function detectLibrary(content: string): string {
  if (content.includes('Pagerfanta') || content.includes('pagerfanta')) return 'pagerfanta';
  if (content.includes('PaginatorInterface') && content.includes('Knp')) return 'knp-paginator';
  if (content.includes('DoctrinePaginator') || content.includes('Paginator') && content.includes('Doctrine')) return 'doctrine-paginator';
  if (content.includes('setFirstResult') || content.includes('setMaxResults')) return 'manual';
  return 'unknown';
}

function parsePaginatorFile(filePath: string): PaginatorInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasPagination = content.includes('Pagerfanta') ||
    content.includes('PaginatorInterface') ||
    content.includes('DoctrinePaginator') ||
    (content.includes('setFirstResult') && content.includes('setMaxResults')) ||
    content.includes('setMaxResults');

  if (!hasPagination) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const library = detectLibrary(content);

  let pageSize: number | undefined;
  const pageSizeMatches = [
    /setMaxResults\s*\(\s*(\d{1,6})\s*\)/.exec(content),
    /perPage\s*[=:]\s*(\d{1,6})/.exec(content),
    /limit\s*[=:]\s*(\d{1,6})/.exec(content),
    /itemsPerPage\s*[=:]\s*(\d{1,6})/.exec(content),
  ];
  for (const m of pageSizeMatches) {
    if (m) { pageSize = parseInt(m[1], 10); break; }
  }

  const hasMaxPageSizeLimit =
    content.includes('maxPerPage') ||
    content.includes('max_per_page') ||
    content.includes('maxResults') ||
    /min\s*\(\s*\$\w{1,80},\s*\d{1,6}\s*\)/.test(content) ||
    /if\s*\([^)]{0,100}>\s*\d{1,6}[^)]{0,50}\)/.test(content);

  const hasDistinctCount = content.includes('SELECT DISTINCT') ||
    content.includes('select distinct') ||
    content.includes('->distinct(') ||
    content.includes('DISTINCT');

  const issues: string[] = [];

  if (library === 'manual') {
    const hasTotalCount = content.includes('count(') || content.includes('COUNT(') ||
      content.includes('->count()') || content.includes('getTotalItemCount');
    if (!hasTotalCount) {
      issues.push('Manual setFirstResult/setMaxResults without total count — cannot build pagination links');
    }
  }

  const hasUserInput = content.includes('$request->') ||
    content.includes('getQuery(') ||
    content.includes('getRequest(');
  if (hasUserInput && !hasMaxPageSizeLimit) {
    issues.push('Page size from request input without max limit — user could request unlimited rows');
  }

  if (library === 'doctrine-paginator' && content.includes('fetchJoinCollection')) {
    const fetchJoinM = /fetchJoinCollection\s*[=:,(]\s*(true|false)/.exec(content);
    if (fetchJoinM && fetchJoinM[1] === 'true') {
      issues.push('DoctrinePaginator fetchJoinCollection: true — may produce Cartesian product on large datasets with joins');
    }
  }

  if (!hasDistinctCount && (library === 'manual' || library === 'doctrine-paginator')) {
    const hasJoin = content.includes('->join(') || content.includes('->leftJoin(') ||
      content.includes('->innerJoin(');
    if (hasJoin) {
      issues.push('Paginated query with JOIN but no DISTINCT — count may be inflated by duplicate rows');
    }
  }

  return {
    library,
    file: path.basename(filePath),
    class: classM[1],
    pageSize,
    hasMaxPageSizeLimit,
    hasDistinctCount,
    issues,
  };
}

export function listPaginatorUsage(appPath: string): McpToolResult {
  try {
    const libs = checkComposerLibraries(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: PaginatorInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parsePaginatorFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    const installedLibs = [
      libs.pagerfanta ? 'pagerfanta' : '',
      libs.knpPaginator ? 'knp-paginator' : '',
      libs.doctrinePaginator ? 'doctrine/orm' : '',
    ].filter(Boolean).join(', ');

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No paginator usage found in src/.\n\nInstalled libraries: ${installedLibs || 'none detected'}`,
        }],
      };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    const byLibrary = new Map<string, PaginatorInfo[]>();
    for (const r of results) {
      const list = byLibrary.get(r.library) ?? [];
      list.push(r);
      byLibrary.set(r.library, list);
    }

    let text = `Paginator Usage Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Libraries: ${installedLibs || 'auto-detected'}  Issues: ${totalIssues}\n`;

    for (const [lib, items] of byLibrary) {
      text += `\n${lib} (${items.length}):\n`;
      for (const r of items) {
        const size = r.pageSize ? ` pageSize:${r.pageSize}` : '';
        const maxLimit = r.hasMaxPageSizeLimit ? ' [max-limit]' : '';
        const distinct = r.hasDistinctCount ? ' [distinct]' : '';
        text += `  ${r.class.padEnd(45)} (${r.file})${size}${maxLimit}${distinct}\n`;
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

export function getPaginatorStats(appPath: string): McpToolResult {
  try {
    const libs = checkComposerLibraries(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: PaginatorInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parsePaginatorFile(file);
      if (info) results.push(info);
    }

    let text = `Paginator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total paginator usages:     ${results.length}\n`;
    text += `  pagerfanta:               ${results.filter((r) => r.library === 'pagerfanta').length}\n`;
    text += `  knp-paginator:            ${results.filter((r) => r.library === 'knp-paginator').length}\n`;
    text += `  doctrine-paginator:       ${results.filter((r) => r.library === 'doctrine-paginator').length}\n`;
    text += `  manual (setMaxResults):   ${results.filter((r) => r.library === 'manual').length}\n`;
    text += `  With max page limit:      ${results.filter((r) => r.hasMaxPageSizeLimit).length}\n`;
    text += `  With DISTINCT count:      ${results.filter((r) => r.hasDistinctCount).length}\n`;
    text += `Libraries in composer.json:\n`;
    text += `  pagerfanta: ${libs.pagerfanta ? 'yes' : 'no'}  knp-paginator: ${libs.knpPaginator ? 'yes' : 'no'}\n`;
    text += `Issues:                     ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPaginatorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_paginator_usage',
      description: 'Show Symfony pagination library usage: Pagerfanta/KNP PaginatorInterface/DoctrinePaginator/manual setMaxResults; detects page size, max-limit guard, DISTINCT in count queries; warns on manual pagination without total count, user-controlled page size without limit, Cartesian product with fetchJoinCollection, JOIN without DISTINCT',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_paginator_stats',
      description: 'Show paginator statistics: total usages by library type, max-limit coverage, DISTINCT count coverage, installed libraries, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
