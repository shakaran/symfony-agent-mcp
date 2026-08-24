// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NullByteInjectionInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
  issue: string;
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

// Superglobal pattern — user-supplied input
const SUPERGLOBALS_RE = /\$_(GET|POST)/;

// File access functions
const FILE_FUNCS = ['fopen(', 'file_get_contents(', 'include ', 'include_once ', 'require ', 'require_once '];

// Null-byte literal in string
const NULL_LITERAL_RE = /\\0|%00|chr\s*\(\s*0\s*\)/;

// str_replace null-byte stripping guard
const NULL_STRIP_RE = /str_replace\s*\(\s*["']\\0["']/;

// preg_match with [^/]+ path-segment pattern (might not handle null bytes)
const PREG_PATH_SEG_RE = /preg_match\s*\(\s*["'][^"']{0,200}[^/]+[^"']{0,200}["']/;

function analyzeLine(
  line: string,
  lineNum: number,
  relFile: string,
  lines: string[],
  lineIdx: number,
): NullByteInjectionInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  // Pattern 1: null-byte literal in file path construction with user data — HIGH
  if (NULL_LITERAL_RE.test(trimmed) && SUPERGLOBALS_RE.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'null-byte-literal-with-user-input',
      severity: 'high',
      issue: 'Null byte literal (\\0 / %00 / chr(0)) in file path construction with $_GET/$_POST — null byte injection risk',
    };
  }

  // Pattern 2: user input passed directly to file access functions — HIGH
  const hasUserInput = SUPERGLOBALS_RE.test(trimmed);
  if (hasUserInput) {
    for (const fn of FILE_FUNCS) {
      if (trimmed.includes(fn)) {
        return {
          file: relFile,
          line: lineNum,
          pattern: 'user-input-in-file-access',
          severity: 'high',
          issue: `$_GET/$_POST passed to ${fn.trim()} without null-byte stripping — user can inject \\0 to truncate path`,
        };
      }
    }
  }

  // Pattern 3: file access function with variable but missing null-byte stripping — MEDIUM
  // Look for file access functions with a $ variable, and check nearby lines for null-byte strip
  const hasFileFunc = FILE_FUNCS.some((fn) => trimmed.includes(fn));
  const hasVariable = trimmed.includes('$');
  if (hasFileFunc && hasVariable && !hasUserInput) {
    // Check current line and 5 prior lines for null-byte stripping guard
    const start = Math.max(0, lineIdx - 5);
    let hasStrip = false;
    for (let i = start; i <= lineIdx; i++) {
      if (NULL_STRIP_RE.test(lines[i])) {
        hasStrip = true;
        break;
      }
    }
    if (!hasStrip) {
      const funcName = FILE_FUNCS.find((fn) => trimmed.includes(fn)) ?? 'file-access';
      return {
        file: relFile,
        line: lineNum,
        pattern: 'missing-null-byte-strip',
        severity: 'medium',
        issue: `${funcName.trim()} called with variable argument — no str_replace("\\0","") guard found in nearby lines; verify user input is null-byte sanitised`,
      };
    }
  }

  // Pattern 4: preg_match with [^/]+ path-segment pattern — LOW
  if (PREG_PATH_SEG_RE.test(trimmed)) {
    return {
      file: relFile,
      line: lineNum,
      pattern: 'preg-path-segment-no-null-byte',
      severity: 'low',
      issue: 'preg_match uses [^/]+ for path segment validation — this character class does not exclude null bytes; add \\x00 exclusion or use str_replace("\\0","") before matching',
    };
  }

  return null;
}

function buildNullByteInjectionInfos(appPath: string): NullByteInjectionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: NullByteInjectionInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    // Quick pre-filter: must contain at least one relevant token
    const hasFileAccess = FILE_FUNCS.some((fn) => content.includes(fn));
    const hasNullLiteral = content.includes('\\0') || content.includes('%00') || content.includes('chr(0)');
    const hasPregMatch = content.includes('preg_match');
    if (!hasFileAccess && !hasNullLiteral && !hasPregMatch) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const info = analyzeLine(lines[i], i + 1, relFile, lines, i);
      if (info !== null) results.push(info);
    }
  }

  return results;
}

export function listPhpNullByteInjection(appPath: string): McpToolResult {
  try {
    const infos = buildNullByteInjectionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No null byte injection risks found in src/.' }] };
    }

    const high = infos.filter((i) => i.severity === 'high');
    const medium = infos.filter((i) => i.severity === 'medium');
    const low = infos.filter((i) => i.severity === 'low');

    let text = `PHP Null Byte Injection Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `  High   (direct null byte risk): ${high.length}\n`;
    text += `  Medium (missing strip guard):    ${medium.length}\n`;
    text += `  Low    (incomplete validation):  ${low.length}\n`;

    if (high.length > 0) {
      text += `\nHIGH SEVERITY — Direct Null Byte Risk:\n`;
      for (const i of high) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (medium.length > 0) {
      text += `\nMEDIUM SEVERITY — Missing Null Byte Strip Guard:\n`;
      for (const i of medium) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (low.length > 0) {
      text += `\nLOW SEVERITY — Incomplete Validation:\n`;
      for (const i of low) {
        text += `  [${i.pattern}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNullByteInjectionStats(appPath: string): McpToolResult {
  try {
    const infos = buildNullByteInjectionInfos(appPath);

    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map((i) => i.file)).size,
      bySeverity: { high: 0, medium: 0, low: 0 } as Record<string, number>,
      byPattern: {} as Record<string, number>,
    };

    for (const i of infos) {
      stats.bySeverity[i.severity] = (stats.bySeverity[i.severity] ?? 0) + 1;
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
    }

    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNullByteInjectionTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_null_byte_injection',
      description: 'Scan PHP src/ for null byte injection vulnerabilities: null-byte literals with user input (high), $_GET/$_POST in fopen/file_get_contents/include/require (high), missing str_replace null-byte strip guard (medium), preg_match path patterns without null-byte exclusion (low)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_null_byte_injection_stats',
      description: 'Statistics for PHP null byte injection findings: JSON with total, bySeverity, byPattern, filesAffected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
