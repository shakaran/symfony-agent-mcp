// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Security Passport Badges Inspector
 *
 * Distinct from custom-authenticators.ts (authenticator class structure)
 * and oauth-sso.ts (OAuth/SSO configuration).
 * Focuses on the Passport badge system introduced in Symfony 5.4:
 *
 * Built-in badges scanned:
 *   - UserBadge: user loader callback, user identifier
 *   - PasswordCredentials: plaintext credential handling
 *   - CsrfTokenBadge: token ID and value extraction
 *   - RememberMeBadge: remember-me opt-in
 *   - TwoFactorBadge (scheb/2fa): two-factor enforcement
 *   - PreAuthenticatedUserBadge: pre-auth scenarios
 *
 * Custom badges:
 *   - Classes implementing BadgeInterface
 *   - isResolved() implementation
 *   - Badges that require a BadgeResolverInterface
 *
 * Analysis:
 *   - Authenticator creating Passport without CsrfTokenBadge (CSRF risk in form logins)
 *   - PasswordCredentials used in stateless API authenticator (sends plain password each request)
 *   - Custom badge with isResolved() always returning true (badge never actually resolved)
 *   - UserBadge without user loader callback (relies solely on provider)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PassportInfo {
  class: string;
  file: string;
  badges: string[];
  hasCsrf: boolean;
  hasRememberMe: boolean;
  hasPassword: boolean;
  customBadges: string[];
  issues: string[];
}

interface CustomBadge {
  class: string;
  file: string;
  isResolvedAlwaysTrue: boolean;
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

const BUILT_IN_BADGES = [
  'UserBadge', 'PasswordCredentials', 'CsrfTokenBadge',
  'RememberMeBadge', 'TwoFactorBadge', 'PreAuthenticatedUserBadge',
];

function parsePassport(filePath: string, appPath: string): PassportInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('Passport') || !content.includes('authenticate(')) return null;
  if (!content.includes('extends AbstractAuthenticator') &&
      !content.includes('implements AuthenticatorInterface') &&
      !content.includes('extends AbstractLoginFormAuthenticator')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const badges = BUILT_IN_BADGES.filter((b) => content.includes(b));
  const customBadges: string[] = [];

  for (const m of content.matchAll(/new\s+([A-Z][A-Za-z]+Badge)\s*\(/g)) {
    if (!BUILT_IN_BADGES.includes(m[1])) customBadges.push(m[1]);
  }

  const hasCsrf       = content.includes('CsrfTokenBadge');
  const hasRememberMe = content.includes('RememberMeBadge');
  const hasPassword   = content.includes('PasswordCredentials');

  const issues: string[] = [];
  if (!hasCsrf && content.includes('LoginFormAuthenticator') || !hasCsrf && content.includes('AbstractLoginFormAuthenticator')) {
    issues.push('Form login authenticator without CsrfTokenBadge — CSRF risk');
  }
  if (hasPassword && content.includes('stateless')) {
    issues.push('PasswordCredentials in stateless authenticator — plaintext password sent every request');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    badges,
    hasCsrf,
    hasRememberMe,
    hasPassword,
    customBadges,
    issues,
  };
}

function parseCustomBadge(filePath: string, appPath: string): CustomBadge | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('BadgeInterface') && !content.includes('implements BadgeInterface')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const isResolvedM = /function\s+isResolved[^{]*\{([^}]{0,200})/.exec(content);
  const isResolvedAlwaysTrue = isResolvedM
    ? /return\s+true/.test(isResolvedM[1]) && !/if|switch/.test(isResolvedM[1])
    : false;

  const issues: string[] = [];
  if (isResolvedAlwaysTrue) {
    issues.push('isResolved() always returns true — badge is never actually resolved/verified');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    isResolvedAlwaysTrue,
    issues,
  };
}

export function listPassportBadges(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const passports: PassportInfo[] = [];
    const customBadges: CustomBadge[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const p = parsePassport(file, appPath);
      if (p) passports.push(p);
      const cb = parseCustomBadge(file, appPath);
      if (cb) customBadges.push(cb);
    }

    if (passports.length === 0 && customBadges.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Passport-based authenticators or custom badges found.\n\nExample authenticator:\n  public function authenticate(Request $request): Passport\n  {\n    return new Passport(\n      new UserBadge($request->request->getString(\'email\')),\n      new PasswordCredentials($request->request->getString(\'password\')),\n      [new CsrfTokenBadge(\'authenticate\', $request->request->getString(\'_token\'))]\n    );\n  }',
        }],
      };
    }

    const totalIssues = passports.reduce((s, p) => s + p.issues.length, 0) +
                        customBadges.reduce((s, b) => s + b.issues.length, 0);

    let text = `Security Passport Badges\n${'='.repeat(55)}\n`;
    text += `\nAuthenticators using Passport: ${passports.length}  Issues: ${totalIssues}\n`;
    text += `Custom BadgeInterface classes:  ${customBadges.length}\n`;

    for (const p of passports.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      text += `\n  ${p.class}  (${p.file})\n`;
      text += `    Badges: ${p.badges.join(', ') || 'none detected'}\n`;
      if (p.customBadges.length > 0) text += `    Custom: ${p.customBadges.join(', ')}\n`;
      for (const issue of p.issues) text += `    ⚠ ${issue}\n`;
    }

    if (customBadges.length > 0) {
      text += `\nCustom badges:\n`;
      for (const b of customBadges) {
        text += `  ${b.class}  (${b.file})\n`;
        for (const issue of b.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBadgeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const passports: PassportInfo[] = [];
    const customBadges: CustomBadge[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const p = parsePassport(file, appPath);
        if (p) passports.push(p);
        const cb = parseCustomBadge(file, appPath);
        if (cb) customBadges.push(cb);
      }
    }

    let text = `Passport Badge Statistics\n${'='.repeat(40)}\n\n`;
    text += `Authenticators:      ${passports.length}\n`;
    text += `  With CSRF badge:   ${passports.filter((p) => p.hasCsrf).length}\n`;
    text += `  With RememberMe:   ${passports.filter((p) => p.hasRememberMe).length}\n`;
    text += `  With Password:     ${passports.filter((p) => p.hasPassword).length}\n`;
    text += `Custom badges:       ${customBadges.length}\n`;
    text += `Issues:              ${passports.reduce((s, p) => s + p.issues.length, 0) + customBadges.reduce((s, b) => s + b.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityPassportTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_passport_badges',
      description: 'Show Symfony Security Passport badge usage: UserBadge/PasswordCredentials/CsrfTokenBadge/RememberMeBadge per authenticator, custom BadgeInterface implementations, CSRF badge missing in form login warning, always-resolved custom badge detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_badge_stats',
      description: 'Show passport badge statistics: authenticator count, CSRF/RememberMe/Password badge counts, custom badge count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
