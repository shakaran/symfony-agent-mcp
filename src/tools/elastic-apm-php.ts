// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ElasticApmPhpInfo {
  source: string;
  type: 'ini' | 'env' | 'php';
  setting: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***');
}

function scanDirRecursive(dir: string, exts: string[]): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, exts));
      else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function processIniContent(content: string, relFile: string, results: ElasticApmPhpInfo[]): void {
  const settings: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
    { pattern: /elastic_apm\.enabled\s*=\s*([^\n;]{1,100})/, name: 'elastic_apm.enabled', sensitive: false },
    { pattern: /elastic_apm\.server_url\s*=\s*([^\n;]{1,200})/, name: 'elastic_apm.server_url', sensitive: true },
    { pattern: /elastic_apm\.secret_token\s*=\s*([^\n;]{1,200})/, name: 'elastic_apm.secret_token', sensitive: true },
    { pattern: /elastic_apm\.api_key\s*=\s*([^\n;]{1,200})/, name: 'elastic_apm.api_key', sensitive: true },
    { pattern: /elastic_apm\.service_name\s*=\s*([^\n;]{1,200})/, name: 'elastic_apm.service_name', sensitive: false },
    { pattern: /elastic_apm\.environment\s*=\s*([^\n;]{1,100})/, name: 'elastic_apm.environment', sensitive: false },
    { pattern: /elastic_apm\.transaction_sample_rate\s*=\s*([^\n;]{1,50})/, name: 'elastic_apm.transaction_sample_rate', sensitive: false },
    { pattern: /elastic_apm\.log_level\s*=\s*([^\n;]{1,50})/, name: 'elastic_apm.log_level', sensitive: false },
  ];

  const foundSettings: Record<string, string> = {};

  for (const s of settings) {
    const m = s.pattern.exec(content);
    if (!m) continue;
    const raw = m[1].trim();
    foundSettings[s.name] = raw;
    const display = s.sensitive ? maskSecrets(`${s.name}=${raw}`) : `${s.name}=${raw}`;

    let issue: string | null = null;

    if (s.name === 'elastic_apm.server_url') {
      if (raw.startsWith('http://') && !raw.startsWith('https://')) {
        issue = `elastic_apm.server_url uses HTTP ("${raw}") — APM data (including traces and secrets) should be sent over HTTPS to prevent interception`;
      }
    }

    if (s.name === 'elastic_apm.transaction_sample_rate') {
      const numVal = parseFloat(raw);
      if (!isNaN(numVal) && numVal >= 1.0) {
        issue = `elastic_apm.transaction_sample_rate=1 means 100% sampling in production — causes significant overhead; reduce to 0.1–0.2 for production environments`;
      }
    }

    if (s.name === 'elastic_apm.log_level') {
      const lower = raw.toLowerCase();
      if (lower === 'debug' || lower === 'trace') {
        issue = `elastic_apm.log_level=${raw} in production — DEBUG/TRACE log level generates very verbose output and may expose sensitive data; use ERROR or WARNING in production`;
      }
    }

    if (s.name === 'elastic_apm.service_name') {
      if (/\s/.test(raw)) {
        issue = `elastic_apm.service_name="${raw}" contains spaces — service names with spaces may cause issues in APM UI grouping; use hyphens or underscores instead`;
      }
    }

    results.push({ source: relFile, type: 'ini', setting: s.name, value: display, issue });
  }

  // Check: both secret_token and api_key set
  if (foundSettings['elastic_apm.secret_token'] && foundSettings['elastic_apm.api_key']) {
    results.push({
      source: relFile,
      type: 'ini',
      setting: 'elastic_apm.secret_token + elastic_apm.api_key',
      value: '(both set)',
      issue: 'Both elastic_apm.secret_token and elastic_apm.api_key are set — only one authentication method should be used; having both may cause unpredictable authentication behavior; remove one',
    });
  }
}

