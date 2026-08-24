// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SecurityHeaderInfo {
  file: string;
  class?: string;
  headers: string[];
  missingHeaders: string[];
  issues: string[];
}

const SECURITY_HEADERS = [
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Strict-Transport-Security',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
];

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

function parseSecurityHeaders(filePath: string, appPath: string): SecurityHeaderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isEventSub = content.includes('KernelEvents::RESPONSE') || content.includes('kernel.response') || content.includes('ResponseListener') || (content.includes('onKernelResponse') && content.includes('headers->set'));
  if (!isEventSub) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const found: string[] = [];
  for (const h of SECURITY_HEADERS) {
    if (content.toLowerCase().includes(h.toLowerCase())) found.push(h);
  }
  const missing = SECURITY_HEADERS.filter(h => !found.includes(h));
  const issues: string[] = [];
  if (found.length === 0) issues.push('Response listener does not set any security headers');
  if (missing.includes('X-Content-Type-Options')) issues.push('Missing X-Content-Type-Options: nosniff — prevents MIME-type sniffing attacks');
  if (missing.includes('Referrer-Policy')) issues.push('Missing Referrer-Policy — sensitive URL data may leak via Referer header');
  if (missing.includes('Permissions-Policy')) issues.push('Missing Permissions-Policy — browser features (camera, microphone) not restricted');
  return { file: path.relative(appPath, filePath), class: classM?.[1], headers: found, missingHeaders: missing, issues };
}

export function listHttpSecurityHeaders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SecurityHeaderInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseSecurityHeaders(f, appPath);
        if (r) results.push(r);
      }
    }
    if (results.length === 0) return { content: [{ type: 'text', text: `No app-level security header listeners found.\n\nRecommend adding a KernelEvents::RESPONSE subscriber that sets:\n${SECURITY_HEADERS.map(h => `  - ${h}`).join('\n')}\n\nNote: webserver-level headers (nginx/apache) are checked by list_webserver_config.` }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `HTTP App-Level Security Headers\n${'='.repeat(55)}\n\nListeners: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class ?? '(file)'}  (${r.file})\n`;
      text += `    Set: ${r.headers.length > 0 ? r.headers.join(', ') : 'none'}\n`;
      if (r.missingHeaders.length > 0) text += `    Missing: ${r.missingHeaders.join(', ')}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHttpSecurityHeaderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SecurityHeaderInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseSecurityHeaders(f, appPath);
        if (r) results.push(r);
      }
    }
    const headerCoverage: Record<string, number> = {};
    for (const h of SECURITY_HEADERS) headerCoverage[h] = results.filter(r => r.headers.includes(h)).length;
    let text = `HTTP Security Header Statistics\n${'='.repeat(40)}\n\n`;
    text += `Response listeners: ${results.length}\nSecurity headers coverage (across listeners):\n`;
    for (const [h, c] of Object.entries(headerCoverage)) text += `  ${h}: ${c}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHttpSecurityHeaderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_http_security_headers', description: 'Detect app-level HTTP security headers set via KernelEvents::RESPONSE subscribers: X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS, COOP, CORP — distinct from webserver-level headers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_http_security_header_stats', description: 'HTTP security header statistics: listener count, per-header coverage count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
