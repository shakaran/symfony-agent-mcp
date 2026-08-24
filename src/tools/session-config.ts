// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Session & Cookie Security Inspector
 *
 * Reads framework.session from config/packages/framework.yaml
 * (or session.yaml if split):
 *   - handler_id (native/Redis/DB/Filesystem/Memcached)
 *   - cookie_secure, cookie_samesite, cookie_httponly, cookie_lifetime
 *   - gc_maxlifetime, gc_probability, gc_divisor
 *   - save_path
 *   - name (session cookie name)
 *
 * Security audit:
 *   - Warns if cookie_secure is false (cleartext sessions over HTTP)
 *   - Warns if cookie_samesite is not 'lax' or 'strict' (CSRF risk)
 *   - Warns if cookie_httponly is false (XSS session theft)
 *   - Warns if using native PHP handler in multi-server setups
 *   - Warns if gc_maxlifetime is excessively long (>= 1 day)
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface SessionConfig {
  handlerId?: string;
  savePath?: string;
  name?: string;
  cookieSecure: boolean | string;
  cookieSameSite: string;
  cookieHttpOnly: boolean;
  cookieLifetime: number;
  cookieDomain?: string;
  cookiePath: string;
  gcMaxLifetime: number;
  gcProbability: number;
  gcDivisor: number;
  useCookies: boolean;
  metadataBag?: string;
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadSessionConfig(appPath: string): SessionConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'session.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const session = framework['session'] as Record<string, unknown> | undefined;
    if (!session) continue;

    return {
      handlerId:       session['handler_id']       ? String(session['handler_id'])        : undefined,
      savePath:        session['save_path']         ? String(session['save_path'])         : undefined,
      name:            session['name']              ? String(session['name'])              : undefined,
      cookieSecure:    (session['cookie_secure'] ?? 'auto') as boolean | string,
      cookieSameSite:  session['cookie_samesite']   ? String(session['cookie_samesite'])  : 'lax',
      cookieHttpOnly:  Boolean(session['cookie_httponly'] ?? true),
      cookieLifetime:  Number(session['cookie_lifetime']  ?? 0),
      cookieDomain:    session['cookie_domain']    ? String(session['cookie_domain'])      : undefined,
      cookiePath:      session['cookie_path']      ? String(session['cookie_path'])        : '/',
      gcMaxLifetime:   Number(session['gc_maxlifetime']   ?? 1440),
      gcProbability:   Number(session['gc_probability']   ?? 1),
      gcDivisor:       Number(session['gc_divisor']       ?? 100),
      useCookies:      Boolean(session['use_cookies']     ?? true),
      metadataBag:     session['metadata_bag']     ? String(session['metadata_bag'])       : undefined,
    };
  }
  return null;
}

// ─── Handler labels ──────────────────────────────────────────────────────────

function describeHandler(handlerId: string | undefined): { label: string; isNative: boolean } {
  if (!handlerId) return { label: 'Default (native PHP files)', isNative: true };
  const id = handlerId.toLowerCase();
  if (id.includes('redis'))      return { label: `Redis  (${handlerId})`, isNative: false };
  if (id.includes('memcache'))   return { label: `Memcached  (${handlerId})`, isNative: false };
  if (id.includes('pdo') || id.includes('doctrine')) return { label: `Database/PDO  (${handlerId})`, isNative: false };
  if (id.includes('filesystem')) return { label: `Filesystem  (${handlerId})`, isNative: false };
  if (id === 'null' || id === 'session.handler.null') return { label: 'Null (disabled — testing only)', isNative: false };
  return { label: handlerId, isNative: handlerId === '' || id === 'native' };
}

// ─── Security audit ──────────────────────────────────────────────────────────

interface SecurityIssue {
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

function auditSecurity(cfg: SessionConfig): SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  if (cfg.cookieSecure === false) {
    issues.push({ severity: 'critical', message: 'cookie_secure: false — sessions sent over HTTP (cleartext)' });
  }
  if (String(cfg.cookieSameSite).toLowerCase() === 'none') {
    issues.push({ severity: 'warning', message: 'cookie_samesite: none — CSRF protection disabled' });
  }
  if (!cfg.cookieHttpOnly) {
    issues.push({ severity: 'critical', message: 'cookie_httponly: false — session cookie accessible via JavaScript (XSS risk)' });
  }
  if (cfg.gcMaxLifetime >= 86400) {
    const hours = Math.round(cfg.gcMaxLifetime / 3600);
    issues.push({ severity: 'warning', message: `gc_maxlifetime: ${hours}h — sessions live very long (consider shorter for sensitive apps)` });
  }
  const { isNative } = describeHandler(cfg.handlerId);
  if (isNative) {
    issues.push({ severity: 'warning', message: 'Native PHP file handler — not suitable for multiple app servers (sessions not shared)' });
  }
  if (cfg.cookieLifetime === 0) {
    issues.push({ severity: 'info', message: 'cookie_lifetime: 0 — session cookie expires when browser closes (browser-session only)' });
  }

