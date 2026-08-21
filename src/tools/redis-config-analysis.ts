import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface RedisUsage {
  context: string;
  dsn: string;
  driver: 'redis' | 'rediss' | 'sentinel' | 'cluster' | 'unknown';
  options: Record<string, unknown>;
  issues: string[];
}

function detectDriver(dsn: string): RedisUsage['driver'] {
  if (dsn.includes('redis+sentinel://')) return 'sentinel';
  if (dsn.includes('redis+cluster://') || dsn.includes('rediscluster://')) return 'cluster';
  if (dsn.startsWith('rediss://')) return 'rediss';
  if (dsn.startsWith('redis://') || dsn.startsWith('%env(REDIS')) return 'redis';
  return 'unknown';
}

function maskDsn(dsn: string): string {
  return dsn.replace(/:([^:@\s]{1,200})@/, ':***@');
}

function loadRedisUsages(appPath: string): RedisUsage[] {
  const usages: RedisUsage[] = [];
  const configFiles = [
    { file: path.join(appPath, 'config', 'packages', 'cache.yaml'), context: 'cache' },
    { file: path.join(appPath, 'config', 'packages', 'framework.yaml'), context: 'framework' },
    { file: path.join(appPath, 'config', 'packages', 'messenger.yaml'), context: 'messenger' },
    { file: path.join(appPath, 'config', 'packages', 'session.yaml'), context: 'session' },
  ];
  for (const { file, context } of configFiles) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;
    const content = JSON.stringify(raw);
    const redisDsnRe = /"((?:redis|rediss)[^"]{0,300})"/g;
    let m: RegExpExecArray | null;
    while ((m = redisDsnRe.exec(content)) !== null) {
      const dsn = m[1];
      const driver = detectDriver(dsn);
      const issues: string[] = [];
      if (driver === 'redis' && !dsn.includes('tls')) issues.push('Redis without TLS (rediss://) — data in transit not encrypted');
      if (driver === 'redis' && !dsn.includes('auth') && !dsn.includes('@') && !dsn.includes('%env(REDIS_PASSWORD')) issues.push('Redis DSN without authentication — use rediss://user:password@host or REDIS_PASSWORD env var');
      if (driver === 'sentinel') issues.push('Using Redis Sentinel — ensure sentinel_master is correctly configured for failover');
      usages.push({ context, dsn: maskDsn(dsn), driver, options: {}, issues });
    }
  }
  return usages;
}

export function listRedisConfig(appPath: string): McpToolResult {
  try {
    const usages = loadRedisUsages(appPath);
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No Redis configuration found in YAML files.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Redis Configuration\n${'='.repeat(55)}\n\nConnections: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  [${u.context}]  driver: ${u.driver}\n    DSN: ${u.dsn}\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRedisConfigStats(appPath: string): McpToolResult {
  try {
    const usages = loadRedisUsages(appPath);
    const drivers = new Map<string, number>();
    for (const u of usages) drivers.set(u.driver, (drivers.get(u.driver) ?? 0) + 1);
    let text = `Redis Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total Redis connections: ${usages.length}\n`;
    for (const [d, c] of drivers.entries()) text += `  ${d}: ${c}\n`;
    text += `Issues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRedisConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_redis_config', description: 'Analyze Redis connections across cache/session/messenger/framework YAML: driver (redis/rediss/sentinel/cluster), TLS warning, missing authentication warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_redis_config_stats', description: 'Redis configuration statistics: connection count, driver breakdown, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
