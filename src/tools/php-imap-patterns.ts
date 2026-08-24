// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP IMAP/POP3 Pattern Inspector
 *
 * Scans src/ PHP files for IMAP/email handling security issues:
 *   - imap_open( with possibly hardcoded credentials (not from variable/env)
 *   - imap_fetchbody( / imap_body( followed by direct HTML output without sanitization
 *   - imap_savebody( with user-controlled path argument
 *   - imap_search( with variable criteria (IMAP injection risk)
 *   - quoted_printable_decode( / base64_decode( on email content without sanitization
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ImapPatternInfo {
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

function windowHasSanitization(lines: string[], centerIdx: number, radius: number): boolean {
  const start = Math.max(0, centerIdx - radius);
  const end = Math.min(lines.length - 1, centerIdx + radius);
  for (let i = start; i <= end; i++) {
    const l = lines[i];
    if (/htmlspecialchars\s*\(/.test(l) || /strip_tags\s*\(/.test(l) || /htmlentities\s*\(/.test(l)) {
      return true;
    }
  }
  return false;
}

function windowHasEcho(lines: string[], centerIdx: number, radius: number): boolean {
  const end = Math.min(lines.length - 1, centerIdx + radius);
  for (let i = centerIdx + 1; i <= end; i++) {
    const l = lines[i].trim();
    if (/^\s*(echo|print)\b/.test(l) || /\?>/.test(l)) return true;
  }
  return false;
}

// Returns true if the first arg after ( looks like a string literal (not a variable)
function firstArgIsLiteral(afterParen: string): boolean {
  const trimmed = afterParen.trimStart();
  return /^['"]/.test(trimmed);
}

// Returns true if arg contains a variable
function argHasVariable(afterParen: string): boolean {
  const section = afterParen.slice(0, 150).split(')')[0] ?? '';
  return /\$/.test(section);
}

function buildImapPatternInfos(appPath: string): ImapPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: ImapPatternInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, appPath)) {
    const content = safeRead(file, appPath);
    if (!content) continue;

    const lines = content.split('\n');
    const relFile = path.relative(appPath, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // imap_open( — check if credentials look hardcoded (literal strings in args)
      const imapOpenMatch = /\bimap_open\s*\(/.exec(trimmed);
      if (imapOpenMatch) {
        const afterFn = trimmed.slice(imapOpenMatch.index + imapOpenMatch[0].length);
        // imap_open($mailbox, $username, $password) — check 2nd and 3rd args for literals
        const argsSection = afterFn.slice(0, 200).split(')')[0] ?? '';
        const parts = argsSection.split(',');
        const userArg = parts[1] ?? '';
        const passArg = parts[2] ?? '';
        const userIsLiteral = firstArgIsLiteral(userArg.trimStart());
        const passIsLiteral = firstArgIsLiteral(passArg.trimStart());
        if (userIsLiteral || passIsLiteral) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'imap_open',
            issue: 'imap_open() appears to use hardcoded credentials (string literal for username or password) — store credentials in environment variables and read via $_ENV or getenv()',
            severity: 'high',
          });
        } else {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'imap_open',
            issue: 'imap_open() usage detected — ensure credentials come from environment variables, connection is over SSL (use /ssl flag in mailbox string), and timeout is configured',
            severity: 'low',
          });
        }
      }

      // imap_fetchbody( or imap_body( followed by HTML output without sanitization
      if (/\bimap_fetchbody\s*\(/.test(trimmed) || /\bimap_body\s*\(/.test(trimmed)) {
        const fn = /\bimap_fetchbody\s*\(/.test(trimmed) ? 'imap_fetchbody' : 'imap_body';
        if (windowHasEcho(lines, i, 5) && !windowHasSanitization(lines, i, 6)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `${fn}() result appears to be output to HTML within 5 lines without htmlspecialchars()/strip_tags() sanitization — email body content is attacker-controlled and can contain XSS payloads`,
            severity: 'high',
          });
        } else if (!windowHasSanitization(lines, i, 8)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn,
            issue: `${fn}() retrieves raw email body — ensure the result is sanitized with htmlspecialchars() or a dedicated HTML purifier before any output or storage`,
            severity: 'medium',
          });
        }
      }

      // imap_savebody( with variable path argument
      const saveBodyMatch = /\bimap_savebody\s*\(/.exec(trimmed);
      if (saveBodyMatch) {
        const afterFn = trimmed.slice(saveBodyMatch.index + saveBodyMatch[0].length);
        if (argHasVariable(afterFn)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'imap_savebody',
            issue: 'imap_savebody() called with variable path — if path derives from user input or email content, an attacker can write files to arbitrary locations; validate and restrict path to a safe upload directory',
            severity: 'high',
          });
        }
      }

      // imap_search( with variable criteria — IMAP injection
      const searchMatch = /\bimap_search\s*\(/.exec(trimmed);
      if (searchMatch) {
        const afterFn = trimmed.slice(searchMatch.index + searchMatch[0].length);
        const argsSection = afterFn.slice(0, 200).split(')')[0] ?? '';
        const parts = argsSection.split(',');
        const criteriaArg = parts[1] ?? '';
        if (/\$/.test(criteriaArg)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'imap_search',
            issue: 'imap_search() called with variable search criteria — if the criteria string includes unsanitized user input, IMAP search injection is possible; whitelist allowed search terms or escape special characters',
            severity: 'high',
          });
        }
      }

      // quoted_printable_decode( on email content without sanitization
      if (/\bquoted_printable_decode\s*\(/.test(trimmed)) {
        if (!windowHasSanitization(lines, i, 5)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'quoted_printable_decode',
            issue: 'quoted_printable_decode() decodes email content — ensure the result is sanitized (htmlspecialchars/strip_tags) before output; email content is attacker-controlled',
            severity: 'medium',
          });
        }
      }

      // base64_decode( without subsequent sanitization (in context likely email processing)
      if (/\bbase64_decode\s*\(/.test(trimmed)) {
        if (!windowHasSanitization(lines, i, 5)) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'base64_decode',
            issue: 'base64_decode() result used without nearby sanitization — if this decodes email attachment/body content, sanitize with htmlspecialchars() or validate MIME type before processing',
            severity: 'medium',
          });
        }
      }
    }
  }

  return results;
}

