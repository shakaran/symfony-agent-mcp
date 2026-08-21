/**
 * PHP sprintf / printf Type Safety Inspector
 *
 * Scans src/ PHP files for formatting function issues:
 *   - sprintf( with %s format specifier and numeric-named args (possible type mismatch)
 *   - printf( calls (output to browser without capture)
 *   - number_format( without explicit decimal/thousands separator args (locale-dependent)
 *   - vprintf( / vsprintf( usage (rare, flag for review)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SprintfTypeSafetyInfo {
  file: string;
  line: number;
  fn: string;
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

// Variable names that strongly suggest numeric values
const NUMERIC_VAR_PATTERN = /\$(count|total|num|id|ids|amount|price|qty|quantity|index|size|length|offset|limit|page|score|rank|weight|bytes|ms|seconds|minutes|hours|percent|ratio|rate|age|year|month|day)\b/i;

function checkSprintfLine(trimmed: string, lineNum: number, relFile: string): SprintfTypeSafetyInfo | null {
  // sprintf( with %s and numeric-looking args
  const sprintfMatch = /\bsprintf\s*\(/.exec(trimmed);
  if (sprintfMatch) {
    const after = trimmed.slice(sprintfMatch.index + sprintfMatch[0].length, sprintfMatch.index + sprintfMatch[0].length + 200);
    // Check for literal format string containing %s
    const fmtMatch = /^['"][^'"]{0,150}%s[^'"]{0,150}['"]/.exec(after.trimStart());
    if (fmtMatch && NUMERIC_VAR_PATTERN.test(after)) {
      return {
        file: relFile,
        line: lineNum,
        fn: 'sprintf',
        issue: 'sprintf() uses %s format specifier with a likely numeric variable — use %d/%f/%u for numeric values to avoid unexpected string coercion',
      };
    }
  }
  return null;
}

function buildSprintfTypeSafetyInfos(appPath: string): SprintfTypeSafetyInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: SprintfTypeSafetyInfo[] = [];
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

      // sprintf type-mismatch heuristic
      const sprintfIssue = checkSprintfLine(trimmed, lineNum, relFile);
      if (sprintfIssue) results.push(sprintfIssue);

      // printf( calls — output directly to browser/stdout
      if (/\bprintf\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'printf',
          issue: 'printf() outputs directly — use sprintf() to capture result, then escape/return via Response; direct printf output bypasses Symfony response pipeline',
        });
      }

      // number_format( — check for missing separator arguments
      const nfMatch = /\bnumber_format\s*\(/.exec(trimmed);
      if (nfMatch) {
        const after = trimmed.slice(nfMatch.index + nfMatch[0].length, nfMatch.index + nfMatch[0].length + 150);
        // Count commas before closing paren to estimate arg count
        const argsSection = after.split(')')[0] ?? '';
        const commaCount = (argsSection.match(/,/g) ?? []).length;
        if (commaCount < 2) {
          results.push({
            file: relFile,
            line: lineNum,
            fn: 'number_format',
            issue: 'number_format() called without explicit decimal/thousands separator arguments — output is locale-dependent; pass all 4 args: number_format($n, 2, \'.\', \',\')',
          });
        }
      }

      // vprintf( — rare, flag for review
      if (/\bvprintf\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'vprintf',
          issue: 'vprintf() outputs directly and is rarely needed — prefer vsprintf() to capture result or use sprintf() with explicit args',
        });
      }

      // vsprintf( — flag for awareness
      if (/\bvsprintf\s*\(/.test(trimmed)) {
        results.push({
          file: relFile,
          line: lineNum,
          fn: 'vsprintf',
          issue: 'vsprintf() with array args — ensure the array is not user-controlled; format string injection is possible if format originates from user input',
        });
      }
    }
  }

  return results;
}

export function listPhpSprintfTypeSafety(appPath: string): McpToolResult {
  try {
    const infos = buildSprintfTypeSafetyInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No sprintf/printf type safety issues found in src/ PHP files.' }] };
    }

    let text = `PHP sprintf/printf Type Safety Issues\n${'='.repeat(55)}\n\n`;
    text += `Total issues found: ${infos.length}\n\n`;

    for (const info of infos.slice(0, 50)) {
      text += `  [${info.fn}]  ${info.file}:${info.line}\n`;
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

export function getPhpSprintfTypeSafetyStats(appPath: string): McpToolResult {
  try {
    const infos = buildSprintfTypeSafetyInfos(appPath);

    const bySprintf = infos.filter((i) => i.fn === 'sprintf').length;
    const byPrintf = infos.filter((i) => i.fn === 'printf').length;
    const byNumberFormat = infos.filter((i) => i.fn === 'number_format').length;
    const byVprintf = infos.filter((i) => i.fn === 'vprintf').length;
    const byVsprintf = infos.filter((i) => i.fn === 'vsprintf').length;

    const byFile = new Map<string, number>();
    for (const info of infos) {
      byFile.set(info.file, (byFile.get(info.file) ?? 0) + 1);
    }
    const topFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

    let text = `PHP sprintf/printf Type Safety Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues: ${infos.length}\n`;
    text += `  sprintf %s with numeric args:      ${bySprintf}\n`;
    text += `  printf direct output:              ${byPrintf}\n`;
    text += `  number_format missing separators:  ${byNumberFormat}\n`;
    text += `  vprintf direct output:             ${byVprintf}\n`;
    text += `  vsprintf array-format usage:       ${byVsprintf}\n\n`;

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

export function getPhpSprintfTypeSafetyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_sprintf_type_safety',
      description: 'List PHP sprintf/printf type safety issues: %s with numeric args, printf direct output, number_format without separators, vprintf/vsprintf usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_sprintf_type_safety_stats',
      description: 'Show PHP sprintf/printf type safety statistics: counts by function type, top files by issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
