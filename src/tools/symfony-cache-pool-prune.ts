/**
 * Symfony Cache Pool Prune Inspector
 *
 * Reads framework.yaml cache pools: detects adapter type (filesystem, doctrine, pdo).
 * Checks cron-related files (crontab, cron.d, Makefile, supervisor) for cache:pool:prune.
 * Scans src/ PHP for PruneableInterface or cache:pool:prune command registration.
 *
 * Warns about:
 *   - Filesystem cache pool without prune scheduled (disk fills up)
 *   - PDO/doctrine cache pool without prune (DB table grows)
 *   - PruneableInterface implemented but prune() never called
 *   - Multiple filesystem pools pointing to same directory (prune conflicts)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CachePoolPruneInfo {
  poolName: string;
  adapter: string;
  isPruneable: boolean;
  hasPruneScheduled: boolean;
  directory?: string;
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

const PRUNEABLE_ADAPTERS = ['filesystem', 'doctrine', 'pdo', 'dbal', 'sqlite'];

function extractAdapterName(adapterRaw: unknown): string {
  const s = String(adapterRaw ?? '').toLowerCase();
  if (s.includes('filesystem') || s.includes('file_system')) return 'filesystem';
  if (s.includes('pdo') || s.includes('dbal') || s.includes('sqlite')) return 'pdo';
  if (s.includes('doctrine')) return 'doctrine';
  if (s.includes('redis')) return 'redis';
  if (s.includes('memcache')) return 'memcached';
  if (s.includes('apcu')) return 'apcu';
  if (s.includes('array')) return 'array';
  return s.slice(0, 40) || 'unknown';
}

interface RawPool {
  name: string;
  adapter: string;
  directory?: string;
}

function loadCachePools(appPath: string): RawPool[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
  ];

  const pools: RawPool[] = [];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const cache = (framework['cache'] ?? {}) as Record<string, unknown>;
    const poolsRaw = (cache['pools'] ?? {}) as Record<string, unknown>;

    for (const [name, poolData] of Object.entries(poolsRaw)) {
      const pool = (poolData ?? {}) as Record<string, unknown>;
      const adapter = extractAdapterName(pool['adapter'] ?? pool['provider'] ?? '');
      const directory = pool['directory'] !== undefined ? String(pool['directory']) : undefined;
      pools.push({ name, adapter, directory });
    }

    // Also check default_cache if present
    const defaultCacheAdapter = cache['app'] as string | undefined;
    if (defaultCacheAdapter && pools.length === 0) {
      pools.push({ name: 'app', adapter: extractAdapterName(defaultCacheAdapter) });
    }
  }

  return pools;
}

const CRON_CANDIDATES = [
  'crontab',
  path.join('etc', 'cron.d'),
  'Makefile',
  path.join('docker', 'cron', 'crontab'),
  path.join('.', 'crontab'),
  path.join('config', 'supervisor', 'cron.conf'),
  path.join('docker-compose.yml'),
  path.join('docker-compose.yaml'),
];

function checkPruneScheduled(appPath: string): boolean {
  const filesToCheck: string[] = [];

  for (const candidate of CRON_CANDIDATES) {
    const fullPath = path.join(appPath, candidate);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          filesToCheck.push(path.join(fullPath, entry.name));
        }
      } else {
        filesToCheck.push(fullPath);
      }
    } catch { /* skip */ }
  }

  for (const filePath of filesToCheck) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('cache:pool:prune')) return true;
    } catch { /* skip */ }
  }

  return false;
}

function checkPruneableInSrc(appPath: string): boolean {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return false;

  for (const file of getAllPhpFiles(srcDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('PruneableInterface') || content.includes('cache:pool:prune')) return true;
    } catch { /* skip */ }
  }
  return false;
}

function buildPruneInfos(appPath: string): CachePoolPruneInfo[] {
  const pools = loadCachePools(appPath);
  const hasPruneScheduled = checkPruneScheduled(appPath);
  const hasPruneableInSrc = checkPruneableInSrc(appPath);

  // Check for duplicate directories
  const dirCount: Record<string, number> = {};
  for (const pool of pools) {
    if (pool.directory) {
      dirCount[pool.directory] = (dirCount[pool.directory] ?? 0) + 1;
    }
  }

  return pools.map((pool) => {
    const isPruneable = PRUNEABLE_ADAPTERS.some((a) => pool.adapter.includes(a));
    const issues: string[] = [];

    if (isPruneable && !hasPruneScheduled) {
      if (pool.adapter === 'filesystem') {
        issues.push(`Filesystem cache pool "${pool.name}" without prune scheduled — disk fills up with expired entries`);
      } else if (pool.adapter === 'pdo' || pool.adapter === 'doctrine') {
        issues.push(`${pool.adapter} cache pool "${pool.name}" without prune scheduled — database table grows with expired entries`);
      } else {
        issues.push(`Pruneable cache pool "${pool.name}" (${pool.adapter}) without cache:pool:prune scheduled`);
      }
    }
    if (hasPruneableInSrc && !hasPruneScheduled) {
      issues.push('PruneableInterface found in src/ but cache:pool:prune not detected in any cron/supervisor config');
    }
    if (pool.directory && dirCount[pool.directory] !== undefined && dirCount[pool.directory] > 1) {
      issues.push(`Pool "${pool.name}" shares directory "${pool.directory}" with another pool — prune may conflict`);
    }

    return {
      poolName: pool.name,
      adapter: pool.adapter,
      isPruneable,
      hasPruneScheduled,
      directory: pool.directory,
      issues,
    };
  });
}

export function listCachePoolPrune(appPath: string): McpToolResult {
  try {
    const infos = buildPruneInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No cache pools found in framework.yaml.\n\nConsider scheduling: php bin/console cache:pool:prune',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Cache Pool Prune Analysis\n${'='.repeat(55)}\n\n`;
    text += `Cache pools: ${infos.length}  Issues: ${totalIssues}\n`;
    text += `Prune scheduled: ${infos[0]?.hasPruneScheduled ? 'yes' : 'no (cache:pool:prune not found in cron/Makefile/supervisor)'}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.poolName}  [${info.adapter}]\n`;
      text += `    pruneable: ${info.isPruneable ? 'yes' : 'no'}  pruneScheduled: ${info.hasPruneScheduled ? 'yes' : 'no'}\n`;
      if (info.directory) text += `    directory: ${info.directory}\n`;
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

export function getCachePoolPruneStats(appPath: string): McpToolResult {
  try {
    const infos = buildPruneInfos(appPath);

    let text = `Cache Pool Prune Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total pools:              ${infos.length}\n`;
    text += `  Filesystem pools:       ${infos.filter((i) => i.adapter === 'filesystem').length}\n`;
    text += `  PDO/Doctrine pools:     ${infos.filter((i) => i.adapter === 'pdo' || i.adapter === 'doctrine').length}\n`;
    text += `  Pruneable:              ${infos.filter((i) => i.isPruneable).length}\n`;
    text += `  With prune scheduled:   ${infos.filter((i) => i.hasPruneScheduled).length}\n`;
    text += `  Without prune:          ${infos.filter((i) => i.isPruneable && !i.hasPruneScheduled).length}\n`;
    text += `Total issues:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCachePoolPruneTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cache_pool_prune',
      description: 'Inspect cache pool prune configuration: adapter types in framework.yaml, cache:pool:prune presence in cron/Makefile/supervisor, PruneableInterface in src/; warns on filesystem/PDO pools without scheduled prune, duplicate directories',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cache_pool_prune_stats',
      description: 'Statistics for cache pool pruning: total pools, filesystem/PDO counts, pruneable count, scheduled prune coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
