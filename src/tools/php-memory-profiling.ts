import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MemoryProfilingInfo {
  source: string;
  type: 'limit' | 'profiler' | 'pattern' | 'leak';
  setting: string;
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

function parseMegabytes(value: string): number {
  const match = value.match(/^(\d+)([MmKkGg]?)$/);
  if (!match) return NaN;
  const num = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  if (unit === 'G') return num * 1024;
  if (unit === 'K') return Math.round(num / 1024);
  return num;
}

function buildPhpMemoryProfilingInfos(appPath: string): MemoryProfilingInfo[] {
  const results: MemoryProfilingInfo[] = [];

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

    const memMatch = content.match(/memory_limit\s*=\s*([^\n\r]+)/);
    if (memMatch) {
      const val = memMatch[1].trim();
      if (val === '-1') {
        results.push({
          source: relSource,
          type: 'limit',
          setting: `memory_limit=${val}`,
          issues: ['memory_limit=-1 disables PHP memory limit in production — a memory leak or recursive operation can consume all system RAM; set a reasonable limit like 256M'],
        });
      } else {
        const mb = parseMegabytes(val);
        if (!isNaN(mb) && mb < 64) {
          results.push({
            source: relSource,
            type: 'limit',
            setting: `memory_limit=${val}`,
            issues: [`memory_limit=${val} may be too low for Symfony — Symfony typically requires 64-256MB; increase to at least 128M`],
          });
        }
      }
    }

    const xdebugModeMatch = content.match(/xdebug\.mode\s*=\s*([^\n\r]+)/);
    if (xdebugModeMatch && xdebugModeMatch[1].includes('profile')) {
      results.push({
        source: relSource,
        type: 'profiler',
        setting: `xdebug.mode=${xdebugModeMatch[1].trim()}`,
        issues: ['Xdebug profiler mode enabled — generates profiling files on every request; disable in production: xdebug.mode=off'],
      });
    }
  }

  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    let composerContent: string;
    try {
      composerContent = fs.readFileSync(composerPath, 'utf8');
      if (composerContent.includes('blackfire-io/blackfire-php') || composerContent.includes('blackfire/php-sdk')) {
        results.push({
          source: 'composer.json',
          type: 'profiler',
          setting: 'Blackfire SDK',
          issues: [],
        });
      }
    } catch { /* skip */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const phpFiles = getAllPhpFiles(srcDir);
    for (const filePath of phpFiles) {
      const content = safeRead(filePath, appPath);
      if (content === null) continue;

      const relSource = path.relative(appPath, filePath);

      if (content.includes('memory_get_usage') || content.includes('memory_get_peak_usage')) {
        results.push({
          source: relSource,
          type: 'pattern',
          setting: 'memory_get_usage / memory_get_peak_usage',
          issues: [],
        });
      }

      if (/for(?:each)?\s*\(/.test(content) && /\[\s*\]|array\s*\(/.test(content) && !content.includes('unset(')) {
        results.push({
          source: relSource,
          type: 'leak',
          setting: 'Large array in loop without unset',
          issues: ['Potential memory leak: large array operations inside loop without unset() — consider chunking operations and unsetting temporary arrays to control memory usage'],
        });
      }
    }
  }

  return results;
}

export function listPhpMemoryProfiling(appPath: string): McpToolResult {
  try {
    const infos = buildPhpMemoryProfilingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No memory profiling issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Memory Profiling Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.setting}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMemoryProfilingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpMemoryProfilingInfos(appPath);
    let text = `PHP Memory Profiling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Limit:    ${infos.filter((i) => i.type === 'limit').length}\n`;
    text += `Profiler: ${infos.filter((i) => i.type === 'profiler').length}\n`;
    text += `Pattern:  ${infos.filter((i) => i.type === 'pattern').length}\n`;
    text += `Leak:     ${infos.filter((i) => i.type === 'leak').length}\n`;
    text += `Issues:   ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMemoryProfilingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_memory_profiling', description: 'Analyze PHP memory configuration and profiling patterns including memory_limit, Xdebug, Blackfire, and potential memory leaks', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_memory_profiling_stats', description: 'Statistics for PHP memory profiling: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
