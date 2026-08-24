// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Cache Redis Sentinel Configuration Inspector
 *
 * Scans .env* files and config/packages/cache.yaml for Redis Sentinel DSN patterns.
 * Checks for HA configuration issues: missing password, no failover timeout,
 * single sentinel (no real HA), and pool configuration problems.
 * Passwords in DSNs are masked before output.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RedisSentinelInfo {
  dsn: string;
  master: string;
  sentinels: string[];
  issues: string[];
}

function collectConfigFiles(dir: string, base: string, exts: string[]): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectConfigFiles(full, base, exts));
    else if (exts.some(e => entry.endsWith(e))) results.push(full);
  }
  return results;
}

function maskPassword(dsn: string): string {
  return dsn
    .replace(/:([^@/\s]{1,200})@/g, ':***@')
    .replace(/:\/\/([^@:/\s]{1,200})@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret)=[^&\s]*/gi, '$1$2=***');
}

function parseSentinelDsn(rawDsn: string): RedisSentinelInfo | null {
  // redis+sentinel://[user:password@]sentinel1:port,sentinel2:port/master/db
  if (!rawDsn.includes('redis+sentinel://') && !rawDsn.includes('sentinel')) return null;

  const dsn = maskPassword(rawDsn);
  const issues: string[] = [];

  // Extract master name from path
  const pathMatch = /redis\+sentinel:\/\/[^/]+(\/[^/]+\/[^/\s?]+)?/.exec(rawDsn);
  const pathPart = pathMatch ? pathMatch[1] ?? '' : '';
  const pathSegments = pathPart.split('/').filter(Boolean);
  const master = pathSegments[0] ?? 'mymaster';

  // Extract host:port pairs (sentinels)
  const hostSection = rawDsn.replace(/redis\+sentinel:\/\//, '').split('/')[0];
  const authStripped = hostSection.replace(/^[^@]+@/, '');
  const sentinels = authStripped.split(',').map(s => s.trim()).filter(Boolean);

  // Check password
  if (!/@/.test(rawDsn) || /:@/.test(rawDsn)) {
    issues.push('No password in Redis Sentinel DSN — production Sentinel clusters should require auth');
  }

  // Check single sentinel
  if (sentinels.length < 2) {
    issues.push('Only one Sentinel host configured — minimum 3 Sentinels required for real high availability');
  } else if (sentinels.length === 2) {
    issues.push('Only two Sentinel hosts — minimum 3 Sentinels needed for quorum (split-brain risk)');
  }

  return { dsn, master, sentinels, issues };
}

function buildRedisSentinelInfos(appPath: string): RedisSentinelInfo[] {
  const infos: RedisSentinelInfo[] = [];
  const seen = new Set<string>();

  // Scan .env* files in appPath root
  let rootEntries: string[] = [];
  try { rootEntries = fs.readdirSync(appPath); } catch { rootEntries = []; }
  for (const entry of rootEntries) {
    if (!entry.startsWith('.env')) continue;
    const full = path.join(appPath, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let content = '';
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('sentinel')) continue;
      // Match DSN assignments: KEY=value
      const assignMatch = /^[A-Z_]{1,80}=(.+)$/.exec(trimmed);
      if (!assignMatch) continue;
      const val = assignMatch[1].replace(/^["']|["']$/g, '');
      if (!val.includes('redis+sentinel://')) continue;
      const key = maskPassword(val);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = parseSentinelDsn(val);
      if (info) {
        // Also check for missing timeout hint
        if (!content.includes('timeout') && !content.includes('TIMEOUT')) {
          info.issues.push('No failover timeout configured — set redis_sentinel options (timeout, read_timeout)');
        }
        infos.push(info);
      }
    }
  }

  // Scan config/packages/cache.yaml
  const configDir = path.join(appPath, 'config');
  const configFiles = collectConfigFiles(configDir, appPath, ['.yaml', '.yml']);

  for (const file of configFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('sentinel')) continue;

    // Find redis sentinel DSN patterns
    const dsnPattern = /redis\+sentinel:\/\/[^\s"'#]{4,300}/g;
    let m: RegExpExecArray | null;
    while ((m = dsnPattern.exec(content)) !== null) {
      const raw = m[0].replace(/['"]/g, '');
      const key = maskPassword(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = parseSentinelDsn(raw);
      if (info) {
        // Check for timeout in the same file
        if (!content.includes('timeout')) {
          info.issues.push('No failover timeout configured in cache pool options');
        }
        infos.push(info);
      }
    }

    // Check framework.cache pools using sentinel adapters
    if (/sentinel_adapter|SentinelAdapter|RedisTagAwareAdapter/.test(content)) {
      const dummyKey = `sentinel-adapter:${file}`;
      if (!seen.has(dummyKey)) {
        seen.add(dummyKey);
        infos.push({
          dsn: 'adapter (no inline DSN)',
          master: 'see config',
          sentinels: [],
          issues: ['Sentinel adapter detected — verify DSN is injected via env var and not hardcoded'],
        });
      }
    }
  }

  return infos;
}

export function listSymfonyCacheRedisSentinel(appPath: string): McpToolResult {
  try {
    const infos = buildRedisSentinelInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Redis Sentinel DSNs found in .env* or config/packages/cache.yaml.' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony Cache Redis Sentinel Configuration\n${'='.repeat(55)}\n\n`;
    text += `Sentinel configs found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    for (const info of infos) {
      text += `  DSN:      ${info.dsn}\n`;
      text += `  Master:   ${info.master}\n`;
      text += `  Sentinels (${info.sentinels.length}): ${info.sentinels.join(', ') || 'none detected'}\n`;
      for (const issue of info.issues) {
        text += `  ! ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheRedisSentinelStats(appPath: string): McpToolResult {
  try {
    const infos = buildRedisSentinelInfos(appPath);
    const withIssues = infos.filter(i => i.issues.length > 0).length;
    const noPassword = infos.filter(i => i.issues.some(s => s.includes('password'))).length;
    const singleSentinel = infos.filter(i => i.issues.some(s => s.includes('one Sentinel'))).length;
    const twoSentinels = infos.filter(i => i.issues.some(s => s.includes('two Sentinel'))).length;
    const noTimeout = infos.filter(i => i.issues.some(s => s.includes('timeout'))).length;

    let text = `Symfony Redis Sentinel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total sentinel configs: ${infos.length}\n`;
    text += `  With issues:          ${withIssues}\n`;
    text += `  No password:          ${noPassword}\n`;
    text += `  Single sentinel:      ${singleSentinel}\n`;
    text += `  Two sentinels:        ${twoSentinels}\n`;
    text += `  No timeout:           ${noTimeout}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyCacheRedisSentinelTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_cache_redis_sentinel',
      description: 'List Redis Sentinel DSNs from .env* and cache config: master name, sentinel hosts, issues with single sentinel, missing password or failover timeout (passwords masked)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_cache_redis_sentinel_stats',
      description: 'Get Redis Sentinel configuration statistics: total configs, issues by category (no password, single/two sentinels, no timeout)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
