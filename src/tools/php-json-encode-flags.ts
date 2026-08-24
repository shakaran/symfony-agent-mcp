// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP JSON Encode Flags Inspector
 *
 * Scans src/ PHP files for json_encode/json_decode usage issues:
 *   - json_encode( without JSON_THROW_ON_ERROR flag
 *   - json_decode( lacking explicit error handling (no JSON_THROW_ON_ERROR)
 *   - JSON_PRETTY_PRINT in non-test files (flag for review)
 *   - json_last_error() calls (old-style error checking)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface JsonEncodeFlagInfo {
  file: string;
  line: number;
  pattern: string;
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

function buildJsonEncodeFlagInfos(appPath: string): JsonEncodeFlagInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: JsonEncodeFlagInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, appPath)) {
    const content = safeRead(file, appPath);
    if (!content) continue;

    const lines = content.split('\n');
    const relFile = path.relative(appPath, file);
    const isTestFile = /[Tt]est/.test(relFile) || relFile.includes('/tests/') || relFile.includes('/Tests/');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // json_encode( without JSON_THROW_ON_ERROR within 120 chars
      const encodeMatch = /json_encode\s*\(/.exec(trimmed);
      if (encodeMatch) {
        const afterParen = trimmed.slice(encodeMatch.index + encodeMatch[0].length);
        const window = afterParen.slice(0, 120);
        if (!window.includes('JSON_THROW_ON_ERROR')) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'json_encode',
            issue: 'json_encode() called without JSON_THROW_ON_ERROR — silent failure on encoding error; add JSON_THROW_ON_ERROR flag',
          });
        }
      }

      // json_decode( without JSON_THROW_ON_ERROR within 120 chars
      const decodeMatch = /json_decode\s*\(/.exec(trimmed);
      if (decodeMatch) {
        const afterParen = trimmed.slice(decodeMatch.index + decodeMatch[0].length);
        const window = afterParen.slice(0, 120);
        if (!window.includes('JSON_THROW_ON_ERROR')) {
          results.push({
            file: relFile,
            line: lineNum,
            pattern: 'json_decode',
            issue: 'json_decode() called without JSON_THROW_ON_ERROR — return value is null on error with no exception; add JSON_THROW_ON_ERROR flag',
          });
        }
      }

      // JSON_PRETTY_PRINT in non-test files
      if (/JSON_PRETTY_PRINT/.test(trimmed) && !isTestFile) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'JSON_PRETTY_PRINT',
          issue: 'JSON_PRETTY_PRINT used in non-test file — increases payload size; acceptable only in dev/debug/API responses where formatting is intentional',
        });
      }

      // json_last_error() — old-style error checking
      if (/json_last_error\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'json_last_error',
          issue: 'json_last_error() is old-style error checking — replace with JSON_THROW_ON_ERROR flag and catch \\JsonException instead',
        });
      }
    }
  }

  return results;
}

export function listPhpJsonEncodeFlags(appPath: string): McpToolResult {
  try {
    const infos = buildJsonEncodeFlagInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No JSON encode/decode flag issues found in src/ PHP files.' }] };
    }

    let text = `PHP JSON Encode/Decode Flag Issues\n${'='.repeat(55)}\n\n`;
    text += `Total issues found: ${infos.length}\n\n`;

    for (const info of infos.slice(0, 50)) {
      text += `  [${info.pattern}]  ${info.file}:${info.line}\n`;
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

export function getPhpJsonEncodeFlagsStats(appPath: string): McpToolResult {
  try {
    const infos = buildJsonEncodeFlagInfos(appPath);

    const encodeIssues = infos.filter((i) => i.pattern === 'json_encode').length;
    const decodeIssues = infos.filter((i) => i.pattern === 'json_decode').length;
    const prettyPrint = infos.filter((i) => i.pattern === 'JSON_PRETTY_PRINT').length;
    const lastError = infos.filter((i) => i.pattern === 'json_last_error').length;

    const byFile = new Map<string, number>();
    for (const info of infos) {
      byFile.set(info.file, (byFile.get(info.file) ?? 0) + 1);
    }
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `PHP JSON Encode/Decode Flag Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues: ${infos.length}\n`;
    text += `  json_encode without JSON_THROW_ON_ERROR: ${encodeIssues}\n`;
    text += `  json_decode without JSON_THROW_ON_ERROR: ${decodeIssues}\n`;
    text += `  JSON_PRETTY_PRINT in non-test files:     ${prettyPrint}\n`;
    text += `  json_last_error() old-style usage:       ${lastError}\n\n`;

    if (topFiles.length > 0) {
      text += `Top files by issue count:\n`;
      for (const [file, count] of topFiles) {
        text += `  ${count}  ${file}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpJsonEncodeFlagsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_json_encode_flags',
      description: 'List PHP json_encode/json_decode flag issues: missing JSON_THROW_ON_ERROR, JSON_PRETTY_PRINT in production code, json_last_error() old-style checks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_json_encode_flags_stats',
      description: 'Show PHP JSON encode/decode flag statistics: counts by pattern type (encode/decode/pretty-print/last-error), top files by issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
