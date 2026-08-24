// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Twig Template Security Inspector
 *
 * Detects Twig template security patterns (is_granted, app.user, security checks).
 * Scans templates/ and src/ for Twig files with:
 *   is_granted(), app.user, app.token, {% if is_granted %},
 *   attribute(app.user, 'role').
 *
 * Warns on:
 *   - is_granted() in loop (repeated authz checks, use once before loop)
 *   - app.user accessed without null check (anonymous user is null)
 *   - is_granted with hardcoded role string not matching security.yaml roles
 *   - ROLE_ prefix missing on role string in is_granted()
 *   - template displaying sensitive data without is_granted check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';


interface TwigSecurityInfo {
  file: string;
  grants: string[];
  hasUserNullCheck: boolean;
  inLoop: boolean;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadDefinedRoles(appPath: string): string[] {
  const configPath = path.join(appPath, 'config', 'packages', 'security.yaml');
  const roles: string[] = [];
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    // Collect roles from role_hierarchy
    const rolePattern = /\bROLE_\w{1,80}\b/g;
    let m: RegExpExecArray | null;
    while ((m = rolePattern.exec(raw)) !== null) {
      if (!roles.includes(m[0])) roles.push(m[0]);
    }
    parseYamlFile(configPath);
  } catch { /* skip */ }
  return roles;
}

const SENSITIVE_PATTERNS = [
  'password',
  'secret',
  'token',
  'credit_card',
  'creditcard',
  'ssn',
  'apikey',
  'api_key',
  'private_key',
];

function parseTwigFile(filePath: string, definedRoles: string[]): TwigSecurityInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSecurityCheck =
    content.includes('is_granted') ||
    content.includes('app.user') ||
    content.includes('app.token');

  if (!hasSecurityCheck) return null;

  const issues: string[] = [];
  const grants: string[] = [];

  // Extract all is_granted() role arguments
  const grantPattern = /is_granted\s*\(\s*['"]([^'"]{1,80})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = grantPattern.exec(content)) !== null) {
    if (!grants.includes(m[1])) grants.push(m[1]);
  }

  // Check ROLE_ prefix
  for (const grant of grants) {
    if (!grant.startsWith('ROLE_') && !grant.startsWith('IS_AUTHENTICATED')) {
      issues.push(`is_granted("${grant}") is missing ROLE_ prefix — Symfony security checks are case-sensitive; use ROLE_${grant.toUpperCase()} or IS_AUTHENTICATED_*`);
    }
  }

  // Check against defined roles in security.yaml
  if (definedRoles.length > 0) {
    for (const grant of grants) {
      if (grant.startsWith('ROLE_') && !definedRoles.includes(grant)) {
        issues.push(`is_granted("${grant}") references a role not found in security.yaml role_hierarchy — this check will always return false`);
      }
    }
  }

  // Check is_granted() in a loop
  const inLoop = ((): boolean => {
    const loopPattern = /\{%-?\s*for\b[^%]{0,300}%\}([\s\S]{0,2000}?)\{%-?\s*endfor\s*-?%\}/g;
    let lm: RegExpExecArray | null;
    while ((lm = loopPattern.exec(content)) !== null) {
      if (lm[1].includes('is_granted')) return true;
    }
    return false;
  })();

  if (inLoop) {
    issues.push('is_granted() called inside a Twig for-loop — authorization check runs on every iteration; evaluate once before the loop and store in a variable');
  }

  // Check app.user null check
  const hasUserAccess = content.includes('app.user');
  const hasUserNullCheck =
    content.includes('app.user is not null') ||
    content.includes('app.user != null') ||
    content.includes('app.user is defined') ||
    content.includes('app.user|default') ||
    content.includes('if app.user');

  if (hasUserAccess && !hasUserNullCheck) {
    issues.push('app.user accessed without null check — anonymous users have app.user == null; accessing properties on null causes a Twig error');
  }

  // Check sensitive data exposed without is_granted
  const hasSensitiveOutput = SENSITIVE_PATTERNS.some((p) => content.toLowerCase().includes(p));
  if (hasSensitiveOutput && !content.includes('is_granted')) {
    issues.push('Template appears to display sensitive data (password/token/secret) without an is_granted() guard');
  }

  // Check attribute(app.user, ...) without null check
  if (content.includes("attribute(app.user") && !hasUserNullCheck) {
    issues.push("attribute(app.user, ...) called without checking app.user is not null — will throw on anonymous requests");
  }

  return { file: filePath, grants, hasUserNullCheck, inLoop, issues };
}

function loadTwigSecurityInfos(appPath: string): TwigSecurityInfo[] {
  const definedRoles = loadDefinedRoles(appPath);
  const results: TwigSecurityInfo[] = [];
  const dirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of getAllTwigFiles(dir)) {
      const r = parseTwigFile(f, definedRoles);
      if (r) {
        r.file = path.relative(appPath, r.file);
        results.push(r);
      }
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyTwigSecurity(appPath: string): McpToolResult {
  try {
    const infos = loadTwigSecurityInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Twig templates with security checks (is_granted, app.user) found.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Twig Security Inspector (${infos.length} templates)\n${'='.repeat(58)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}\n`;
      if (info.grants.length > 0) {
        text += `    roles checked: [${info.grants.join(', ')}]\n`;
      }
      const flags = [
        info.hasUserNullCheck ? 'user-null-checked' : 'NO-null-check',
        info.inLoop ? 'is_granted-in-loop' : '',
      ].filter(Boolean).join(', ');
      if (flags) text += `    flags: [${flags}]\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTwigSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = loadTwigSecurityInfos(appPath);

    let text = `Twig Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates with security checks:   ${infos.length}\n`;
    text += `  With app.user null check:       ${infos.filter((i) => i.hasUserNullCheck).length}\n`;
    text += `  is_granted in loop:             ${infos.filter((i) => i.inLoop).length}\n`;
    text += `Unique roles checked:             ${[...new Set(infos.flatMap((i) => i.grants))].length}\n`;
    text += `Issues:                           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTwigSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_twig_security',
      description: 'List Twig template security patterns: detects is_granted(), app.user, app.token usage; warns on is_granted() in for-loop (performance), app.user without null check (anonymous user crash), missing ROLE_ prefix, undefined roles, sensitive data without guard',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_twig_security_stats',
      description: 'Show Twig security statistics: total templates with security checks, null-check coverage, loop usage, unique roles checked, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
