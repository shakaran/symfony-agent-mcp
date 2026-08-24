// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP ext-parallel Extension Inspector
 *
 * Scans src/**\/*.php for usage of the parallel extension:
 * parallel\Runtime, parallel\Channel, parallel\Future, parallel\run,
 * parallel\bootstrap. Detects missing try/catch around Runtime creation
 * and Future->value(), shared mutable state passed across runtimes.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ParallelFinding {
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

const PARALLEL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /new\s+parallel\\Runtime\s*\(/,       label: 'parallel\\Runtime(' },
  { re: /parallel\\Channel\s*::\s*make\s*\(/, label: 'parallel\\Channel::make(' },
  { re: /new\s+parallel\\Channel\s*\(/,       label: 'parallel\\Channel(' },
  { re: /parallel\\Future/,                   label: 'parallel\\Future' },
  { re: /parallel\\run\s*\(/,                 label: 'parallel\\run(' },
  { re: /parallel\\bootstrap\s*\(/,           label: 'parallel\\bootstrap(' },
  { re: /->value\s*\(\s*\)/,                  label: '->value()' },
];

function analyseFile(filePath: string, base: string): ParallelFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  const findings: ParallelFinding[] = [];
  const lines = content.split('\n');

  // Track try context via brace depth stack
  const tryDepths: number[] = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;

    // Update brace depth
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth < 0) braceDepth = 0;
      }
    }
    if (/^\s*try\s*\{/.test(line)) tryDepths.push(braceDepth);

    const inTry = tryDepths.length > 0;

    for (const { re, label } of PARALLEL_PATTERNS) {
      if (!re.test(line)) continue;

      let issue: string | null = null;

      if (label === 'parallel\\Runtime(') {
        if (!inTry) issue = 'parallel\\Runtime created outside try/catch — throws parallel\\Error on thread creation failure';
      } else if (label === '->value()') {
        // Only flag if prior lines suggest a Future context
        const context = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
        if (/parallel\\Future|->run\s*\(/.test(context) && !inTry) {
          issue = 'Future->value() not wrapped in try/catch — throws parallel\\Error/parallel\\Killed if task failed';
        }
      } else if (label === 'parallel\\run(') {
        if (!inTry) issue = 'parallel\\run() not in try/catch — closure errors propagate as parallel\\Error on ->value()';
      } else if (label === 'parallel\\bootstrap(') {
        // Check if bootstrap path is a variable (not validated)
        if (/parallel\\bootstrap\s*\(\s*\$/.test(line)) {
          issue = 'Bootstrap path comes from a variable — ensure the path is validated before use';
        }
      } else if (label === 'parallel\\Channel(' || label === 'parallel\\Channel::make(') {
        const bufMatch = /Channel(?:::\s*make)?\s*\(\s*(\d+)\s*\)/.exec(line);
        if (!bufMatch) {
          issue = 'Unbuffered channel — parallel\\Channel() with no capacity blocks sender until receiver is ready';
        }
      } else if (label === 'parallel\\Future') {
        // Mutable state check: passing objects by reference in closures
        if (/use\s*\([^)]{0,200}&\$/.test(line)) {
          issue = 'Object passed by reference into parallel closure — sharing mutable state across runtimes causes data races';
        }
      }

      findings.push({ file: filePath, line: lineNo, pattern: label, issue });
    }
  }

  return findings;
}

function loadFindings(appPath: string): ParallelFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: ParallelFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listPhpParallelExtension(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No ext-parallel usage found in src/.\n\nExample:\n  $runtime = new parallel\\Runtime(__DIR__ . \'/bootstrap.php\');\n  $future  = $runtime->run(static fn() => heavyWork());\n  try { $result = $future->value(); } catch (\\parallel\\Error $e) { ... }' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP ext-parallel Usage\n${'='.repeat(55)}\n\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
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

export function getPhpParallelExtensionStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    let text = `PHP ext-parallel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${findings.length}\nWith issues: ${issues.length}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nFiles with parallel usage: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpParallelExtensionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_parallel_extension', description: 'Scan src/**/*.php for ext-parallel usage: parallel\\Runtime/Channel/Future/run/bootstrap — flags missing try/catch around Runtime creation and Future->value(), unbuffered channels, mutable state shared across runtimes', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_parallel_extension_stats', description: 'Statistics for ext-parallel usage: total findings, issues count, breakdown by pattern, files affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
