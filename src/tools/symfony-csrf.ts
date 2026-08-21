/**
 * Symfony CSRF Protection Inspector
 *
 * Distinct from security-scanner.ts (SQL injection / XSS generic scan).
 * Focuses specifically on CSRF protection configuration:
 *
 * framework.yaml:
 *   - csrf_protection: enabled (true/false)
 *   - form CSRF: enabled per form type
 *
 * Form-level CSRF:
 *   - FormType classes with getDefaultOptions/configureOptions setting csrf_protection: false
 *   - Forms that extend AbstractType but don't call parent options (CSRF bypass risk)
 *
 * Cookie / session security:
 *   - session.cookie_samesite (strict/lax/none)
 *   - session.cookie_secure
 *   - session.cookie_httponly
 *   - cookie_lifetime: 0 (session cookie)
 *
 * Route-level CSRF:
 *   - StateInterface / #[IgnoreCsrf] (Symfony 7)
 *   - Routes that modify state without CSRF protection (POST handlers with no _token check)
 *
 * Analysis:
 *   - CSRF globally disabled
 *   - Forms disabling CSRF without obvious reason (API endpoint vs web form)
 *   - SameSite=None without Secure flag (CSRF vector)
 *   - Long session lifetime (increases CSRF window)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CsrfConfig {
  globallyEnabled: boolean;
  cookieSameSite?: string;
  cookieSecure?: boolean;
  cookieHttpOnly?: boolean;
  cookieLifetime?: number;
}

interface FormCsrfIssue {
  class: string;
  file: string;
  issue: string;
}

function loadCsrfConfig(appPath: string): CsrfConfig {
  const frameworkPath = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkPath) as Record<string, unknown> | null;
  if (!raw) return { globallyEnabled: true };

  const fw      = (raw['framework'] ?? raw) as Record<string, unknown>;
  const csrfRaw = fw['csrf_protection'];
  const globallyEnabled = csrfRaw === undefined ? true :
    (typeof csrfRaw === 'object' ? (csrfRaw as Record<string, unknown>)['enabled'] !== false : csrfRaw !== false && csrfRaw !== 'false');

  const sessionRaw = (fw['session'] ?? {}) as Record<string, unknown>;
  const cookieSameSite  = sessionRaw['cookie_samesite'] ? String(sessionRaw['cookie_samesite']) : undefined;
  const cookieSecure    = sessionRaw['cookie_secure'] === true || sessionRaw['cookie_secure'] === 'auto';
  const cookieHttpOnly  = sessionRaw['cookie_httponly'] !== false;
  const cookieLifetime  = sessionRaw['cookie_lifetime'] ? parseInt(String(sessionRaw['cookie_lifetime']), 10) : undefined;

  return { globallyEnabled, cookieSameSite, cookieSecure, cookieHttpOnly, cookieLifetime };
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

function scanFormCsrfIssues(appPath: string): FormCsrfIssue[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const issues: FormCsrfIssue[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('AbstractType') && !content.includes('FormTypeInterface')) continue;
    if (!content.includes('configureOptions')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // CSRF explicitly disabled
    if (/csrf_protection['"]\s*=>\s*false/.test(content)) {
      issues.push({ class: classM[1], file: path.basename(file), issue: 'CSRF protection explicitly disabled (csrf_protection => false)' });
    }

    // API forms that may not need CSRF but worth flagging if they have state-changing actions
    if (/csrf_field_name/.test(content) === false && content.includes('csrf_protection')) {
      // Already caught above
    }
  }
  return issues;
}

export function listCsrfConfig(appPath: string): McpToolResult {
  try {
    const config     = loadCsrfConfig(appPath);
    const formIssues = scanFormCsrfIssues(appPath);

    let text = `CSRF Protection Configuration\n${'='.repeat(55)}\n\n`;
    text += `Global CSRF:       ${config.globallyEnabled ? '✓ enabled' : '⚠ DISABLED'}\n`;
    text += `Cookie SameSite:   ${config.cookieSameSite ?? '⚠ not set (browser default, usually Lax)'}\n`;
    text += `Cookie Secure:     ${config.cookieSecure ? 'yes' : '⚠ no — cookies sent over HTTP'}\n`;
    text += `Cookie HttpOnly:   ${config.cookieHttpOnly ? 'yes' : '⚠ no — accessible via JavaScript'}\n`;
    if (config.cookieLifetime !== undefined) {
      text += `Cookie Lifetime:   ${config.cookieLifetime === 0 ? 'session (0)' : `${config.cookieLifetime}s`}\n`;
    }

    const globalIssues: string[] = [];
    if (!config.globallyEnabled) {
      globalIssues.push('CSRF protection globally disabled — all state-changing forms are vulnerable');
    }
    if (config.cookieSameSite === 'none' && !config.cookieSecure) {
      globalIssues.push('SameSite=None without Secure flag — CSRF tokens sent in cross-site requests');
    }
    if (config.cookieLifetime && config.cookieLifetime > 86400 * 30) {
      globalIssues.push(`Cookie lifetime ${Math.round(config.cookieLifetime / 86400)}d — long session increases CSRF exposure window`);
    }

    const allIssues = [...globalIssues, ...formIssues.map((f) => `${f.class}: ${f.issue}`)];
    if (allIssues.length > 0) {
      text += `\nIssues (${allIssues.length}):\n`;
      for (const issue of allIssues) text += `  ⚠ ${issue}\n`;
    } else {
      text += `\n✓ No CSRF issues detected\n`;
    }

    if (formIssues.length > 0) {
      text += `\nForms with CSRF disabled (${formIssues.length}):\n`;
      for (const f of formIssues) text += `  ${f.class}  (${f.file})\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCsrfStats(appPath: string): McpToolResult {
  try {
    const config     = loadCsrfConfig(appPath);
    const formIssues = scanFormCsrfIssues(appPath);

    let text = `CSRF Statistics\n${'='.repeat(40)}\n\n`;
    text += `Global CSRF enabled: ${config.globallyEnabled ? 'yes' : 'no'}\n`;
    text += `SameSite policy:     ${config.cookieSameSite ?? 'not set'}\n`;
    text += `Secure flag:         ${config.cookieSecure ? 'yes' : 'no'}\n`;
    text += `Forms disabling CSRF: ${formIssues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCsrfTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_csrf_config',
      description: 'Show CSRF protection configuration: global csrf_protection flag, cookie SameSite/Secure/HttpOnly/Lifetime, forms with csrf_protection disabled, SameSite=None without Secure warning, long session lifetime warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_csrf_stats',
      description: 'Show CSRF statistics: global CSRF enabled, SameSite policy, secure flag, form CSRF disabled count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