export function listPhpImapPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildImapPatternInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No IMAP/POP3 security patterns found in src/ PHP files.' }] };
    }

    // Sort: high first, then medium, then low
    const severityOrder = { high: 0, medium: 1, low: 2 };
    infos.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    let text = `PHP IMAP/POP3 Security Pattern Issues\n${'='.repeat(55)}\n\n`;
    text += `Total issues found: ${infos.length}\n`;
    text += `  High:   ${infos.filter((i) => i.severity === 'high').length}\n`;
    text += `  Medium: ${infos.filter((i) => i.severity === 'medium').length}\n`;
    text += `  Low:    ${infos.filter((i) => i.severity === 'low').length}\n\n`;

    for (const info of infos.slice(0, 50)) {
      text += `  [${info.severity.toUpperCase()}]  [${info.fn}]  ${info.file}:${info.line}\n`;
      text += `    Issue: ${info.issue}\n\n`;
    }

    if (infos.length > 50) {
      text += `  ... and ${infos.length - 50} more issues\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpImapPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildImapPatternInfos(appPath);

    const byFn = new Map<string, number>();
    for (const info of infos) {
      byFn.set(info.fn, (byFn.get(info.fn) ?? 0) + 1);
    }

    const byFile = new Map<string, number>();
    for (const info of infos) {
      byFile.set(info.file, (byFile.get(info.file) ?? 0) + 1);
    }
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `PHP IMAP/POP3 Pattern Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues: ${infos.length}\n`;
    text += `  High severity:    ${infos.filter((i) => i.severity === 'high').length}\n`;
    text += `  Medium severity:  ${infos.filter((i) => i.severity === 'medium').length}\n`;
    text += `  Low severity:     ${infos.filter((i) => i.severity === 'low').length}\n\n`;
    text += `By function:\n`;
    for (const [fn, count] of [...byFn.entries()].sort((a, b) => b[1] - a[1])) {
      text += `  ${String(count).padEnd(4)} ${fn}\n`;
    }

    if (topFiles.length > 0) {
      text += `\nTop files by issue count:\n`;
      for (const [file, count] of topFiles) {
        text += `  ${count}  ${file}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpImapPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_imap_patterns',
      description: 'List PHP IMAP/POP3 security issues: hardcoded credentials in imap_open, unsanitized body output, imap_savebody path injection, imap_search IMAP injection, base64/quoted-printable decode without sanitization',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_imap_patterns_stats',
      description: 'Show PHP IMAP/POP3 pattern statistics: counts by severity (high/medium/low), counts by function name, top files by issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
