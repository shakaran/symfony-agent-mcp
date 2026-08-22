/**
 * Symfony Lock Component Inspector
 *
 * Reads config/packages/lock.yaml:
 *   - Named lock stores (redis, flock, pdo, semaphore, in-memory)
 *   - Default store configuration
 *
 * Scans src/ for LockFactory usage:
 *   - createLock('resource-name') calls
 *   - createLockFromKey() calls
 *   - TTL / blocking flags passed to createLock()
 *   - Classes that inject LockFactory
 *
 * Warns about locks without TTL (potential for deadlocks).
 * Pure static analysis — no locks acquired.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface LockStore {
  name: string;
  dsn: string;
  storeType: string;
}

interface LockUsage {
  class: string;
  file: string;
  resource: string;
  ttl?: number;
  autoRelease?: boolean;
  blocking?: boolean;
}

// ─── Store type detection ───────────────────────────────────────────────────

function detectStoreType(dsn: string): string {
  if (dsn.startsWith('redis')) return 'Redis';
  if (dsn.startsWith('rediss')) return 'Redis TLS';
  if (dsn.startsWith('flock')) return 'Flock (filesystem)';
  if (dsn.startsWith('pdo') || dsn.startsWith('mysql') || dsn.startsWith('postgresql')) return 'PDO (database)';
  if (dsn.startsWith('semaphore')) return 'Semaphore';
  if (dsn.startsWith('memcached')) return 'Memcached';
  if (dsn.startsWith('%env(') || dsn.startsWith('%')) return 'Env variable';
  if (dsn === 'in_memory' || dsn === 'InMemory') return 'In-memory (non-persistent)';
  if (dsn.startsWith('mongodb')) return 'MongoDB';
  if (dsn.startsWith('zookeeper')) return 'ZooKeeper';
  return 'Custom / Unknown';
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadLockStores(appPath: string): LockStore[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'lock.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    // framework.lock or standalone lock:
    const fw = raw['framework'] as Record<string, unknown> | undefined;
    const lockSection = (fw?.['lock'] ?? raw['lock']) as unknown;
    if (!lockSection) continue;

    const stores: LockStore[] = [];

    if (typeof lockSection === 'string') {
      stores.push({ name: 'default', dsn: lockSection, storeType: detectStoreType(lockSection) });
    } else if (typeof lockSection === 'object' && lockSection !== null) {
      const ls = lockSection as Record<string, unknown>;
      for (const [name, dsn] of Object.entries(ls)) {
        const dsnStr = typeof dsn === 'string' ? dsn : JSON.stringify(dsn);
        stores.push({ name, dsn: dsnStr, storeType: detectStoreType(dsnStr) });
      }
    }

    if (stores.length > 0) return stores;
  }

  return [];
}

// ─── PHP usage scanning ─────────────────────────────────────────────────────

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

function scanLockUsage(appPath: string): LockUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usages: LockUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('LockFactory') && !content.includes('createLock')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // createLock('resource', ttl, autoRelease)
    for (const m of content.matchAll(/->createLock\s*\(\s*(['"])([^'"]+)\1(?:\s*,\s*(\d+))?(?:\s*,\s*(true|false))?/g)) {
      const ttlStr = m[3];
      const autoRelStr = m[4];
      usages.push({
        class: classM[1],
        file: path.basename(file),
        resource: m[2],
        ttl: ttlStr ? parseInt(ttlStr, 10) : undefined,
        autoRelease: autoRelStr ? autoRelStr === 'true' : undefined,
      });
    }

    // createLockFromKey() — resource is dynamic
    if (content.includes('createLockFromKey')) {
      usages.push({
        class: classM[1],
        file: path.basename(file),
        resource: '(dynamic key)',
      });
    }
  }

  return usages;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listLockConfig(appPath: string): McpToolResult {
  try {
    const stores = loadLockStores(appPath);
    const usages = scanLockUsage(appPath);

    if (stores.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Symfony Lock component not configured.\n\nInstall:\n  composer require symfony/lock\n\nConfigure config/packages/lock.yaml:\n  framework:\n    lock:\n      default: \'%env(REDIS_URL)%\'\n      invoice: \'flock\'',
        }],
      };
    }

    let text = `Symfony Lock Inspector\n${'='.repeat(50)}\n`;

    if (stores.length > 0) {
      text += `\nLock stores (${stores.length}):\n`;
      for (const s of stores) {
        const maskedDsn = s.dsn.replace(/:\/\/[^@]+@/, '://***@');
        text += `  ${s.name.padEnd(20)} ${s.storeType.padEnd(25)} ${maskedDsn}\n`;
      }
    }

    if (usages.length > 0) {
      text += `\nLock usages in src/ (${usages.length}):\n`;

      const noTtl = usages.filter((u) => u.ttl === undefined && u.resource !== '(dynamic key)');

      if (noTtl.length > 0) {
        text += `  ⚠ ${noTtl.length} lock(s) without explicit TTL — risk of deadlock on crash:\n`;
        for (const u of noTtl) text += `    ${u.class}  resource: "${u.resource}"\n`;
        text += '\n';
      }

      for (const u of usages) {
        const ttl = u.ttl !== undefined ? `  TTL: ${u.ttl}s` : '  TTL: none';
        const ar = u.autoRelease !== undefined ? `  autoRelease: ${u.autoRelease}` : '';
        text += `  ${u.class.padEnd(35)} resource: "${u.resource}"${ttl}${ar}\n`;
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

export function getLockStats(appPath: string): McpToolResult {
  try {
    const stores = loadLockStores(appPath);
    const usages = scanLockUsage(appPath);

    let text = `Lock Statistics\n${'='.repeat(40)}\n\n`;
    text += `Stores configured: ${stores.length}\n`;
    text += `Lock usages found: ${usages.length}\n`;
    text += `Without TTL:       ${usages.filter((u) => u.ttl === undefined && u.resource !== '(dynamic key)').length}\n`;
    text += `Dynamic keys:      ${usages.filter((u) => u.resource === '(dynamic key)').length}\n`;

    const storeTypes = new Set(stores.map((s) => s.storeType));
    if (storeTypes.size > 0) text += `Store types:       ${[...storeTypes].join(', ')}\n`;

    const resources = [...new Set(usages.filter((u) => u.resource !== '(dynamic key)').map((u) => u.resource))];
    if (resources.length > 0) {
      text += `\nResource names:\n`;
      for (const r of resources) text += `  ${r}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getLockTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_lock_config',
      description: 'Show Symfony Lock component config: lock stores (Redis/flock/PDO), LockFactory usages in src/ with resource names and TTL, deadlock risk warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_lock_stats',
      description: 'Show lock statistics: store count, usage count, locks without TTL (deadlock risk), dynamic key usage, resource names',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
