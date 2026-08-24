// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * New Relic PHP Agent Inspector
 *
 * Scans New Relic INI configuration files and src/**\/*.php for New Relic
 * PHP agent usage patterns.
 *
 * INI files: php.ini, conf.d/newrelic.ini, docker/php/newrelic.ini,
 *            newrelic.ini in project root, any *.ini containing "newrelic"
 *
 * PHP code: src/**\/*.php for newrelic_* function calls
 *
 * Issues flagged:
 * - newrelic.license not set or empty (agent won't report)
 * - newrelic.transaction_tracer.record_sql = raw (exposes SQL with credentials)
 * - newrelic_add_custom_parameter() with sensitive param names
 * - newrelic.enabled = false in what looks like a prod config
 *
 * Pure static analysis. License values are always masked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NewrelicPhpAgentInfo {
  source: string;
  type: 'ini' | 'php';
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

function maskLicense(value: string): string {
  if (value.length >= 8) return '***';
  return value;
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

function findIniFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'conf.d', 'newrelic.ini'),
    path.join(appPath, 'docker', 'php', 'newrelic.ini'),
    path.join(appPath, 'newrelic.ini'),
  ];

  const found: string[] = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) found.push(c);
    } catch { /* skip */ }
  }

  // Also scan for *.ini files containing "newrelic" in common config dirs
  const scanDirs = [
    appPath,
    path.join(appPath, 'conf.d'),
    path.join(appPath, 'docker'),
    path.join(appPath, 'docker', 'php'),
    path.join(appPath, 'config'),
  ];

  for (const dir of scanDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.ini')) continue;
        const full = path.join(dir, entry.name);
        if (found.includes(full)) continue;
        const raw = safeRead(full, dir);
        if (raw === null) continue;
        if (/newrelic/i.test(raw)) found.push(full);
      }
    } catch { /* skip */ }
  }

  return [...new Set(found)];
}

function parseIniFile(filePath: string, appPath: string): NewrelicPhpAgentInfo[] {
  const relFile = path.relative(appPath, filePath);
  const raw = safeRead(filePath, appPath);
  if (!raw) return [];

  const results: NewrelicPhpAgentInfo[] = [];
  const lines = raw.split('\n');

  // Track which newrelic settings we found for completeness check
  const foundSettings = new Set<string>();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].slice(0, 400).trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    // Match newrelic.* = value
    const iniMatch = /^(newrelic\.[A-Za-z0-9_.]{1,80})\s*=\s*([^\r\n;]{0,200})/.exec(line);
    if (!iniMatch) continue;

    const setting = iniMatch[1].trim();
    const rawValue = iniMatch[2].trim();
    foundSettings.add(setting);

    let displayValue = rawValue;
    let issue: string | null = null;

    if (setting === 'newrelic.license') {
      displayValue = maskLicense(rawValue);
      if (!rawValue || rawValue === '""' || rawValue === "''") {
        issue = 'newrelic.license is empty — the New Relic agent will not report data without a valid license key';
      }
    } else if (setting === 'newrelic.appname') {
      // Safe to show as-is
    } else if (setting === 'newrelic.enabled') {
      const lower = rawValue.toLowerCase();
      if (lower === 'false' || lower === '0' || lower === 'off') {
        // Heuristic: if file is under docker/ or contains "prod" in path, flag it
        const lowerPath = filePath.toLowerCase();
        if (/prod|production|live/.test(lowerPath)) {
          issue = 'newrelic.enabled = false in what appears to be a production config — New Relic monitoring will be disabled';
        } else {
          issue = 'newrelic.enabled = false — New Relic monitoring is disabled in this config';
        }
      }
    } else if (setting === 'newrelic.transaction_tracer.record_sql') {
      if (rawValue.toLowerCase() === 'raw') {
        issue = 'newrelic.transaction_tracer.record_sql = raw — SQL queries are recorded verbatim including any credential values or PII; use "obfuscated" instead';
      }
    } else if (setting === 'newrelic.distributed_tracing_enabled') {
      if (rawValue.toLowerCase() === 'false' || rawValue === '0') {
        issue = 'newrelic.distributed_tracing_enabled = false — distributed tracing disabled; enable for full request tracing across services';
      }
    }

    results.push({ source: relFile, type: 'ini', setting, value: displayValue, issue });
  }

  // Check for missing critical settings
  if (!foundSettings.has('newrelic.license') && /newrelic/i.test(raw)) {
    results.push({
      source: relFile,
      type: 'ini',
      setting: 'newrelic.license',
      value: '(not set)',
      issue: 'newrelic.license is not defined in this New Relic config file — agent will not report without a license key',
    });
  }

  return results;
}

const SENSITIVE_PARAM_NAMES = ['email', 'password', 'token', 'secret', 'passwd', 'pass', 'credential', 'ssn', 'card'];

