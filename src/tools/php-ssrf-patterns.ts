// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SsrfInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

const SUPERGLOBALS = /\$_(GET|POST|REQUEST)/;
const FILTER_VAR_RE = /filter_var\s*\(/;
const LOCALHOST_RE = /127\.0\.0\.1|localhost|0\.0\.0\.0/;

function hasFilterVarNearby(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 10);
  const end = Math.min(lines.length - 1, lineIdx + 10);
  for (let i = start; i <= end; i++) {
    if (FILTER_VAR_RE.test(lines[i])) return true;
  }
  return false;
}

function hasLocalhostCheck(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 10);
  const end = Math.min(lines.length - 1, lineIdx + 10);
  for (let i = start; i <= end; i++) {
    if (LOCALHOST_RE.test(lines[i])) return true;
  }
  return false;
}

function buildSsrfInfos(appPath: string): SsrfInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: SsrfInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    // Quick pre-filter
    if (
      !content.includes('curl_init') &&
      !content.includes('curl_setopt') &&
      !content.includes('file_get_contents') &&
      !content.includes('->get(') &&
      !content.includes('->post(') &&
      !content.includes('->request(') &&
      !content.includes('new Client(')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

      // curl_init($var) — variable URL
      if (/\bcurl_init\s*\(\s*\$[^)]{0,200}\)/.test(trimmed)) {
        const filterPresent = hasFilterVarNearby(lines, i);
        const localhostCheck = hasLocalhostCheck(lines, i);
        let severity: 'high' | 'medium' | 'low';
        let issue: string;
        if (SUPERGLOBALS.test(trimmed)) {
          severity = 'high';
          issue = 'curl_init() with user-supplied URL — SSRF via superglobal; validate URL against an allowlist';
        } else if (!filterPresent && !localhostCheck) {
          severity = 'medium';
          issue = 'curl_init() with variable URL and no filter_var/allowlist check nearby';
        } else {
          severity = 'low';
          issue = 'curl_init() with variable URL — filter_var or allowlist check present nearby';
        }
        results.push({ file: relFile, line: i + 1, fn: 'curl_init', issue, severity });
      }

      // curl_setopt($ch, CURLOPT_URL, $var)
      if (/\bcurl_setopt\s*\([^,]{0,100},\s*CURLOPT_URL\s*,[^)]{0,200}\$[^)]{0,200}\)/.test(trimmed)) {
        const filterPresent = hasFilterVarNearby(lines, i);
        let severity: 'high' | 'medium' | 'low';
        let issue: string;
        if (SUPERGLOBALS.test(trimmed)) {
          severity = 'high';
          issue = 'curl_setopt(CURLOPT_URL) with user-supplied URL — SSRF via superglobal';
        } else if (!filterPresent) {
          severity = 'medium';
          issue = 'curl_setopt(CURLOPT_URL) with variable URL and no filter_var check nearby';
        } else {
          severity = 'low';
          issue = 'curl_setopt(CURLOPT_URL) with variable URL — filter_var check present nearby';
        }
        results.push({ file: relFile, line: i + 1, fn: 'curl_setopt(CURLOPT_URL)', issue, severity });
      }

      // file_get_contents($var) — variable URL
      if (/\bfile_get_contents\s*\(\s*\$[^)]{0,200}\)/.test(trimmed)) {
        const filterPresent = hasFilterVarNearby(lines, i);
        let severity: 'high' | 'medium' | 'low';
        let issue: string;
        if (SUPERGLOBALS.test(trimmed)) {
          severity = 'high';
          issue = 'file_get_contents() with user-supplied URL — SSRF or LFI via superglobal';
        } else if (!filterPresent) {
          severity = 'medium';
          issue = 'file_get_contents() with variable URL and no filter_var check nearby';
        } else {
          severity = 'low';
          issue = 'file_get_contents() with variable URL — filter_var check present nearby';
        }
        results.push({ file: relFile, line: i + 1, fn: 'file_get_contents', issue, severity });
      }

      // HTTP client: ->get($var), ->post($var), ->request($method, $var), new Client($var)
      const httpClientRe = /(->(get|post|request)\s*\(|new\s+Client\s*\()[^)]{0,200}\$[^)]{0,200}\)/;
      const httpMatch = httpClientRe.exec(trimmed);
      if (httpMatch !== null) {
        const fnName = httpMatch[2] !== undefined ? `->${ httpMatch[2]}()` : 'new Client()';
        const filterPresent = hasFilterVarNearby(lines, i);
        let severity: 'high' | 'medium' | 'low';
        let issue: string;
        if (SUPERGLOBALS.test(trimmed)) {
          severity = 'high';
          issue = `HTTP client ${fnName} with user-supplied URL — SSRF via superglobal; validate and allowlist the URL`;
        } else if (!filterPresent) {
          severity = 'high';
          issue = `HTTP client ${fnName} with variable URL and no filter_var check nearby — potential SSRF`;
        } else {
          severity = 'medium';
          issue = `HTTP client ${fnName} with variable URL — filter_var present but verify allowlist enforced`;
        }
        results.push({ file: relFile, line: i + 1, fn: fnName, issue, severity });
      }
    }
  }

  return results;
}

