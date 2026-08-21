import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface JitConfigInfo {
  source: string;
  directive: string;
  value: string;
  issues: string[];
}

function findIniFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, '.php.ini'),
    path.join(appPath, 'config', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'conf.d', 'opcache.ini'),
    path.join(appPath, 'docker', 'php', 'conf.d', 'jit.ini'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

function readIniValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key.replace('.', '\\.')}\\s*=\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '').replace(/\s*;.*$/, '') : null;
}

function buildJitInfos(appPath: string): JitConfigInfo[] {
  const results: JitConfigInfo[] = [];
  const iniFiles = findIniFiles(appPath);

  if (iniFiles.length === 0) {
    results.push({ source: 'docker/php/', directive: 'opcache.jit', value: 'not found', issues: ['No PHP ini file found — JIT configuration cannot be verified; add docker/php/conf.d/opcache.ini'] });
    return results;
  }

  for (const file of iniFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);
    const jit = readIniValue(content, 'opcache.jit');
    const jitBufferSize = readIniValue(content, 'opcache.jit_buffer_size');
    const jitHotFunc = readIniValue(content, 'opcache.jit_hot_func');
    const opcacheEnabled = readIniValue(content, 'opcache.enable');
    const opcacheCliEnabled = readIniValue(content, 'opcache.enable_cli');

    if (opcacheEnabled === '0' || opcacheEnabled === 'Off') {
      results.push({ source: relFile, directive: 'opcache.enable', value: opcacheEnabled, issues: ['opcache.enable=0 — JIT requires OPcache; enable OPcache first'] });
    }

    if (jit !== null) {
      const issues: string[] = [];
      const jitVal = jit.toLowerCase();

      if (jitVal === '0' || jitVal === 'off' || jitVal === 'disable') {
        issues.push('JIT is disabled — PHP 8+ JIT can improve CPU-bound workloads by 5–30%; enable with opcache.jit=tracing or opcache.jit=1255');
      } else if (jitVal === 'tracing' || jitVal === '1255') {
        // tracing JIT — best for web apps
      } else if (jitVal === 'function' || jitVal === '1205') {
        issues.push('Using function JIT (opcache.jit=function) — tracing JIT (opcache.jit=tracing) typically gives better results for Symfony applications');
      } else if (!['tracing', 'function', 'on'].includes(jitVal) && !['1255', '1205', '1', '0'].includes(jitVal)) {
        issues.push(`Unknown JIT mode "${jit}" — valid values: tracing (1255), function (1205), off (0)`);
      }

      results.push({ source: relFile, directive: 'opcache.jit', value: jit, issues });
    } else {
      results.push({ source: relFile, directive: 'opcache.jit', value: '(not set)', issues: ['opcache.jit not configured — defaults to disabled in PHP 8.0-8.1, needs explicit tracing or function value in PHP 8.2+'] });
    }

    if (jitBufferSize !== null) {
      const issues: string[] = [];
      const sizeMb = parseInt(jitBufferSize, 10);
      if (jitBufferSize.endsWith('M') && sizeMb < 64) {
        issues.push(`opcache.jit_buffer_size=${jitBufferSize} is small — use 128M-256M for production; too small a buffer causes JIT to fall back to interpreted mode`);
      }
      if (jitBufferSize.endsWith('M') && sizeMb > 1024) {
        issues.push(`opcache.jit_buffer_size=${jitBufferSize} is very large — 128M-256M is sufficient; excess wastes shared memory`);
      }
      results.push({ source: relFile, directive: 'opcache.jit_buffer_size', value: jitBufferSize, issues });
    } else if (jit && jit !== '0' && jit !== 'off') {
      results.push({ source: relFile, directive: 'opcache.jit_buffer_size', value: '(not set)', issues: ['JIT enabled but opcache.jit_buffer_size not set — JIT will be silently disabled without a buffer; add opcache.jit_buffer_size=128M'] });
    }

    if (jitHotFunc !== null) {
      const n = parseInt(jitHotFunc, 10);
      if (!isNaN(n) && n < 5) {
        results.push({ source: relFile, directive: 'opcache.jit_hot_func', value: jitHotFunc, issues: [`jit_hot_func=${jitHotFunc} is very low — JIT compiles functions after just ${jitHotFunc} calls; increase to 10-50 to avoid JIT overhead on rarely-called functions`] });
      }
    }

    if (opcacheCliEnabled === '1' || opcacheCliEnabled === 'On') {
      results.push({ source: relFile, directive: 'opcache.enable_cli', value: opcacheCliEnabled, issues: ['opcache.enable_cli=1 enables JIT for CLI — acceptable for long-running CLI workers but wastes memory for short-lived console commands'] });
    }
  }

  return results;
}

export function listPhpJitConfig(appPath: string): McpToolResult {
  try {
    const infos = buildJitInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP JIT Configuration Analysis\n${'='.repeat(50)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.directive}] ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpJitStats(appPath: string): McpToolResult {
  try {
    const infos = buildJitInfos(appPath);
    const jitEntry = infos.find((i) => i.directive === 'opcache.jit');
    let text = `PHP JIT Statistics\n${'='.repeat(40)}\n\n`;
    text += `JIT mode:  ${jitEntry ? jitEntry.value : '(not configured)'}\n`;
    text += `Entries:   ${infos.length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpJitConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_jit_config', description: 'Analyze PHP 8 JIT compiler configuration (opcache.jit mode, jit_buffer_size, hot_func threshold); warns on disabled JIT, missing buffer size, function vs tracing JIT, buffer too small', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_jit_stats', description: 'Statistics for PHP JIT: mode, entry count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
