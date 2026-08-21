import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FullTextSearchInfo {
  source: string;
  type: 'mysql-fulltext' | 'postgres-gin' | 'like-query' | 'extension';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildDoctrineFullTextSearchInfos(appPath: string): FullTextSearchInfo[] {
  const results: FullTextSearchInfo[] = [];

  const composerJson = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerJson)) {
    let content = '';
    try { content = fs.readFileSync(composerJson, 'utf-8'); } catch { /* skip */ }

    if (content.includes('beberlei/doctrineextensions')) {
      results.push({
        source: 'composer.json',
        type: 'extension',
        pattern: 'beberlei/doctrineextensions',
        issues: [],
      });
    }
    if (content.includes('scienta/doctrine-json-functions')) {
      results.push({
        source: 'composer.json',
        type: 'extension',
        pattern: 'scienta/doctrine-json-functions',
        issues: [],
      });
    }
    if (content.includes('stof/doctrine-extensions-bundle')) {
      results.push({
        source: 'composer.json',
        type: 'extension',
        pattern: 'stof/doctrine-extensions-bundle',
        issues: [],
      });
    }
    if (content.includes('dunglas/doctrine-json-odm')) {
      results.push({
        source: 'composer.json',
        type: 'extension',
        pattern: 'dunglas/doctrine-json-odm',
        issues: [],
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }

          const relFile = path.relative(appPath, full);

          if (content.includes('#[Index(') || content.includes('@Index(')) {
            if (content.includes("'fulltext'") || content.includes('"fulltext"') || content.includes('fulltext')) {
              results.push({
                source: relFile,
                type: 'mysql-fulltext',
                pattern: 'MySQL FULLTEXT index defined',
                issues: [],
              });
            }
            if (content.includes('GIN') || content.includes('GiST') || content.includes('gin') || content.includes('gist')) {
              results.push({
                source: relFile,
                type: 'postgres-gin',
                pattern: 'PostgreSQL GIN/GiST index defined',
                issues: [],
              });
            }
          }

          if (content.includes('MATCH (') || content.includes('MATCH(') || content.includes('match (')) {
            results.push({
              source: relFile,
              type: 'mysql-fulltext',
              pattern: 'MATCH AGAINST full-text query',
              issues: [],
            });
          }

          if (
            (e.name.includes('Repository') || content.includes('Repository') || content.includes('EntityRepository')) &&
            (content.includes("'LIKE'") || content.includes('"LIKE"') || content.includes("LIKE '%") || content.includes('LIKE :') || content.includes("like('%"))
          ) {
            results.push({
              source: relFile,
              type: 'like-query',
              pattern: 'LIKE query on text column',
              issues: [
                'LIKE query on text column detected — for full-text search on large tables, use MySQL FULLTEXT index with MATCH AGAINST, or PostgreSQL\'s tsvector/tsquery for better performance',
              ],
            });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listDoctrineFullTextSearch(appPath: string): McpToolResult {
  try {
    const infos = buildDoctrineFullTextSearchInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No full-text search patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Full-Text Search Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineFullTextSearchStats(appPath: string): McpToolResult {
  try {
    const infos = buildDoctrineFullTextSearchInfos(appPath);
    let text = `Doctrine Full-Text Search Statistics\n${'='.repeat(40)}\n\n`;
    text += `MySQL-fulltext: ${infos.filter((i) => i.type === 'mysql-fulltext').length}\n`;
    text += `Postgres-GIN:   ${infos.filter((i) => i.type === 'postgres-gin').length}\n`;
    text += `LIKE-query:     ${infos.filter((i) => i.type === 'like-query').length}\n`;
    text += `Extension:      ${infos.filter((i) => i.type === 'extension').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineFullTextSearchTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_full_text_search', description: 'Analyze Doctrine full-text search usage; warns on LIKE queries that should use FULLTEXT indexes, detects MATCH AGAINST patterns, GIN/GiST indexes, and Doctrine extension packages', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_full_text_search_stats', description: 'Statistics for Doctrine full-text search: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
