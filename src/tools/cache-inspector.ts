// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Cache Inspector Tool
 *
 * Provides two layers of cache inspection:
 *
 * 1. Symfony application cache (var/cache/):
 *    - Lists cache pools and their sizes
 *    - Shows cache configuration from config/packages/cache.yaml
 *    - Detects APCu, Redis, Memcached, Filesystem pools
 *
 * 2. MCP server's own in-process cache (cache-manager):
 *    - Hits, misses, hit rate
 *    - Entries per namespace
 *    - TTL and max-size settings
 *
 * All operations are read-only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { cacheManager } from '../utils/cache-manager.js';
import { McpToolResult } from '../server.js';

interface CachePool {
  name: string;
  adapter: string;
  namespace?: string;
  path?: string;
  sizeBytes?: number;
  fileCount?: number;
  dsn?: string;
}

interface SymfonyCacheInfo {
  appEnv: string;
  varCachePath: string;
  exists: boolean;
  totalSizeBytes: number;
  pools: CachePool[];
}

// ─── Symfony cache reading ─────────────────────────────────────────────────

function parseCacheConfig(appPath: string): Record<string, unknown> | null {
  const configPaths = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'dev', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'prod', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'cache.yml'),
  ];

  for (const configPath of configPaths) {
    const config = parseYamlFile(configPath) as Record<string, unknown> | null;
    if (config) return config;
  }
  return null;
}

