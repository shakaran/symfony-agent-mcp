import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface RawSqlInfo {
  file: string;
  type: 'raw-query' | 'native-query' | 'dql' | 'interpolation';
  pattern: string;
  issues: string[];
}

function buildRawSqlInfos(appPath: string): RawSqlInfo[] {
  const results: RawSqlInfo[] = [];

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

          const hasRawSql = content.includes('executeQuery(') || content.includes('executeStatement(') || content.includes('createNativeQuery(') || content.includes('->query(') || content.includes('$conn->exec(');
          const hasDql = content.includes('createQuery(') || content.includes('createQueryBuilder(');
          if (!hasRawSql && !hasDql) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          if (hasRawSql) {
            const hasInterpolation = /executeQuery\s*\(\s*['"][^'"]*\s*\.\s*\$/.test(content) ||
              /executeQuery\s*\(\s*"[^"]*\$[a-zA-Z_]/.test(content) ||
              /executeStatement\s*\(\s*['"][^'"]*\s*\.\s*\$/.test(content);
            if (hasInterpolation) {
              issues.push(`SQL string concatenation with variable in "${relFile}" — use positional (?) or named (:name) placeholders with executeQuery($sql, [$value]) to prevent SQL injection`);
            }

            const hasMixedBindings = content.includes("executeQuery(") && content.includes("'%' .") || content.includes(". '%'");
            if (hasMixedBindings) {
              issues.push(`LIKE clause with string concatenation in "${relFile}" — use parameter binding with CONCAT('%', :term, '%') or pass the % in the bound value to prevent injection`);
            }

            results.push({ file: relFile, type: 'raw-query', pattern: 'executeQuery/executeStatement', issues });
          }

          if (hasDql) {
            const hasDqlInterpolation = /createQuery\s*\(\s*['"][^'"]*\s*\.\s*\$/.test(content) ||
              /createQuery\s*\(\s*"[^"]*\$[a-zA-Z_]/.test(content);
            if (hasDqlInterpolation) {
              issues.push(`DQL string concatenation in "${relFile}" — use setParameter() for query parameters instead of concatenating variables into DQL strings`);
            }

            const hasOrderByUser = /orderBy\s*\([^,)]+\$[a-zA-Z_]/.test(content);
            if (hasOrderByUser) {
              issues.push(`User-controlled orderBy direction in "${relFile}" — validate ORDER BY column against an allowlist before using in query to prevent column enumeration`);
            }

            results.push({ file: relFile, type: 'dql', pattern: 'DQL query', issues });
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listDoctrineRawSql(appPath: string): McpToolResult {
  try {
    const infos = buildRawSqlInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No raw SQL or unsafe DQL patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Raw SQL Security Analysis\n${'='.repeat(55)}\n\nQueries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineRawSqlStats(appPath: string): McpToolResult {
  try {
    const infos = buildRawSqlInfos(appPath);
    let text = `Doctrine Raw SQL Statistics\n${'='.repeat(40)}\n\n`;
    text += `Raw queries:    ${infos.filter((i) => i.type === 'raw-query').length}\n`;
    text += `DQL queries:    ${infos.filter((i) => i.type === 'dql').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineRawSqlTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_raw_sql', description: 'Analyze raw SQL and DQL queries for injection risks; warns on SQL/DQL string concatenation with variables, LIKE with concatenation, user-controlled ORDER BY without allowlist validation', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_raw_sql_stats', description: 'Statistics for raw SQL/DQL: query count by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
