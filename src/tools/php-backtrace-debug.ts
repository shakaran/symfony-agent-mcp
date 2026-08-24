// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface BacktraceDebugInfo {
  file: string;
  function: string;
  context: string;
  risk: 'high' | 'medium' | 'low';
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

const DEBUG_FUNCTIONS = [
  { name: 'debug_backtrace', pattern: 'debug_backtrace(' },
  { name: 'debug_print_backtrace', pattern: 'debug_print_backtrace(' },
  { name: 'var_dump', pattern: 'var_dump(' },
  { name: 'print_r', pattern: 'print_r(' },
  { name: 'var_export', pattern: 'var_export(' },
];

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/tests/') ||
    normalized.includes('/Tests/') ||
    normalized.includes('/test/') ||
    normalized.includes('/spec/') ||
    normalized.endsWith('Test.php') ||
    normalized.endsWith('Spec.php');
}

function buildBacktraceDebugInfos(appPath: string): BacktraceDebugInfo[] {
  const results: BacktraceDebugInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const inTestContext = isTestFile(file);
    const lines = content.split('\n');

    for (const dbgFn of DEBUG_FUNCTIONS) {
      if (!content.includes(dbgFn.pattern)) continue;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (!line.includes(dbgFn.pattern)) continue;

        const trimmed = line.trim();
        // Skip commented-out calls
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

        // Determine context: check surrounding lines for echo/return/response
        const surroundStart = Math.max(0, lineIdx - 3);
        const surroundEnd = Math.min(lines.length - 1, lineIdx + 3);
        const surroundingText = lines.slice(surroundStart, surroundEnd + 1).join('\n');

        const isOutputted = surroundingText.includes('echo ') ||
          surroundingText.includes('print ') ||
          surroundingText.includes('return ') ||
          surroundingText.includes('->send(') ||
          surroundingText.includes('Response(') ||
          dbgFn.name === 'debug_print_backtrace' ||
          dbgFn.name === 'var_dump';

        let risk: 'high' | 'medium' | 'low';
        let context: string;

        if (!inTestContext && isOutputted) {
          risk = 'high';
          context = 'Debug output in non-test context — likely leaks stack trace or internal data to end users';
        } else if (!inTestContext) {
          risk = 'medium';
          context = 'Debug function in non-test code — remove before production deployment';
        } else {
          risk = 'low';
          context = 'Debug function in test context — acceptable but consider using PHPUnit assertions instead';
        }

        results.push({
          file: path.relative(appPath, file),
          function: dbgFn.name,
          context,
          risk,
        });

        // Only report first occurrence per function per file to avoid noise
        break;
      }
    }
  }

  return results;
}

export function listPhpBacktraceDebug(appPath: string): McpToolResult {
  try {
    const infos = buildBacktraceDebugInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP backtrace or debug output functions found.' }] };
    }
    // Sort by risk: high > medium > low
    const riskOrder = { high: 0, medium: 1, low: 2 };
    infos.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk]);
    const lines = infos.map(i =>
      `${i.file}\n  Function: ${i.function}  Risk: ${i.risk.toUpperCase()}\n  Context: ${i.context}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBacktraceDebugStats(appPath: string): McpToolResult {
  try {
    const infos = buildBacktraceDebugInfos(appPath);
    const stats = {
      total: infos.length,
      byRisk: { high: 0, medium: 0, low: 0 } as Record<string, number>,
      byFunction: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.byRisk[i.risk] = (stats.byRisk[i.risk] ?? 0) + 1;
      stats.byFunction[i.function] = (stats.byFunction[i.function] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBacktraceDebugTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_php_backtrace_debug',
      description: 'List PHP debug and backtrace functions: debug_backtrace(), debug_print_backtrace(), var_dump(), print_r(), var_export() — flags high-risk usages in non-test contexts where output may be exposed to users.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    },
    {
      name: 'get_php_backtrace_debug_stats',
      description: 'Get statistics for PHP debug function usage: total occurrences grouped by risk level (high/medium/low) and function name.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' }
        },
        required: ['app_path']
      }
    }
  ];
}
