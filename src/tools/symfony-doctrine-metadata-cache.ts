// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Doctrine Metadata Cache Inspector
 *
 * Reads config/packages/doctrine.yaml to discover:
 *   - metadata_cache_driver, query_cache_driver, result_cache_driver config
 *   - server_version setting (needed for proper metadata)
 *
 * Flags: no metadata cache in prod, array cache in non-dev,
 *        FilesystemAdapter in prod (slow).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MetadataCacheInfo {
  driver: string;
  pool: string;
  environment: string;
  issues: string[];
}

function sanitizeDsn(val: string): string {
  return val
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

function readYamlRaw(filePath: string, appPath: string): string {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep)) return '';
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function extractDriverValue(content: string, key: string): string {
  // Match key: value (YAML scalar) or key:\n  type: ...
  const lineM = new RegExp(`${key}:\\s*([^\\n\\r]+)`).exec(content);
  if (lineM) return lineM[1].trim();
  return 'none';
}

function extractPoolName(content: string, key: string): string {
  // Look for pool: under the key section
  const keyIdx = content.indexOf(key + ':');
  if (keyIdx === -1) return 'none';
  const section = content.slice(keyIdx, keyIdx + 300);
  const poolM = /pool:\s*([^\n\r]+)/.exec(section);
  if (poolM) return poolM[1].trim();
  return 'none';
}

function detectEnvironment(filePath: string, content: string): string {
  if (filePath.includes('/dev/')) return 'dev';
  if (filePath.includes('/prod/')) return 'prod';
  if (filePath.includes('/test/')) return 'test';
  // Check when: '@=...' or env conditions in YAML
  if (content.includes('when@prod')) return 'prod+dev';
  return 'all';
}

function analyzeDoctrineYaml(yamlPath: string, appPath: string): MetadataCacheInfo[] {
  const content = readYamlRaw(yamlPath, appPath);
  if (!content) return [];

  const results: MetadataCacheInfo[] = [];
  const env = detectEnvironment(yamlPath, content);

  // Parse metadata_cache_driver
  const hasMetadataCache = content.includes('metadata_cache_driver');
  const hasQueryCache = content.includes('query_cache_driver');
  const hasServerVersion = content.includes('server_version');

  // Extract each cache driver config
  const cacheTypes: Array<{ key: string; label: string }> = [
    { key: 'metadata_cache_driver', label: 'metadata' },
    { key: 'query_cache_driver', label: 'query' },
    { key: 'result_cache_driver', label: 'result' },
  ];

  for (const { key, label } of cacheTypes) {
    if (!content.includes(key)) continue;

    const driver = extractDriverValue(content, key);
    const pool = extractPoolName(content, key);
    const issues: string[] = [];

    // Flag: array cache in non-dev environments
    if (driver.includes('array') && env !== 'dev') {
      issues.push(`${label} cache uses array driver — resets on every request; use a persistent cache pool (Redis/APCu/filesystem) in ${env}`);
    }

    // Flag: FilesystemAdapter in prod (slow due to disk I/O)
    if ((driver.includes('filesystem') || driver.includes('Filesystem') || pool.includes('filesystem')) && env === 'prod') {
      issues.push(`${label} cache uses FilesystemAdapter in prod — disk I/O makes this slow; prefer Redis or APCu`);
    }

    // Flag: no server_version (metadata resolution issues)
    if (label === 'metadata' && !hasServerVersion) {
      issues.push('server_version not set in doctrine.dbal — Doctrine may resolve incorrect metadata for your database version');
    }

    results.push({ driver, pool, environment: env, issues });
  }

  // Check overall: no metadata cache at all
  if (!hasMetadataCache && env !== 'dev') {
    const issues = ['No metadata_cache_driver configured — Doctrine re-parses entity metadata on every request in ' + env];
    if (!hasServerVersion) {
      issues.push('server_version not set — set it to the actual DB server version for correct platform-specific behavior');
    }
    results.push({ driver: 'none', pool: 'none', environment: env, issues });
  }

  // Warn if query cache not configured in prod
  if (!hasQueryCache && env !== 'dev') {
    results.push({
      driver: 'none',
      pool: 'none',
      environment: env,
      issues: ['No query_cache_driver configured — DQL queries are re-parsed on every execution in ' + env],
    });
  }

  return results;
}

function buildMetadataCacheInfos(appPath: string): MetadataCacheInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine.yml'),
    path.join(appPath, 'config', 'packages', 'prod', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'doctrine.yml'),
    path.join(appPath, 'config', 'packages', 'dev', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'doctrine.yml'),
  ];

  const results: MetadataCacheInfo[] = [];
  for (const yamlPath of candidates) {
    const resolved = path.resolve(yamlPath);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    if (!fs.existsSync(yamlPath)) continue;
    results.push(...analyzeDoctrineYaml(yamlPath, appPath));
  }

  return results;
}

export function listSymfonyDoctrineMetadataCache(appPath: string): McpToolResult {
  try {
    const infos = buildMetadataCacheInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No doctrine.yaml found or no cache driver configuration detected.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Doctrine Metadata Cache Analysis\n${'='.repeat(55)}\n\n`;
    text += `Cache driver entries found: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos) {
      text += `  Driver: ${sanitizeDsn(info.driver)}  Pool: ${info.pool}  Env: ${info.environment}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineMetadataCacheStats(appPath: string): McpToolResult {
  try {
    const infos = buildMetadataCacheInfos(appPath);

    const withArray = infos.filter((i) => i.driver.includes('array')).length;
    const withFilesystem = infos.filter((i) => i.driver.includes('filesystem') || i.pool.includes('filesystem')).length;
    const withNone = infos.filter((i) => i.driver === 'none').length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Doctrine Metadata Cache Statistics\n${'='.repeat(45)}\n\n`;
    text += `Cache driver entries: ${infos.length}\n`;
    text += `  Using array driver:       ${withArray}\n`;
    text += `  Using filesystem adapter: ${withFilesystem}\n`;
    text += `  Not configured:           ${withNone}\n`;
    text += `Total issues:              ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyDoctrineMetadataCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_doctrine_metadata_cache',
      description: 'List Symfony Doctrine metadata/query/result cache configuration from doctrine.yaml: driver and pool per environment, flags missing cache in prod, array cache in non-dev, FilesystemAdapter in prod, missing server_version',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_doctrine_metadata_cache_stats',
      description: 'Show Symfony Doctrine metadata cache statistics: count by driver type (array/filesystem/none), total issues found',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
