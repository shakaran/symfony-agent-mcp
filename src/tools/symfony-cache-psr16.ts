import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CachePsr16Info {
  file: string;
  interface: 'psr6' | 'psr16' | 'mixed' | 'symfony';
  adapter: string;
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

function buildCachePsr16Infos(appPath: string): CachePsr16Info[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CachePsr16Info[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const usesPsr6 = content.includes('CacheItemPoolInterface') || content.includes('CacheItemInterface') ||
      (content.includes('->getItem(') && content.includes('->save('));
    const usesPsr16 = content.includes('Psr\\SimpleCache\\CacheInterface') ||
      (content.includes('->getMultiple(') || content.includes('->setMultiple('));
    const usesSymfony = content.includes('Symfony\\Contracts\\Cache\\CacheInterface') ||
      (content.includes('->get(') && /->get\(\s*\$\w{1,60}\s*,\s*(?:function|fn|static)/.test(content));

    if (usesPsr16) {
      const hasTags = content.includes('TagAwareCacheInterface') || content.includes('->withTag(');
      if (hasTags) {
        issues.push('PSR-16 SimpleCache used with TagAwareCacheInterface — PSR-16 has no tag support; tags are silently ignored');
      }
      if (usesPsr6) {
        issues.push('Mixed PSR-6 and PSR-16 usage in same class — consolidate to one cache interface to avoid confusion');
      }
      results.push({ file: relFile, interface: usesPsr6 ? 'mixed' : 'psr16', adapter: 'Psr\\SimpleCache\\CacheInterface', issues });
    }

    if (usesPsr6 && !usesPsr16) {
      const getItemWithoutHit = /->getItem\([^)]{0,200}\)(?![^;]{0,200}isHit\(\))/.test(content);
      if (getItemWithoutHit) {
        issues.push('->getItem() called without ->isHit() check — stale null value may be returned on cache miss');
      }
      results.push({ file: relFile, interface: 'psr6', adapter: 'CacheItemPoolInterface', issues });
    }

    if (usesSymfony && !usesPsr16 && !usesPsr6) {
      const confusedWithPsr16 = content.includes('->get(') && !content.includes('function(') && !content.includes('fn(');
      if (confusedWithPsr16) {
        issues.push('Symfony\\Contracts\\Cache\\CacheInterface->get() requires a callable second argument — different from PSR-16 SimpleCache->get()');
      }
      results.push({ file: relFile, interface: 'symfony', adapter: 'Symfony\\Contracts\\Cache\\CacheInterface', issues });
    }
  }

  return results;
}

export function listSymfonyCachePsr16(appPath: string): McpToolResult {
  try {
    const infos = buildCachePsr16Infos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PSR-6/PSR-16 cache interface usage found in src/.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cache PSR-6/PSR-16 Interface Analysis\n${'='.repeat(55)}\n\nUsages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.interface.toUpperCase()}] ${info.adapter}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCachePsr16Stats(appPath: string): McpToolResult {
  try {
    const infos = buildCachePsr16Infos(appPath);
    let text = `Cache PSR Statistics\n${'='.repeat(40)}\n\n`;
    text += `PSR-6:          ${infos.filter((i) => i.interface === 'psr6').length}\n`;
    text += `PSR-16:         ${infos.filter((i) => i.interface === 'psr16').length}\n`;
    text += `Mixed:          ${infos.filter((i) => i.interface === 'mixed').length}\n`;
    text += `Symfony Cache:  ${infos.filter((i) => i.interface === 'symfony').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCachePsr16Tools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_cache_psr16', description: 'Analyze PSR-6 vs PSR-16 cache interface usage; warns on PSR-16 with tags (unsupported), mixed PSR-6/PSR-16, getItem without isHit check, Symfony CacheInterface confused with PSR-16', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_cache_psr16_stats', description: 'Statistics for cache interface: PSR-6/PSR-16/mixed/Symfony usage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