  return issues;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listSessionConfig(appPath: string): McpToolResult {
  try {
    const cfg = loadSessionConfig(appPath);

    if (!cfg) {
      return {
        content: [{
          type: 'text',
          text: 'framework.session not configured.\n\nAdd to config/packages/framework.yaml:\n  framework:\n    session:\n      handler_id: null  # or redis service\n      cookie_secure: auto\n      cookie_samesite: lax\n      cookie_httponly: true\n      gc_maxlifetime: 3600',
        }],
      };
    }

    const { label: handlerLabel } = describeHandler(cfg.handlerId);
    const issues = auditSecurity(cfg);

    let text = `Session Configuration\n${'='.repeat(55)}\n`;

    text += `\nHandler:           ${handlerLabel}\n`;
    if (cfg.savePath) {
      const safeSavePath = cfg.savePath.replace(
        /([?&](?:auth|password|token|secret|key)=)[^&\s]+/gi, '$1***'
      );
      text += `Save path:         ${safeSavePath}\n`;
    }
    if (cfg.name)     text += `Cookie name:       ${cfg.name}\n`;

    text += `\nCookie settings:\n`;
    text += `  secure:          ${cfg.cookieSecure}\n`;
    text += `  samesite:        ${cfg.cookieSameSite}\n`;
    text += `  httponly:        ${cfg.cookieHttpOnly}\n`;
    text += `  lifetime:        ${cfg.cookieLifetime === 0 ? '0 (browser session)' : `${cfg.cookieLifetime}s`}\n`;
    text += `  path:            ${cfg.cookiePath}\n`;
    if (cfg.cookieDomain) text += `  domain:          ${cfg.cookieDomain}\n`;

    text += `\nGarbage collection:\n`;
    const gcChance = cfg.gcDivisor > 0
      ? `${((cfg.gcProbability / cfg.gcDivisor) * 100).toFixed(2)}%`
      : '0%';
    text += `  gc_maxlifetime:  ${cfg.gcMaxLifetime}s (${Math.round(cfg.gcMaxLifetime / 60)} min)\n`;
    text += `  gc chance:       ${gcChance} per request (${cfg.gcProbability}/${cfg.gcDivisor})\n`;

    if (issues.length > 0) {
      text += `\nSecurity audit (${issues.length} issue${issues.length > 1 ? 's' : ''}):\n`;
      for (const issue of issues) {
        const icon = issue.severity === 'critical' ? '✖' : issue.severity === 'warning' ? '⚠' : 'ℹ';
        text += `  ${icon} [${issue.severity.toUpperCase()}] ${issue.message}\n`;
      }
    } else {
      text += `\nSecurity audit: no issues found.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSessionStats(appPath: string): McpToolResult {
  try {
    const cfg = loadSessionConfig(appPath);

    let text = `Session Statistics\n${'='.repeat(40)}\n\n`;

    if (!cfg) {
      text += 'framework.session: not configured\n';
      return { content: [{ type: 'text', text }] };
    }

    const { isNative } = describeHandler(cfg.handlerId);
    const issues = auditSecurity(cfg);
    const critical = issues.filter((i) => i.severity === 'critical').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;

    text += `Handler:           ${isNative ? 'native (file)' : 'distributed'}\n`;
    text += `cookie_secure:     ${cfg.cookieSecure}\n`;
    text += `cookie_samesite:   ${cfg.cookieSameSite}\n`;
    text += `cookie_httponly:   ${cfg.cookieHttpOnly}\n`;
    text += `gc_maxlifetime:    ${cfg.gcMaxLifetime}s\n`;
    text += `\nSecurity issues:   ${critical} critical, ${warnings} warnings\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getSessionConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_session_config',
      description: 'Show session configuration and security audit: handler (Redis/DB/native), cookie_secure/samesite/httponly, gc_maxlifetime, security warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_session_stats',
      description: 'Show session statistics: handler type, cookie security settings, critical/warning issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
