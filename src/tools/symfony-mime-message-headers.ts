// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony MIME Message Headers Inspector
 *
 * Scans src/ PHP for getHeaders()->add(), new UnstructuredHeader(),
 *   addTextHeader(), addPathHeader(), getHeaders()->remove().
 * Extracts header names from string literals in header operations.
 *
 * Warns on:
 *   - Header name starting X- (deprecated RFC 6648, prefer X-less names)
 *   - Header value containing newline characters (injection risk)
 *   - Content-Type set manually instead of setBody()
 *   - Bcc header added after DKIM signing
 *   - Removing From/To/Subject (invalid email)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MimeHeaderInfo {
  file: string;
  className: string;
  customHeaders: string[];
  hasInjectionRisk: boolean;
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

function extractHeaderNames(content: string): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();

  // getHeaders()->add('Header-Name', ...) or addTextHeader('Header-Name', ...)
  const addRe = /(?:getHeaders\s*\(\s*\)\s*->\s*add|addTextHeader|addPathHeader|new\s+UnstructuredHeader)\s*\(\s*['"]([^'"]{1,100})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(content)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      headers.push(name);
    }
  }

  return headers;
}

function checkInjectionRisk(content: string): boolean {
  // Detect header value from user input or variable that might contain \n or \r
  // Simple heuristic: dynamic variable concatenated with header add calls
  const dynamicHeaderRe = /(?:addTextHeader|addPathHeader|getHeaders\s*\(\s*\)\s*->\s*add)\s*\([^)]{0,200}\$[a-zA-Z_][a-zA-Z0-9_]{0,50}/g;
  return dynamicHeaderRe.test(content);
}

function parseMimeHeaderFile(filePath: string, appPath: string): MimeHeaderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMimeHeaders = content.includes('getHeaders()') ||
    content.includes('UnstructuredHeader') ||
    content.includes('addTextHeader') ||
    content.includes('addPathHeader') ||
    content.includes('HeaderSet');

  if (!hasMimeHeaders) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const customHeaders = extractHeaderNames(content);
  const hasInjectionRisk = checkInjectionRisk(content);

  const issues: string[] = [];

  // Warn on X- headers (RFC 6648 deprecated)
  for (const header of customHeaders) {
    if (/^X-/i.test(header)) {
      issues.push(`Header "${header}" uses deprecated X- prefix (RFC 6648); prefer the unprefixed name instead`);
    }
  }

  // Warn on Content-Type set manually
  if (customHeaders.some((h) => /content-type/i.test(h))) {
    issues.push('Content-Type header set manually — use setBody() or setHtmlBody() / setTextBody() instead to ensure correct boundary/encoding');
  }

  // Warn on removing From/To/Subject
  const removeCalls = content.match(/getHeaders\s*\(\s*\)\s*->\s*remove\s*\(\s*['"]([^'"]{1,100})['"]/g) ?? [];
  for (const call of removeCalls) {
    const nameM = /remove\s*\(\s*['"]([^'"]{1,100})['"]/.exec(call);
    if (nameM) {
      const removed = nameM[1].toLowerCase();
      if (removed === 'from' || removed === 'to' || removed === 'subject') {
        issues.push(`Removing required header "${nameM[1]}" — email will be invalid and likely rejected by mail servers`);
      }
    }
  }

  // Warn on Bcc added after DKIM (heuristic: Bcc + DkimSigner in same file)
  if (content.includes('Bcc') && content.includes('DkimSigner')) {
    issues.push('Bcc header manipulation found alongside DkimSigner — adding Bcc after DKIM signing invalidates the signature');
  }

  // Warn on potential header injection via dynamic values
  if (hasInjectionRisk) {
    issues.push('Header value appears to use dynamic/user-supplied variable — validate and sanitize to prevent CRLF header injection');
  }

  return {
    file: path.relative(appPath, filePath),
    className: classM[1],
    customHeaders,
    hasInjectionRisk,
    issues,
  };
}

export function listSymfonyMimeMessageHeaders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: MimeHeaderInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseMimeHeaderFile(file, appPath);
      if (info) results.push(info);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony MIME header manipulation found in src/.' }] };
    }

    results.sort((a, b) => b.issues.length - a.issues.length);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Symfony MIME Message Headers Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles with header operations: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      text += `\n  ${r.className}  (${r.file})\n`;
      if (r.customHeaders.length > 0) {
        text += `    Headers: ${r.customHeaders.join(', ')}\n`;
      }
      text += `    Injection risk: ${r.hasInjectionRisk ? 'YES' : 'no'}\n`;
      for (const issue of r.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyMimeMessageHeaderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: MimeHeaderInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseMimeHeaderFile(file, appPath);
        if (info) results.push(info);
      }
    }

    const allHeaders = results.flatMap((r) => r.customHeaders);
    const xPrefixHeaders = allHeaders.filter((h) => /^X-/i.test(h));

    let text = `Symfony MIME Message Header Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with header operations:  ${results.length}\n`;
    text += `Unique custom headers:         ${new Set(allHeaders).size}\n`;
    text += `X- prefixed headers:           ${xPrefixHeaders.length}\n`;
    text += `Files with injection risk:     ${results.filter((r) => r.hasInjectionRisk).length}\n`;
    text += `Total issues:                  ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyMimeMessageHeaderTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_mime_message_headers',
      description: 'Inspect Symfony MIME message header operations: getHeaders()->add(), UnstructuredHeader, addTextHeader, addPathHeader, getHeaders()->remove(); warns on deprecated X- prefix (RFC 6648), CRLF injection risk, manual Content-Type, Bcc after DKIM signing, removing From/To/Subject',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_mime_message_header_stats',
      description: 'Statistics for Symfony MIME message headers: files with operations, unique custom headers, X- prefixed count, injection risk count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
