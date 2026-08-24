// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Cache Stampede Inspector
 *
 * Reads framework.yaml cache pools for early_expiration_handler or beta config.
 * Scans src/ PHP for:
 *   - CacheItem::tag(), CacheItem::expiresAfter(), CacheInterface::get() with callback
 *   - PSR-6 vs PSR-16 patterns
 *
 * Warns about:
 *   - Cache pool without stampede protection (no early_expiration_handler)
 *   - CacheItem with very short TTL in high-traffic code (high miss rate)
 *   - cache->get() with long computation in callback (cold cache stampede)
 *   - No stampede protection on shared cache pools
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface CacheStampedeInfo {
  poolName: string;
  hasEarlyExpiration: boolean;
  betaFactor?: number;
  shortTtlUsages: number;
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

interface PoolInfo {
  name: string;
  hasEarlyExpiration: boolean;
  betaFactor?: number;
}

function loadCachePools(appPath: string): PoolInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
  ];

  const pools: PoolInfo[] = [];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const cache = (framework['cache'] ?? {}) as Record<string, unknown>;
    const poolsRaw = (cache['pools'] ?? {}) as Record<string, unknown>;

    for (const [name, poolData] of Object.entries(poolsRaw)) {
      const pool = (poolData ?? {}) as Record<string, unknown>;
      const hasEarlyExpiration =
        pool['early_expiration_handler'] !== undefined ||
        (pool['default_lifetime'] !== undefined && pool['provider'] !== undefined);
      const betaRaw = pool['beta'] as number | string | undefined;
      const betaFactor = betaRaw !== undefined ? parseFloat(String(betaRaw)) : undefined;
      pools.push({ name, hasEarlyExpiration: hasEarlyExpiration || betaFactor !== undefined, betaFactor });
    }
  }

  return pools;
}

interface PhpCacheUsage {
  file: string;
  hasGetWithCallback: boolean;
  hasShortTtl: boolean;
  shortTtlCount: number;
  usedPools: string[];
}

function scanPhpCacheUsage(appPath: string, poolNames: string[]): PhpCacheUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpCacheUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (
      !content.includes('CacheInterface') &&
      !content.includes('CacheItemPool') &&
      !content.includes('->get(') &&
      !content.includes('expiresAfter') &&
      !content.includes('CacheItem')
    ) continue;

    const hasGetWithCallback = /->get\s*\([^)]{0,200}function\s*\(/.test(content);

    // Short TTL: expiresAfter with value <= 30s
    const ttlMatches = content.matchAll(/expiresAfter\s*\(\s*(\d{1,5})\s*\)/g);
    let shortTtlCount = 0;
    for (const m of ttlMatches) {
      if (parseInt(m[1], 10) <= 30) shortTtlCount++;
    }

    const usedPools = poolNames.filter((p) => content.includes(p));

    if (hasGetWithCallback || shortTtlCount > 0 || usedPools.length > 0) {
      results.push({ file, hasGetWithCallback, hasShortTtl: shortTtlCount > 0, shortTtlCount, usedPools });
    }
  }

  return results;
}

function buildStampedeInfos(appPath: string): CacheStampedeInfo[] {
  const pools = loadCachePools(appPath);
  const poolNames = pools.map((p) => p.name);
  const usages = scanPhpCacheUsage(appPath, poolNames);

  // Count short TTL usages per pool
  const shortTtlByPool: Record<string, number> = {};
  for (const usage of usages) {
    for (const p of usage.usedPools) {
      shortTtlByPool[p] = (shortTtlByPool[p] ?? 0) + (usage.shortTtlCount > 0 ? usage.shortTtlCount : 0);
    }
  }

  const results: CacheStampedeInfo[] = pools.map((pool) => {
    const shortTtlUsages = shortTtlByPool[pool.name] ?? 0;
    const issues: string[] = [];

    if (!pool.hasEarlyExpiration) {
      issues.push(`Cache pool "${pool.name}" has no stampede protection (no early_expiration_handler or beta factor)`);
    }
    if (shortTtlUsages > 0 && !pool.hasEarlyExpiration) {
      issues.push(`Pool "${pool.name}" has ${shortTtlUsages} short-TTL usage(s) without stampede protection — high miss rate under load`);
    }

    return {
      poolName: pool.name,
      hasEarlyExpiration: pool.hasEarlyExpiration,
      betaFactor: pool.betaFactor,
      shortTtlUsages,
      issues,
    };
  });

  // Add issues for files using get() with callback on unprotected pools
  const callbackUsages = usages.filter((u) => u.hasGetWithCallback);
  if (callbackUsages.length > 0) {
    const unprotected = pools.filter((p) => !p.hasEarlyExpiration);
    if (unprotected.length > 0 && results.length > 0) {
      results[0].issues.push(
        `${callbackUsages.length} cache->get() callback(s) found; ${unprotected.length} pool(s) lack stampede protection — cold cache stampede risk`
      );
    }
  }

  if (results.length === 0) {
    // Return a global summary if no pools found
    const hasCallbacks = usages.some((u) => u.hasGetWithCallback);
    const hasShortTtl = usages.some((u) => u.hasShortTtl);
    const globalIssues: string[] = [];
    if (hasCallbacks) globalIssues.push('cache->get() with callback found but no cache pools configured in framework.yaml');
    if (hasShortTtl) globalIssues.push('Short TTL cache usages found but no pools to assess stampede protection');
    if (globalIssues.length > 0) {
      results.push({ poolName: '(no pools)', hasEarlyExpiration: false, shortTtlUsages: 0, issues: globalIssues });
    }
  }

  return results;
}

export function listCacheStampede(appPath: string): McpToolResult {
  try {
    const infos = buildStampedeInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No cache pools found in framework.yaml and no cache usage detected in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cache Stampede Protection\n${'='.repeat(55)}\n\n`;
    text += `Cache pools: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.poolName}\n`;
      text += `    earlyExpiration: ${info.hasEarlyExpiration ? 'yes' : 'no'}`;
      if (info.betaFactor !== undefined) text += `  beta: ${info.betaFactor}`;
      text += `\n`;
      if (info.shortTtlUsages > 0) text += `    shortTtlUsages: ${info.shortTtlUsages}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheStampedeStats(appPath: string): McpToolResult {
  try {
    const infos = buildStampedeInfos(appPath);

    let text = `Cache Stampede Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total pools:                   ${infos.length}\n`;
    text += `  With early expiration:       ${infos.filter((i) => i.hasEarlyExpiration).length}\n`;
    text += `  With beta factor:            ${infos.filter((i) => i.betaFactor !== undefined).length}\n`;
    text += `  With short TTL usages:       ${infos.filter((i) => i.shortTtlUsages > 0).length}\n`;
    text += `  Without protection:          ${infos.filter((i) => !i.hasEarlyExpiration).length}\n`;
    text += `Total issues:                  ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheStampedeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cache_stampede',
      description: 'Inspect cache pools for stampede protection: early_expiration_handler/beta config in framework.yaml, short-TTL usages in src/, cache->get() callbacks; warns on unprotected pools serving high-traffic data',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cache_stampede_stats',
      description: 'Statistics for cache stampede protection: pool count, early-expiration coverage, beta-factor count, short-TTL usage count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
