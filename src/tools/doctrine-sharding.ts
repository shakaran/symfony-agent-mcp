/**
 * Doctrine DBAL Sharding Inspector
 *
 * Detects Doctrine DBAL sharding configuration (ShardChoser, PoolingShardManager).
 * Pure static analysis — reads YAML config and PHP source files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DoctrineShardingInfo {
  hasSharding: boolean;
  shardCount: number;
  shardChoser: string;
  issues: string[];
}

function readFileOr(filePath: string, fallback: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return fallback; }
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function findDoctrineYaml(appPath: string): string {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'doctrine.yaml'),
    path.join(appPath, 'app', 'config', 'config.yml'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* skip */ }
  }
  return '';
}

function analyzeSharding(appPath: string): DoctrineShardingInfo {
  const yamlPath = findDoctrineYaml(appPath);
  const yamlContent = yamlPath ? readFileOr(yamlPath, '') : '';

  const hasShardingYaml = yamlContent.includes('shards') ||
    yamlContent.includes('shard_choser') ||
    yamlContent.includes('PoolingShardConnectionWrapper') ||
    yamlContent.includes('ShardManager');

  const srcDir = path.join(appPath, 'src');
  let hasShardingCode = false;
  let hasSelectShardWithoutTx = false;
  let hasShardManagerWithOrm = false;
  let phpShardChoser = '';

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('ShardManager') && !content.includes('selectShard') &&
      !content.includes('getActiveShards') && !content.includes('Doctrine\\DBAL\\Sharding')) {
      continue;
    }

    hasShardingCode = true;

    if (content.includes('selectShard(') && !content.includes('beginTransaction')) {
      hasSelectShardWithoutTx = true;
    }

    if (content.includes('ShardManager') && content.includes('EntityManager')) {
      hasShardManagerWithOrm = true;
    }

    const choserM = /ShardChoser[^;]{0,100}class\s+(\w{1,80})/i.exec(content);
    if (choserM && !phpShardChoser) phpShardChoser = choserM[1];
  }

  const hasSharding = hasShardingYaml || hasShardingCode;

  // Count shard blocks in YAML
  let shardCount = 0;
  const shardMatches = yamlContent.match(/shard_\d{1,5}\s*:/g) ?? [];
  shardCount = shardMatches.length;
  if (shardCount === 0 && hasShardingYaml) shardCount = (yamlContent.match(/shards\s*:/g) ?? []).length;

  // Extract shardChoser from YAML
  let shardChoser = phpShardChoser;
  const choserM = /shard_choser\s*:\s*([^\n]{1,200})/.exec(yamlContent);
  if (choserM) shardChoser = choserM[1].trim();

  const issues: string[] = [];

  if (hasSharding && !shardChoser) {
    issues.push('Sharding configured without ShardChoser — default choser likely incorrect for production use');
  }

  if (hasSelectShardWithoutTx) {
    issues.push('selectShard() called without beginTransaction() — shard selection is unsafe outside a transaction');
  }

  // Check for overlapping shard ranges in YAML
  const rangeMatches = [...yamlContent.matchAll(/range\s*:\s*(\d{1,20})\s*-\s*(\d{1,20})/g)];
  const ranges: Array<[number, number]> = rangeMatches.map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)]);
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const [aStart, aEnd] = ranges[i] ?? [0, 0];
      const [bStart, bEnd] = ranges[j] ?? [0, 0];
      if (aStart <= bEnd && bStart <= aEnd) {
        issues.push(`Overlapping shard ranges detected: [${aStart}-${aEnd}] and [${bStart}-${bEnd}] — data may go to multiple shards`);
      }
    }
  }

  if (hasShardManagerWithOrm) {
    issues.push('ShardManager used alongside EntityManager — DBAL sharding is not supported by Doctrine ORM, use DBAL connection directly');
  }

  return { hasSharding, shardCount, shardChoser, issues };
}

export function listDoctrineShardingConfig(appPath: string): McpToolResult {
  try {
    const info = analyzeSharding(appPath);

    if (!info.hasSharding) {
      return { content: [{ type: 'text', text: 'No Doctrine DBAL sharding configuration or usage found.' }] };
    }

    let text = `Doctrine DBAL Sharding Configuration\n${'='.repeat(55)}\n\n`;
    text += `Has sharding:   ${info.hasSharding ? 'yes' : 'no'}\n`;
    text += `Shard count:    ${info.shardCount}\n`;
    text += `Shard choser:   ${info.shardChoser || '(not configured)'}\n`;
    text += `Issues:         ${info.issues.length}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineShardingStats(appPath: string): McpToolResult {
  try {
    const info = analyzeSharding(appPath);

    let text = `Doctrine DBAL Sharding Statistics\n${'='.repeat(40)}\n\n`;
    text += `Sharding enabled:  ${info.hasSharding ? 'yes' : 'no'}\n`;
    text += `Shard count:       ${info.shardCount}\n`;
    text += `ShardChoser:       ${info.shardChoser || 'none'}\n`;
    text += `Issues:            ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineShardingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_sharding_config',
      description: 'Detect Doctrine DBAL sharding: reads doctrine.yaml for shards/shard_choser/PoolingShardConnectionWrapper, scans src/ for ShardManager/getActiveShards()/selectShard(); warns on missing ShardChoser, selectShard() without beginTransaction, overlapping shard ranges, ShardManager used with ORM EntityManager',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_sharding_stats',
      description: 'Statistics for Doctrine DBAL sharding: whether sharding is enabled, shard count, ShardChoser, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
