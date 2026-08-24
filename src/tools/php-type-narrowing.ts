// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Type Narrowing Inspector
 *
 * Scans src/**\/*.php for type narrowing patterns:
 * - instanceof checks
 * - is_array, is_string, is_int, is_null, is_object calls
 * - assert() usage (flag in production)
 * - isset() vs null check patterns
 * - Missing null check before ->method() on nullable types
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TypeNarrowingInfo {
  file: string;
  type: 'instanceof' | 'is-check' | 'assert' | 'nullcheck';
  pattern: string;
  issues: string[];
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

function analyseTypeNarrowingFile(content: string, relFile: string): TypeNarrowingInfo[] {
  const infos: TypeNarrowingInfo[] = [];
  const lines = content.split('\n');

  // instanceof checks
  const instanceofIssues: string[] = [];
  const instanceofPatterns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /(\$\w+)\s+instanceof\s+(\w+)/.exec(line);
    if (m) {
      instanceofPatterns.push(`Line ${i + 1}: ${m[0]}`);
      // Check if result is used in condition
      if (!/if\s*\(|&&|\|\||\?/.test(line)) {
        instanceofIssues.push(`Line ${i + 1}: instanceof result may not be used in a branch — verify narrowing is applied`);
      }
    }
  }
  if (instanceofPatterns.length > 0) {
    infos.push({
      file: relFile,
      type: 'instanceof',
      pattern: instanceofPatterns.slice(0, 5).join('; '),
      issues: instanceofIssues,
    });
  }

  // is_* function calls
  const isCheckIssues: string[] = [];
  const isCheckPatterns: string[] = [];
  const isChecks = ['is_array', 'is_string', 'is_int', 'is_null', 'is_object', 'is_bool', 'is_float', 'is_numeric'];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const check of isChecks) {
      if (line.includes(check + '(')) {
        isCheckPatterns.push(`Line ${i + 1}: ${check}()`);
        // Flag if negated is_null without alternative check
        if (check === 'is_null' && /!\s*is_null/.test(line)) {
          isCheckIssues.push(`Line ${i + 1}: !is_null() — consider null !== $var for clarity`);
        }
      }
    }
  }
  if (isCheckPatterns.length > 0) {
    infos.push({
      file: relFile,
      type: 'is-check',
      pattern: isCheckPatterns.slice(0, 5).join('; '),
      issues: isCheckIssues,
    });
  }

  // assert() usage
  const assertIssues: string[] = [];
  const assertPatterns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bassert\s*\(/.test(line)) {
      assertPatterns.push(`Line ${i + 1}: assert()`);
      assertIssues.push(`Line ${i + 1}: assert() may be disabled in production (zend.assertions=-1) — use explicit type checks or throw exceptions`);
    }
  }
  if (assertPatterns.length > 0) {
    infos.push({
      file: relFile,
      type: 'assert',
      pattern: assertPatterns.slice(0, 5).join('; '),
      issues: assertIssues,
    });
  }

  // Null check patterns — detect ->method() without preceding isset/null check
  const nullcheckIssues: string[] = [];
  const nullcheckPatterns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect ?-> (nullsafe — good) vs -> on variable that might be nullable
    const directCall = /(\$\w+)->(\w+)\s*\(/.exec(line);
    if (directCall && !/\?\?|isset\s*\(|null\s*!==|!==\s*null|null\s*==|==\s*null/.test(line)) {
      // Look back 3 lines for null guard
      const priorBlock = lines.slice(Math.max(0, i - 4), i).join('\n');
      const varName = directCall[1];
      // Only flag if no preceding guard for this variable
      if (
        !priorBlock.includes(`isset(${varName}`) &&
        !priorBlock.includes(`${varName} !== null`) &&
        !priorBlock.includes(`null !== ${varName}`) &&
        !priorBlock.includes(`${varName} != null`) &&
        !priorBlock.includes(`if (${varName})`) &&
        !/\?\?/.test(line) &&
        !/\?->/.test(line)
      ) {
        // Only flag annotated nullable hints or common patterns
        if (/getOrNull|findOneBy|nullable|Nullable/.test(content.slice(0, 200)) ||
            /\?\s+\$/.test(lines[i] ?? '') ||
            /null\|/.test(content.slice(0, 500))) {
          nullcheckPatterns.push(`Line ${i + 1}: ${varName}->${directCall[2]}()`);
          nullcheckIssues.push(`Line ${i + 1}: ${varName}->${directCall[2]}() called without visible null guard — if nullable, use ?-> or check first`);
        }
      }
    }
    // Flag use of null coalescing without type check when result is chained
    if (/\?\?->/.test(line)) {
      nullcheckIssues.push(`Line ${i + 1}: ??-> is not valid PHP syntax — did you mean ??  or  ?-> (nullsafe operator)?`);
      nullcheckPatterns.push(`Line ${i + 1}: ??-> chained`);
    }
  }
  if (nullcheckPatterns.length > 0) {
    infos.push({
      file: relFile,
      type: 'nullcheck',
      pattern: nullcheckPatterns.slice(0, 5).join('; '),
      issues: nullcheckIssues.slice(0, 10),
    });
  }

  return infos;
}

function buildTypeNarrowingInfos(appPath: string): TypeNarrowingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: TypeNarrowingInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const infos = analyseTypeNarrowingFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpTypeNarrowing(appPath: string): McpToolResult {
  try {
    const infos = buildTypeNarrowingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No type narrowing patterns found in src/.' }] };
    }

    let text = `PHP Type Narrowing Analysis\n${'='.repeat(50)}\n\n`;
    text += `Total pattern groups: ${infos.length}\n\n`;

    const byType: Record<string, TypeNarrowingInfo[]> = {};
    for (const info of infos) {
      if (!byType[info.type]) byType[info.type] = [];
      byType[info.type].push(info);
    }

    for (const [type, items] of Object.entries(byType)) {
      const withIssues = items.filter((i) => i.issues.length > 0);
      text += `[${type.toUpperCase()}] — ${items.length} files (${withIssues.length} with issues)\n`;
      for (const item of withIssues.slice(0, 10)) {
        text += `  ${item.file}\n`;
        text += `  Pattern: ${item.pattern}\n`;
        for (const issue of item.issues) {
          text += `    - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTypeNarrowingStats(appPath: string): McpToolResult {
  try {
    const infos = buildTypeNarrowingInfos(appPath);

    const counts: Record<string, number> = { instanceof: 0, 'is-check': 0, assert: 0, nullcheck: 0 };
    for (const info of infos) counts[info.type] = (counts[info.type] ?? 0) + 1;
    const withIssues = infos.filter((i) => i.issues.length > 0).length;

    let text = `PHP Type Narrowing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total pattern groups:  ${infos.length}\n`;
    text += `Groups with issues:    ${withIssues}\n\n`;
    text += `By type:\n`;
    text += `  instanceof checks:   ${counts['instanceof'] ?? 0}\n`;
    text += `  is_*() checks:       ${counts['is-check'] ?? 0}\n`;
    text += `  assert() calls:      ${counts['assert'] ?? 0}\n`;
    text += `  Null-check patterns: ${counts['nullcheck'] ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpTypeNarrowingTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_type_narrowing',
      description: 'List PHP type narrowing patterns: instanceof checks, is_*() function usage, assert() (production risk), nullable method calls without null guards',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_type_narrowing_stats',
      description: 'Get PHP type narrowing statistics: counts per pattern type (instanceof/is-check/assert/nullcheck), files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
