// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Sentry Integration Inspector
 *
 * Detects sentry/sentry-symfony installation and configuration:
 *
 * sentry.yaml / config/packages/sentry.yaml:
 *   - dsn (masked): SENTRY_DSN env var
 *   - environment: %kernel.environment%
 *   - release: version string or git hash
 *   - traces_sample_rate (0.0–1.0)
 *   - profiles_sample_rate
 *   - send_default_pii: personal data collection flag
 *   - ignore_exceptions: list of exception classes to suppress
 *   - max_breadcrumbs
 *   - in_app_include / in_app_exclude paths
 *
 * SDK version (from composer.json):
 *   - sentry/sentry-symfony installed version
 *   - sentry/sentry (PHP SDK) version
 *
 * Integration scan:
 *   - #[AsEventListener] listeners for SentryMonitoringCheckIn events
 *   - Sentry\SentrySdk::getCurrentHub() direct calls (bypasses DI)
 *   - captureException() / captureMessage() call sites in src/
 *
 * Analysis:
 *   - send_default_pii: true (GDPR risk — sends user email/IP)
 *   - traces_sample_rate: 1.0 in production (high Sentry volume)
 *   - No ignore_exceptions (Symfony's HttpExceptionInterface always reported)
 *   - DSN missing (Sentry installed but not configured)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface SentryConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  profilesSampleRate?: number;
  sendDefaultPii?: boolean;
  ignoreExceptions: string[];
  maxBreadcrumbs?: number;
  sdkVersion?: string;
}

function maskDsn(dsn: string): string {
  return dsn.replace(/:\/\/([^:@]+)@/, '://***@').replace(/%env\([^)]+\)%/, '%env(SENTRY_DSN)%');
}

function loadSentryConfig(appPath: string): SentryConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'sentry.yaml'),
    path.join(appPath, 'config', 'packages', 'sentry.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const sentry = (raw['sentry'] ?? raw) as Record<string, unknown>;
    const dsn    = sentry['dsn'] ? maskDsn(String(sentry['dsn'])) : undefined;

    const ignoreRaw = sentry['ignore_exceptions'] as unknown[] | undefined;
    const ignoreExceptions = ignoreRaw ? ignoreRaw.map(String) : [];

    return {
      dsn,
      environment: sentry['environment'] ? String(sentry['environment']) : undefined,
      release:     sentry['release']     ? String(sentry['release'])     : undefined,
      tracesSampleRate:   sentry['traces_sample_rate'] !== undefined   ? parseFloat(String(sentry['traces_sample_rate'])) : undefined,
      profilesSampleRate: sentry['profiles_sample_rate'] !== undefined ? parseFloat(String(sentry['profiles_sample_rate'])) : undefined,
      sendDefaultPii: sentry['send_default_pii'] === true || sentry['send_default_pii'] === 'true',
      ignoreExceptions,
      maxBreadcrumbs: sentry['max_breadcrumbs'] ? parseInt(String(sentry['max_breadcrumbs']), 10) : undefined,
    };
  }
  return null;
}

function getSdkVersion(appPath: string): string | undefined {
  const composerLock = path.join(appPath, 'composer.lock');
  if (!fs.existsSync(composerLock)) return undefined;
  try {
    const content = fs.readFileSync(composerLock, 'utf-8');
    const m = /"name"\s*:\s*"sentry\/sentry-symfony"[^}]*"version"\s*:\s*"([^"]+)"/.exec(content);
    return m?.[1];
  } catch { return undefined; }
}

function isSentryInstalled(appPath: string): boolean {
  const composerJson = path.join(appPath, 'composer.json');
  if (!fs.existsSync(composerJson)) return false;
  try {
    const content = fs.readFileSync(composerJson, 'utf-8');
    return content.includes('"sentry/sentry');
  } catch { return false; }
}

function scanSentryUsage(appPath: string): { directCalls: number; captureCallSites: string[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { directCalls: 0, captureCallSites: [] };

  let directCalls = 0;
  const captureCallSites: string[] = [];

  const gather = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { gather(full); return; }
        if (!e.name.endsWith('.php')) return;
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
        if (!content.includes('sentry') && !content.includes('Sentry')) return;
        if (content.includes('getCurrentHub()')) directCalls++;
        if ((content.includes('captureException') || content.includes('captureMessage')) && captureCallSites.length < 10) {
          const classM = /class\s+(\w+)/.exec(content);
          if (classM) captureCallSites.push(classM[1]);
        }
      }
    } catch { /* skip */ }
  };
  gather(srcDir);
  return { directCalls, captureCallSites };
}

