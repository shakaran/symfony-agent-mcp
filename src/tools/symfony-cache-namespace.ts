// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Cache Namespace Inspector
 *
 * Scans config/packages/cache.yaml (and env variants):
 *   - Parses pools: section — pool name, adapter, namespace, default_lifetime
 *   - Redis-backed pools without a namespace per pool — collision risk
 *   - Multiple pools sharing the same Redis DSN without distinct namespaces
 *   - Namespace strings empty or < 3 chars — collision risk
 *   - Scans .env* files for REDIS_URL / CACHE_DSN; notes pools sharing DSN
 *
 * Pure static analysis — secrets masked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CacheNamespaceEntry {
  pool: string;
  adapter: string;
  namespace: string | null;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecret(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@]{1,200}@/, '://***@')
    .replace(/%env\([^)]+\)%/, '[ENV]')
    .replace(/([?&])(auth|password|token|secret)=[^&\s]*/gi, '$1$2=***');
}

function loadCacheYaml(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'dev', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'prod', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'cache.yml'),
  ];
  for (const c of candidates) {
    const content = safeRead(c, appPath);
    if (content) return content;
  }
  return null;
}

interface PoolDef {
  name: string;
  adapter: string;
  namespace: string | null;
  provider: string | null;
  defaultLifetime: string | null;
}

function extractPoolBlock(content: string): string | null {
  // Find the pools: block under framework.cache or cache:
  const poolsRe = /^[ \t]*pools:\s*\n([\s\S]*?)(?=^[ \t]{0,8}\S[^:]{0,100}:[ \t]*$|(?![\s\S]))/m;
  const m = poolsRe.exec(content);
  return m ? m[1] : null;
}

function parsePools(content: string): PoolDef[] {
  const pools: PoolDef[] = [];
  const poolBlock = extractPoolBlock(content);
  if (!poolBlock) return pools;

  // Find top-level pool entries (8-space or 4-space indented keys)
  const poolNameRe = /^([ \t]{4,12})(\S[^\n:]{0,100}):\s*$/gm;
  let m: RegExpExecArray | null;
  const poolPositions: Array<{ name: string; indent: string; pos: number }> = [];

  while ((m = poolNameRe.exec(poolBlock)) !== null) {
    poolPositions.push({ name: m[2].trim(), indent: m[1], pos: m.index });
  }

  for (let i = 0; i < poolPositions.length; i++) {
    const { name, pos } = poolPositions[i];
    const end = i + 1 < poolPositions.length ? poolPositions[i + 1].pos : poolBlock.length;
    const body = poolBlock.slice(pos, end);

    const adapterM = /adapter:\s*([^\n]{1,120})/.exec(body);
    const namespaceM = /namespace:\s*([^\n]{0,120})/.exec(body);
    const providerM = /provider:\s*([^\n]{1,200})/.exec(body);
    const lifetimeM = /default_lifetime:\s*([^\n]{1,50})/.exec(body);

    pools.push({
      name,
      adapter: adapterM ? adapterM[1].trim() : '',
      namespace: namespaceM ? namespaceM[1].trim() : null,
      provider: providerM ? maskSecret(providerM[1].trim()) : null,
      defaultLifetime: lifetimeM ? lifetimeM[1].trim() : null,
    });
  }
  return pools;
}

function extractGlobalAdapter(content: string): string | null {
  const m = /^\s*app:\s*([^\n]{1,120})/m.exec(content);
  return m ? m[1].trim() : null;
}

function extractGlobalRedisProvider(content: string): string | null {
  const m = /default_redis_provider:\s*([^\n]{1,200})/.exec(content);
  return m ? maskSecret(m[1].trim()) : null;
}

function loadEnvFiles(appPath: string): string {
  const envFiles = ['.env', '.env.local', '.env.prod', '.env.dev', '.env.test'];
  const parts: string[] = [];
  for (const name of envFiles) {
    const content = safeRead(path.join(appPath, name), appPath);
    if (content) parts.push(content);
  }
  return parts.join('\n');
}

function extractEnvDsns(envContent: string): string[] {
  const dsns: string[] = [];
  const re = /(?:REDIS_URL|CACHE_DSN|REDIS_DSN)=([^\n]{1,200})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(envContent)) !== null) {
    dsns.push(maskSecret(m[1].trim()));
  }
  return dsns;
}

