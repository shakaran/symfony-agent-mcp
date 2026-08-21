import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface NamedQueryInfo {
  class: string;
  file: string;
  namedNativeQueries: Array<{ name: string; query: string }>;
  sqlResultMappings: string[];
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

function parseNamedQueries(filePath: string, appPath: string): NamedQueryInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('NamedNativeQuery') && !content.includes('SqlResultSetMapping')) return null;
  if (content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const namedNativeQueries: Array<{ name: string; query: string }> = [];
  const nqPattern = /#\[ORM\\NamedNativeQuery\([^)]{0,600}\)/g;
  let m: RegExpExecArray | null;
  while ((m = nqPattern.exec(content)) !== null) {
    const block = m[0];
    const nameM = /name\s*:\s*['"]([^'"]{0,100})['"]/i.exec(block);
    const queryM = /query\s*:\s*['"]([^'"]{0,200})['"]/i.exec(block);
    if (nameM) namedNativeQueries.push({ name: nameM[1], query: queryM?.[1] ?? '' });
  }
  const sqlResultMappings: string[] = [];
  const srmPattern = /#\[ORM\\SqlResultSetMapping\([^)]{0,200}\)/g;
  while ((m = srmPattern.exec(content)) !== null) {
    const nameM = /name\s*:\s*['"]([^'"]{0,100})['"]/i.exec(m[0]);
    if (nameM) sqlResultMappings.push(nameM[1]);
  }
  const issues: string[] = [];
  for (const nq of namedNativeQueries) {
    if (nq.query && nq.query.toLowerCase().includes('select *')) issues.push(`"${nq.name}": SELECT * in named query — explicitly list columns for stability`);
    if (!sqlResultMappings.includes(nq.name) && !nq.query.includes('resultSetMapping')) issues.push(`"${nq.name}": NamedNativeQuery without matching SqlResultSetMapping — result hydration may fail`);
  }
  if (namedNativeQueries.length + sqlResultMappings.length === 0) return null;
  return { class: classM[1], file: path.relative(appPath, filePath), namedNativeQueries, sqlResultMappings, issues };
}

export function listDoctrineNamedQueries(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const entities: NamedQueryInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseNamedQueries(file, appPath);
      if (e) entities.push(e);
    }
    if (entities.length === 0) return { content: [{ type: 'text', text: 'No #[ORM\\NamedNativeQuery] or #[ORM\\SqlResultSetMapping] found.\n\nExample:\n  #[ORM\\NamedNativeQuery(name: \'findByStatus\', query: \'SELECT ...\', resultSetMapping: \'...\')]\n  #[ORM\\SqlResultSetMapping(name: \'...\', entities: [...])]\n  class Order { }' }] };
    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);
    let text = `Doctrine Named Native Queries\n${'='.repeat(55)}\n\nEntities: ${entities.length}  Issues: ${totalIssues}\n`;
    for (const e of entities.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${e.class}  named queries: ${e.namedNativeQueries.length}  result mappings: ${e.sqlResultMappings.length}  (${e.file})\n`;
      for (const nq of e.namedNativeQueries) text += `    query: ${nq.name}\n`;
      for (const i of e.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineNamedQueryStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: NamedQueryInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseNamedQueries(file, appPath);
        if (e) entities.push(e);
      }
    }
    let text = `Doctrine Named Query Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities: ${entities.length}\n  Named queries: ${entities.reduce((s, e) => s + e.namedNativeQueries.length, 0)}\n  Result mappings: ${entities.reduce((s, e) => s + e.sqlResultMappings.length, 0)}\nIssues: ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineNamedQueryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_named_queries', description: 'Show Doctrine #[ORM\\NamedNativeQuery] and #[ORM\\SqlResultSetMapping]: query names, SELECT * warning, missing SqlResultSetMapping warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_named_query_stats', description: 'Show Doctrine named query statistics: entity count, query count, result mapping count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