export function listPhpSsrfPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildSsrfInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SSRF risk patterns found in src/.' }] };
    }

    const high = infos.filter((i) => i.severity === 'high');
    const medium = infos.filter((i) => i.severity === 'medium');
    const low = infos.filter((i) => i.severity === 'low');

    let text = `PHP SSRF Pattern Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `  High   (user input / no validation): ${high.length}\n`;
    text += `  Medium (variable, may lack validation): ${medium.length}\n`;
    text += `  Low    (filter_var or allowlist present): ${low.length}\n`;

    if (high.length > 0) {
      text += `\nHIGH SEVERITY — Unvalidated User-Controlled URL:\n`;
      for (const i of high) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (medium.length > 0) {
      text += `\nMEDIUM SEVERITY — Variable URL, Partial or Missing Validation:\n`;
      for (const i of medium) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (low.length > 0) {
      text += `\nLOW SEVERITY — Variable URL with Validation Present:\n`;
      for (const i of low) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSsrfPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildSsrfInfos(appPath);

    const high = infos.filter((i) => i.severity === 'high').length;
    const medium = infos.filter((i) => i.severity === 'medium').length;
    const low = infos.filter((i) => i.severity === 'low').length;
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    const byFn: Record<string, number> = {};
    for (const info of infos) {
      byFn[info.fn] = (byFn[info.fn] ?? 0) + 1;
    }

    const knownFns = ['curl_init', 'curl_setopt(CURLOPT_URL)', 'file_get_contents', '->get()', '->post()', '->request()', 'new Client()'];

    let text = `PHP SSRF Pattern Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total findings:       ${infos.length}\n`;
    text += `Files affected:       ${filesAffected}\n`;
    text += `  High severity:      ${high}\n`;
    text += `  Medium severity:    ${medium}\n`;
    text += `  Low severity:       ${low}\n\n`;
    text += `By function type:\n`;
    for (const fn of knownFns) {
      text += `  ${fn.padEnd(26)}: ${byFn[fn] ?? 0}\n`;
    }

    // Any function names not in the known list (e.g. from future additions)
    for (const [fn, count] of Object.entries(byFn)) {
      if (!knownFns.includes(fn)) {
        text += `  ${fn.padEnd(26)}: ${count}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSsrfPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_ssrf_patterns',
      description: 'Scan PHP source for SSRF (Server-Side Request Forgery) risks: curl_init, curl_setopt(CURLOPT_URL), file_get_contents, and HTTP client calls with variable URLs — classified by severity based on user-input and filter_var validation presence',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_ssrf_patterns_stats',
      description: 'Statistics for PHP SSRF findings: counts by severity (high/medium/low), affected files, and breakdown by function type (curl_init, file_get_contents, HTTP client methods)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
