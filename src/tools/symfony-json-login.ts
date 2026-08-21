/**
 * Symfony json_login Security Configuration Inspector
 *
 * Scans config/packages/security.yaml for json_login and form_login
 * firewall entries. Flags missing handlers, stateless firewalls,
 * conflicting check_paths, and CSRF notes.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface LoginFinding {
  firewall: string;
  type: 'json_login' | 'form_login' | 'json_login_ldap';
  checkPath: string | null;
  issue: string | null;
}

function safeReadAbs(filePath: string): string | null {
  try { return fs.readFileSync(path.resolve(filePath), 'utf-8'); } catch { return null; }
}

function findSecurityYaml(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
    path.join(appPath, 'config', 'security.yaml'),
  ];
  for (const c of candidates) {
    if (safeReadAbs(c) !== null) return c;
  }
  return null;
}

// Parse security.yaml line-by-line to extract firewall login config
function parseSecurityYaml(content: string): LoginFinding[] {
  const findings: LoginFinding[] = [];
  const lines = content.split('\n');

  // Track firewalls section
  let inFirewalls = false;
  let currentFirewall = '';
  let firewallIndent = -1;
  let currentStateless = false;
  let currentHasTokenStorage = false;

  // Per-firewall: collect login entries
  let pendingFindings: Array<{
    type: 'json_login' | 'form_login' | 'json_login_ldap';
    checkPath: string | null;
    hasSuccessHandler: boolean;
    hasFailureHandler: boolean;
  }> = [];

  const checkPaths = new Set<string>();

  const flushFirewall = (): void => {
    if (!currentFirewall) return;
    for (const pf of pendingFindings) {
      const issues: string[] = [];

      if (pf.type === 'json_login' || pf.type === 'json_login_ldap') {
        if (!pf.hasSuccessHandler) {
          issues.push('json_login without success_handler — Symfony returns 200+JSON body on success; SPA clients may expect a custom token response; add success_handler');
        }
        if (!pf.hasFailureHandler) {
          issues.push('json_login without failure_handler — default 401 response body may not match your API error format; add failure_handler');
        }
        if (currentStateless && !currentHasTokenStorage) {
          issues.push('json_login on stateless firewall without token storage configured — credentials are not persisted between requests; add token_storage or use JWT');
        }
        // Note: CSRF does not apply to json_login
        issues.push('Note: CSRF protection is not applicable for json_login — authentication is handled via JSON body parsing');
      }

      if (pf.type === 'form_login') {
        // Check for conflict with json_login on same check_path
        for (const of2 of pendingFindings) {
          if (of2 !== pf && (of2.type === 'json_login' || of2.type === 'json_login_ldap') && pf.checkPath && of2.checkPath === pf.checkPath) {
            issues.push(`form_login and ${of2.type} share the same check_path (${pf.checkPath}) — may conflict; use distinct paths`);
          }
        }
      }

      // Global: check_path not matching firewall pattern (heuristic: if check_path contains 'api' and firewall is 'main', flag)
      if (pf.checkPath && checkPaths.has(pf.checkPath)) {
        issues.push(`check_path ${pf.checkPath} is used by multiple login entries — may cause routing conflicts`);
      }
      if (pf.checkPath) checkPaths.add(pf.checkPath);

      findings.push({
        firewall: currentFirewall,
        type: pf.type,
        checkPath: pf.checkPath,
        issue: issues.length > 0 ? issues.join(' | ') : null,
      });
    }

    currentFirewall = '';
    currentStateless = false;
    currentHasTokenStorage = false;
    pendingFindings = [];
  };

  let currentLoginType: 'json_login' | 'form_login' | 'json_login_ldap' | null = null;
  let currentCheckPath: string | null = null;
  let currentHasSuccessHandler = false;
  let currentHasFailureHandler = false;
  let loginIndent = -1;

  const flushLogin = (): void => {
    if (!currentLoginType) return;
    pendingFindings.push({
      type: currentLoginType,
      checkPath: currentCheckPath,
      hasSuccessHandler: currentHasSuccessHandler,
      hasFailureHandler: currentHasFailureHandler,
    });
    currentLoginType = null;
    currentCheckPath = null;
    currentHasSuccessHandler = false;
    currentHasFailureHandler = false;
    loginIndent = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Detect firewalls: section
    if (/^\s{4,8}firewalls\s*:/.test(trimmed) || /^firewalls\s*:/.test(trimmed)) {
      inFirewalls = true;
      firewallIndent = (trimmed.match(/^(\s*)/) ?? ['', ''])[1].length + 4;
      continue;
    }
    if (!inFirewalls) continue;

    // Exit firewalls section on a top-level key
    if (/^\S/.test(trimmed) && !/^security\s*:|^\s/.test(trimmed)) {
      flushLogin();
      flushFirewall();
      inFirewalls = false;
      continue;
    }

    // Detect new firewall name
    const fwMatch = new RegExp(`^(\\s{${firewallIndent}})(\\w[a-zA-Z0-9_]{0,80})\\s*:`).exec(trimmed);
    if (fwMatch) {
      flushLogin();
      flushFirewall();
      currentFirewall = fwMatch[2];
      continue;
    }

    if (!currentFirewall) continue;

    // Stateless
    if (/^\s+stateless\s*:\s*true/.test(trimmed)) currentStateless = true;
    // Token storage
    if (/token_storage|token_authenticator|jwt/.test(trimmed)) currentHasTokenStorage = true;

    // Detect login type entries
    const jsonLoginMatch = /^(\s+)(json_login|json_login_ldap|form_login)\s*:/.exec(trimmed);
    if (jsonLoginMatch) {
      flushLogin();
      currentLoginType = jsonLoginMatch[2] as 'json_login' | 'form_login' | 'json_login_ldap';
      loginIndent = jsonLoginMatch[1].length + 4;
      continue;
    }

    if (!currentLoginType) continue;

    // Properties inside a login block (indented beyond loginIndent)
    const indent = (trimmed.match(/^(\s*)/) ?? ['', ''])[1].length;
    if (loginIndent > 0 && indent < loginIndent) {
      flushLogin();
      continue;
    }

    const checkPathMatch = /^\s+check_path\s*:\s*([^\s#][^\n]{0,200})/.exec(trimmed);
    if (checkPathMatch) { currentCheckPath = checkPathMatch[1].trim().replace(/^['"]|['"]$/g, ''); continue; }

    if (/^\s+success_handler\s*:/.test(trimmed)) currentHasSuccessHandler = true;
    if (/^\s+failure_handler\s*:/.test(trimmed)) currentHasFailureHandler = true;
  }

  flushLogin();
  flushFirewall();

  return findings;
}

function loadFindings(appPath: string): LoginFinding[] {
  const secFile = findSecurityYaml(appPath);
  if (!secFile) return [];
  const raw = safeReadAbs(secFile);
  if (!raw) return [];
  return parseSecurityYaml(raw);
}

export function listSymfonyJsonLogin(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No json_login or form_login firewall entries found in config/packages/security.yaml.\n\nExample:\n  firewalls:\n    api:\n      json_login:\n        check_path: /api/login\n        success_handler: App\\Security\\AuthSuccessHandler\n        failure_handler: App\\Security\\AuthFailureHandler' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony json_login / form_login Configuration\n${'='.repeat(55)}\n\nEntries: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      text += `\n  firewall: ${f.firewall}  type: ${f.type}\n`;
      if (f.checkPath) text += `    check_path: ${f.checkPath}\n`;
      if (f.issue) {
        for (const part of f.issue.split(' | ')) text += `    ⚠ ${part}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyJsonLoginStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byType: Record<string, number> = {};
    for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony json_login Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total login entries: ${findings.length}\nWith issues: ${issues.length}\n\nBy type:\n`;
    for (const [t, count] of Object.entries(byType)) text += `  ${t}: ${count}\n`;
    const firewalls = new Set(findings.map(f => f.firewall));
    text += `\nFirewalls with login: ${firewalls.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyJsonLoginTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_json_login', description: 'Parse config/packages/security.yaml for json_login/form_login/json_login_ldap firewall entries — flags missing success/failure handlers, stateless firewall without token storage, conflicting check_paths, notes CSRF not applicable for json_login', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_json_login_stats', description: 'Statistics for json_login configuration: total login entries, issues count, breakdown by login type, firewalls affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
