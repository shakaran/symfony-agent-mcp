import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface OpcacheSettingInfo {
  source: string;
  type: 'validate' | 'memory' | 'jit' | 'permission' | 'files';
  setting: string;
  value: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseIniValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`${key}\\s*=\\s*([^\\n\\r]+)`));
  return match ? match[1].trim() : null;
}

function parseMegabytes(value: string): number {
  const match = value.match(/^(\d+)([MmKkGg]?)$/);
  if (!match) return NaN;
  const num = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  if (unit === 'G') return num * 1024;
  if (unit === 'K') return Math.round(num / 1024);
  return num;
}

function buildPhpOpcacheSettingInfos(appPath: string): OpcacheSettingInfo[] {
  const results: OpcacheSettingInfo[] = [];

  const iniCandidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'config', 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
    path.join(appPath, '.docker', 'php.ini'),
  ];

  for (const iniPath of iniCandidates) {
    if (!fs.existsSync(iniPath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(iniPath, 'utf8');
    } catch { continue; }

    const relSource = path.relative(appPath, iniPath);

    const validateTimestamps = parseIniValue(content, 'opcache\\.validate_timestamps');
    if (validateTimestamps === '0') {
      results.push({
        source: relSource,
        type: 'validate',
        setting: 'opcache.validate_timestamps',
        value: '0',
        issues: [],
      });
    }

    const memoryCons = parseIniValue(content, 'opcache\\.memory_consumption');
    if (memoryCons !== null) {
      const mb = parseMegabytes(memoryCons);
      if (!isNaN(mb) && mb < 128) {
        results.push({
          source: relSource,
          type: 'memory',
          setting: 'opcache.memory_consumption',
          value: memoryCons,
          issues: [`opcache.memory_consumption=${memoryCons}MB may be insufficient for large applications — typical Symfony app needs 128-256MB; increase to prevent cache eviction`],
        });
      }
    }

    const maxFiles = parseIniValue(content, 'opcache\\.max_accelerated_files');
    if (maxFiles !== null) {
      const num = parseInt(maxFiles, 10);
      if (!isNaN(num) && num < 10000) {
        results.push({
          source: relSource,
          type: 'files',
          setting: 'opcache.max_accelerated_files',
          value: maxFiles,
          issues: [`opcache.max_accelerated_files=${maxFiles} may be too low for Symfony — Symfony has thousands of files; increase to at least 20000`],
        });
      }
    }

    const fileOverride = parseIniValue(content, 'opcache\\.enable_file_override');
    if (fileOverride === '1') {
      results.push({
        source: relSource,
        type: 'files',
        setting: 'opcache.enable_file_override',
        value: '1',
        issues: ['opcache.enable_file_override=1 may cause issues with __FILE__ and __DIR__ constants in cached files; disable unless specifically needed'],
      });
    }

    const validatePerm = parseIniValue(content, 'opcache\\.validate_permission');
    if (validatePerm === null || validatePerm === '0') {
      results.push({
        source: relSource,
        type: 'permission',
        setting: 'opcache.validate_permission',
        value: validatePerm ?? 'not set',
        issues: ['opcache.validate_permission not enabled — files may be served to PHP processes without checking file permissions; set opcache.validate_permission=1'],
      });
    }

    const jit = parseIniValue(content, 'opcache\\.jit');
    if (jit !== null) {
      results.push({
        source: relSource,
        type: 'jit',
        setting: 'opcache.jit',
        value: jit,
        issues: [],
      });
    }

    const jitBuffer = parseIniValue(content, 'opcache\\.jit_buffer_size');
    if (jitBuffer !== null) {
      results.push({
        source: relSource,
        type: 'jit',
        setting: 'opcache.jit_buffer_size',
        value: jitBuffer,
        issues: [],
      });
    }

    const memoryLimit = parseIniValue(content, 'memory_limit');
    if (memoryLimit === '-1') {
      results.push({
        source: relSource,
        type: 'memory',
        setting: 'memory_limit',
        value: '-1',
        issues: ['memory_limit=-1 disables PHP memory limit — a memory leak or recursive code can exhaust all server RAM; set a reasonable limit like 256M or 512M'],
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const phpFiles = getAllPhpFiles(srcDir);
    for (const filePath of phpFiles) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch { continue; }

      if (!content.includes('ini_set') || !content.includes('opcache')) continue;

      const relSource = path.relative(appPath, filePath);
      const matches = content.matchAll(/ini_set\s*\(\s*['"]([^'"]*opcache[^'"]*)['"]\s*,\s*['"]?([^'",)]+)['"]?\s*\)/g);
      for (const m of matches) {
        results.push({
          source: relSource,
          type: 'validate',
          setting: m[1],
          value: m[2],
          issues: [],
        });
      }
    }
  }

  return results;
}

export function listPhpOpcacheSettings(appPath: string): McpToolResult {
  try {
    const infos = buildPhpOpcacheSettingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OPcache settings found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP OPcache Settings Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}=${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOpcacheSettingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpOpcacheSettingInfos(appPath);
    let text = `PHP OPcache Setting Statistics\n${'='.repeat(40)}\n\n`;
    text += `Validate:   ${infos.filter((i) => i.type === 'validate').length}\n`;
    text += `Memory:     ${infos.filter((i) => i.type === 'memory').length}\n`;
    text += `JIT:        ${infos.filter((i) => i.type === 'jit').length}\n`;
    text += `Permission: ${infos.filter((i) => i.type === 'permission').length}\n`;
    text += `Files:      ${infos.filter((i) => i.type === 'files').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpOpcacheSettingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_opcache_settings', description: 'Analyze PHP OPcache settings for memory, JIT, permission, and file configuration issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_opcache_setting_stats', description: 'Statistics for PHP OPcache settings: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
