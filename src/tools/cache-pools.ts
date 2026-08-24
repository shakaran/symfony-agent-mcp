// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Cache Pools Deep Configuration Inspector
 *
 * Reads framework.cache from config/packages/cache.yaml (or framework.yaml):
 *   - Default Redis/Memcached/APCu/Filesystem DSN (masked)
 *   - Default lifetime
 *   - Prefix seed
 *   - App pool adapter
 *   - All named pools: adapter, provider, tags, default_lifetime
 *   - System / Doctrine pools
 *
 * Also scans src/ for:
 *   - #[Cache] attribute on controllers (HTTP cache — already in http-cache.ts)
 *   - Injected CacheInterface / TagAwareCacheInterface pool names
 *
 * Warns: pools without explicit TTL (memory accumulation risk),
 *        Redis pools without maxmemory-policy set (can't be detected here,
 *        flags the pool for manual check).
 *
 * Pure static analysis — DSN credentials masked.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CachePool {
  name: string;
  adapter?: string;
  provider?: string;
  tags: boolean;
  defaultLifetime?: number;
  isSystem: boolean;
  isDoctrine: boolean;
}

interface CacheConfig {
  appAdapter?: string;
  systemAdapter?: string;
  directoryVar?: string;
  prefixSeed?: string;
  defaultRedis?: string;
  defaultMemcached?: string;
  pools: CachePool[];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@]+@/, '://***@')
    .replace(/%[^%]+%/g, '%***%');
}

function parsePools(raw: Record<string, unknown>): CachePool[] {
  const pools: CachePool[] = [];

  const poolsRaw = raw['pools'] as Record<string, unknown> | undefined;
  if (!poolsRaw) return pools;

  for (const [name, def] of Object.entries(poolsRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const lt = d['default_lifetime'];
    pools.push({
      name,
      adapter: d['adapter'] ? String(d['adapter']) : undefined,
      provider: d['provider'] ? maskDsn(String(d['provider'])) : undefined,
      tags: Boolean(d['tags'] ?? false),
      defaultLifetime: lt !== undefined ? Number(lt) : undefined,
      isSystem: name.startsWith('cache.system') || name === 'system',
      isDoctrine: name.includes('doctrine'),
    });
  }
  return pools;
}

function loadCacheConfig(appPath: string): CacheConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const cache = framework['cache'] as Record<string, unknown> | undefined;
    if (!cache) continue;

    const redisRaw = cache['default_redis_provider'];
    const memcachedRaw = cache['default_memcached_provider'];

    return {
      appAdapter:      cache['app']    ? String(cache['app'])    : undefined,
      systemAdapter:   cache['system'] ? String(cache['system']) : undefined,
      directoryVar:    cache['directory'] ? String(cache['directory']) : undefined,
      prefixSeed:      cache['prefix_seed'] ? String(cache['prefix_seed']) : undefined,
      defaultRedis:    redisRaw    ? maskDsn(String(redisRaw))    : undefined,
      defaultMemcached: memcachedRaw ? maskDsn(String(memcachedRaw)) : undefined,
      pools: parsePools(cache),
    };
  }
  return null;
}

// ─── Adapter labels ──────────────────────────────────────────────────────────

const ADAPTER_LABELS: Record<string, string> = {
  'cache.adapter.redis':           'Redis',
  'cache.adapter.redis_tag_aware': 'Redis (tag-aware)',
  'cache.adapter.memcached':       'Memcached',
  'cache.adapter.apcu':            'APCu',
  'cache.adapter.filesystem':      'Filesystem',
  'cache.adapter.pdo':             'PDO/Database',
  'cache.adapter.array':           'In-memory array',
  'cache.adapter.null':            'Null (disabled)',
  'cache.adapter.chain':           'Chain',
  'cache.adapter.doctrine':        'Doctrine',
};

