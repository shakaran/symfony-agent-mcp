// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CacheInvalidationInfo {
  file: string;
  type: 'tag' | 'key' | 'event' | 'http';
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

function buildCacheInvalidationInfos(appPath: string): CacheInvalidationInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CacheInvalidationInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    if (content.includes('TagAwareCacheInterface') || content.includes('->withTag(') || content.includes('invalidateTags(')) {
      const issues: string[] = [];
      const usesTagAware = content.includes('TagAwareCacheInterface') || content.includes('TagAwareCacheAdapter');
      if (content.includes('->invalidateTags(') && !usesTagAware) {
        issues.push('invalidateTags() called but CacheInterface is not TagAwareCacheInterface — tags are silently ignored without TagAwareAdapter');
      }
      results.push({ file: relFile, type: 'tag', pattern: 'tag-based invalidation', issues });
    }

    if (content.includes('->delete(') || content.includes('->deleteItem(') || content.includes('->clear(')) {
      const issues: string[] = [];
      if (content.includes('->clear(') && !content.includes('// clear')) {
        issues.push('cache->clear() purges the entire cache pool — use ->delete()/$pool->invalidateTags() for targeted invalidation');
      }
      results.push({ file: relFile, type: 'key', pattern: 'key-based invalidation', issues });
    }

    if ((content.includes('postFlush') || content.includes('postUpdate') || content.includes('postRemove')) &&
        content.includes('delete(') || content.includes('invalidateTags(')) {
      results.push({ file: relFile, type: 'event', pattern: 'event-triggered invalidation', issues: [] });
    }

    if (content.includes('setPublic()') || content.includes('setMaxAge(') || content.includes('setEtag(') || content.includes('Cache-Control')) {
      const issues: string[] = [];
      if (content.includes('setPublic()') && content.includes('setMaxAge(0)')) {
        issues.push('Response is setPublic() with maxAge=0 — contradictory: public but not cacheable; use setPrivate() or remove maxAge(0)');
      }
      if (content.includes('setPublic()') && !content.includes('setMaxAge(') && !content.includes('setSharedMaxAge(')) {
        issues.push('Response setPublic() without setMaxAge() — HTTP cache does not know how long to cache (missing TTL)');
      }
      results.push({ file: relFile, type: 'http', pattern: 'HTTP cache headers', issues });
    }
  }

  return results;
}

export function listSymfonyCacheInvalidation(appPath: string): McpToolResult {
  try {
    const infos = buildCacheInvalidationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No cache invalidation patterns found (no TagAwareCacheInterface, delete, clear, or HTTP cache headers).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cache Invalidation Analysis\n${'='.repeat(50)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheInvalidationStats(appPath: string): McpToolResult {
  try {
    const infos = buildCacheInvalidationInfos(appPath);
    let text = `Cache Invalidation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Tag-based:   ${infos.filter((i) => i.type === 'tag').length}\n`;
    text += `Key-based:   ${infos.filter((i) => i.type === 'key').length}\n`;
    text += `Event-based: ${infos.filter((i) => i.type === 'event').length}\n`;
    text += `HTTP cache:  ${infos.filter((i) => i.type === 'http').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheInvalidationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_cache_invalidation', description: 'Analyze cache invalidation strategies; warns on invalidateTags without TagAwareCacheInterface, cache->clear() (whole pool purge), public response without maxAge, contradictory cache headers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_cache_invalidation_stats', description: 'Statistics for cache invalidation: tag/key/event/http pattern count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
