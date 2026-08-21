/**
 * Symfony Lock Store Configuration Inspector
 *
 * Scans config/packages/lock.yaml and config/packages/*.yaml for lock config:
 * - framework.lock resources and their store backends
 * - Detects: FlockStore, SemaphoreStore, RedisStore, PdoStore,
 *             ZookeeperStore, InMemoryStore, CombinedStore
 * - Checks .env* for LOCK_DSN
 * - Flags: InMemoryStore in prod, FlockStore multi-server, missing HA setup
 *
 * Masks DSN passwords before returning.
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface LockStoreInfo {
  store: string;
  backend: 'redis' | 'flock' | 'pdo' | 'semaphore' | 'zookeeper' | 'in-memory' | 'combined' | 'unknown';
  dsn: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskDsnCredentials(dsn: string): string {
  return dsn
    .replace(/(\/\/[^:@/\s]*:)[^@]+(@)/g, '$1***$2')
    .replace(/:\/\/([^@:/\s]{1,200})@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret)=[^&\s]*/gi, '$1$2=***');
}

function detectBackend(value: string): LockStoreInfo['backend'] {
  const lower = value.toLowerCase();
  if (lower.includes('redis') || lower.startsWith('redis://') || lower.startsWith('rediss://')) return 'redis';
  if (lower.includes('flock') || lower.startsWith('flock://')) return 'flock';
  if (lower.includes('pdo') || lower.startsWith('mysql://') || lower.startsWith('pgsql://') || lower.startsWith('sqlite://')) return 'pdo';
  if (lower.includes('semaphore') || lower === 'semaphore') return 'semaphore';
  if (lower.includes('zookeeper')) return 'zookeeper';
  if (lower.includes('memory') || lower === '%env(lock_dsn)%' && lower.includes('memory')) return 'in-memory';
  if (lower.includes('combined')) return 'combined';
  return 'unknown';
}

function buildIssues(backend: LockStoreInfo['backend'], store: string): string[] {
  const issues: string[] = [];
  if (backend === 'in-memory') {
    issues.push('InMemoryStore is not persistent — locks are lost on restart; do not use in production');
    issues.push('InMemoryStore is not shared across processes — not suitable for any concurrent workload');
  }
  if (backend === 'flock') {
    issues.push('FlockStore uses file locks — not shared across servers; avoid in multi-server/load-balanced setups');
  }
  if (backend === 'unknown') {
    issues.push(`Unknown lock backend for store "${store}" — verify DSN is correctly configured`);
  }
  if (backend === 'semaphore') {
    issues.push('SemaphoreStore is local to the host — not suitable for distributed environments');
  }
  if (backend === 'redis') {
    issues.push('RedisStore: ensure Redis is HA (Sentinel/Cluster) to avoid a single point of failure for locks');
  }
  return issues;
}

function parseLockYaml(content: string): LockStoreInfo[] {
  const infos: LockStoreInfo[] = [];
  const lines = content.split('\n');

  let inLockSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^framework:/.test(trimmed)) { inLockSection = false; }
    if (/^lock:/.test(trimmed) || /^\s+lock:/.test(line)) { inLockSection = true; continue; }

    if (!inLockSection) continue;
    if (/^\s{0,4}\S/.test(line) && !/lock:/.test(line) && !/\s{4}/.test(line)) {
      inLockSection = false;
      continue;
    }

    // Detect resource entries: "name: 'dsn-or-value'"
    const resourceMatch = /^\s+(\w[\w.-]*):\s*['"]?([^'"#\n]+)['"]?/.exec(line);
    if (resourceMatch) {
      const store = resourceMatch[1].trim();
      const rawDsn = resourceMatch[2].trim();
      const backend = detectBackend(rawDsn);
      const dsn = maskDsnCredentials(rawDsn);
      const issues = buildIssues(backend, store);
      infos.push({ store, backend, dsn, issues });
    }

    // Detect simple list style: - 'redis://...'
    const listMatch = /^\s+-\s+['"]?([^'"#\n]+)['"]?/.exec(line);
    if (listMatch) {
      const rawDsn = listMatch[1].trim();
      const backend = detectBackend(rawDsn);
      const dsn = maskDsnCredentials(rawDsn);
      const issues = buildIssues(backend, 'default');
      infos.push({ store: 'default', backend, dsn, issues });
    }
  }

  return infos;
}