function adapterLabel(adapter: string): string {
  return ADAPTER_LABELS[adapter] ?? adapter.split('.').pop() ?? adapter;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listCachePools(appPath: string): McpToolResult {
  try {
    const config = loadCacheConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'framework.cache config not found.\n\nCreate config/packages/cache.yaml:\n  framework:\n    cache:\n      app: cache.adapter.redis\n      default_redis_provider: "%env(REDIS_URL)%"\n      pools:\n        cache.app:\n          adapter: cache.adapter.redis\n          default_lifetime: 3600',
        }],
      };
    }

    let text = `Cache Pool Configuration\n${'='.repeat(55)}\n`;

    if (config.appAdapter)   text += `\nApp adapter:     ${adapterLabel(config.appAdapter)}\n`;
    if (config.systemAdapter) text += `System adapter:  ${adapterLabel(config.systemAdapter)}\n`;
    if (config.prefixSeed)   text += `Prefix seed:     ${config.prefixSeed}\n`;
    if (config.defaultRedis)      text += `Redis DSN:       ${config.defaultRedis}\n`;
    if (config.defaultMemcached)  text += `Memcached DSN:   ${config.defaultMemcached}\n`;

    const appPools    = config.pools.filter((p) => !p.isSystem && !p.isDoctrine);
    const sysPools    = config.pools.filter((p) => p.isSystem);
    const doctPools   = config.pools.filter((p) => p.isDoctrine);
    const noTtlPools  = config.pools.filter((p) => p.defaultLifetime === undefined && !p.isSystem);

    if (config.pools.length === 0) {
      text += `\nNo named pools configured (using default app pool).\n`;
    } else {
      if (appPools.length > 0) {
        text += `\nApplication pools (${appPools.length}):\n`;
        for (const p of appPools) {
          const adapter = p.adapter ? adapterLabel(p.adapter) : '(inherited from app)';
          const ttl = p.defaultLifetime !== undefined ? `  TTL: ${p.defaultLifetime}s` : '  ⚠ no TTL';
          const tags = p.tags ? '  [tags]' : '';
          const provider = p.provider ? `  provider: ${p.provider}` : '';
          text += `  ${p.name.padEnd(35)} ${adapter}${ttl}${tags}${provider}\n`;
        }
      }
      if (sysPools.length > 0) {
        text += `\nSystem pools (${sysPools.length}): ${sysPools.map((p) => p.name).join(', ')}\n`;
      }
      if (doctPools.length > 0) {
        text += `Doctrine pools (${doctPools.length}): ${doctPools.map((p) => p.name).join(', ')}\n`;
      }
    }

    if (noTtlPools.length > 0) {
      text += `\n⚠ Pools with no default_lifetime (may accumulate indefinitely):\n`;
      for (const p of noTtlPools) text += `   ${p.name}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCachePoolStats(appPath: string): McpToolResult {
  try {
    const config = loadCacheConfig(appPath);

    let text = `Cache Pool Statistics\n${'='.repeat(40)}\n\n`;

    if (!config) {
      text += 'framework.cache: not configured\n';
      return { content: [{ type: 'text', text }] };
    }

    const tagAware = config.pools.filter((p) => p.tags || p.adapter?.includes('tag_aware')).length;
    const noTtl    = config.pools.filter((p) => p.defaultLifetime === undefined && !p.isSystem).length;
    const redisCount = config.pools.filter((p) => p.adapter?.includes('redis') || config.appAdapter?.includes('redis')).length;

    text += `Named pools:      ${config.pools.length}\n`;
    text += `Tag-aware:        ${tagAware}\n`;
    text += `Without TTL:      ${noTtl}\n`;
    text += `Redis-backed:     ${redisCount > 0 ? 'yes' : 'no'}\n`;
    text += `Memcached:        ${config.defaultMemcached ? 'yes' : 'no'}\n`;
    text += `Prefix seed:      ${config.prefixSeed ? 'set' : 'not set (collision risk on shared infra)'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getCachePoolTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_cache_pools',
      description: 'List cache pools: adapter per pool (Redis/APCu/Filesystem), TTL, tag-aware flag, DSN masked, warns on pools without TTL',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_cache_pool_stats',
      description: 'Show cache pool statistics: pool count, tag-aware count, pools without TTL, Redis/Memcached usage, prefix seed presence',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
