// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MatchInfo {
  file: string;
  class?: string;
  lineApprox: number;
  subject?: string;
  hasDefault: boolean;
  armCount: number;
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

function scanMatchExpressions(filePath: string, appPath: string): MatchInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];
  if (!content.includes('match ') && !content.includes('match(')) return [];
  if (content.includes('namespace Symfony\\')) return [];
  const classM = /class\s+(\w+)/.exec(content);
  const results: MatchInfo[] = [];
  const matchPattern = /\bmatch\s*\(([^)]{0,200})\)\s*\{([^}]{0,2000})\}/g;
  let m: RegExpExecArray | null;
  while ((m = matchPattern.exec(content)) !== null) {
    const subject = m[1].trim();
    const body = m[2];
    const hasDefault = /\bdefault\s*=>/.test(body);
    const armCount = [...body.matchAll(/=>/g)].length;
    const lineApprox = content.slice(0, m.index).split('\n').length;
    const issues: string[] = [];
    if (!hasDefault) {
      issues.push(`match() without default arm — throws UnhandledMatchError for unmatched values`);
    }
    results.push({ file: path.relative(appPath, filePath), class: classM?.[1], lineApprox, subject, hasDefault, armCount, issues });
  }
  return results;
}

export function listPhpMatchExhaustiveness(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const all: MatchInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      all.push(...scanMatchExpressions(file, appPath));
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No match expressions found.' }] };
    const withoutDefault = all.filter((m) => !m.hasDefault);
    const totalIssues = all.reduce((s, m) => s + m.issues.length, 0);
    let text = `PHP match() Exhaustiveness\n${'='.repeat(55)}\n\nMatch expressions: ${all.length}  Without default: ${withoutDefault.length}  Issues: ${totalIssues}\n`;
    for (const m of withoutDefault.slice(0, 50)) {
      text += `\n  ${m.class ?? '(file)'}  match(${m.subject ?? ''})  arms: ${m.armCount}  line ~${m.lineApprox}  (${m.file})\n`;
      for (const i of m.issues) text += `    ⚠ ${i}\n`;
    }
    if (withoutDefault.length > 50) text += `\n  ... and ${withoutDefault.length - 50} more\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMatchExhaustivenessStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const all: MatchInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        all.push(...scanMatchExpressions(file, appPath));
      }
    }
    let text = `PHP match() Statistics\n${'='.repeat(40)}\n\n`;
    text += `Match expressions: ${all.length}\n  With default: ${all.filter((m) => m.hasDefault).length}\n  Without default: ${all.filter((m) => !m.hasDefault).length}\nIssues: ${all.reduce((s, m) => s + m.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMatchExhaustivenessTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_match_exhaustiveness', description: 'Show PHP match() expressions without default arm: file, approximate line, subject expression, arm count, UnhandledMatchError risk warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_match_exhaustiveness_stats', description: 'Show PHP match() statistics: total expressions, with/without default counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
