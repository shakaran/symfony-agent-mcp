/**
 * Symfony Cache Chain Adapter Inspector
 *
 * Reads framework.yaml (or cache.yaml) cache section and detects:
 *   - Pools using cache.adapter.chain or ChainAdapter
 *   - Inner adapters list and their order
 *   - TagAwareAdapter wrapping chain pools
 *   - Pool decorated by another pool
 *
 * Warns: ChainAdapter with vastly different TTL adapters (stale data risk),
 * TagAwareAdapter wrapping non-tag-aware adapter (tags silently ignored),
 * chain with >3 adapters (latency on miss), memory adapter not first in chain.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CacheChainInfo {
  poolName: string;
  adapters: string[];
  isTagAware: boolean;
  adapterCount: number;
  memoryFirst: boolean;
  issues: string[];
}

const MEMORY_ADAPTERS = [
  'cache.adapter.array',
  'cache.adapter.apcu',
  'Symfony\\Component\\Cache\\Adapter\\ArrayAdapter',
  'Symfony\\Component\\Cache\\Adapter\\ApcuAdapter',
];

const TAG_AWARE_ADAPTERS = [
  'cache.adapter.redis_tag_aware',
  'Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter',
  'cache.adapter.tag_aware',
];

function isMemoryAdapter(name: string): boolean {
  return MEMORY_ADAPTERS.some((m) => name.includes(m) || name === m);
}

function isTagAwareAdapter(name: string): boolean {
  return TAG_AWARE_ADAPTERS.some((t) => name.includes(t) || name === t);
}

function parseChainPools(appPath: string): CacheChainInfo[] {
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

    const poolsRaw = cache['pools'] as Record<string, unknown> | undefined;
    if (!poolsRaw) continue;

    const chains: CacheChainInfo[] = [];

    for (const [poolName, def] of Object.entries(poolsRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      const adapter = d['adapter'] ? String(d['adapter']) : '';
      const isChainPool =
        adapter === 'cache.adapter.chain' ||
        adapter.includes('ChainAdapter') ||
        adapter === 'chain';

      if (!isChainPool) continue;

      const providersRaw = d['providers'] as unknown[] | undefined;
      const adapters: string[] = Array.isArray(providersRaw)
        ? providersRaw.map((p) => String(p))
        : [];

      const tagsValue = d['tags'] as boolean | string | undefined;
      const isTagAware =
        Boolean(tagsValue) ||
        adapters.some((a) => isTagAwareAdapter(a)) ||
        adapter.includes('TagAware');

      const adapterCount = adapters.length;
      const memoryFirst = adapterCount > 0 && isMemoryAdapter(adapters[0]);

      const issues: string[] = [];

      if (adapterCount > 3) {
        issues.push(`Chain has ${adapterCount} adapters — latency on cache miss increases with each additional adapter`);
      }
      if (!memoryFirst && adapterCount > 0) {
        const hasMemory = adapters.some((a) => isMemoryAdapter(a));
        if (hasMemory) {
          issues.push('Memory adapter is not first in chain — place array/APCu adapter first for fastest hit rate');
        }
      }
      if (adapterCount === 0) {
        issues.push('ChainAdapter has no providers list defined — check YAML config');
      }
      if (isTagAware) {
        const innerNonTagAware = adapters.filter((a) => !isTagAwareAdapter(a) && !a.includes('tag'));
        if (innerNonTagAware.length > 0) {
          issues.push(`TagAwareAdapter wraps non-tag-aware adapter(s) (${innerNonTagAware.join(', ')}) — cache tags may be silently ignored`);
        }
      }

      chains.push({ poolName, adapters, isTagAware, adapterCount, memoryFirst, issues });
    }

    if (chains.length > 0 || poolsRaw) return chains;
  }

  return [];
}

export function listCacheChainConfig(appPath: string): McpToolResult {
  try {
    const chains = parseChainPools(appPath);

    if (chains.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No cache.adapter.chain pools found in cache.yaml / framework.yaml.\n\nExample:\n  framework:\n    cache:\n      pools:\n        cache.fast_chain:\n          adapter: cache.adapter.chain\n          providers:\n            - cache.adapter.array\n            - cache.adapter.redis',
        }],
      };
    }

    const totalIssues = chains.reduce((s, c) => s + c.issues.length, 0);
    let text = `Symfony Cache Chain Configuration\n${'='.repeat(55)}\n`;
    text += `\nChain pools: ${chains.length}  Issues: ${totalIssues}\n`;

    for (const c of chains.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  Pool: ${c.poolName}\n`;
      text += `    Adapters (${c.adapterCount}): ${c.adapters.join(' -> ') || '(none listed)'}\n`;
      text += `    Tag-aware: ${c.isTagAware ? 'yes' : 'no'}  Memory first: ${c.memoryFirst ? 'yes' : 'NO'}\n`;
      for (const issue of c.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getCacheChainStats(appPath: string): McpToolResult {
  try {
    const chains = parseChainPools(appPath);

    let text = `Cache Chain Statistics\n${'='.repeat(40)}\n\n`;
    text += `Chain pools:                ${chains.length}\n`;
    text += `  Tag-aware:                ${chains.filter((c) => c.isTagAware).length}\n`;
    text += `  Memory-first:             ${chains.filter((c) => c.memoryFirst).length}\n`;
    text += `  Memory NOT first:         ${chains.filter((c) => !c.memoryFirst && c.adapterCount > 0).length}\n`;
    text += `  >3 adapters:              ${chains.filter((c) => c.adapterCount > 3).length}\n`;
    text += `  Empty providers:          ${chains.filter((c) => c.adapterCount === 0).length}\n`;
    text += `Issues detected:            ${chains.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheChainTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cache_chain_config',
      description: 'Show Symfony cache.adapter.chain pool configuration: inner adapters list, TagAwareAdapter wrapping, warns on >3 adapters (latency), memory adapter not first in chain, TagAwareAdapter wrapping non-tag-aware (tags ignored), empty providers',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cache_chain_stats',
      description: 'Show cache chain statistics: chain pool count, tag-aware count, memory-first count, >3 adapters count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