function scanPhpFile(filePath: string, appPath: string): NewrelicPhpAgentInfo[] {
  const raw = safeRead(filePath, appPath);
  if (!raw) return [];
  const relFile = path.relative(appPath, filePath);
  const lines = raw.split('\n');
  const results: NewrelicPhpAgentInfo[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].slice(0, 400);
    const lineNum = idx + 1;

    if (/\bnewrelic_notice_error\s*\(/.test(line)) {
      results.push({
        source: `${relFile}:${lineNum}`,
        type: 'php',
        setting: 'newrelic_notice_error',
        value: line.trim().slice(0, 80),
        issue: null,
      });
    }

    if (/\bnewrelic_add_custom_parameter\s*\(/.test(line)) {
      // Extract first argument (parameter name)
      const argMatch = /newrelic_add_custom_parameter\s*\(\s*['"]([^'"]{1,80})['"]/i.exec(line);
      const paramName = argMatch ? argMatch[1].toLowerCase() : '';
      let issue: string | null = null;
      if (paramName && SENSITIVE_PARAM_NAMES.some((s) => paramName.includes(s))) {
        issue = `newrelic_add_custom_parameter() with sensitive param name "${paramName}" — PII/credentials should not be sent as custom attributes to New Relic`;
      }
      results.push({
        source: `${relFile}:${lineNum}`,
        type: 'php',
        setting: 'newrelic_add_custom_parameter',
        value: paramName || line.trim().slice(0, 80),
        issue,
      });
    }

    if (/\bnewrelic_start_transaction\s*\(/.test(line)) {
      results.push({
        source: `${relFile}:${lineNum}`,
        type: 'php',
        setting: 'newrelic_start_transaction',
        value: line.trim().slice(0, 80),
        issue: null,
      });
    }

    if (/\bnewrelic_name_transaction\s*\(/.test(line)) {
      results.push({
        source: `${relFile}:${lineNum}`,
        type: 'php',
        setting: 'newrelic_name_transaction',
        value: line.trim().slice(0, 80),
        issue: null,
      });
    }

    if (/\bnewrelic_record_custom_event\s*\(/.test(line)) {
      results.push({
        source: `${relFile}:${lineNum}`,
        type: 'php',
        setting: 'newrelic_record_custom_event',
        value: line.trim().slice(0, 80),
        issue: null,
      });
    }
  }

  return results;
}

function buildNewrelicPhpAgentInfos(appPath: string): NewrelicPhpAgentInfo[] {
  const results: NewrelicPhpAgentInfo[] = [];

  // Scan INI files
  for (const iniFile of findIniFiles(appPath)) {
    results.push(...parseIniFile(iniFile, appPath));
  }

  // Scan PHP source files
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      results.push(...scanPhpFile(f, appPath));
    }
  }

  return results;
}

export function listNewrelicPhpAgent(appPath: string): McpToolResult {
  try {
    const infos = buildNewrelicPhpAgentInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No New Relic PHP agent configuration or function usage found (no newrelic.ini files and no newrelic_* calls in src/).' }] };
    }

    const withIssues = infos.filter((i) => i.issue !== null);
    let text = `New Relic PHP Agent Analysis\n${'='.repeat(55)}\n\n`;
    text += `Entries found: ${infos.length}  |  Issues: ${withIssues.length}\n\n`;

    const iniEntries = infos.filter((i) => i.type === 'ini');
    const phpEntries = infos.filter((i) => i.type === 'php');

    if (iniEntries.length > 0) {
      text += `INI CONFIGURATION (${iniEntries.length} settings)\n${'-'.repeat(40)}\n`;
      for (const info of iniEntries) {
        text += `  [${info.source}] ${info.setting} = ${info.value}\n`;
        if (info.issue) {
          text += `    ISSUE: ${info.issue}\n`;
        }
      }
      text += '\n';
    }

    if (phpEntries.length > 0) {
      text += `PHP FUNCTION USAGE (${phpEntries.length} calls)\n${'-'.repeat(40)}\n`;
      for (const info of phpEntries) {
        text += `  ${info.source}  ${info.setting}()\n`;
        if (info.issue) {
          text += `    ISSUE: ${info.issue}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNewrelicPhpAgentStats(appPath: string): McpToolResult {
  try {
    const infos = buildNewrelicPhpAgentInfos(appPath);

    const iniCount = infos.filter((i) => i.type === 'ini').length;
    const phpCount = infos.filter((i) => i.type === 'php').length;
    const issueCount = infos.filter((i) => i.issue !== null).length;
    const licenseSet = infos.some((i) => i.setting === 'newrelic.license' && i.value !== '(not set)' && i.value !== '***empty***');
    const recordSqlRaw = infos.some((i) => i.setting === 'newrelic.transaction_tracer.record_sql' && i.issue !== null);
    const piiParams = infos.filter((i) => i.setting === 'newrelic_add_custom_parameter' && i.issue !== null).length;
    const customParams = infos.filter((i) => i.setting === 'newrelic_add_custom_parameter').length;
    const customEvents = infos.filter((i) => i.setting === 'newrelic_record_custom_event').length;
    const transactionNaming = infos.filter((i) => i.setting === 'newrelic_name_transaction').length;

    let text = `New Relic PHP Agent Statistics\n${'='.repeat(40)}\n\n`;
    text += `INI settings found:        ${iniCount}\n`;
    text += `PHP function calls found:  ${phpCount}\n`;
    text += `Total issues:              ${issueCount}\n`;
    text += `\nConfiguration status:\n`;
    text += `  License key set:         ${licenseSet ? 'yes' : 'NO (agent will not report)'}\n`;
    text += `  SQL recording = raw:     ${recordSqlRaw ? 'YES (security risk)' : 'no'}\n`;
    text += `\nPHP API usage:\n`;
    text += `  newrelic_add_custom_parameter: ${customParams}  (PII risk: ${piiParams})\n`;
    text += `  newrelic_record_custom_event:  ${customEvents}\n`;
    text += `  newrelic_name_transaction:     ${transactionNaming}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNewrelicPhpAgentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_newrelic_php_agent',
      description: 'Scan New Relic PHP agent INI configs (php.ini, newrelic.ini, conf.d/, docker/php/) and src/ PHP files for newrelic_* calls — flags missing/empty license, record_sql=raw, PII in custom parameters, disabled monitoring',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_newrelic_php_agent_stats',
      description: 'Show New Relic PHP agent statistics: INI setting count, PHP API call counts, license key status, SQL recording mode, PII-risk custom parameter count, custom event and transaction naming usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
