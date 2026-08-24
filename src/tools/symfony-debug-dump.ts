// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Debug Dump Inspector
 *
 * Scans src/ PHP (excluding Tests/, DataFixtures/, Command/Debug files) for:
 *   - dump(), dd(), var_dump(), print_r(), var_export(), debug_backtrace()
 *   - VarDumper::dump(), Symfony\Component\VarDumper\VarDumper::dump()
 *
 * Warns: dump in non-test/non-command code, dd() in controller,
 * var_dump instead of dump(), debug_backtrace() without depth limit.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DumpUsage {
  function: string;
  line?: number;
  isInTest: boolean;
  issues: string[];
}

interface DebugDumpInfo {
  file: string;
  class?: string;
  usages: DumpUsage[];
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function shouldSkipFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return normalized.includes('/Tests/') ||
    normalized.includes('/Test/') ||
    normalized.includes('/DataFixtures/') ||
    /\bTest\.php$/.test(file) ||
    /\bFixture\.php$/.test(file) ||
    /\bFixtures\.php$/.test(file) ||
    /Command\/Debug/.test(normalized);
}

function isTestFile(file: string): boolean {
  return /[Tt]est/.test(file) ||
    file.includes('/Tests/') ||
    file.includes('/DataFixtures/');
}

function scanDumpUsages(appPath: string): DebugDumpInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: DebugDumpInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (shouldSkipFile(file)) continue;

    const content = safeRead(file, appPath);
    if (content === null) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : undefined;

    const isController = /Controller\b/.test(file) || (className ? /Controller$/.test(className) : false);
    const inTest = isTestFile(file);

    const usages: DumpUsage[] = [];
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';

      // Skip commented lines
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

      const localPattern = /\b(dump|dd|var_dump|print_r|var_export|debug_backtrace)\s*\(|VarDumper::dump\s*\(/g;
      let m = localPattern.exec(line);
      while (m !== null) {
        const funcName = m[1] ?? 'VarDumper::dump';
        const issues: string[] = [];

        if (!inTest) {
          if (funcName === 'dd' && isController) {
            issues.push('dd() in controller — stops execution for all users in production');
          } else if (funcName === 'var_dump') {
            issues.push('Use dump() instead of var_dump() to leverage VarDumper formatting');
          } else if (funcName === 'debug_backtrace') {
            if (!/depth/.test(line)) {
              issues.push('debug_backtrace() without depth limit — may cause memory exhaustion');
            }
          } else if (funcName === 'dump' || funcName === 'dd' || funcName === 'print_r' || funcName === 'var_export') {
            issues.push(`${funcName}() in production code — remove before deployment`);
          }
        }

        usages.push({ function: funcName, line: lineIdx + 1, isInTest: inTest, issues });
        m = localPattern.exec(line);
      }
    }

    if (usages.length === 0) continue;

    const fileIssues: string[] = [];
    const nonTestUsages = usages.filter((u) => !u.isInTest);
    if (nonTestUsages.length > 0) {
      fileIssues.push(`${nonTestUsages.length} debug dump call(s) in non-test production code`);
    }

    results.push({
      file: path.relative(appPath, file),
      class: className,
      usages,
      issues: fileIssues,
    });
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listDebugDumps(appPath: string): McpToolResult {
  try {
    const items = scanDumpUsages(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No debug dump calls found in src/ (excluding tests and fixtures).' }] };
    }

    let text = `Debug Dump Calls\n${'='.repeat(50)}\n\n`;
    text += `Found dump-related calls in ${items.length} file(s):\n\n`;

    for (const item of items) {
      text += `  ${item.file}${item.class ? ` (${item.class})` : ''}\n`;
      for (const usage of item.usages) {
        const lineStr = usage.line !== undefined ? `:${usage.line}` : '';
        text += `    ${usage.function}()  line${lineStr}${usage.isInTest ? '  [test]' : '  [PRODUCTION]'}\n`;
        for (const issue of usage.issues) {
          text += `      - ${issue}\n`;
        }
      }
      if (item.issues.length > 0) {
        for (const issue of item.issues) {
          text += `    WARNING: ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDebugDumpStats(appPath: string): McpToolResult {
  try {
    const items = scanDumpUsages(appPath);

    const totalUsages = items.reduce((s, i) => s + i.usages.length, 0);
    const productionUsages = items.reduce((s, i) => s + i.usages.filter((u) => !u.isInTest).length, 0);
    const ddCount = items.reduce((s, i) => s + i.usages.filter((u) => u.function === 'dd').length, 0);
    const varDumpCount = items.reduce((s, i) => s + i.usages.filter((u) => u.function === 'var_dump').length, 0);

    let text = `Debug Dump Stats\n${'='.repeat(40)}\n\n`;
    text += `Files with dump calls:      ${items.length}\n`;
    text += `Total dump calls:           ${totalUsages}\n`;
    text += `In production code:         ${productionUsages}\n`;
    text += `dd() calls:                 ${ddCount}\n`;
    text += `var_dump() calls:           ${varDumpCount}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getDebugDumpTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_debug_dumps',
      description: 'Scan src/ for debug dump calls (dump, dd, var_dump, print_r, debug_backtrace) in production code — excludes test and fixture files',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_debug_dump_stats',
      description: 'Statistics for debug dump calls: total count, production vs test split, dd() and var_dump() counts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}

