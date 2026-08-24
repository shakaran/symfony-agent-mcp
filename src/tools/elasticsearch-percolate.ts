// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ElasticsearchPercolateInfo {
  file: string;
  type: 'query' | 'scroll' | 'percolate' | 'bulk' | 'alias' | 'config';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildElasticsearchPercolateInfos(appPath: string): ElasticsearchPercolateInfo[] {
  const results: ElasticsearchPercolateInfo[] = [];

  // Check composer.json for Elasticsearch packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (
      composerContent.includes('elasticsearch/elasticsearch') ||
      composerContent.includes('friendsofsymfony/elastica-bundle') ||
      composerContent.includes('ruflin/elastica')
    ) {
      results.push({ file: 'composer.json', type: 'config', issues: ['Elasticsearch client package detected'] });
    }
  }

  // Scan config/**/*.yaml for Elasticsearch config
  const configFiles: string[] = [
    ...scanDirRecursive(path.join(appPath, 'config'), '.yaml'),
    ...scanDirRecursive(path.join(appPath, 'config'), '.yml'),
  ];
  for (const filePath of configFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('elasticsearch') &&
      !content.includes('elastica') &&
      !content.includes('fos_elastica')
    ) continue;
    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Direct index name instead of alias
    const directIndexMatch = /index[_-]?name\s*:\s*['"]?(prod_|dev_|staging_)[a-zA-Z0-9_-]+/.exec(content);
    if (directIndexMatch) {
      issues.push(
        `Direct index name with environment prefix in ${relFile}: '${directIndexMatch[0].trim()}' — use index aliases instead of direct names for zero-downtime reindexing`,
      );
    }

    results.push({ file: relFile, type: 'config', issues });
  }

  // Scan src/**/*.php for Elasticsearch usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('_update_by_query') &&
      !content.includes('_delete_by_query') &&
      !content.includes('scroll_id') &&
      !content.includes('scroll') &&
      !content.includes('percolate') &&
      !content.includes('match_all') &&
      !content.includes('bulk(') &&
      !content.includes('prod_') &&
      !content.includes('dev_')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];
    let detectedType: ElasticsearchPercolateInfo['type'] = 'query';

    // _update_by_query / _delete_by_query without conflicts: proceed
    if (content.includes('_update_by_query') || content.includes('_delete_by_query')) {
      const opName = content.includes('_update_by_query') ? '_update_by_query' : '_delete_by_query';
      const opIndex = content.includes('_update_by_query')
        ? content.indexOf('_update_by_query')
        : content.indexOf('_delete_by_query');
      const contextWindow = content.slice(Math.max(0, opIndex - 200), opIndex + 400);
      if (!contextWindow.includes('conflicts')) {
        issues.push(
          `${opName} in ${relFile} used without 'conflicts: proceed' — by default it aborts on version conflict; add conflicts: proceed to continue on conflict`,
        );
        detectedType = 'query';
      }
    }

    // Unbounded scroll without size limit
    if (content.includes('scroll_id') || content.includes("'scroll'") || content.includes('"scroll"')) {
      const scrollIndex = Math.max(
        content.indexOf('scroll_id'),
        content.indexOf("'scroll'"),
        content.indexOf('"scroll"'),
      );
      const contextWindow = content.slice(Math.max(0, scrollIndex - 300), scrollIndex + 400);
      if (!contextWindow.includes('size') && !contextWindow.includes('limit')) {
        issues.push(
          `Scroll usage in ${relFile} without size limit — unbounded scroll can exhaust heap; always set 'size' parameter to control batch size`,
        );
        detectedType = 'scroll';
      }
    }

    // Percolate with user-supplied document without field validation
    if (content.includes('percolate')) {
      const percolateIndex = content.indexOf('percolate');
      const contextWindow = content.slice(Math.max(0, percolateIndex - 300), percolateIndex + 400);
      const userInputPattern = /\$request->get|\$_GET|\$_POST/;
      if (userInputPattern.test(contextWindow)) {
        issues.push(
          `Percolate query in ${relFile} uses user-supplied document near user input without evident field validation — validate and whitelist document fields before percolation`,
        );
        detectedType = 'percolate';
      }
    }

    // match_all without size limit
    if (content.includes('match_all')) {
      const matchAllMatches = [...content.matchAll(/match_all/g)];
      for (const match of matchAllMatches) {
        const around = content.slice(Math.max(0, (match.index ?? 0) - 200), (match.index ?? 0) + 400);
        if (!around.includes('size') && !around.includes('limit')) {
          issues.push(
            `match_all query in ${relFile} without size or limit — match_all on large indices returns all documents and can overwhelm the cluster`,
          );
          detectedType = 'query';
          break;
        }
      }
    }

    // Direct index name (prod_/dev_) used in string literals
    const directIndexPattern = /['"](?:prod|dev|staging)_[a-zA-Z0-9_-]+['"]/g;
    const directMatches = [...content.matchAll(directIndexPattern)];
    if (directMatches.length > 0) {
      issues.push(
        `Direct environment-prefixed index name(s) in ${relFile}: ${directMatches.map((m) => m[0]).slice(0, 3).join(', ')} — use index aliases for environment-agnostic queries`,
      );
      detectedType = 'alias';
    }

    if (issues.length > 0) {
      results.push({ file: relFile, type: detectedType, issues });
    }
  }

  // Scan tests/**/*.php for bulk() without refresh
  const testFiles = scanDirRecursive(path.join(appPath, 'tests'), '.php');
  for (const filePath of testFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('bulk(')) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    const bulkMatches = [...content.matchAll(/bulk\s*\(/g)];
    for (const match of bulkMatches) {
      const around = content.slice(Math.max(0, (match.index ?? 0) - 200), (match.index ?? 0) + 400);
      if (!around.includes('refresh')) {
        issues.push(
          `bulk() in test file ${relFile} without 'refresh: true' — indexed documents may not be visible immediately in tests; add refresh: true or wait for refresh`,
        );
        break;
      }
    }

    if (issues.length > 0) {
      results.push({ file: relFile, type: 'bulk', issues });
    }
  }

  return results;
}

export function listElasticsearchPercolate(appPath: string): McpToolResult {
  try {
    const infos = buildElasticsearchPercolateInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Elasticsearch integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Elasticsearch Percolate Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticsearchPercolateStats(appPath: string): McpToolResult {
  try {
    const infos = buildElasticsearchPercolateInfos(appPath);
    let text = `Elasticsearch Percolate Statistics\n${'='.repeat(40)}\n\n`;
    text += `Query patterns:     ${infos.filter((i) => i.type === 'query').length}\n`;
    text += `Scroll patterns:    ${infos.filter((i) => i.type === 'scroll').length}\n`;
    text += `Percolate patterns: ${infos.filter((i) => i.type === 'percolate').length}\n`;
    text += `Bulk patterns:      ${infos.filter((i) => i.type === 'bulk').length}\n`;
    text += `Alias patterns:     ${infos.filter((i) => i.type === 'alias').length}\n`;
    text += `Config patterns:    ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticsearchPercolateTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_elasticsearch_percolate',
      description: 'Analyze Elasticsearch advanced usage: _update_by_query/_delete_by_query without conflicts:proceed, unbounded scroll without size limit, percolate queries with unvalidated user input, match_all without size limit, bulk() in tests without refresh:true, direct environment-prefixed index names instead of aliases',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_elasticsearch_percolate_stats',
      description: 'Statistics for Elasticsearch usage: query/scroll/percolate/bulk/alias/config pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
