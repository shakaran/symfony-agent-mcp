// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UserChecker Inspector
 *
 * Scans src/ PHP for UserCheckerInterface implementations:
 *   checkPreAuth, checkPostAuth methods, classes extending AbstractUserChecker
 *
 * Reads security.yaml for user_checker: config per firewall.
 *
 * Detects:
 *   - AccountExpiredUser, AccountStatusException subclasses, custom ban/suspended checks
 *
 * Warns:
 *   - UserChecker implemented but not configured in any firewall
 *   - checkPreAuth() empty (no-op check)
 *   - checkPostAuth() throwing exception that doesn't extend AccountStatusException
 *   - Multiple UserCheckers but only one registered per firewall
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';


interface UserCheckerInfo {
  file: string;
  class: string;
  hasPreAuth: boolean;
  hasPostAuth: boolean;
  firewalls: string[];
  throwsCorrectException: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

// ─── Security.yaml reader ─────────────────────────────────────────────────────

function loadFirewallUserCheckers(appPath: string): Record<string, string> {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  const result: Record<string, string> = {};
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const firewalls = (security['firewalls'] ?? {}) as Record<string, unknown>;
    for (const [fwName, fwData] of Object.entries(firewalls)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      if (fw['user_checker']) {
        result[fwName] = String(fw['user_checker']);
      }
    }
    break;
  }
  return result;
}

// ─── Method body extractor ────────────────────────────────────────────────────

function extractMethodBody(content: string, methodName: string): string {
  const re = new RegExp(
    `function\\s+${methodName}\\s*\\([^)]{0,300}\\)[^{]{0,80}\\{([\\s\\S]{0,2000}?)\\}`,
  );
  const m = re.exec(content);
  return m ? m[1] : '';
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, firewallCheckers: Record<string, string>): UserCheckerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isUserChecker =
    content.includes('UserCheckerInterface') ||
    content.includes('AbstractUserChecker') ||
    (content.includes('checkPreAuth') && content.includes('checkPostAuth'));

  if (!isUserChecker) return null;

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasPreAuth = /function\s+checkPreAuth\s*\(/.test(content);
  const hasPostAuth = /function\s+checkPostAuth\s*\(/.test(content);

  // Which firewalls register this checker (match by short class name or FQCN)
  const firewalls: string[] = [];
  for (const [fw, checker] of Object.entries(firewallCheckers)) {
    if (checker.endsWith(className) || checker === className) {
      firewalls.push(fw);
    }
  }

  const issues: string[] = [];

  // Not configured in any firewall
  if (firewalls.length === 0) {
    issues.push(
      `${className} implements UserChecker but is not configured as user_checker in any firewall. ` +
      `Add user_checker: ${className} under the relevant firewall in security.yaml.`,
    );
  }

  // checkPreAuth with empty body (no-op)
  if (hasPreAuth) {
    const preBody = extractMethodBody(content, 'checkPreAuth');
    const bodyTrimmed = preBody.replace(/[\s\n\r]+/g, '');
    if (bodyTrimmed.length === 0 || bodyTrimmed === '//nothing' || bodyTrimmed === '//noop') {
      issues.push(
        `${className}::checkPreAuth() appears to be a no-op (empty body). ` +
        `If pre-authentication checks are needed, implement them; otherwise remove the method.`,
      );
    }
  }

  // checkPostAuth throwing wrong exception type
  let throwsCorrectException = true;
  if (hasPostAuth) {
    const postBody = extractMethodBody(content, 'checkPostAuth');
    if (postBody.includes('throw ')) {
      const hasAccountStatus =
        postBody.includes('AccountStatusException') ||
        postBody.includes('AccountExpiredException') ||
        postBody.includes('CredentialsExpiredException') ||
        postBody.includes('DisabledException') ||
        postBody.includes('LockedException');
      if (!hasAccountStatus) {
        throwsCorrectException = false;
        issues.push(
          `${className}::checkPostAuth() throws an exception that may not extend AccountStatusException. ` +
          `Symfony expects AccountStatusException subclasses — other exceptions will not be handled correctly.`,
        );
      }
    }
  }

  // Multiple checkers but only one per firewall
  const totalConfigured = Object.keys(firewallCheckers).length;
  const uniqueCheckers = new Set(Object.values(firewallCheckers)).size;
  if (totalConfigured > 1 && uniqueCheckers < totalConfigured) {
    issues.push(
      `Multiple firewalls share the same user_checker — each firewall can only have one user_checker. ` +
      `Consider using ChainUserChecker or consolidating checks.`,
    );
  }

  return {
    file: path.basename(filePath),
    class: className,
    hasPreAuth,
    hasPostAuth,
    firewalls,
    throwsCorrectException,
    issues,
  };
}

function loadAll(appPath: string): UserCheckerInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const firewallCheckers = loadFirewallUserCheckers(appPath);
  const results: UserCheckerInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file, firewallCheckers);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listUserCheckers(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No UserChecker implementations found in src/.\n\n' +
            'Implement UserCheckerInterface to add pre/post-authentication checks:\n' +
            '  class UserChecker implements UserCheckerInterface {\n' +
            '    public function checkPreAuth(UserInterface $user): void { ... }\n' +
            '    public function checkPostAuth(UserInterface $user): void { ... }\n' +
            '  }',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);
    const configured = items.filter((i) => i.firewalls.length > 0);

    let text = `Symfony UserChecker Analysis\n${'='.repeat(55)}\n`;
    text += `  UserChecker implementations: ${items.length}\n`;
    text += `  Configured in firewalls:     ${configured.length}\n`;
    text += `  With issues:                 ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.class} [${item.file}]\n`;
      text += `  checkPreAuth:  ${item.hasPreAuth ? 'yes' : 'no'}\n`;
      text += `  checkPostAuth: ${item.hasPostAuth ? 'yes' : 'no'}\n`;
      text += `  firewalls:     ${item.firewalls.length > 0 ? item.firewalls.join(', ') : '(none)'}\n`;
      text += `  correct exception: ${item.throwsCorrectException ? 'yes' : 'no'}\n`;
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUserCheckerStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `UserChecker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total checkers:            ${items.length}\n`;
    text += `Configured in firewalls:   ${items.filter((i) => i.firewalls.length > 0).length}\n`;
    text += `Unconfigured:              ${items.filter((i) => i.firewalls.length === 0).length}\n`;
    text += `Has checkPreAuth:          ${items.filter((i) => i.hasPreAuth).length}\n`;
    text += `Has checkPostAuth:         ${items.filter((i) => i.hasPostAuth).length}\n`;
    text += `Correct exception type:    ${items.filter((i) => i.throwsCorrectException).length}\n`;
    text += `With issues:               ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getUserCheckerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_user_checkers',
      description: 'List UserCheckerInterface implementations: checkPreAuth/checkPostAuth detection, firewall configuration, AccountStatusException usage, no-op check warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_user_checker_stats',
      description: 'Show UserChecker statistics: total checkers, configured/unconfigured counts, checkPreAuth/checkPostAuth coverage, exception type correctness, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
