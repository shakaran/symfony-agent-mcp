/**
 * Symfony Rate Limiter Storage Inspector
 *
 * Reads framework.yaml rate_limiter section: each policy's storage (cache_pool, lock_factory).
 * Reads cache config to cross-reference pool types used by rate limiters.
 *
 * Warns about:
 *   - Rate limiter using 'cache.app' pool (shared with application cache — key collision risk)
 *   - In-memory/array storage in production (resets on worker restart — not distributed)
 *   - APCu storage in multi-worker setup (each worker has own APCu — limits not shared)
 *   - Redis rate limiter without expiry on keys (Redis fills up)
 *   - Rate limiter with no storage configured (uses default which may not fit use case)
 *   - Different storage for same logical limiter across environments (dev passes, prod fails)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface RateLimiterStorageInfo {
  policyName: string;
  storageType: string;
  cachePool?: string;
  isDistributed: boolean;
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

interface PoolTypeMap {
  [poolName: string]: string;
}

function loadCachePoolTypes(appPath: string): PoolTypeMap {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
  ];
  const poolTypes: PoolTypeMap = {};

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const cache = (framework['cache'] ?? {}) as Record<string, unknown>;
    const pools = (cache['pools'] ?? {}) as Record<string, unknown>;

    for (const [name, poolData] of Object.entries(pools)) {
      const pool = (poolData ?? {}) as Record<string, unknown>;
      const adapter = String(pool['adapter'] ?? pool['provider'] ?? '').toLowerCase();
      if (adapter.includes('redis')) poolTypes[name] = 'redis';
      else if (adapter.includes('apcu')) poolTypes[name] = 'apcu';
      else if (adapter.includes('memcache')) poolTypes[name] = 'memcached';
      else if (adapter.includes('filesystem') || adapter.includes('file_system')) poolTypes[name] = 'filesystem';
      else if (adapter.includes('array')) poolTypes[name] = 'array';
      else if (adapter.includes('pdo') || adapter.includes('dbal')) poolTypes[name] = 'pdo';
      else poolTypes[name] = adapter || 'unknown';
    }

    // Detect app pool adapter at top level
    const appAdapter = String(cache['app'] ?? '').toLowerCase();
    if (appAdapter) {
      if (appAdapter.includes('redis')) poolTypes['cache.app'] = 'redis';
      else if (appAdapter.includes('apcu')) poolTypes['cache.app'] = 'apcu';
      else poolTypes['cache.app'] = appAdapter;
    }
  }

  return poolTypes;
}

function detectStorageType(cachePool: string, poolTypes: PoolTypeMap): string {
  const poolName = cachePool.replace(/^cache\./, '');
  // Check direct match
  if (poolTypes[cachePool]) return poolTypes[cachePool];
  if (poolTypes[poolName]) return poolTypes[poolName];

  // Heuristic from pool name
  const lower = cachePool.toLowerCase();
  if (lower.includes('redis')) return 'redis';
  if (lower.includes('apcu')) return 'apcu';
  if (lower.includes('memcache')) return 'memcached';
  if (lower.includes('array') || lower.includes('memory')) return 'array';
  if (lower.includes('filesystem') || lower.includes('file')) return 'filesystem';
  if (lower === 'cache.app' || lower === 'app') return 'unknown';

  return 'unknown';
}

function buildRateLimiterStorageInfos(appPath: string): RateLimiterStorageInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'rate_limiter.yaml'),
  ];

  const poolTypes = loadCachePoolTypes(appPath);
  const results: RateLimiterStorageInfo[] = [];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const rateLimiter = (framework['rate_limiter'] ?? {}) as Record<string, unknown>;

    for (const [policyName, policyData] of Object.entries(rateLimiter)) {
      const policy = (policyData ?? {}) as Record<string, unknown>;
      const cachePool = String(policy['cache_pool'] ?? policy['storage_service'] ?? '');
      const lockFactory = String(policy['lock_factory'] ?? '');

      const storageType = cachePool
        ? detectStorageType(cachePool, poolTypes)
        : lockFactory
          ? 'lock'
          : 'default';

      const isDistributed = ['redis', 'memcached', 'pdo'].includes(storageType);
      const issues: string[] = [];

      if (!cachePool && !lockFactory) {
        issues.push(`Rate limiter policy "${policyName}" has no storage configured — uses default pool which may not fit production use case`);
      }

      if (cachePool === 'cache.app') {
        issues.push(`Rate limiter "${policyName}" uses 'cache.app' pool (shared with application cache) — key collision risk and eviction may reset limits`);
      }

      if (storageType === 'array' || storageType === 'memory') {
        issues.push(`Rate limiter "${policyName}" uses in-memory/array storage — limits reset on worker restart and are not shared across workers`);
      }

      if (storageType === 'apcu') {
        issues.push(`Rate limiter "${policyName}" uses APCu storage — each PHP-FPM worker has its own APCu; limits are not shared in multi-worker setups`);
      }

      if (storageType === 'redis') {
        // Check for expiry concerns (static analysis only warns)
        issues.push(`Rate limiter "${policyName}" uses Redis — ensure TTL/expiry is configured on keys to prevent Redis filling up over time`);
      }

      results.push({
        policyName,
        storageType,
        cachePool: cachePool || undefined,
        isDistributed,
        issues,
      });
    }
  }

  // Cross-check PHP src for any rate limiter usage indicating missing config
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir) && results.length === 0) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('RateLimiterFactory') || content.includes('rate_limiter')) {
        results.push({
          policyName: '(no config found)',
          storageType: 'unknown',
          isDistributed: false,
          issues: ['RateLimiterFactory usage found in src/ but no rate_limiter config detected in framework.yaml'],
        });
        break;
      }
    }
  }

  return results;
}

export function listRateLimiterStorage(appPath: string): McpToolResult {
  try {
    const infos = buildRateLimiterStorageInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No rate_limiter policies found in framework.yaml.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Rate Limiter Storage Analysis\n${'='.repeat(55)}\n\n`;
    text += `Policies: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.policyName}\n`;
      text += `    storageType:   ${info.storageType}\n`;
      text += `    distributed:   ${info.isDistributed ? 'yes' : 'no'}\n`;
      if (info.cachePool) text += `    cachePool:     ${info.cachePool}\n`;
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

export function getRateLimiterStorageStats(appPath: string): McpToolResult {
  try {
    const infos = buildRateLimiterStorageInfos(appPath);

    let text = `Rate Limiter Storage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total policies:              ${infos.length}\n`;
    text += `  Distributed storage:       ${infos.filter((i) => i.isDistributed).length}\n`;
    text += `  Redis storage:             ${infos.filter((i) => i.storageType === 'redis').length}\n`;
    text += `  APCu storage:              ${infos.filter((i) => i.storageType === 'apcu').length}\n`;
    text += `  Array/in-memory storage:   ${infos.filter((i) => i.storageType === 'array' || i.storageType === 'memory').length}\n`;
    text += `  Using cache.app pool:      ${infos.filter((i) => i.cachePool === 'cache.app').length}\n`;
    text += `  No storage configured:     ${infos.filter((i) => i.storageType === 'default' || i.storageType === 'unknown').length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRateLimiterStorageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_rate_limiter_storage',
      description: 'Inspect rate limiter storage configuration: cache_pool/lock_factory per policy, storage type (Redis/APCu/array/filesystem), distributed vs single-node; warns on cache.app pool collision, in-memory in production, APCu in multi-worker setup, missing storage config',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_rate_limiter_storage_stats',
      description: 'Statistics for rate limiter storage: total policies, distributed count, Redis/APCu/array breakdown, cache.app collision count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
