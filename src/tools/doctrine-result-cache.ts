import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ResultCacheUsage {
  file: string;
  class?: string;
  usesEnableResultCache: boolean;
  usesSetCacheMode: boolean;
  usesSetResultCacheId: boolean;
  hasLifetime: boolean;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function parseResultCache(filePath: string, appPath: string): ResultCacheUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const hasNew = content.includes('enableResultCache') || content.includes('setCacheMode') || content.includes('useQueryCache') || content.includes('setResultCacheId');
  if (!hasNew) return null;
  if (content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const usesEnableResultCache = content.includes('enableResultCache');
  const usesSetCacheMode = content.includes('setCacheMode');
  const usesSetResultCacheId = content.includes('setResultCacheId');
  const hasLifetime = /enableResultCache\s*\(\s*\d+/.test(content) || /setLifetime\s*\(\s*\d+/.test(content);
  const issues: string[] = [];
  if (usesEnableResultCache && !hasLifetime) issues.push('enableResultCache() called without explicit lifetime — cache may use driver default (often 0 = no cache)');
  if (usesSetResultCacheId && !content.includes('clearResultCache')) issues.push('setResultCacheId() used without clearResultCache() — consider cache invalidation strategy');
  return { file: path.relative(appPath, filePath), class: classM?.[1], usesEnableResultCache, usesSetCacheMode, usesSetResultCacheId, hasLifetime, issues };
}

export function listDoctrineResultCache(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: ResultCacheUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseResultCache(f, appPath);
      if (r) usages.push(r);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No Doctrine result cache usage found.\n\nExample:\n  $query->enableResultCache(3600, \'my_cache_key\');' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Doctrine Result Cache Usage\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        u.usesEnableResultCache ? 'enableResultCache' : null,
        u.usesSetCacheMode ? 'setCacheMode' : null,
        u.usesSetResultCacheId ? 'cacheId' : null,
        u.hasLifetime ? 'lifetime✓' : null,
      ].filter(Boolean).join('  ');
      text += `\n  ${u.class ?? '(file)'}  ${flags}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineResultCacheStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: ResultCacheUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseResultCache(f, appPath);
        if (r) usages.push(r);
      }
    }
    let text = `Doctrine Result Cache Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using result cache: ${usages.length}\n  enableResultCache: ${usages.filter(u => u.usesEnableResultCache).length}\n  setCacheMode: ${usages.filter(u => u.usesSetCacheMode).length}\n  With explicit lifetime: ${usages.filter(u => u.hasLifetime).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineResultCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_result_cache', description: 'Detect query-level result caching: enableResultCache(), setCacheMode(), setResultCacheId(), missing lifetime warning, missing cache invalidation warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_result_cache_stats', description: 'Doctrine result cache statistics: file count, enableResultCache/setCacheMode count, lifetime coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
