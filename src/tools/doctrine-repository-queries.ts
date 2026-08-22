import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RepositoryQueryIssue {
  file: string;
  class?: string;
  method?: string;
  type: 'dql' | 'sql' | 'querybuilder';
  hasMaxResults: boolean;
  hasFirstResult: boolean;
  hasSqlInjectionRisk: boolean;
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

function scanRepositoryQueries(filePath: string, appPath: string): RepositoryQueryIssue[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const isRepo = content.includes('extends ServiceEntityRepository') || content.includes('extends EntityRepository') || content.includes('Repository');
  if (!isRepo) return [];
  if (content.includes('namespace Doctrine\\')) return [];
  const classM = /class\s+(\w+)/.exec(content);
  const found: RepositoryQueryIssue[] = [];
  const hasDql = content.includes('createQuery(') || content.includes('createNamedQuery(');
  const hasSql = content.includes('createNativeQuery(') || content.includes('getConnection()');
  const hasQb = content.includes('createQueryBuilder(');
  if (!hasDql && !hasSql && !hasQb) return [];
  const hasMaxResults = content.includes('->setMaxResults(') || content.includes('setMaxResults');
  const hasFirstResult = content.includes('->setFirstResult(');
  const hasSqlInjectionRisk = /createNativeQuery\s*\(\s*['""][^'"]*\.\s*\$/.test(content) || /getConnection\(\)->executeQuery\s*\(\s*['""][^'"]*\.\s*\$/.test(content);
  const issues: string[] = [];
  if ((hasDql || hasQb) && !hasMaxResults) issues.push('DQL/QueryBuilder without setMaxResults() — unbounded query; set a page size');
  if (hasSqlInjectionRisk) issues.push('Native SQL with string concatenation — potential SQL injection; use parameterized queries');
  const type: 'dql' | 'sql' | 'querybuilder' = hasDql ? 'dql' : hasQb ? 'querybuilder' : 'sql';
  found.push({ file: path.relative(appPath, filePath), class: classM?.[1], type, hasMaxResults, hasFirstResult, hasSqlInjectionRisk, issues });
  return found;
}

export function listDoctrineRepositoryQueries(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const all: RepositoryQueryIssue[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      all.push(...scanRepositoryQueries(file, appPath));
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No raw DQL/SQL repository queries found.' }] };
    const totalIssues = all.reduce((s, q) => s + q.issues.length, 0);
    let text = `Doctrine Repository Queries\n${'='.repeat(55)}\n\nRepositories: ${all.length}  Issues: ${totalIssues}\n`;
    text += `  DQL: ${all.filter((q) => q.type === 'dql').length}  QueryBuilder: ${all.filter((q) => q.type === 'querybuilder').length}  SQL: ${all.filter((q) => q.type === 'sql').length}\n`;
    for (const q of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const limits = [q.hasMaxResults ? '✓ maxResults' : '⚠ no maxResults', q.hasFirstResult ? '✓ offset' : ''].filter(Boolean).join('  ');
      const risk = q.hasSqlInjectionRisk ? '  ⚠ SQL injection risk' : '';
      text += `\n  ${q.class ?? '(file)'}  type: ${q.type}  ${limits}${risk}  (${q.file})\n`;
      for (const i of q.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineRepositoryQueryStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const all: RepositoryQueryIssue[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        all.push(...scanRepositoryQueries(file, appPath));
      }
    }
    let text = `Doctrine Repository Query Statistics\n${'='.repeat(40)}\n\n`;
    text += `Repositories with queries: ${all.length}\n  DQL: ${all.filter((q) => q.type === 'dql').length}\n  QueryBuilder: ${all.filter((q) => q.type === 'querybuilder').length}\n  Native SQL: ${all.filter((q) => q.type === 'sql').length}\n  With setMaxResults: ${all.filter((q) => q.hasMaxResults).length}\nIssues: ${all.reduce((s, q) => s + q.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineRepositoryQueryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_repository_queries', description: 'Show Doctrine repository DQL/SQL/QueryBuilder queries: setMaxResults/setFirstResult presence, native SQL string concatenation (SQL injection risk), unbounded query warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_repository_query_stats', description: 'Show Doctrine repository query statistics: repository count, by query type, setMaxResults adoption, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
