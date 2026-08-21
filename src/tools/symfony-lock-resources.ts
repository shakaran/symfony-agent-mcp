/**
 * Symfony Lock Component Resources Inspector
 *
 * Distinct from rate-limiter.ts (token bucket / sliding window rate limiting).
 * Focuses on the Lock component for distributed mutual exclusion:
 *
 * Configuration (framework.yaml):
 *   framework:
 *     lock: '%env(REDIS_URL)%'         # single store for all resources
 *     lock:                             # per-resource named stores
 *       invoice: '%env(REDIS_URL)%'
 *       payment: 'flock:///var/lock/payment.lock'
 *       report:  'semaphore'
 *
 * Store types:
 *   - flock          — file-based, local, not suitable for distributed systems
 *   - semaphore      — SysV semaphore, local
 *   - redis://...    — distributed, single-server
 *   - rediss://...   — distributed, TLS
 *   - redis+cluster://... — distributed, cluster
 *   - zookeeper://...
 *   - postgresql://...
 *   - mysql://...
 *   - %env(...)%     — from environment (store type unknown at static analysis time)
 *   - combined-lock: [store1, store2] — quorum-based
 *
 * PHP usage scan:
 *   - LockFactory::createLock(string $resource, ?float $ttl, bool $autoRelease)
 *   - #[AutowireLocator] with LockFactory
 *   - $lock->acquire() / $lock->acquireOrBlock() / $lock->release()
 *   - Resource strings: literal vs variable
 *
 * Analysis:
 *   - flock store in production config (not suitable for multiple processes/hosts)
 *   - Lock acquired but never released (missing release() call in same method)
 *   - TTL > 300s (5 min) — very long lock, consider heartbeat
 *   - No lock config (default in-memory — not process-safe)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface LockResource {
  name: string;
  store: string;
  storeType: string;
  issues: string[];
}

interface LockUsage {
  file: string;
  resource: string;
  hasTtl: boolean;
  hasRelease: boolean;
  issues: string[];
}

function classifyStore(store: string): string {
  if (store.startsWith('flock://') || store === 'flock') return 'flock';
  if (store === 'semaphore') return 'semaphore';
  if (store.startsWith('redis+cluster://')) return 'redis-cluster';
  if (store.startsWith('rediss://')) return 'redis-tls';
  if (store.startsWith('redis://')) return 'redis';
  if (store.startsWith('zookeeper://')) return 'zookeeper';
  if (store.startsWith('postgresql://') || store.startsWith('pgsql://')) return 'postgresql';
  if (store.startsWith('mysql://') || store.startsWith('mysqli://')) return 'mysql';
  if (store.startsWith('%env(')) return 'env-reference';
  if (store.startsWith('combined-lock:')) return 'combined';
  if (store.startsWith('@')) return 'service';
  return 'unknown';
}

function loadLockResources(appPath: string): LockResource[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
    path.join(appPath, 'config', 'packages', 'lock.yaml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw      = (raw['framework'] ?? raw) as Record<string, unknown>;
    const lockRaw = fw['lock'];
    if (!lockRaw) continue;

    const resources: LockResource[] = [];

    if (typeof lockRaw === 'string') {
      const storeType = classifyStore(lockRaw);
      const issues: string[] = [];
      if (storeType === 'flock' || storeType === 'semaphore') {
        issues.push(`Store type "${storeType}" is local-only — not suitable for multi-process/multi-host deployment`);
      }
      resources.push({ name: 'default', store: lockRaw, storeType, issues });
    } else if (typeof lockRaw === 'object' && lockRaw !== null) {
      for (const [name, storeVal] of Object.entries(lockRaw as Record<string, unknown>)) {
        const store = String(storeVal ?? '');
        const storeType = classifyStore(store);
        const issues: string[] = [];
        if (storeType === 'flock' || storeType === 'semaphore') {
          issues.push(`Store type "${storeType}" is local-only — not suitable for multi-process/multi-host deployment`);
        }
        resources.push({ name, store, storeType, issues });
      }
    }

    return resources;
  }
  return [];
}

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

function scanLockUsages(appPath: string): LockUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usages: LockUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('createLock') && !content.includes('LockFactory') && !content.includes('LockInterface')) continue;

    const relPath = path.relative(appPath, file);

    const createM = /createLock\s*\(\s*['"]([^'"]{1,80})['"]\s*(?:,\s*([\d.]+))?/.exec(content);
    if (createM) {
      const resource  = createM[1];
      const ttl       = createM[2] ? parseFloat(createM[2]) : undefined;
      const hasTtl    = ttl !== undefined;
      const hasRelease = content.includes('->release()');

      const issues: string[] = [];
      if (ttl !== undefined && ttl > 300) {
        issues.push(`TTL ${ttl}s exceeds 5 minutes — consider a heartbeat pattern`);
      }
      if (!hasRelease) {
        issues.push('Lock is acquired but ->release() not found in this file — verify manual release or autoRelease');
      }

      usages.push({ file: relPath, resource, hasTtl, hasRelease, issues });
    }
  }
  return usages;
}

export function listLockResources(appPath: string): McpToolResult {
  try {
    const resources = loadLockResources(appPath);
    const usages    = scanLockUsages(appPath);

    if (resources.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Lock component configuration found.\n\nConfigure in config/packages/framework.yaml:\n  framework:\n    lock:\n      report: \'%env(REDIS_URL)%\'\n      session: \'flock:///var/lock/session.lock\'',
        }],
      };
    }

    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0) +
                        usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `Lock Component Resources\n${'='.repeat(55)}\n`;
    text += `\nConfigured resources: ${resources.length}  Usages: ${usages.length}  Issues: ${totalIssues}\n`;

    if (resources.length > 0) {
      text += `\nResources:\n`;
      for (const r of resources) {
        text += `  ${r.name.padEnd(20)} ${r.storeType.padEnd(16)} ${r.store.slice(0, 60)}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (usages.length > 0) {
      text += `\nUsages in src/:\n`;
      for (const u of usages) {
        const relStr    = u.hasRelease ? '✓ release' : '⚠ no release';
        const ttlStr    = u.hasTtl ? ' with TTL' : '';
        text += `  "${u.resource}"${ttlStr}  ${relStr}  (${u.file})\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLockResourceStats(appPath: string): McpToolResult {
  try {
    const resources = loadLockResources(appPath);
    const usages    = scanLockUsages(appPath);

    let text = `Lock Resource Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured resources: ${resources.length}\n`;
    text += `  Flock (local):      ${resources.filter((r) => r.storeType === 'flock').length}\n`;
    text += `  Redis:              ${resources.filter((r) => r.storeType.startsWith('redis')).length}\n`;
    text += `  Database:           ${resources.filter((r) => r.storeType === 'postgresql' || r.storeType === 'mysql').length}\n`;
    text += `Usages:               ${usages.length}\n`;
    text += `  With TTL:           ${usages.filter((u) => u.hasTtl).length}\n`;
    text += `  With release():     ${usages.filter((u) => u.hasRelease).length}\n`;
    text += `Issues:               ${resources.reduce((s, r) => s + r.issues.length, 0) + usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLockResourceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_lock_resources',
      description: 'Show Symfony Lock component resources: per-resource store configuration (flock/semaphore/redis/postgresql/mysql/combined), store type classification, createLock() usages, TTL detection, missing release() warning, flock local-only warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_lock_resource_stats',
      description: 'Show lock resource statistics: configured resource count by store type, usage count, TTL/release counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