function buildCacheNamespaceEntries(appPath: string): {
  entries: CacheNamespaceEntry[];
  globalAdapter: string | null;
  globalRedisProvider: string | null;
  envDsns: string[];
  yamlFound: boolean;
} {
  const yamlContent = loadCacheYaml(appPath);
  if (!yamlContent) {
    return { entries: [], globalAdapter: null, globalRedisProvider: null, envDsns: [], yamlFound: false };
  }

  const globalAdapter = extractGlobalAdapter(yamlContent);
  const globalRedisProvider = extractGlobalRedisProvider(yamlContent);
  const pools = parsePools(yamlContent);
  const envContent = loadEnvFiles(appPath);
  const envDsns = extractEnvDsns(envContent);

  // Find pools sharing a provider (potential collision)
  const providerMap = new Map<string, string[]>();
  for (const p of pools) {
    const key = p.provider ?? globalRedisProvider ?? '';
    if (!key) continue;
    const existing = providerMap.get(key) ?? [];
    existing.push(p.name);
    providerMap.set(key, existing);
  }

  const entries: CacheNamespaceEntry[] = [];

  for (const p of pools) {
    const isRedis = p.adapter.includes('redis') ||
      (!p.adapter && (globalAdapter?.includes('redis') ?? false));
    const issues: string[] = [];

    if (isRedis && p.namespace === null) {
      issues.push('Redis pool has no namespace: set — key collision risk with other pools/apps');
    } else if (p.namespace !== null && p.namespace.length < 3) {
      issues.push(`Namespace "${p.namespace}" is very short (<3 chars) — collision risk on shared Redis`);
    }

    // Check if multiple pools share same provider without distinct namespaces
    const providerKey = p.provider ?? globalRedisProvider ?? '';
    if (providerKey) {
      const sharing = (providerMap.get(providerKey) ?? []).filter((n) => n !== p.name);
      if (sharing.length > 0 && p.namespace === null) {
        issues.push(`Shares Redis DSN with pool(s) [${sharing.join(', ')}] and has no namespace — collision risk`);
      }
    }

    entries.push({
      pool: p.name,
      adapter: p.adapter || globalAdapter || '(inherited)',
      namespace: p.namespace,
      issue: issues.length > 0 ? issues.join('; ') : null,
    });
  }

  return { entries, globalAdapter, globalRedisProvider, envDsns, yamlFound: true };
}

export function listSymfonyCacheNamespace(appPath: string): McpToolResult {
  try {
    const { entries, globalAdapter, globalRedisProvider, envDsns, yamlFound } = buildCacheNamespaceEntries(appPath);

    if (!yamlFound) {
      return { content: [{ type: 'text', text: 'No cache.yaml found in config/packages/ (including dev/ and prod/ subdirectories).' }] };
    }

    let text = `Symfony Cache Namespace Inspector\n${'='.repeat(55)}\n\n`;
    if (globalAdapter) text += `Global app adapter: ${globalAdapter}\n`;
    if (globalRedisProvider) text += `Global Redis provider: ${globalRedisProvider}\n`;
    if (envDsns.length > 0) text += `Env Redis/Cache DSNs: ${envDsns.join(', ')}\n`;
    text += `\nPools: ${entries.length}\n\n`;

    if (entries.length === 0) {
      text += 'No named pools found in pools: section.\n';
      return { content: [{ type: 'text', text }] };
    }

    for (const e of entries) {
      const ns = e.namespace ?? '(none)';
      const adapterShort = e.adapter.replace('cache.adapter.', '');
      text += `  ${e.pool}\n`;
      text += `    Adapter:   ${adapterShort}\n`;
      text += `    Namespace: ${ns}\n`;
      if (e.issue) text += `    Issue: ${e.issue}\n`;
    }

    const issueCount = entries.filter((e) => e.issue !== null).length;
    if (issueCount > 0) {
      text += `\nTotal pools with namespace issues: ${issueCount}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheNamespaceStats(appPath: string): McpToolResult {
  try {
    const { entries, globalAdapter, globalRedisProvider, yamlFound } = buildCacheNamespaceEntries(appPath);

    let text = `Symfony Cache Namespace Statistics\n${'='.repeat(45)}\n\n`;

    if (!yamlFound) {
      text += 'cache.yaml: not found\n';
      return { content: [{ type: 'text', text }] };
    }

    const redisPools = entries.filter((e) => e.adapter.includes('redis') || (!e.adapter && globalAdapter?.includes('redis')));
    const withNamespace = entries.filter((e) => e.namespace !== null && e.namespace.length >= 3);
    const withoutNamespace = redisPools.filter((e) => e.namespace === null);
    const shortNamespace = entries.filter((e) => e.namespace !== null && e.namespace.length < 3);
    const withIssues = entries.filter((e) => e.issue !== null);

    text += `Total pools:                  ${entries.length}\n`;
    text += `Redis-backed pools:           ${redisPools.length}\n`;
    text += `With valid namespace:          ${withNamespace.length}\n`;
    text += `Redis pools missing namespace: ${withoutNamespace.length}\n`;
    text += `Pools with short namespace:    ${shortNamespace.length}\n`;
    text += `Pools with issues:             ${withIssues.length}\n`;
    text += `Global Redis provider set:     ${globalRedisProvider ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheNamespaceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_cache_namespace',
      description: 'List Symfony cache pool namespaces: pool name, adapter, namespace (or none), Redis pools missing namespace, pools sharing DSN without distinct namespaces, short namespace collision risks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_cache_namespace_stats',
      description: 'Show Symfony cache namespace statistics: pool count, Redis pools, pools with/without namespace, short namespace count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
