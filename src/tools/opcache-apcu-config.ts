import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface OpcacheApcuConfig {
  opcacheEnabled?: boolean;
  opcachePreload?: string;
  opcacheMemory?: number;
  opcacheValidateTimestamps?: boolean;
  apcuEnabled?: boolean;
  apcuSharedMemory?: number;
  phpVersion?: string;
  configFiles: string[];
  issues: string[];
}

function searchIniFiles(appPath: string): string[] {
  const candidates: string[] = [];
  const searchDirs = [
    path.join(appPath, 'docker'),
    path.join(appPath, '.docker'),
    path.join(appPath, 'docker-compose'),
    appPath,
  ];
  for (const dir of searchDirs) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && (e.name.endsWith('.ini') || e.name === 'php.ini' || e.name.includes('opcache'))) {
          candidates.push(path.join(dir, e.name));
        }
      }
    } catch { /* skip */ }
  }
  return candidates;
}

function loadOpcacheConfig(appPath: string): OpcacheApcuConfig {
  const configFiles: string[] = [];
  const issues: string[] = [];
  let opcacheEnabled: boolean | undefined;
  let opcachePreload: string | undefined;
  let opcacheMemory: number | undefined;
  let opcacheValidateTimestamps: boolean | undefined;
  let apcuEnabled: boolean | undefined;
  let apcuSharedMemory: number | undefined;
  const iniFiles = searchIniFiles(appPath);
  for (const iniPath of iniFiles) {
    let content = '';
    try { content = fs.readFileSync(iniPath, 'utf-8'); } catch { continue; }
    if (!content.includes('opcache') && !content.includes('apcu')) continue;
    configFiles.push(path.relative(appPath, iniPath));
    if (/opcache\.enable\s*=\s*1/.test(content)) opcacheEnabled = true;
    else if (/opcache\.enable\s*=\s*0/.test(content)) opcacheEnabled = false;
    const preloadM = /opcache\.preload\s*=\s*(.+)/.exec(content);
    if (preloadM) opcachePreload = preloadM[1].trim();
    const memM = /opcache\.memory_consumption\s*=\s*(\d+)/.exec(content);
    if (memM) opcacheMemory = parseInt(memM[1], 10);
    if (/opcache\.validate_timestamps\s*=\s*0/.test(content)) opcacheValidateTimestamps = false;
    else if (/opcache\.validate_timestamps\s*=\s*1/.test(content)) opcacheValidateTimestamps = true;
    if (/apcuEnabled|apcu\.enable\s*=\s*1|extension\s*=\s*apcu/.test(content)) apcuEnabled = true;
    const apcuMemM = /apcu\.shm_size\s*=\s*(\d+)/.exec(content);
    if (apcuMemM) apcuSharedMemory = parseInt(apcuMemM[1], 10);
  }
  if (configFiles.length === 0) issues.push('No php.ini/opcache.ini found in project — verify OPcache config in system php.ini');
  if (opcacheEnabled === false) issues.push('OPcache disabled — significant performance penalty in production');
  if (opcacheEnabled && !opcachePreload) issues.push('OPcache enabled without preload script — add opcache.preload for PHP 8+ warm-start performance');
  if (opcacheMemory !== undefined && opcacheMemory < 128) issues.push(`opcache.memory_consumption=${opcacheMemory}M is low — 128-256M recommended for Symfony apps`);
  if (opcacheValidateTimestamps === true) issues.push('opcache.validate_timestamps=1 — set to 0 in production and clear cache on deploy for best performance');
  return { opcacheEnabled, opcachePreload, opcacheMemory, opcacheValidateTimestamps, apcuEnabled, apcuSharedMemory, configFiles, issues };
}

export function listOpcacheApcuConfig(appPath: string): McpToolResult {
  try {
    const config = loadOpcacheConfig(appPath);
    let text = `OPcache / APCu Configuration\n${'='.repeat(55)}\n\nConfig files: ${config.configFiles.length}  Issues: ${config.issues.length}\n`;
    text += `\nOPcache:\n  Enabled: ${config.opcacheEnabled ?? 'unknown'}\n  Memory: ${config.opcacheMemory ? `${config.opcacheMemory}M` : 'unknown'}\n  Preload: ${config.opcachePreload ?? 'not configured'}\n  validate_timestamps: ${config.opcacheValidateTimestamps ?? 'unknown'}\n`;
    text += `\nAPCu:\n  Enabled: ${config.apcuEnabled ?? 'unknown'}\n  Shared memory: ${config.apcuSharedMemory ? `${config.apcuSharedMemory}M` : 'unknown'}\n`;
    if (config.configFiles.length > 0) text += `\nConfig files:\n${config.configFiles.map(f => `  ${f}`).join('\n')}\n`;
    for (const i of config.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpcacheApcuStats(appPath: string): McpToolResult {
  try {
    const config = loadOpcacheConfig(appPath);
    let text = `OPcache/APCu Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files found: ${config.configFiles.length}\nOPcache enabled: ${config.opcacheEnabled ?? 'unknown'}\nAPCu enabled: ${config.apcuEnabled ?? 'unknown'}\nPreload configured: ${config.opcachePreload ? 'yes' : 'no'}\nIssues: ${config.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOpcacheApcuTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_opcache_apcu_config', description: 'Detect OPcache and APCu configuration from .ini files in docker/: enabled status, memory_consumption, preload script, validate_timestamps, APCu shm_size, missing preload/low memory warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_opcache_apcu_stats', description: 'OPcache/APCu statistics: config files found, enabled status, preload configured, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
