// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CookieUsage {
  file: string;
  class?: string;
  hasHttpOnly: boolean;
  hasSecure: boolean;
  hasSameSite: boolean;
  usesRawCookie: boolean;
  issues: string[];
}

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

function parseCookieUsage(filePath: string, appPath: string): CookieUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  if (!content.includes('new Cookie(') && !content.includes('setcookie(') && !content.includes('->cookie(')) return null;
  if (content.includes('namespace Symfony\\Component\\HttpFoundation\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasHttpOnly = /httpOnly\s*[:=]\s*true/i.test(content) || /new Cookie\s*\([^)]{0,300}true\s*,\s*true/.test(content);
  const hasSecure = /secure\s*[:=]\s*true/i.test(content) || content.includes("'auto'");
  const hasSameSite = /sameSite\s*[:=]\s*['"](?:Strict|Lax|None)['"]/i.test(content) || content.includes('Cookie::SAMESITE_');
  const usesRawCookie = content.includes('setcookie(');
  const issues: string[] = [];
  if (usesRawCookie) issues.push('setcookie() used directly — prefer Symfony Cookie class for full flag control and testability');
  if (!hasHttpOnly) issues.push('Cookie without HttpOnly flag — JavaScript can access this cookie (XSS risk)');
  if (!hasSecure) issues.push('Cookie without Secure flag — cookie may be sent over plain HTTP');
  if (!hasSameSite) issues.push('Cookie without SameSite attribute — CSRF risk; set to Lax or Strict');
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasHttpOnly, hasSecure, hasSameSite, usesRawCookie, issues };
}

function loadSessionCookieConfig(appPath: string): string[] {
  const issues: string[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'framework.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const session = (framework['session'] ?? {}) as Record<string, unknown>;
    if (!session['cookie_secure'] || session['cookie_secure'] === false) issues.push('session.cookie_secure is not true — session cookie sent over HTTP');
    if (!session['cookie_httponly'] && session['cookie_httponly'] !== true) issues.push('session.cookie_httponly not explicitly true — JavaScript may access session cookie');
    if (!session['cookie_samesite']) issues.push('session.cookie_samesite not set — set to "lax" or "strict" to prevent CSRF');
  }
  return issues;
}

export function listCookieSecurity(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: CookieUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseCookieUsage(f, appPath);
        if (r) usages.push(r);
      }
    }
    const sessionIssues = loadSessionCookieConfig(appPath);
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0) + sessionIssues.length;
    let text = `Cookie Security\n${'='.repeat(55)}\n\nFiles with cookies: ${usages.length}  Issues: ${totalIssues}\n`;
    if (sessionIssues.length > 0) {
      text += '\nSession cookie (framework.yaml):\n';
      for (const i of sessionIssues) text += `  ⚠ ${i}\n`;
    }
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [u.hasHttpOnly ? '✓HttpOnly' : '✗HttpOnly', u.hasSecure ? '✓Secure' : '✗Secure', u.hasSameSite ? '✓SameSite' : '✗SameSite'].join('  ');
      text += `\n  ${u.class ?? '(file)'}  ${flags}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCookieSecurityStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: CookieUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseCookieUsage(f, appPath);
        if (r) usages.push(r);
      }
    }
    const sessionIssues = loadSessionCookieConfig(appPath);
    let text = `Cookie Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with cookies: ${usages.length}\n  HttpOnly: ${usages.filter(u => u.hasHttpOnly).length}\n  Secure: ${usages.filter(u => u.hasSecure).length}\n  SameSite: ${usages.filter(u => u.hasSameSite).length}\n  setcookie() (raw): ${usages.filter(u => u.usesRawCookie).length}\nSession config issues: ${sessionIssues.length}\nTotal issues: ${usages.reduce((s, u) => s + u.issues.length, 0) + sessionIssues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCookieSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_cookie_security', description: 'Audit cookie security flags: Symfony Cookie class HttpOnly/Secure/SameSite, setcookie() raw usage, session cookie config (cookie_secure/cookie_httponly/cookie_samesite) in framework.yaml', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_cookie_security_stats', description: 'Cookie security statistics: file count, HttpOnly/Secure/SameSite coverage, raw setcookie usage, session config issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
