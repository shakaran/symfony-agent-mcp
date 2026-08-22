/**
 * Symfony Cache Tagging Inspector
 *
 * Distinct from cache-config.ts (adapter/pool config) and symfony-cache-pools.ts (pool listing).
 * Focuses on tag-based cache invalidation patterns:
 *
 * TagAwareCacheInterface usage:
 *   - Services injecting TagAwareCacheInterface or CacheInterface+TagAwareCacheInterface
 *   - $cache->get(key, callback) with $item->tag([...])
 *   - $cache->invalidateTags([...]) call sites
 *   - tag() called with dynamic values (hard to audit)
 *
 * HTTP cache tags (Symfony HttpKernel):
 *   - #[Cache(tags: [...])] attribute on controllers
 *   - Response::headers->set('Cache-Tags', ...) manual headers
 *   - Response::headers->set('X-Cache-Tags', ...) (Varnish style)
 *
 * ESI cache tags:
 *   - ESI includes with s-maxage and surrogate-key headers
 *
 * Analysis:
 *   - invalidateTags() with very broad tags (e.g. 'all', '*') — nukes entire cache
 *   - TagAwareAdapter used on Redis without proper tag invalidation support
 *   - $item->tag() inside long-running loops (performance)
 *   - Controllers setting Cache-Tags but ESI disabled
 *
 * Pool adapter check:
 *   - TagAwareAdapter wrapping memcached (tags not supported in APCu/Memcache backend)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CacheTagSite {
  class: string;
  file: string;
  tagsSet: string[];
  invalidatesSites: string[];
  hasDynamicTags: boolean;
  issues: string[];
}

const BROAD_TAGS = new Set(['all', '*', 'everything', 'invalidate_all']);

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseCacheTagSite(filePath: string, appPath: string): CacheTagSite | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasTags = content.includes('->tag(') || content.includes('invalidateTags(') ||
                  content.includes('TagAwareCacheInterface') || content.includes('Cache-Tags') ||
                  content.includes('X-Cache-Tags');
  if (!hasTags) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Extract static tag values from ->tag([...]) calls
  const tagsSet: string[] = [];
  for (const m of content.matchAll(/->tag\s*\(\s*\[([^\]]+)\]/g)) {
    for (const t of m[1].matchAll(/['"]([^'"]+)['"]/g)) tagsSet.push(t[1]);
  }

  // ->tag('single-tag')
  for (const m of content.matchAll(/->tag\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    tagsSet.push(m[1]);
  }

  const hasDynamicTags = content.includes('->tag($') || content.includes('->tag([...');

  // invalidateTags sites
  const invalidatesSites: string[] = [];
  for (const m of content.matchAll(/invalidateTags\s*\(\s*\[([^\]]+)\]/g)) {
    for (const t of m[1].matchAll(/['"]([^'"]+)['"]/g)) invalidatesSites.push(t[1]);
  }

  const issues: string[] = [];
  const broadFound = [...tagsSet, ...invalidatesSites].filter((t) => BROAD_TAGS.has(t.toLowerCase()));
  if (broadFound.length > 0) {
    issues.push(`Broad cache tags used: ${broadFound.join(', ')} — may invalidate entire cache`);
  }
  if (hasDynamicTags) {
    issues.push('Dynamic tag values ($variable) — tags hard to audit statically');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    tagsSet: [...new Set(tagsSet)],
    invalidatesSites: [...new Set(invalidatesSites)],
    hasDynamicTags,
    issues,
  };
}

export function listCacheTagConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const sites: CacheTagSite[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const s = parseCacheTagSite(file, appPath);
      if (s) sites.push(s);
    }

    if (sites.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No cache tag usage found.\n\nExample:\n  $value = $this->cache->get(\'my_key\', function (ItemInterface $item): string {\n    $item->tag([\'article\', \'article_42\']);\n    $item->expiresAfter(3600);\n    return $this->fetchData();\n  });\n\n  // Invalidation:\n  $this->cache->invalidateTags([\'article_42\']);',
        }],
      };
    }

    sites.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
    const totalIssues = sites.reduce((s, c) => s + c.issues.length, 0);

    // Collect all tag names
    const allTags = new Set(sites.flatMap((s) => s.tagsSet));
    const invalidatedTags = new Set(sites.flatMap((s) => s.invalidatesSites));
    const tagsNeverInvalidated = [...allTags].filter((t) => !invalidatedTags.has(t));

    let text = `Cache Tag Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles with tag usage: ${sites.length}  Issues: ${totalIssues}\n`;
    text += `Unique tags set:      ${allTags.size}\n`;
    text += `Unique tags invalidated: ${invalidatedTags.size}\n`;

    for (const s of sites) {
      text += `\n  ${s.class}  (${s.file})\n`;
      if (s.tagsSet.length > 0) text += `    Tags: ${s.tagsSet.join(', ')}\n`;
      if (s.invalidatesSites.length > 0) text += `    Invalidates: ${s.invalidatesSites.join(', ')}\n`;
      for (const issue of s.issues) text += `    ⚠ ${issue}\n`;
    }

    if (tagsNeverInvalidated.length > 0 && tagsNeverInvalidated.length <= 10) {
      text += `\nTags set but never invalidated in src/:\n`;
      for (const t of tagsNeverInvalidated) text += `  ${t}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheTagStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const sites: CacheTagSite[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const s = parseCacheTagSite(file, appPath);
        if (s) sites.push(s);
      }
    }

    const allTags        = new Set(sites.flatMap((s) => s.tagsSet));
    const invalidatedTags = new Set(sites.flatMap((s) => s.invalidatesSites));

    let text = `Cache Tag Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with tag usage:  ${sites.length}\n`;
    text += `Unique tags defined:   ${allTags.size}\n`;
    text += `Tags invalidated:      ${invalidatedTags.size}\n`;
    text += `With dynamic tags:     ${sites.filter((s) => s.hasDynamicTags).length}\n`;
    text += `Issues:                ${sites.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheTagTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cache_tag_config',
      description: 'Show cache tag usage: TagAwareCacheInterface injection sites, $item->tag() calls, invalidateTags() sites, broad tag warning, dynamic tag detection, tags set but never invalidated',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cache_tag_stats',
      description: 'Show cache tag statistics: file count, unique tags defined, tags invalidated, dynamic tag count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
