// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpIniSetting {
  source: string;
  setting: string;
  value: string;
  recommendation: string;
  severity: string;
}

function parseIniValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function memoryToMb(val: string): number {
  const m = /^(\d+)([KMG]?)$/i.exec(val.trim());
  if (!m) return -1;
  const n = parseInt(m[1], 10);
  const unit = m[2].toUpperCase();
  if (unit === 'G') return n * 1024;
  if (unit === 'M') return n;
  if (unit === 'K') return Math.round(n / 1024);
  return n;
}

function buildIniSettings(appPath: string): PhpIniSetting[] {
  const candidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, '.docker', 'php.ini'),
    path.join(appPath, 'config', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'conf.d', 'app.ini'),
  ];

  const results: PhpIniSetting[] = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let content = '';
    try { content = fs.readFileSync(candidate, 'utf-8'); } catch { continue; }

    const source = path.relative(appPath, candidate);

    const checks: Array<[string, (v: string) => string | null]> = [
      ['display_errors', (v: string): string | null => (v === 'On' || v === '1') ? 'display_errors=On leaks errors to end users in production (HIGH severity)' : null],
      ['expose_php', (v: string): string | null => (v === 'On' || v === '1') ? 'expose_php=On reveals PHP version in Server header (MEDIUM severity)' : null],
      ['memory_limit', (v: string): string | null => { const mb = memoryToMb(v); return mb > 0 && mb < 256 ? `memory_limit=${v} is below 256M — Symfony applications commonly need 256M+ (MEDIUM severity)` : null; }],
      ['max_execution_time', (v: string): string | null => v === '0' ? 'max_execution_time=0 allows runaway scripts — set to 30 or 60 in production (MEDIUM severity)' : null],
      ['date.timezone', (v: string): string | null => (!v || v === '' || v === 'UTC') ? (v === '' ? 'date.timezone not set — PHP will emit warnings and use system timezone (MEDIUM severity)' : null) : null],
      ['log_errors', (v: string): string | null => (v === 'Off' || v === '0') ? 'log_errors=Off — PHP errors not logged (HIGH severity in production)' : null],
      ['error_reporting', (v: string): string | null => v === '0' ? 'error_reporting=0 silences all errors — not recommended even in production (MEDIUM severity)' : null],
      ['session.gc_maxlifetime', (v: string): string | null => { const n = parseInt(v, 10); return n > 86400 ? `session.gc_maxlifetime=${v}s exceeds 24h — expired sessions accumulate in storage (LOW severity)` : null; }],
    ];

    for (const [key, check] of checks) {
      const value = parseIniValue(content, key.replace('.', '\\.'));
      if (value !== null) {
        const msg = check(value);
        if (msg) {
          const severity = msg.includes('HIGH') ? 'high' : msg.includes('MEDIUM') ? 'medium' : 'low';
          results.push({ source, setting: key, value, recommendation: msg, severity });
        }
      }
    }
  }

  return results;
}

export function listPhpIniSettings(appPath: string): McpToolResult {
  try {
    const settings = buildIniSettings(appPath);
    if (settings.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP INI configuration issues found (or no php.ini files detected).' }] };
    }
    let text = `PHP INI Production Readiness Analysis\n${'='.repeat(55)}\n\nIssues: ${settings.length}\n`;
    for (const s of settings.sort((a, b) => (a.severity < b.severity ? 1 : -1))) {
      text += `\n  [${s.severity.toUpperCase()}] ${s.setting}=${s.value}  (${s.source})\n`;
      text += `    ${s.recommendation}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIniStats(appPath: string): McpToolResult {
  try {
    const settings = buildIniSettings(appPath);
    let text = `PHP INI Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total issues:   ${settings.length}\n`;
    text += `  High:         ${settings.filter((s) => s.severity === 'high').length}\n`;
    text += `  Medium:       ${settings.filter((s) => s.severity === 'medium').length}\n`;
    text += `  Low:          ${settings.filter((s) => s.severity === 'low').length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIniTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_ini_settings', description: 'Analyze php.ini files for production readiness; warns on display_errors, expose_php, low memory_limit, max_execution_time=0, missing date.timezone, disabled log_errors', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_ini_stats', description: 'Statistics for PHP INI issues by severity: high/medium/low counts', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