function getDirectorySize(dirPath: string): { sizeBytes: number; fileCount: number } {
  let sizeBytes = 0;
  let fileCount = 0;

  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const sub = getDirectorySize(full);
        sizeBytes += sub.sizeBytes;
        fileCount += sub.fileCount;
      } else {
        try {
          sizeBytes += fs.statSync(full).size;
          fileCount++;
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return { sizeBytes, fileCount };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function scanSymfonyCachePools(varCachePath: string): CachePool[] {
  const pools: CachePool[] = [];

  if (!fs.existsSync(varCachePath)) return pools;

  try {
    for (const env of fs.readdirSync(varCachePath, { withFileTypes: true })) {
      if (!env.isDirectory()) continue;
      const envPath = path.join(varCachePath, env.name);

      const { sizeBytes, fileCount } = getDirectorySize(envPath);

      // Look for pools subdirectory
      const poolsDir = path.join(envPath, 'pools');
      if (fs.existsSync(poolsDir)) {
        try {
          for (const poolEntry of fs.readdirSync(poolsDir, { withFileTypes: true })) {
            if (!poolEntry.isDirectory()) continue;
            const poolPath = path.join(poolsDir, poolEntry.name);
            const poolSize = getDirectorySize(poolPath);
            pools.push({
              name: `${env.name}/${poolEntry.name}`,
              adapter: 'filesystem',
              path: poolPath,
              sizeBytes: poolSize.sizeBytes,
              fileCount: poolSize.fileCount,
            });
          }
        } catch {
          // Skip
        }
      } else {
        // Whole env dir as a single pool
        pools.push({
          name: env.name,
          adapter: 'filesystem',
          path: envPath,
          sizeBytes,
          fileCount,
        });
      }
    }
  } catch {
    // Skip
  }

  return pools;
}

function parseConfiguredPools(config: Record<string, unknown>): CachePool[] {
  const pools: CachePool[] = [];

  const framework = config['framework'] as Record<string, unknown> | undefined;
  const cacheSection = (framework?.['cache'] ?? config['cache']) as Record<string, unknown> | undefined;
  if (!cacheSection) return pools;

  const poolsConfig = cacheSection['pools'] as Record<string, unknown> | undefined;
  if (!poolsConfig) return pools;

  for (const [name, poolDef] of Object.entries(poolsConfig)) {
    if (!poolDef || typeof poolDef !== 'object') continue;
    const def = poolDef as Record<string, unknown>;

    const adapter = String(def['adapter'] ?? def['app'] ?? 'cache.adapter.filesystem');
    const adapterShort = adapter.replace(/^cache\.adapter\./, '').replace(/^Symfony\\/, '');

    pools.push({
      name,
      adapter: adapterShort,
      namespace: def['namespace'] as string | undefined,
      dsn: def['provider'] as string | undefined,
    });
  }

  // Also add the default pools
  const defaultAdapter = String(
    (cacheSection['app'] as string) ?? 'cache.adapter.filesystem'
  ).replace(/^cache\.adapter\./, '');

  if (!pools.find((p) => p.name === 'app')) {
    pools.unshift({ name: 'app', adapter: defaultAdapter });
  }

  return pools;
}

function getSymfonyCacheInfo(appPath: string): SymfonyCacheInfo {
  const varCachePath = path.join(appPath, 'var', 'cache');
  const exists = fs.existsSync(varCachePath);

  const config = parseCacheConfig(appPath);
  const configuredPools = config ? parseConfiguredPools(config) : [];
  const diskPools = scanSymfonyCachePools(varCachePath);

  // Merge config pools with disk data
  const mergedPools = configuredPools.map((cp) => {
    const diskPool = diskPools.find((dp) => dp.name.includes(cp.name));
    return diskPool ? { ...cp, sizeBytes: diskPool.sizeBytes, fileCount: diskPool.fileCount, path: diskPool.path } : cp;
  });

  // Add disk pools not in config
  for (const dp of diskPools) {
    if (!mergedPools.find((mp) => mp.name === dp.name)) {
      mergedPools.push(dp);
    }
  }

  const totalSizeBytes = diskPools.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0);

  // Detect APCu / Redis from environment
  const env = process.env;
  if (env['REDIS_URL'] || env['REDIS_DSN']) {
    mergedPools.push({ name: 'redis (detected via env)', adapter: 'redis', dsn: '[via REDIS_URL env var]' });
  }
  if (env['MEMCACHE_URL'] || env['MEMCACHED_DSN']) {
    mergedPools.push({ name: 'memcached (detected via env)', adapter: 'memcached', dsn: '[via MEMCACHED_DSN env var]' });
  }

  return {
    appEnv: process.env['APP_ENV'] ?? 'unknown',
    varCachePath,
    exists,
    totalSizeBytes,
    pools: mergedPools.length > 0 ? mergedPools : diskPools,
  };
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function inspectSymfonyCache(appPath: string): McpToolResult {
  try {
    const info = getSymfonyCacheInfo(appPath);

    let text = `Symfony Cache Inspector\n${'='.repeat(50)}\n\n`;
    text += `Cache directory: ${info.varCachePath}\n`;
    text += `Status:          ${info.exists ? 'exists' : 'not found'}\n`;
    text += `Total disk size: ${formatBytes(info.totalSizeBytes)}\n`;

    if (!info.exists) {
      text += `\nCache directory does not exist. Run: php bin/console cache:warmup`;
      return { content: [{ type: 'text', text }] };
    }

    if (info.pools.length > 0) {
      text += `\nCache Pools (${info.pools.length}):\n${'─'.repeat(60)}\n`;
      for (const pool of info.pools) {
        text += `\n  ${pool.name}\n`;
        text += `    Adapter: ${pool.adapter}\n`;
        if (pool.sizeBytes !== undefined) text += `    Size:    ${formatBytes(pool.sizeBytes)} (${pool.fileCount ?? 0} files)\n`;
        if (pool.dsn) text += `    DSN:     ${pool.dsn}\n`;
        if (pool.namespace) text += `    NS:      ${pool.namespace}\n`;
      }
    }

    text += `\nClear commands:\n`;
    text += `  All:          php bin/console cache:clear\n`;
    text += `  Pool only:    php bin/console cache:pool:clear <pool_name>\n`;
    text += `  Warmup:       php bin/console cache:warmup\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error inspecting Symfony cache: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function inspectMcpCache(): McpToolResult {
  try {
    const stats = cacheManager.getStats();

    let text = `MCP Server Cache Statistics\n${'='.repeat(50)}\n\n`;
    text += `Status:       ${stats.enabled ? 'enabled' : 'disabled (SYMFONY_MCP_CACHE=false)'}\n`;
    text += `TTL:          ${(stats.ttlMs / 1000).toFixed(0)}s (SYMFONY_MCP_CACHE_TTL_MS)\n`;
    text += `Max size:     ${stats.maxSize} entries/namespace (SYMFONY_MCP_CACHE_MAX_SIZE)\n`;
    text += `Total entries: ${stats.totalEntries}\n\n`;

    text += `Performance:\n`;
    text += `  Hits:     ${stats.hits}\n`;
    text += `  Misses:   ${stats.misses}\n`;
    text += `  Hit rate: ${stats.hitRate}%\n`;
    text += `  Evictions: ${stats.evictions}\n`;

    if (Object.keys(stats.namespaces).length > 0) {
      text += `\nNamespaces:\n`;
      for (const [ns, count] of Object.entries(stats.namespaces)) {
        text += `  ${ns.padEnd(20)} ${count} entries\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading MCP cache stats: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function clearMcpCache(): McpToolResult {
  try {
    const before = cacheManager.getStats().totalEntries;
    cacheManager.clear();
    return {
      content: [{
        type: 'text',
        text: `MCP server cache cleared. Removed ${before} entries across all namespaces.`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error clearing MCP cache: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheConfig(appPath: string): McpToolResult {
  try {
    const config = parseCacheConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'Cache configuration not found in config/packages/cache.yaml.\n\nDefault Symfony cache uses filesystem adapter (var/cache/).',
        }],
      };
    }

    const framework = config['framework'] as Record<string, unknown> | undefined;
    const cacheSection = (framework?.['cache'] ?? config['cache']) as Record<string, unknown> | undefined;

    if (!cacheSection) {
      return {
        content: [{ type: 'text', text: 'No cache section found in the configuration.' }],
      };
    }

    let text = `Cache Configuration\n${'='.repeat(40)}\n\n`;

    const app = cacheSection['app'] as string | undefined;
    const system = cacheSection['system'] as string | undefined;
    const directory = cacheSection['directory'] as string | undefined;
    const defaultLifetime = cacheSection['default_lifetime'] as number | undefined;

    if (app) text += `App adapter:    ${app}\n`;
    if (system) text += `System adapter: ${system}\n`;
    if (directory) text += `Directory:      ${directory}\n`;
    if (defaultLifetime) text += `Default TTL:    ${defaultLifetime}s\n`;

    const pools = cacheSection['pools'] as Record<string, unknown> | undefined;
    if (pools && Object.keys(pools).length > 0) {
      text += `\nConfigured pools:\n`;
      for (const [name, def] of Object.entries(pools)) {
        const d = def as Record<string, unknown>;
        const adapter = String(d['adapter'] ?? 'default').replace('cache.adapter.', '');
        text += `  ${name} → ${adapter}`;
        if (d['tags']) text += ' (tagged)';
        text += '\n';
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading cache config: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getCacheInspectorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'inspect_symfony_cache',
      description: 'Inspect Symfony application cache pools in var/cache/ — lists pools with disk size, file count, and adapter type',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_cache_config',
      description: 'Read Symfony cache configuration from config/packages/cache.yaml — shows app/system adapters and configured pools',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'inspect_mcp_cache',
      description: 'Show MCP server internal cache statistics: hit rate, entries per namespace, TTL, and evictions',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'clear_mcp_cache',
      description: 'Clear the MCP server internal cache — forces fresh file reads on next tool calls',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];
}
