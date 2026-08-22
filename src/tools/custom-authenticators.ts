/**
 * Custom Authenticator Inspector
 *
 * Scans src/ for Symfony Security authenticators:
 *   - AbstractAuthenticator subclasses (Passport-based, Symfony 5.3+)
 *   - AbstractLoginFormAuthenticator subclasses (form login)
 *   - AuthenticatorInterface implementations (custom)
 *   - RememberMeHandlerInterface implementations
 *
 * Passport badge analysis:
 *   - PasswordCredentials / SelfValidatingPassport
 *   - RememberMeBadge, CsrfTokenBadge, UserBadge, PreAuthenticatedUserBadge
 *
 * Firewall deep analysis from security.yaml:
 *   - firewall name, pattern, lazy, stateless
 *   - custom_authenticator references
 *   - login_throttling configuration
 *   - remember_me settings (lifetime, secure cookie)
 *   - access_denied_handler, entry_point
 *
 * Security:
 *   - Stateless firewalls with remember_me (contradiction)
 *   - Login throttling missing (brute-force risk)
 *   - CSRF badge missing on form login
 *   - Remember-me without secure cookie
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface CustomAuthenticator {
  class: string;
  file: string;
  kind: 'abstract_authenticator' | 'form_login' | 'interface' | 'remember_me';
  badges: string[];
  supportsRoute?: string;
  issues: string[];
}

interface FirewallConfig {
  name: string;
  pattern?: string;
  stateless: boolean;
  lazy: boolean;
  customAuthenticators: string[];
  hasLoginThrottling: boolean;
  rememberMe?: { lifetime?: number; secure: boolean };
  entryPoint?: string;
  issues: string[];
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

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

const BADGE_PATTERNS: Array<[RegExp, string]> = [
  [/PasswordCredentials/,        'PasswordCredentials'],
  [/SelfValidatingPassport/,     'SelfValidatingPassport'],
  [/RememberMeBadge/,            'RememberMeBadge'],
  [/CsrfTokenBadge/,             'CsrfTokenBadge'],
  [/UserBadge/,                  'UserBadge'],
  [/PreAuthenticatedUserBadge/,  'PreAuthenticatedUserBadge'],
  [/TwoFactorBadge/,             'TwoFactorBadge'],
];

function parseAuthenticator(filePath: string): CustomAuthenticator | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isAbstract    = content.includes('AbstractAuthenticator');
  const isFormLogin   = content.includes('AbstractLoginFormAuthenticator');
  const isInterface   = content.includes('AuthenticatorInterface') && !isAbstract && !isFormLogin;
  const isRememberMe  = content.includes('RememberMeHandlerInterface');

  if (!isAbstract && !isFormLogin && !isInterface && !isRememberMe) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const kind: CustomAuthenticator['kind'] = isFormLogin   ? 'form_login'
    : isAbstract  ? 'abstract_authenticator'
    : isRememberMe ? 'remember_me'
    : 'interface';

  const badges: string[] = [];
  for (const [pattern, name] of BADGE_PATTERNS) {
    if (pattern.test(content)) badges.push(name);
  }

  const supportsM = /getLoginUrl\s*\([^)]*\)[^{]*\{[^}]*return\s+['"]([^'"]+)['"]/.exec(content) ??
                    /loginPath\s*=\s*['"]([^'"]+)['"]/.exec(content);

  const issues: string[] = [];
  if (kind === 'form_login' && !badges.includes('CsrfTokenBadge')) {
    issues.push('no CsrfTokenBadge — CSRF protection missing on login form');
  }
  if (kind === 'abstract_authenticator' && badges.length === 0) {
    issues.push('no Passport badges detected — verify authenticate() returns a proper Passport');
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    kind,
    badges,
    supportsRoute: supportsM?.[1],
    issues,
  };
}

function scanAuthenticators(appPath: string): CustomAuthenticator[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CustomAuthenticator[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const a = parseAuthenticator(file);
    if (a) results.push(a);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Firewall analysis ────────────────────────────────────────────────────────

function loadFirewalls(appPath: string): FirewallConfig[] {
  const secFile = path.join(appPath, 'config', 'packages', 'security.yaml');
  const raw = parseYamlFile(secFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const security   = (raw['security'] ?? raw) as Record<string, unknown>;
  const firewallsRaw = security['firewalls'] as Record<string, unknown> | undefined;
  if (!firewallsRaw) return [];

  const firewalls: FirewallConfig[] = [];

  for (const [name, def] of Object.entries(firewallsRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;

    if (d['security'] === false) continue; // dev/profiler firewalls

    const stateless = d['stateless'] === true;
    const lazy      = d['lazy'] === true;

    const customAuthenticators: string[] = [];
    if (d['custom_authenticator']) {
      const ca = d['custom_authenticator'];
      if (Array.isArray(ca)) customAuthenticators.push(...ca.map(String));
      else customAuthenticators.push(String(ca));
    }

    const hasLoginThrottling = !!d['login_throttling'];

    let rememberMe: FirewallConfig['rememberMe'];
    if (d['remember_me']) {
      const rm = d['remember_me'] as Record<string, unknown>;
      rememberMe = {
        lifetime: rm['lifetime'] !== undefined ? Number(rm['lifetime']) : undefined,
        secure: rm['secure'] !== false,
      };
    }

    const issues: string[] = [];
    if (stateless && rememberMe) {
      issues.push('stateless firewall with remember_me — remember_me has no effect on stateless firewalls');
    }
    if (!stateless && !hasLoginThrottling && customAuthenticators.length > 0) {
      issues.push('no login_throttling — brute-force protection missing');
    }
    if (rememberMe && !rememberMe.secure) {
      issues.push('remember_me.secure is false — cookie may be sent over HTTP');
    }
    if (rememberMe?.lifetime && rememberMe.lifetime > 2592000) {
      issues.push(`remember_me lifetime is ${Math.round(rememberMe.lifetime / 86400)} days — consider a shorter value`);
    }

    firewalls.push({
      name,
      pattern: d['pattern'] ? String(d['pattern']) : undefined,
      stateless,
      lazy,
      customAuthenticators,
      hasLoginThrottling,
      rememberMe,
      entryPoint: d['entry_point'] ? String(d['entry_point']) : undefined,
      issues,
    });
  }

  return firewalls;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listCustomAuthenticators(appPath: string): McpToolResult {
  try {
    const authenticators = scanAuthenticators(appPath);
    const firewalls      = loadFirewalls(appPath);

    if (authenticators.length === 0 && firewalls.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom authenticators or security firewalls found.\n\nCreate a custom authenticator:\n  php bin/console make:security:custom-authenticator\n\nOr use built-in form login:\n  # security.yaml\n  firewalls:\n    main:\n      form_login:\n        login_path: app_login\n        check_path: app_login',
        }],
      };
    }

    let text = `Custom Authenticators & Firewalls\n${'='.repeat(55)}\n`;

    if (authenticators.length > 0) {
      const byKind = new Map<string, CustomAuthenticator[]>();
      for (const a of authenticators) {
        const list = byKind.get(a.kind) ?? [];
        list.push(a);
        byKind.set(a.kind, list);
      }

      text += `\nAuthenticator classes (${authenticators.length}):\n`;
      for (const [kind, auths] of byKind) {
        const label = kind.replace(/_/g, ' ');
        text += `\n  ${label} (${auths.length}):\n`;
        for (const a of auths) {
          const badges = a.badges.length > 0 ? `  badges: ${a.badges.join(', ')}` : '';
          text += `    ${a.class.padEnd(40)} (${a.file})${badges}\n`;
          for (const issue of a.issues) text += `      ⚠ ${issue}\n`;
        }
      }
    }

    if (firewalls.length > 0) {
      text += `\nFirewalls (${firewalls.length}):\n`;
      for (const fw of firewalls) {
        const pattern    = fw.pattern ? `  pattern: ${fw.pattern}` : '';
        const stateless  = fw.stateless ? '  [stateless]' : '';
        const throttle   = fw.hasLoginThrottling ? '  ✓ throttling' : '';
        const rm         = fw.rememberMe ? `  remember_me(${fw.rememberMe.lifetime ? `${Math.round(fw.rememberMe.lifetime / 86400)}d` : '?'})` : '';
        text += `  ${fw.name.padEnd(25)}${pattern}${stateless}${throttle}${rm}\n`;
        if (fw.customAuthenticators.length > 0) {
          text += `    Authenticators: ${fw.customAuthenticators.join(', ')}\n`;
        }
        for (const issue of fw.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    const allIssues = [
      ...authenticators.flatMap((a) => a.issues),
      ...firewalls.flatMap((fw) => fw.issues),
    ];
    if (allIssues.length === 0) {
      text += `\n✓ No security issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAuthenticatorStats(appPath: string): McpToolResult {
  try {
    const authenticators = scanAuthenticators(appPath);
    const firewalls      = loadFirewalls(appPath);

    let text = `Authenticator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total authenticators:   ${authenticators.length}\n`;
    text += `  AbstractAuthenticator: ${authenticators.filter((a) => a.kind === 'abstract_authenticator').length}\n`;
    text += `  Form login:            ${authenticators.filter((a) => a.kind === 'form_login').length}\n`;
    text += `  AuthInterface:         ${authenticators.filter((a) => a.kind === 'interface').length}\n`;
    text += `With CSRF badge:        ${authenticators.filter((a) => a.badges.includes('CsrfTokenBadge')).length}\n`;
    text += `With RememberMe badge:  ${authenticators.filter((a) => a.badges.includes('RememberMeBadge')).length}\n`;
    text += `Firewalls:              ${firewalls.length}\n`;
    text += `Stateless firewalls:    ${firewalls.filter((fw) => fw.stateless).length}\n`;
    text += `With login throttling:  ${firewalls.filter((fw) => fw.hasLoginThrottling).length}\n`;
    text += `Security issues:        ${[...authenticators, ...firewalls].reduce((s, x) => s + x.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomAuthenticatorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_custom_authenticators',
      description: 'Show custom authenticators: AbstractAuthenticator/AbstractLoginFormAuthenticator subclasses with Passport badge analysis (CSRF/RememberMe/PasswordCredentials), firewall deep config (stateless, login_throttling, remember_me security), security issue detection',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_authenticator_stats',
      description: 'Show authenticator statistics: total count by kind, CSRF/RememberMe badge coverage, firewall count, stateless count, login throttling coverage, security issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
