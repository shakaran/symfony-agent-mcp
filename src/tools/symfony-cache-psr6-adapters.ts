// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Cache PSR-6/PSR-16 Adapter Inspector
 *
 * Scans src/**\/*.php and config/**\/*.yaml for cache adapter misuse:
 *   - CacheItemPoolInterface (PSR-6) and CacheInterface (PSR-16) mixed in same service
 *   - Psr16Cache wrapping a pool that wraps another pool (double-wrapping)
 *   - TagAwareAdapter used without invalidateTags() anywhere
 *   - ChainAdapter with pools ordered slowest-first
 *   - NullAdapter in non-test environment
 *   - FilesystemAdapter with empty namespace
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CacheServiceInfo {
  file: string;
  className: string;
  usesPsr6: boolean;
  usesPsr16: boolean;
  usesPsr16Cache: boolean;
  usesTagAwareAdapter: boolean;
  usesInvalidateTags: boolean;
  usesChainAdapter: boolean;
  usesNullAdapter: boolean;
  usesFilesystemAdapter: boolean;
  filesystemNamespace: string;
  issues: string[];
}

interface YamlCachePool {
  name: string;
  adapter: string;
  namespace: string;
  file: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllYamlFiles(full));
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function scanPhpCacheUsage(appPath: string): CacheServiceInfo[] {
  const resolvedBase = path.resolve(appPath);
  const srcDir = path.join(resolvedBase, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CacheServiceInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (!path.resolve(file).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasCacheUsage = content.includes('CacheItemPool') ||
                          content.includes('CacheInterface') ||
                          content.includes('Psr16Cache') ||
                          content.includes('TagAwareAdapter') ||
                          content.includes('ChainAdapter') ||
                          content.includes('NullAdapter') ||
                          content.includes('FilesystemAdapter') ||
                          content.includes('invalidateTags');

    if (!hasCacheUsage) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    const usesPsr6 = content.includes('CacheItemPoolInterface') || content.includes('CacheItemPool');
    const usesPsr16 = content.includes('CacheInterface') && (
      content.includes('Symfony\\Contracts\\Cache\\CacheInterface') ||
      content.includes('Psr\\SimpleCache\\CacheInterface')
    );
    const usesPsr16Cache = content.includes('Psr16Cache');
    const usesTagAwareAdapter = content.includes('TagAwareAdapter') || content.includes('TagAwareCacheInterface');
    const usesInvalidateTags = content.includes('invalidateTags(');
    const usesChainAdapter = content.includes('ChainAdapter');
    const usesNullAdapter = content.includes('NullAdapter');
    const usesFilesystemAdapter = content.includes('FilesystemAdapter');

    // Extract namespace from new FilesystemAdapter($dir, '')
    let filesystemNamespace = '';
    const fsMatch = /new\s+FilesystemAdapter\s*\(\s*([^,)]+),\s*(['"]?)(\w*)\2/.exec(content);
    if (fsMatch) {
      filesystemNamespace = fsMatch[3];
    }

    const issues: string[] = [];

    if (usesPsr6 && usesPsr16) {
      issues.push('Both PSR-6 CacheItemPoolInterface and PSR-16/Symfony CacheInterface used in same service — pick one interface; mixing creates confusion and double-wrapping risk');
    }

    if (usesTagAwareAdapter && !usesInvalidateTags) {
      issues.push('TagAwareAdapter used but invalidateTags() never called in this file — tags are configured but may never be purged; check if invalidation happens elsewhere');
    }

    if (usesFilesystemAdapter && filesystemNamespace === '') {
      issues.push('FilesystemAdapter created with empty namespace — if multiple apps share the same cache directory, keys may collide; set a unique namespace string');
    }

    if (usesPsr16Cache) {
      // Check if it wraps another Psr16Cache — double wrapping
      const wrappedMatch = /new\s+Psr16Cache\s*\(\s*new\s+Psr16Cache/.exec(content);
      if (wrappedMatch) {
        issues.push('Psr16Cache wrapping another Psr16Cache — double-wrapping adds overhead without benefit; wrap the underlying pool directly');
      }
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      usesPsr6,
      usesPsr16,
      usesPsr16Cache,
      usesTagAwareAdapter,
      usesInvalidateTags,
      usesChainAdapter,
      usesNullAdapter,
      usesFilesystemAdapter,
      filesystemNamespace,
      issues,
    });
  }

  return results;
}

function scanYamlCachePools(appPath: string): YamlCachePool[] {
  const resolvedBase = path.resolve(appPath);
  const configDir = path.join(resolvedBase, 'config');
  if (!fs.existsSync(configDir)) return [];

  const pools: YamlCachePool[] = [];

  for (const yamlFile of getAllYamlFiles(configDir)) {
    if (!path.resolve(yamlFile).startsWith(resolvedBase + path.sep)) continue;

    let content = '';
    try { content = fs.readFileSync(yamlFile, 'utf-8'); } catch { continue; }

    if (!content.includes('cache') && !content.includes('adapter')) continue;

    const relFile = path.relative(appPath, yamlFile);
    const isProdFile = relFile.includes('prod') || relFile.includes('production');

    // Extract pool definitions
    const poolBlockRegex = /^( {4,6})(\w[\w_.]+):\s*\n((?:\1 {2}[^\n]*\n)*)/gm;
    let m: RegExpExecArray | null;
    while ((m = poolBlockRegex.exec(content)) !== null) {
      const poolName = m[2];
      const poolBlock = m[3];

      if (!poolBlock.includes('adapter:')) continue;

      const adapterMatch = /adapter:\s*(\S+)/m.exec(poolBlock);
      if (!adapterMatch) continue;

      const adapter = adapterMatch[1];
      const namespaceMatch = /namespace:\s*['"]?([^'"\s]*)['"]?/m.exec(poolBlock);
      const namespace = namespaceMatch ? namespaceMatch[1] : '';

      const issues: string[] = [];

      if (adapter.includes('null') && isProdFile) {
        issues.push(`NullAdapter used in prod config — cache will never store anything; this is likely a misconfiguration`);
      }

      if (adapter.includes('filesystem') && namespace === '') {
        issues.push(`FilesystemAdapter pool "${poolName}" has no namespace — all apps sharing the cache dir may have key collisions`);
      }

      // ChainAdapter: check order (memory first is best practice)
      if (adapter.includes('chain') || poolBlock.includes('adapters:')) {
        const adaptersMatch = /adapters:\s*\n((?:\s+-[^\n]*\n)+)/m.exec(poolBlock);
        if (adaptersMatch) {
          const adapterLines = adaptersMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
          if (adapterLines.length > 1) {
            const firstAdapter = adapterLines[0] ?? '';
            const isMemoryFirst = firstAdapter.includes('array') || firstAdapter.includes('memory') || firstAdapter.includes('apcu');
            if (!isMemoryFirst) {
              issues.push(`ChainAdapter pool "${poolName}": first adapter is not a memory-based adapter (array/apcu) — put fastest adapter first for optimal performance`);
            }
          }
        }
      }

      pools.push({ name: poolName, adapter, namespace, file: relFile, issues });
    }
  }

  return pools;
}

function buildAnalysis(appPath: string): { phpServices: CacheServiceInfo[]; yamlPools: YamlCachePool[] } {
  const phpServices = scanPhpCacheUsage(appPath);
  const yamlPools = scanYamlCachePools(appPath);
  return { phpServices, yamlPools };
}

export function listSymfonyCachePsr6Adapters(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { phpServices, yamlPools } = buildAnalysis(appPath);

    if (phpServices.length === 0 && yamlPools.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Cache PSR-6/PSR-16 adapter usage found.\n\nCommon adapters:\n  - FilesystemAdapter (PSR-6)\n  - ChainAdapter (combines multiple pools)\n  - TagAwareAdapter (adds tag-based invalidation)\n  - Psr16Cache (PSR-16 wrapper around PSR-6 pool)',
        }],
      };
    }

    let text = `Symfony Cache PSR-6/PSR-16 Adapter Audit\n${'='.repeat(55)}\n\n`;

    if (phpServices.length > 0) {
      text += `PHP cache service usage (${phpServices.length} file(s)):\n\n`;
      for (const svc of phpServices) {
        text += `  ${svc.className}  (${svc.file})\n`;
        const tags: string[] = [];
        if (svc.usesPsr6) tags.push('PSR-6');
        if (svc.usesPsr16) tags.push('PSR-16');
        if (svc.usesTagAwareAdapter) tags.push('TagAware');
        if (svc.usesChainAdapter) tags.push('Chain');
        if (svc.usesNullAdapter) tags.push('Null');
        if (svc.usesFilesystemAdapter) tags.push(`Filesystem(ns="${svc.filesystemNamespace}")`);
        text += `    Adapters: [${tags.join(', ')}]\n`;
        for (const issue of svc.issues) {
          text += `    - ${issue}\n`;
        }
        if (svc.issues.length === 0) text += `    [OK]\n`;
        text += '\n';
      }
    }

    if (yamlPools.length > 0) {
      text += `YAML cache pools (${yamlPools.length}):\n\n`;
      for (const pool of yamlPools) {
        text += `  ${pool.name}  adapter: ${pool.adapter}  namespace: "${pool.namespace}"\n`;
        text += `    (${pool.file})\n`;
        for (const issue of pool.issues) {
          text += `    - ${issue}\n`;
        }
        if (pool.issues.length === 0) text += `    [OK]\n`;
        text += '\n';
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

export function getSymfonyCachePsr6AdaptersStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { phpServices, yamlPools } = buildAnalysis(appPath);

    const phpIssues = phpServices.reduce((s, svc) => s + svc.issues.length, 0);
    const yamlIssues = yamlPools.reduce((s, p) => s + p.issues.length, 0);

    let text = `Symfony Cache PSR-6/PSR-16 Adapter Stats\n${'='.repeat(40)}\n\n`;
    text += `PHP files using cache:          ${phpServices.length}\n`;
    text += `  Mixing PSR-6 and PSR-16:      ${phpServices.filter((s) => s.usesPsr6 && s.usesPsr16).length}\n`;
    text += `  TagAware without invalidate:  ${phpServices.filter((s) => s.usesTagAwareAdapter && !s.usesInvalidateTags).length}\n`;
    text += `  Filesystem empty namespace:   ${phpServices.filter((s) => s.usesFilesystemAdapter && s.filesystemNamespace === '').length}\n`;
    text += `  PHP issues total:             ${phpIssues}\n`;
    text += `YAML cache pools:               ${yamlPools.length}\n`;
    text += `  NullAdapter in prod:          ${yamlPools.filter((p) => p.adapter.includes('null') && p.file.includes('prod')).length}\n`;
    text += `  Chain without memory-first:   ${yamlPools.filter((p) => p.issues.some((i) => i.includes('ChainAdapter'))).length}\n`;
    text += `  YAML issues total:            ${yamlIssues}\n`;
    text += `Total issues:                   ${phpIssues + yamlIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyCachePsr6AdaptersTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_cache_psr6_adapters',
      description: 'Audit Symfony Cache adapter usage: PSR-6/PSR-16 mixing in same service, Psr16Cache double-wrapping, TagAwareAdapter without invalidateTags(), ChainAdapter slowest-first order, NullAdapter in prod, FilesystemAdapter empty namespace',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_cache_psr6_adapters_stats',
      description: 'Statistics for Symfony Cache PSR-6/PSR-16 adapters: file count, PSR mixing, TagAware/invalidate ratio, empty namespace, YAML pool issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