function readEnvLockDsn(appPath: string): string | null {
  const envFiles = ['.env', '.env.local', '.env.prod', '.env.production'];
  for (const envFile of envFiles) {
    const filePath = path.join(appPath, envFile);
    const resolved = path.resolve(filePath);
    const resolvedBase = path.resolve(appPath);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) continue;
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      for (const line of content.split('\n')) {
        const m = /^LOCK_DSN\s*=\s*(.+)/.exec(line);
        if (m) return maskDsnCredentials(m[1].trim());
      }
    } catch { continue; }
  }
  return null;
}

function buildLockStoreInfos(appPath: string): LockStoreInfo[] {
  const results: LockStoreInfo[] = [];
  const configDir = path.join(appPath, 'config', 'packages');

  let configFiles: string[] = [];
  try {
    configFiles = fs.readdirSync(configDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => path.join(configDir, f));
  } catch { /* no config dir */ }

  const lockYaml = path.join(configDir, 'lock.yaml');
  const allFiles = configFiles.includes(lockYaml) ? configFiles : [lockYaml, ...configFiles];

  for (const file of allFiles) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/lock:/.test(content)) continue;
    const infos = parseLockYaml(content);
    results.push(...infos);
  }

  // Check .env for LOCK_DSN if no config found
  if (results.length === 0) {
    const envDsn = readEnvLockDsn(appPath);
    if (envDsn) {
      const backend = detectBackend(envDsn);
      results.push({
        store: 'LOCK_DSN (env)',
        backend,
        dsn: envDsn,
        issues: buildIssues(backend, 'LOCK_DSN'),
      });
    }
  }

  return results;
}

export function listSymfonyLockStoreConfig(appPath: string): McpToolResult {
  try {
    const infos = buildLockStoreInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony lock store configuration found (config/packages/lock.yaml, .env LOCK_DSN).' }] };
    }

    let text = `Symfony Lock Store Configuration\n${'='.repeat(50)}\n\n`;
    text += `Lock stores configured: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `Store: ${info.store}\n`;
      text += `  Backend: ${info.backend}\n`;
      text += `  DSN:     ${info.dsn}\n`;
      if (info.issues.length > 0) {
        text += `  Issues:\n`;
        for (const issue of info.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLockStoreConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildLockStoreInfos(appPath);

    const backendCounts: Record<string, number> = {};
    for (const info of infos) {
      backendCounts[info.backend] = (backendCounts[info.backend] ?? 0) + 1;
    }
    const withIssues = infos.filter((i) => i.issues.length > 0).length;
    const hasInMemory = infos.some((i) => i.backend === 'in-memory');
    const hasFlock = infos.some((i) => i.backend === 'flock');
    const hasCombined = infos.some((i) => i.backend === 'combined');

    let text = `Symfony Lock Store Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total lock stores:    ${infos.length}\n`;
    text += `Stores with issues:   ${withIssues}\n\n`;
    text += `By backend:\n`;
    for (const [backend, count] of Object.entries(backendCounts)) {
      text += `  ${backend.padEnd(12)}: ${count}\n`;
    }
    text += '\n';
    if (hasInMemory) text += `WARNING: InMemoryStore detected — not suitable for production\n`;
    if (hasFlock) text += `WARNING: FlockStore detected — not suitable for multi-server setup\n`;
    if (!hasCombined && infos.length > 0) text += `INFO: No CombinedStore — consider for HA lock configuration\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLockStoreConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_lock_store_config',
      description: 'List Symfony lock store configuration: backends (Redis/Flock/PDO/Semaphore/InMemory/Combined), DSNs (passwords masked), issues like InMemoryStore in prod or FlockStore in multi-server',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_lock_store_config_stats',
      description: 'Get Symfony lock store statistics: counts by backend, issues summary, HA readiness (CombinedStore), warnings for production-unsafe backends',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
