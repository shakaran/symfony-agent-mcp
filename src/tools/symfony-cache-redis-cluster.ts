// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RedisCacheClusterInfo {
  source: string;
  type: 'cluster' | 'sentinel' | 'serializer' | 'prefix' | 'auth';
  pattern: string;
  issues: string[];
}

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function buildSymfonyCacheRedisClusterInfos(appPath: string): RedisCacheClusterInfo[] {
  const results: RedisCacheClusterInfo[] = [];

  const configFiles = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  for (const configFile of configFiles) {
    if (!fs.existsSync(configFile)) continue;
    const content = readFileSafe(configFile);
    const source = path.relative(appPath, configFile);

    if (!content.includes('redis://') && !content.includes('rediss://') && !content.includes('redis+cluster://') && !content.includes('redis+sentinel://')) continue;

    if (content.includes('redis://') && !content.includes('redis+cluster://') && !content.includes('redis+sentinel://')) {
      const hostCount = (content.match(/redis:\/\//g) ?? []).length;
      if (hostCount > 1) {
        results.push({ source, type: 'cluster', pattern: 'multiple redis:// DSNs', issues: ['Single Redis DSN for multi-host Redis — use redis+cluster:// for Cluster mode or redis+sentinel:// for Sentinel/HA mode'] });
      }
    }

    if (content.includes('redis+cluster://')) {
      results.push({ source, type: 'cluster', pattern: 'redis+cluster://', issues: [] });
    }
    if (content.includes('redis+sentinel://')) {
      results.push({ source, type: 'sentinel', pattern: 'redis+sentinel://', issues: [] });
    }

    if (!content.includes('serializer') && (content.includes('redis://') || content.includes('redis+cluster://'))) {
      results.push({ source, type: 'serializer', pattern: 'no serializer configured', issues: ['Redis cache without serializer configuration — default PHP serializer can be slow; consider using igbinary or msgpack for better performance'] });
    }

    if (!content.includes('namespace') && !content.includes('prefix_seed') && (content.includes('redis://') || content.includes('redis+cluster://'))) {
      results.push({ source, type: 'prefix', pattern: 'no namespace/prefix', issues: ['Redis cache without namespace/prefix — multiple applications sharing Redis may have key collisions; set app.cache.prefix_seed or cache pool namespace'] });
    }
  }

  // Check .env for REDIS_URL
  const envFiles = ['.env', '.env.local'];
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    const content = readFileSafe(envPath);
    const match = content.match(/REDIS_URL=(.+)/);
    if (!match) continue;
    const dsn = match[1].trim();

    if (/:\/\/[^@]+:[^@]+@/.test(dsn) && !dsn.includes('%env(')) {
      results.push({ source: envFile, type: 'auth', pattern: 'REDIS_URL with literal password', issues: ['Redis URL contains plaintext password in env file — use secrets management or Symfony secrets vault'] });
    }
    if (!dsn.startsWith('rediss://') && !dsn.includes('localhost') && !dsn.includes('127.0.0.1')) {
      results.push({ source: envFile, type: 'auth', pattern: 'REDIS_URL without TLS', issues: ['Redis connection without TLS (use rediss://) — credentials and data transmitted in plaintext over network'] });
    }
  }

  return results;
}

export function listSymfonyCacheRedisCluster(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyCacheRedisClusterInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Redis cache configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Cache Redis Cluster Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheRedisClusterStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyCacheRedisClusterInfos(appPath);
    let text = `Symfony Cache Redis Cluster Statistics\n${'='.repeat(40)}\n\n`;
    text += `Cluster:     ${infos.filter((i) => i.type === 'cluster').length}\n`;
    text += `Sentinel:    ${infos.filter((i) => i.type === 'sentinel').length}\n`;
    text += `Serializer:  ${infos.filter((i) => i.type === 'serializer').length}\n`;
    text += `Prefix:      ${infos.filter((i) => i.type === 'prefix').length}\n`;
    text += `Auth:        ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheRedisClusterTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_cache_redis_cluster', description: 'Analyze Symfony Redis cache configuration: cluster/sentinel mode, serializer, namespace/prefix, TLS and credential security', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_cache_redis_cluster_stats', description: 'Statistics for Symfony Redis cache: counts by type (cluster/sentinel/serializer/prefix/auth) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
