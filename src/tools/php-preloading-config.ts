import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PreloadingInfo {
  preloadFile: string;
  classCount: number;
  estimatedMemoryMb: number;
  issues: string[];
}

function findPhpIniFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, '.docker', 'php.ini'),
    path.join(appPath, 'config', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

function buildPreloadingInfos(appPath: string): PreloadingInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'preload.php'),
    path.join(appPath, 'var', 'cache', 'prod', 'App_KernelProdContainer.preload.php'),
    path.join(appPath, 'preload.php'),
  ];
  const preloadFile = candidates.find((c) => fs.existsSync(c)) ?? null;
  const iniFiles = findPhpIniFiles(appPath);

  let opcachePreloadConfigured = false;
  let opcachePreloadUserSet = false;

  for (const iniFile of iniFiles) {
    let content = '';
    try { content = fs.readFileSync(iniFile, 'utf-8'); } catch { continue; }
    if (/opcache\.preload\s*=/.test(content)) opcachePreloadConfigured = true;
    if (/opcache\.preload_user\s*=/.test(content)) opcachePreloadUserSet = true;
  }

  const issues: string[] = [];

  if (!preloadFile) {
    issues.push('No PHP OPcache preload file found (config/preload.php or var/cache/prod/App_KernelProdContainer.preload.php)');
    if (!opcachePreloadConfigured) {
      issues.push('opcache.preload not configured in any php.ini — preloading disabled');
    }
    return [{ preloadFile: 'none', classCount: 0, estimatedMemoryMb: 0, issues }];
  }

  let preloadContent = '';
  try { preloadContent = fs.readFileSync(preloadFile, 'utf-8'); } catch { /* ignore */ }

  const requireLines = (preloadContent.match(/require_once\s+/g) ?? []).length;
  const estimatedMemoryMb = Math.round(requireLines * 0.01 * 100) / 100;

  if (!opcachePreloadConfigured) {
    issues.push('Preload file exists but opcache.preload not set in php.ini — preloading not active');
  }
  if (!opcachePreloadUserSet) {
    issues.push('opcache.preload_user not set — required for security when PHP runs as root');
  }
  if (requireLines > 2000) {
    issues.push(`Preload file requires ${requireLines} classes (~${estimatedMemoryMb}MB) — consider reducing to avoid memory pressure`);
  }
  if (preloadFile.includes('/dev/') || preloadFile.endsWith('dev.php')) {
    issues.push('Preload file path suggests dev environment — preloading should only be used in production');
  }

  return [{ preloadFile, classCount: requireLines, estimatedMemoryMb, issues }];
}

export function listPhpPreloadingConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPreloadingInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP OPcache Preloading Analysis\n${'='.repeat(50)}\n\nIssues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  Preload file:  ${info.preloadFile}\n`;
      text += `    Classes:     ${info.classCount}\n`;
      text += `    Est. memory: ~${info.estimatedMemoryMb}MB\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPreloadingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPreloadingInfos(appPath);
    let text = `PHP Preloading Statistics\n${'='.repeat(40)}\n\n`;
    text += `Preload files found:   ${infos.filter((i) => i.preloadFile !== 'none').length}\n`;
    text += `Total classes:         ${infos.reduce((s, i) => s + i.classCount, 0)}\n`;
    text += `Est. memory (MB):      ${infos.reduce((s, i) => s + i.estimatedMemoryMb, 0)}\n`;
    text += `Total issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPreloadingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_preloading_config', description: 'Analyze PHP OPcache preload script; warns on missing preload file, opcache.preload not set, opcache.preload_user missing, too many classes, dev-env preloading', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_preloading_stats', description: 'Statistics for PHP OPcache preloading: file count, class count, estimated memory, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
