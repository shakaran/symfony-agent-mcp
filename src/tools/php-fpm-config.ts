import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpFpmPool {
  pool: string;
  pm: string;
  maxChildren: number;
  startServers: number;
  minSpare: number;
  maxSpare: number;
  slowlogThreshold: string;
  issues: string[];
}

function extractIniValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function findFpmFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'docker', 'php-fpm', 'www.conf'),
    path.join(appPath, 'docker', 'php', 'www.conf'),
    path.join(appPath, '.docker', 'fpm', 'www.conf'),
    path.join(appPath, 'docker', 'php-fpm.conf'),
    path.join(appPath, 'docker', 'php', 'php-fpm.conf'),
    path.join(appPath, 'php-fpm.d', 'www.conf'),
    path.join(appPath, 'www.conf'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

function buildFpmPools(appPath: string): PhpFpmPool[] {
  const files = findFpmFiles(appPath);
  const results: PhpFpmPool[] = [];

  if (files.length === 0) {
    return [{ pool: 'not-found', pm: '', maxChildren: 0, startServers: 0, minSpare: 0, maxSpare: 0, slowlogThreshold: '', issues: ['No PHP-FPM pool configuration files found (www.conf, php-fpm.conf)'] }];
  }

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const pool = extractIniValue(content, '\\[\\w') ?? path.basename(file);
    const pm = extractIniValue(content, 'pm') ?? '';
    const maxChildren = parseInt(extractIniValue(content, 'pm\\.max_children') ?? '0', 10);
    const startServers = parseInt(extractIniValue(content, 'pm\\.start_servers') ?? '0', 10);
    const minSpare = parseInt(extractIniValue(content, 'pm\\.min_spare_servers') ?? '0', 10);
    const maxSpare = parseInt(extractIniValue(content, 'pm\\.max_spare_servers') ?? '0', 10);
    const slowlogThreshold = extractIniValue(content, 'request_slowlog_timeout') ?? '';
    const hasSlowlog = content.includes('slowlog') && content.includes('request_slowlog_timeout');

    const issues: string[] = [];

    if (pm === 'static' && maxChildren > 20) {
      issues.push(`pm=static with max_children=${maxChildren} — static mode allocates all workers at start; reduce if memory is limited`);
    }
    if (maxChildren > 0 && maxChildren < 5) {
      issues.push(`pm.max_children=${maxChildren} is very low — may bottleneck concurrent requests`);
    }
    if (!hasSlowlog || slowlogThreshold === '' || slowlogThreshold === '0') {
      issues.push('No slowlog configured — slow PHP requests not detected (add request_slowlog_timeout=5s and slowlog path)');
    }
    if (maxChildren > 50 && pm !== 'static') {
      issues.push(`pm.max_children=${maxChildren} is high for dynamic mode — verify memory budget allows this many workers`);
    }

    results.push({ pool, pm, maxChildren, startServers, minSpare, maxSpare, slowlogThreshold, issues });
  }

  return results;
}

export function listPhpFpmConfig(appPath: string): McpToolResult {
  try {
    const pools = buildFpmPools(appPath);
    const totalIssues = pools.reduce((s, p) => s + p.issues.length, 0);
    let text = `PHP-FPM Pool Configuration\n${'='.repeat(50)}\n\nPools: ${pools.length}  Issues: ${totalIssues}\n`;
    for (const pool of pools) {
      text += `\n  Pool: ${pool.pool}\n`;
      text += `    pm: ${pool.pm || '(not set)'}  max_children: ${pool.maxChildren}  start_servers: ${pool.startServers}\n`;
      text += `    min_spare: ${pool.minSpare}  max_spare: ${pool.maxSpare}  slowlog_timeout: ${pool.slowlogThreshold || '(not set)'}\n`;
      for (const issue of pool.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFpmStats(appPath: string): McpToolResult {
  try {
    const pools = buildFpmPools(appPath);
    let text = `PHP-FPM Statistics\n${'='.repeat(40)}\n\n`;
    text += `Pools found:           ${pools.length}\n`;
    text += `  pm=dynamic:          ${pools.filter((p) => p.pm === 'dynamic').length}\n`;
    text += `  pm=static:           ${pools.filter((p) => p.pm === 'static').length}\n`;
    text += `  pm=ondemand:         ${pools.filter((p) => p.pm === 'ondemand').length}\n`;
    text += `  With slowlog:        ${pools.filter((p) => p.slowlogThreshold !== '').length}\n`;
    text += `Total issues:          ${pools.reduce((s, p) => s + p.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFpmTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_fpm_config', description: 'Analyze PHP-FPM pool configuration (www.conf); warns on static pm with high max_children, low max_children bottleneck, missing slowlog, excessive workers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_fpm_stats', description: 'Statistics for PHP-FPM pools: count, pm strategy breakdown, slowlog coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
