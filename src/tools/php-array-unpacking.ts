// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Array Unpacking Inspector
 *
 * Scans src/**\/*.php for array unpacking patterns:
 * - list() positional unpacking
 * - Short list syntax [$a, $b] = $array
 * - Spread operator [...$spread] in array expression
 * - Argument unpacking $fn(...$args)
 * - PHP 8.1 string-keyed unpacking ['key' => $value] = $array
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ArrayUnpackingFinding {
  file: string;
  line: number;
  pattern: string;
  issue: string | null;
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

// Count comma-separated variables inside list() or [...] — bounded to avoid ReDoS
function countVarsInList(segment: string): number {
  let depth = 0;
  let count = 1;
  for (const ch of segment) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth < 0) break; }
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

function analyseFile(filePath: string, base: string): ArrayUnpackingFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  const findings: ArrayUnpackingFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // list( assignment
    const listMatch = /\blist\s*\(([^)]{0,300})\)\s*=/.exec(line);
    if (listMatch) {
      const varCount = countVarsInList(listMatch[1]);
      const issue = varCount > 5
        ? `list() unpacks ${varCount} variables — fragile if source array structure changes; consider named keys or a DTO`
        : null;
      findings.push({ file: filePath, line: lineNo, pattern: 'list(', issue });
    }

    // Short list [$a, $b, ...] = $array  (assignment target, not array literal)
    const shortListMatch = /^\s*\[([^\][]{0,300}(?:\[[^\][]{0,300}\][^\][]{0,300}){0,40})\]\s*=\s*\$/.exec(line);
    if (shortListMatch) {
      const inner = shortListMatch[1];
      // Detect string-keyed unpacking: 'key' => $var
      const isStringKeyed = /['"][^'"]{0,80}['"]\s*=>\s*\$/.test(inner);
      let issue: string | null = null;
      if (isStringKeyed) {
        issue = 'String-keyed array unpacking (PHP 8.1+) — ensure key exists in source array to avoid undefined offset notice';
      } else {
        const varCount = countVarsInList(inner);
        if (varCount > 5) issue = `Short list unpacks ${varCount} variables — positional unpacking is fragile if source array grows or reorders`;
      }
      findings.push({ file: filePath, line: lineNo, pattern: isStringKeyed ? "['key'=>$v]=" : '[$a,$b]=', issue });
    }

    // Spread in array expression: [...$var] but NOT argument unpacking
    if (/\[\s*\.\.\.\$[a-zA-Z_][a-zA-Z0-9_]{0,80}/.test(line) && !/\]\s*=\s*\$/.test(line)) {
      // Check for non-array type hint context (heuristic: no type annotation visible)
      const issue: string | null = null;
      findings.push({ file: filePath, line: lineNo, pattern: '[...$spread]', issue });
    }

    // Argument unpacking: $fn(...$args) or func(...$args)
    if (/\(\s*\.\.\.\$[a-zA-Z_][a-zA-Z0-9_]{0,80}/.test(line)) {
      // Flag if spread target might not be array (no is_array/array type in nearby context)
      const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
      const hasTypeCheck = /is_array\s*\(|array\s+\$|array\s*\|/.test(context);
      const issue = hasTypeCheck ? null : 'Argument unpacking without nearby is_array() check — spread of non-array/Traversable throws TypeError';
      findings.push({ file: filePath, line: lineNo, pattern: '$fn(...$args)', issue });
    }
  }

  return findings;
}

function loadFindings(appPath: string): ArrayUnpackingFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: ArrayUnpackingFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listPhpArrayUnpacking(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No array unpacking patterns found in src/.\n\nExample:\n  [$first, $second] = $items;\n  [\'name\' => $name] = $data; // PHP 8.1\n  $result = array_merge(...$arrays);' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP Array Unpacking\n${'='.repeat(55)}\n\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      text += `\n  ${rel}:${f.line}  [${f.pattern}]\n`;
      if (f.issue) text += `    ⚠ ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArrayUnpackingStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP Array Unpacking Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${findings.length}\nWith issues: ${issues.length}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nFiles with unpacking: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArrayUnpackingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_array_unpacking', description: 'Scan src/**/*.php for array unpacking: list(), short-list [$a,$b]=, spread [...$arr], argument unpacking $fn(...$args), string-keyed PHP 8.1 unpacking — flags fragile positional unpacking and missing type checks', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_array_unpacking_stats', description: 'Statistics for PHP array unpacking usage: total findings, issues count, breakdown by pattern, files affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