function buildElasticApmPhpInfos(appPath: string): ElasticApmPhpInfo[] {
  const results: ElasticApmPhpInfo[] = [];

  // php.ini in common locations
  const iniSearchPaths = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.ini'),
    path.join(appPath, 'docker', 'php', 'php.prod.ini'),
    path.join(appPath, 'docker', 'php', 'conf.d', 'elastic-apm.ini'),
    path.join(appPath, '.docker', 'php', 'php.ini'),
  ];

  for (const iniPath of iniSearchPaths) {
    const content = safeRead(iniPath, appPath);
    if (!content) continue;
    if (!content.includes('elastic_apm')) continue;
    const relFile = path.relative(appPath, iniPath);
    processIniContent(content, relFile, results);
  }

  // conf.d/*.ini under docker/php/
  const confDirs = [
    path.join(appPath, 'docker', 'php', 'conf.d'),
    path.join(appPath, '.docker', 'php', 'conf.d'),
    path.join(appPath, 'docker', 'conf.d'),
  ];
  for (const confDir of confDirs) {
    if (!fs.existsSync(confDir)) continue;
    const iniFiles = scanDirRecursive(confDir, ['.ini']);
    for (const iniPath of iniFiles) {
      const content = safeRead(iniPath, appPath);
      if (!content || !content.includes('elastic_apm')) continue;
      const relFile = path.relative(appPath, iniPath);
      processIniContent(content, relFile, results);
    }
  }

  // .env* files — ELASTIC_APM_* vars
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const apmVars: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
      { pattern: /ELASTIC_APM_SERVER_URL\s*=\s*([^\n]{1,200})/, name: 'ELASTIC_APM_SERVER_URL', sensitive: true },
      { pattern: /ELASTIC_APM_SECRET_TOKEN\s*=\s*([^\n]{1,200})/, name: 'ELASTIC_APM_SECRET_TOKEN', sensitive: true },
      { pattern: /ELASTIC_APM_API_KEY\s*=\s*([^\n]{1,200})/, name: 'ELASTIC_APM_API_KEY', sensitive: true },
      { pattern: /ELASTIC_APM_SERVICE_NAME\s*=\s*([^\n]{1,200})/, name: 'ELASTIC_APM_SERVICE_NAME', sensitive: false },
      { pattern: /ELASTIC_APM_ENVIRONMENT\s*=\s*([^\n]{1,100})/, name: 'ELASTIC_APM_ENVIRONMENT', sensitive: false },
      { pattern: /ELASTIC_APM_TRANSACTION_SAMPLE_RATE\s*=\s*([^\n]{1,50})/, name: 'ELASTIC_APM_TRANSACTION_SAMPLE_RATE', sensitive: false },
      { pattern: /ELASTIC_APM_LOG_LEVEL\s*=\s*([^\n]{1,50})/, name: 'ELASTIC_APM_LOG_LEVEL', sensitive: false },
    ];

    for (const varDef of apmVars) {
      const m = varDef.pattern.exec(content);
      if (!m) continue;
      const raw = m[1].trim();
      const display = varDef.sensitive ? maskSecrets(`${varDef.name}=${raw}`) : `${varDef.name}=${raw}`;

      let issue: string | null = null;
      if (varDef.name === 'ELASTIC_APM_SERVER_URL' && raw.startsWith('http://')) {
        issue = `ELASTIC_APM_SERVER_URL uses HTTP — APM data should be sent over HTTPS`;
      }
      if (varDef.name === 'ELASTIC_APM_TRANSACTION_SAMPLE_RATE') {
        const numVal = parseFloat(raw);
        if (!isNaN(numVal) && numVal >= 1.0 && fname.includes('prod')) {
          issue = `ELASTIC_APM_TRANSACTION_SAMPLE_RATE=1 in ${fname} — 100% sampling causes overhead; reduce for production`;
        }
      }

      results.push({ source: fname, type: 'env', setting: varDef.name, value: display, issue });
    }
  }

  // src/**/*.php — ElasticApm usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), ['.php']);
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasApm =
      content.includes('ElasticApm::getCurrentTransaction(') ||
      content.includes('ElasticApm::beginCurrentSpan(') ||
      content.includes('->createSpan(');

    if (!hasApm) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('ElasticApm::getCurrentTransaction(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', setting: 'ElasticApm::getCurrentTransaction()', value: line.trim().slice(0, 100), issue: null });
      }
      if (line.includes('ElasticApm::beginCurrentSpan(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', setting: 'ElasticApm::beginCurrentSpan()', value: line.trim().slice(0, 100), issue: null });
      }
      if (line.includes('->createSpan(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', setting: '->createSpan()', value: line.trim().slice(0, 100), issue: null });
      }
    }
  }

  return results;
}

export function listElasticApmPhp(appPath: string): McpToolResult {
  try {
    const infos = buildElasticApmPhpInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Elastic APM PHP agent configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Elastic APM PHP Agent Analysis\n${'='.repeat(55)}\n\nSettings: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.source}\n`;
      text += `    ${info.setting}: ${info.value}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticApmPhpStats(appPath: string): McpToolResult {
  try {
    const infos = buildElasticApmPhpInfos(appPath);
    const iniEntries = infos.filter((i) => i.type === 'ini');
    const envEntries = infos.filter((i) => i.type === 'env');
    const phpEntries = infos.filter((i) => i.type === 'php');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Elastic APM PHP Statistics\n${'='.repeat(40)}\n\n`;
    text += `INI settings:   ${iniEntries.length}\n`;
    text += `Env entries:    ${envEntries.length}\n`;
    text += `PHP patterns:   ${phpEntries.length}\n`;
    text += `Issues:         ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticApmPhpTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_elastic_apm_php',
      description: 'Scan for Elastic APM PHP agent configuration: php.ini/conf.d/*.ini/docker/php/*.ini elastic_apm.* settings, .env* ELASTIC_APM_* vars (masked secret_token/api_key), PHP ElasticApm::getCurrentTransaction/beginCurrentSpan/createSpan. Flags both secret_token+api_key set, HTTP server_url, transaction_sample_rate=1 in production, log_level=debug, service_name with spaces.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_elastic_apm_php_stats',
      description: 'Statistics for Elastic APM PHP agent: INI/env/PHP entry counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
