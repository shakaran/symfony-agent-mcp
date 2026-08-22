import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface UpsertPatternInfo {
  file: string;
  type: 'dbal' | 'orm' | 'native' | 'fetch-persist';
  pattern: string;
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

function buildUpsertInfos(appPath: string): UpsertPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: UpsertPatternInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const hasDbalUpsert = content.includes('ON CONFLICT') || content.includes('ON DUPLICATE KEY UPDATE') ||
      content.includes('INSERT OR REPLACE') || content.includes('INSERT OR IGNORE');

    const hasOrmUpsert = content.includes('scheduleForUpsert(') || content.includes('->upsert(');

    const hasNativeUpsert = content.includes('REPLACE INTO') ||
      (content.includes('->prepare(') && (content.includes('ON CONFLICT') || content.includes('REPLACE INTO')));

    const hasFetchPersist = content.includes('findOneBy(') && content.includes('->persist(') &&
      !content.includes('ON CONFLICT') && !content.includes('upsert');

    if (hasDbalUpsert) {
      const issues: string[] = [];
      if (content.includes('ON DUPLICATE KEY UPDATE') && !content.includes('column')) {
        issues.push('ON DUPLICATE KEY UPDATE without explicit column list — updates all columns on collision (may overwrite created_at, uuid, etc.)');
      }
      const noTransaction = !content.includes('beginTransaction') && !content.includes('transactional(');
      if (noTransaction && content.includes('executeStatement(')) {
        issues.push('DBAL upsert without explicit transaction — partial failure on batch upsert leaves data inconsistent');
      }
      results.push({ file: relFile, type: 'dbal', pattern: 'INSERT ON CONFLICT / ON DUPLICATE KEY', issues });
    }

    if (hasOrmUpsert) {
      results.push({ file: relFile, type: 'orm', pattern: 'Doctrine ORM upsert()', issues: [] });
    }

    if (hasNativeUpsert && !hasDbalUpsert) {
      const issues: string[] = [];
      if (content.includes('REPLACE INTO')) {
        issues.push('REPLACE INTO performs DELETE+INSERT (not true upsert) — ON DELETE triggers fire, auto-increment ID changes, FK cascades may activate');
      }
      results.push({ file: relFile, type: 'native', pattern: 'REPLACE INTO / native SQL upsert', issues });
    }

    if (hasFetchPersist) {
      const inLoop = /(?:foreach|for|while)\s*\([^)]{0,200}\)[^{]{0,50}\{[^}]{0,2000}findOneBy\(/.test(content);
      if (inLoop) {
        results.push({ file: relFile, type: 'fetch-persist', pattern: 'findOneBy+persist in loop', issues: ['fetch-then-persist in a loop is not an upsert — generates N+1 SELECT queries and has race condition (two processes may insert same entity simultaneously)'] });
      }
    }
  }

  return results;
}

export function listDoctrineUpsertPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildUpsertInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No upsert patterns found (no ON CONFLICT, REPLACE INTO, upsert(), or fetch-persist loops).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Upsert Pattern Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineUpsertStats(appPath: string): McpToolResult {
  try {
    const infos = buildUpsertInfos(appPath);
    let text = `Doctrine Upsert Statistics\n${'='.repeat(40)}\n\n`;
    text += `DBAL upserts:       ${infos.filter((i) => i.type === 'dbal').length}\n`;
    text += `ORM upserts:        ${infos.filter((i) => i.type === 'orm').length}\n`;
    text += `Native SQL:         ${infos.filter((i) => i.type === 'native').length}\n`;
    text += `Fetch-persist:      ${infos.filter((i) => i.type === 'fetch-persist').length}\n`;
    text += `Issues:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineUpsertTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_upsert_patterns', description: 'Detect DBAL/ORM/native upsert patterns; warns on ON DUPLICATE KEY without column list, REPLACE INTO (delete+insert), upsert without transaction, fetch-persist loop (N+1 + race condition)', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_upsert_stats', description: 'Statistics for upsert patterns: DBAL/ORM/native/fetch-persist count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
