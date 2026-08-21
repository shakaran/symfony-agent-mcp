/**
 * Doctrine Query Cache Configuration Inspector
 *
 * Distinct from cache-pools.ts (Symfony cache pool config), cache-inspector.ts (runtime cache),
 * and doctrine-result-cache.ts (PHP code scanning for ->enableResultCache()).
 * Focuses solely on doctrine.yaml ORM cache driver configuration:
 *
 * - Reads doctrine.yaml: query_cache_driver, metadata_cache_driver, result_cache_driver
 * - Detects each cache driver type (array, apcu, redis, memcached, filesystem, pool)
 * - Checks for per-request-only (array) cache usage
 *
 * Warnings:
 *   - query_cache_driver: array (AST parsed every request)
 *   - metadata_cache_driver: array (class metadata reflected every request)
 *   - Different drivers for query vs metadata (inconsistency)
 *   - result_cache_driver not configured (results not cached)
 *   - Same Redis DSN for query and result cache without key prefix (key collision risk)
 *
 * Pure static analysis — reads doctrine.yaml only.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface DoctrineQueryCacheInfo {
  queryCacheDriver: string;
  metadataCacheDriver: string;
  resultCacheDriver?: string;
  issues: string[];
}

type CacheDriverConfig = Record<string, unknown>;

function extractDriverType(driverRaw: unknown): string {
  if (!driverRaw) return 'none';
  if (typeof driverRaw === 'string') return driverRaw;
  if (typeof driverRaw === 'object') {
    const d = driverRaw as CacheDriverConfig;
    if (d['type']) return String(d['type']);
    if (d['id']) return `service:${d['id']}`;
    if (d['pool']) return `pool:${d['pool']}`;
    if (d['cache_provider']) return `provider:${d['cache_provider']}`;
  }
  return 'unknown';
}

function extractDsn(driverRaw: unknown): string | undefined {
  if (!driverRaw || typeof driverRaw !== 'object') return undefined;
  const d = driverRaw as CacheDriverConfig;
  if (typeof d['dsn'] === 'string') return d['dsn'];
  return undefined;
}

function loadDoctrineQueryCacheConfig(appPath: string): DoctrineQueryCacheInfo | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine.yml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const doctrineRaw = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const ormRaw = (doctrineRaw['orm'] ?? {}) as Record<string, unknown>;

    const queryCacheRaw = ormRaw['query_cache_driver'] ?? ormRaw['query_cache'];
    const metaCacheRaw = ormRaw['metadata_cache_driver'] ?? ormRaw['metadata_cache'];
    const resultCacheRaw = ormRaw['result_cache_driver'] ?? ormRaw['result_cache'];

    const queryCacheDriver = extractDriverType(queryCacheRaw);
    const metadataCacheDriver = extractDriverType(metaCacheRaw);
    const resultCacheDriver = resultCacheRaw ? extractDriverType(resultCacheRaw) : undefined;

    const queryDsn = extractDsn(queryCacheRaw);
    const resultDsn = extractDsn(resultCacheRaw);

    const issues: string[] = [];

    if (queryCacheDriver === 'array' || queryCacheDriver === 'none') {
      issues.push('query_cache_driver: array — DQL AST re-parsed on every request; use apcu/redis for cross-request benefit');
    }

    if (metadataCacheDriver === 'array' || metadataCacheDriver === 'none') {
      issues.push('metadata_cache_driver: array — entity class metadata reflected on every request; use apcu/redis');
    }

    if (queryCacheDriver !== 'none' && metadataCacheDriver !== 'none' &&
      queryCacheDriver !== metadataCacheDriver &&
      !queryCacheDriver.startsWith('pool:') && !metadataCacheDriver.startsWith('pool:')) {
      issues.push(`query_cache (${queryCacheDriver}) and metadata_cache (${metadataCacheDriver}) use different drivers — inconsistent caching strategy`);
    }

    if (!resultCacheDriver) {
      issues.push('result_cache_driver not configured — query results not cached; add for read-heavy endpoints');
    }

    if (queryDsn && resultDsn && queryDsn === resultDsn) {
      issues.push(`query_cache and result_cache use same Redis DSN without key prefix — risk of key collisions`);
    }

    return { queryCacheDriver, metadataCacheDriver, resultCacheDriver, issues };
  }

  return null;
}

export function listDoctrineQueryCache(appPath: string): McpToolResult {
  try {
    const config = loadDoctrineQueryCacheConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'No doctrine.yaml found or no ORM cache configuration detected.\n\nAdd cache configuration in config/packages/doctrine.yaml:\n  doctrine:\n    orm:\n      query_cache_driver:\n        type: pool\n        pool: doctrine.system_cache_pool\n      metadata_cache_driver:\n        type: pool\n        pool: doctrine.system_cache_pool',
        }],
      };
    }

    let text = `Doctrine Query Cache Configuration\n${'='.repeat(55)}\n`;
    text += `\n`;
    text += `query_cache_driver:    ${config.queryCacheDriver}\n`;
    text += `metadata_cache_driver: ${config.metadataCacheDriver}\n`;
    text += `result_cache_driver:   ${config.resultCacheDriver ?? 'not configured'}\n`;

    if (config.issues.length === 0) {
      text += `\nNo cache configuration issues detected.\n`;
    } else {
      text += `\nIssues (${config.issues.length}):\n`;
      for (const issue of config.issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineQueryCacheStats(appPath: string): McpToolResult {
  try {
    const config = loadDoctrineQueryCacheConfig(appPath);

    let text = `Doctrine Query Cache Statistics\n${'='.repeat(40)}\n\n`;

    if (!config) {
      text += `Configuration:   not found\n`;
      text += `Issues:          1 (doctrine.yaml missing)\n`;
      return { content: [{ type: 'text', text }] };
    }

    text += `Query cache:      ${config.queryCacheDriver}\n`;
    text += `Metadata cache:   ${config.metadataCacheDriver}\n`;
    text += `Result cache:     ${config.resultCacheDriver ?? 'none'}\n`;
    text += `Uses array cache: ${(config.queryCacheDriver === 'array' || config.metadataCacheDriver === 'array') ? 'yes' : 'no'}\n`;
    text += `Issues:           ${config.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineQueryCacheTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_query_cache',
      description: "Show Doctrine ORM cache driver configuration from doctrine.yaml: query_cache_driver, metadata_cache_driver, result_cache_driver types (array/apcu/redis/pool); warns on array drivers (per-request only), inconsistent drivers, missing result cache, same Redis DSN without key prefix",
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_query_cache_stats',
      description: 'Show Doctrine query cache statistics: driver types for query/metadata/result cache, whether array cache is used, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