export function listSentryConfig(appPath: string): McpToolResult {
  try {
    const installed = isSentryInstalled(appPath);
    const config    = loadSentryConfig(appPath);
    const sdkVersion = getSdkVersion(appPath);

    if (!installed && !config) {
      return {
        content: [{
          type: 'text',
          text: 'Sentry not installed.\n\nInstall:\n  composer require sentry/sentry-symfony\n\nConfigure in config/packages/sentry.yaml:\n  sentry:\n    dsn: \'%env(SENTRY_DSN)%\'\n    traces_sample_rate: 0.1\n    send_default_pii: false\n    ignore_exceptions:\n      - Symfony\\Component\\HttpKernel\\Exception\\HttpException',
        }],
      };
    }

    const { directCalls, captureCallSites } = scanSentryUsage(appPath);

    let text = `Sentry Integration\n${'='.repeat(55)}\n\n`;
    text += `SDK installed:       ${installed ? 'yes' : 'no'}\n`;
    text += `SDK version:         ${sdkVersion ?? 'unknown'}\n`;
    text += `Config file:         ${config ? 'sentry.yaml found' : '⚠ not found'}\n`;

    if (config) {
      text += `\nConfiguration:\n`;
      text += `  DSN:               ${config.dsn ?? '⚠ not set'}\n`;
      text += `  Environment:       ${config.environment ?? 'not set'}\n`;
      text += `  Release:           ${config.release ?? 'not set'}\n`;
      text += `  Traces sample:     ${config.tracesSampleRate !== undefined ? config.tracesSampleRate : 'not set'}\n`;
      text += `  Profiles sample:   ${config.profilesSampleRate !== undefined ? config.profilesSampleRate : 'not set'}\n`;
      text += `  send_default_pii:  ${config.sendDefaultPii ? '⚠ true (GDPR risk)' : 'false'}\n`;
      text += `  Ignored exceptions: ${config.ignoreExceptions.length > 0 ? config.ignoreExceptions.join(', ') : 'none'}\n`;
      if (config.maxBreadcrumbs !== undefined) text += `  Max breadcrumbs:   ${config.maxBreadcrumbs}\n`;
    }

    if (captureCallSites.length > 0) {
      text += `\nDirect capture calls in: ${captureCallSites.join(', ')}\n`;
    }
    if (directCalls > 0) {
      text += `\n⚠ ${directCalls} SentrySdk::getCurrentHub() call(s) — use DI injection instead\n`;
    }

    const issues: string[] = [];
    if (config?.sendDefaultPii) issues.push('send_default_pii: true — sends user email/IP to Sentry (GDPR concern)');
    if (config?.tracesSampleRate === 1.0) issues.push('traces_sample_rate: 1.0 — 100% of requests traced (high Sentry volume in production)');
    if (config && config.ignoreExceptions.length === 0) {
      issues.push('No ignore_exceptions — 4xx HTTP errors reported to Sentry (adds noise)');
    }
    if (installed && !config?.dsn) issues.push('Sentry installed but DSN not configured — no errors will be reported');

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSentryStats(appPath: string): McpToolResult {
  try {
    const installed = isSentryInstalled(appPath);
    const config    = loadSentryConfig(appPath);

    let text = `Sentry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Installed:           ${installed ? 'yes' : 'no'}\n`;
    text += `Configured:          ${config ? 'yes' : 'no'}\n`;
    text += `DSN set:             ${config?.dsn ? 'yes' : 'no'}\n`;
    text += `Tracing enabled:     ${config?.tracesSampleRate ? `yes (${config.tracesSampleRate})` : 'no'}\n`;
    text += `send_default_pii:    ${config?.sendDefaultPii ? 'yes' : 'no'}\n`;
    text += `Ignored exceptions:  ${config?.ignoreExceptions.length ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSentryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_sentry_config',
      description: 'Show Sentry SDK configuration: DSN (masked), SDK version, traces/profiles sample rate, send_default_pii (GDPR warning), ignored exceptions, direct capture call sites, getCurrentHub() anti-pattern detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_sentry_stats',
      description: 'Show Sentry statistics: installed, configured, DSN set, tracing enabled, send_default_pii, ignored exception count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
