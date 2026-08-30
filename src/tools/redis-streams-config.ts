// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RedisStreamsInfo {
  source: string;
  type: 'stream' | 'consumer-group' | 'maxlen' | 'transport' | 'config';
  directive: string;
  value: string;
  issues: string[];
}

function buildRedisStreamsInfos(appPath: string): RedisStreamsInfo[] {
  const results: RedisStreamsInfo[] = [];

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('redis://') || content.includes('REDIS_URL') || content.includes('%env(REDIS')) {
      const issues: string[] = [];

      const hasStream = content.includes('stream:') || content.includes('/messages');
      if (!hasStream) {
        issues.push('Redis Messenger transport without explicit stream name — defaults to "messages" stream; name streams explicitly to separate message types and enable per-stream monitoring');
      }

      const hasGroup = content.includes('group:') || content.includes('consumer_group:');
      if (!hasGroup) {
        issues.push('Redis Messenger transport without consumer group — multiple workers would duplicate message processing; add group: my_app_consumers for proper distributed consumption');
      }

      const hasMaxLen = content.includes('maxlen:') || content.includes('max_entries:');
      if (!hasMaxLen) {
        issues.push('Redis stream transport without maxlen — stream grows unboundedly; add maxlen: 0 (trimmed to 1000 messages approx) or maxlen: 10000 to cap stream memory usage');
      }

      const hasAck = content.includes('delete_after_ack:') || content.includes('reclaimTimeout:') || content.includes('reclaim_timeout:');
      if (!hasAck) {
        issues.push('Redis stream transport without delete_after_ack or reclaimTimeout — unacknowledged messages accumulate in PEL (pending entry list) and are never reclaimed after worker crash');
      }

      results.push({ source: 'messenger.yaml', type: 'transport', directive: 'Redis stream transport', value: 'redis://', issues });
    }
  }

  const redisDsn = [
    path.join(appPath, 'config', 'packages', 'snc_redis.yaml'),
    path.join(appPath, 'config', 'packages', 'snc_redis.yml'),
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yml'),
    path.join(appPath, '.env'),
  ];

  for (const cfgPath of redisDsn) {
    if (!fs.existsSync(cfgPath)) continue;
    let content = '';
    try { content = fs.readFileSync(cfgPath, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, cfgPath);

    if (content.includes('redis://') || content.includes('rediss://')) {
      const hasPassword = content.includes('redis://:') || content.includes('@') || content.includes('password:');
      const hasTls = content.includes('rediss://') || content.includes('tls:');
      const issues: string[] = [];

      if (!hasPassword) {
        issues.push(`Redis DSN in "${relFile}" without password — Redis without authentication is accessible to any host on the same network; add :password@ to the DSN and set requirepass in redis.conf`);
      }
      if (!hasTls && content.includes('rediss://') === false) {
        issues.push(`Redis DSN in "${relFile}" uses unencrypted redis:// — use rediss:// (TLS) for connections over non-localhost networks to prevent credential and data exposure`);
      }

      results.push({ source: relFile, type: 'config', directive: 'Redis DSN', value: 'redis://', issues });
    }
  }

  return results;
}

export function listRedisStreamsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildRedisStreamsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Redis Streams configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Redis Streams Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRedisStreamsConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildRedisStreamsInfos(appPath);
    let text = `Redis Streams Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Config:      ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRedisStreamsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_redis_streams_config', description: 'Analyze Redis Streams configuration for Messenger transport; warns on missing stream name, no consumer group, no maxlen cap, no delete_after_ack/reclaimTimeout, Redis DSN without password or TLS', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_redis_streams_config_stats', description: 'Statistics for Redis Streams config: transport/config count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
