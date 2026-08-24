// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BcmathPatternInfo {
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

const BC_FUNCTIONS = ['bcadd', 'bcsub', 'bcmul', 'bcdiv', 'bcmod', 'bcsqrt', 'bcpow', 'bccomp', 'bcscale'];

function firstBcLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    for (const fn of BC_FUNCTIONS) {
      if (lines[i].includes(fn + '(')) return i;
    }
  }
  return 0;
}

function analyseFile(content: string, relFile: string): BcmathPatternInfo[] {
  const infos: BcmathPatternInfo[] = [];
  const lines = content.split('\n');

  // File-level: bc* present but no bcscale call
  const hasBcOp = BC_FUNCTIONS.some((fn) => fn !== 'bcscale' && content.includes(fn + '('));
  const hasBcScale = content.includes('bcscale(');
  if (hasBcOp && !hasBcScale) {
    const lineIdx = firstBcLine(lines);
    // Determine which bc function appears first
    let firstFn = 'bcmath';
    for (const fn of BC_FUNCTIONS) {
      if (fn !== 'bcscale' && lines[lineIdx].includes(fn + '(')) { firstFn = fn; break; }
    }
    infos.push({ file: relFile, line: lineIdx + 1, fn: firstFn, issue: 'missing-bcscale: file uses bc* functions but has no bcscale() call — default scale is 0, so all divisions return integer results only' });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // bcdiv zero-check
    if (line.includes('bcdiv(')) {
      const windowStart = Math.max(0, i - 5);
      const windowEnd = Math.min(lines.length, i + 6);
      const block = lines.slice(windowStart, windowEnd).join('\n');
      const hasZeroCheck = /===\s*'0'|===\s*0\b|==\s*'0'|==\s*0\b/.test(block);
      if (!hasZeroCheck) {
        infos.push({ file: relFile, line: i + 1, fn: 'bcdiv', issue: 'bcdiv-no-zero-check: bcdiv() called without a nearby check for divisor === 0 / === \'0\' — division by zero will raise a DivisionByZeroError in PHP 8' });
      }
    }

    // bcscale large value
    if (line.includes('bcscale(')) {
      const scaleMatch = /bcscale\s*\(\s*(\d{1,10})\s*\)/.exec(line);
      if (scaleMatch) {
        const scaleVal = parseInt(scaleMatch[1], 10);
        if (scaleVal > 20) {
          infos.push({ file: relFile, line: i + 1, fn: 'bcscale', issue: `large-bcscale: bcscale(${scaleVal}) is very high (> 20) — may indicate a performance issue or accidental over-precision in calculations` });
        }
      }
    }

    // bccomp informational
    if (line.includes('bccomp(')) {
      infos.push({ file: relFile, line: i + 1, fn: 'bccomp', issue: 'bccomp-usage: bccomp() used for comparison — acceptable pattern; returns -1/0/1 (not bool), ensure result is compared with === 0, === 1, or === -1' });
    }

    // number_format wrapping bc function
    if (line.includes('number_format(')) {
      const bcFnsInLine = ['bcmul', 'bcadd', 'bcsub', 'bcdiv', 'bcmod', 'bcsqrt', 'bcpow'];
      const foundFn = bcFnsInLine.find((fn) => line.includes(fn + '('));
      if (foundFn) {
        infos.push({ file: relFile, line: i + 1, fn: foundFn, issue: `number_format-precision-loss: number_format(${foundFn}(...)) — number_format converts the bcmath string result to float internally, losing arbitrary-precision guarantees; format manually using string operations` });
      }
    }

    // Mixed float and bcmath on same line
    const hasBcCall = BC_FUNCTIONS.some((fn) => line.includes(fn + '('));
    if (hasBcCall) {
      // Native float ops: multiplication, addition, subtraction, division — but NOT inside string literals
      // Look for operator pattern: space-op-space or digit-op-digit outside bc function calls
      const strippedLine = line.replace(/bc(?:add|sub|mul|div|mod|sqrt|pow|comp|scale)\s*\([^)]{0,200}\)/g, '');
      const hasNativeFloat = /\$[a-zA-Z_]\w{0,50}\s*[*+/-]\s*\$[a-zA-Z_]\w{0,50}|\$[a-zA-Z_]\w{0,50}\s*[*+/-]\s*[\d.]|[\d.]\s*[*+/-]\s*\$[a-zA-Z_]\w{0,50}/.test(strippedLine);
      if (hasNativeFloat) {
        const foundFn = BC_FUNCTIONS.find((fn) => line.includes(fn + '(')) ?? 'bcmath';
        infos.push({ file: relFile, line: i + 1, fn: foundFn, issue: 'mixed-float-bcmath: native float arithmetic operator used on same line as bcmath function — mixing float and bcmath loses arbitrary-precision guarantees; use bcmath for all operations on the same variable' });
      }
    }
  }

  return infos;
}

function buildBcmathInfos(appPath: string): BcmathPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: BcmathPatternInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('bc')) continue;
    const hasBcFn = BC_FUNCTIONS.some((fn) => content.includes(fn + '('));
    if (!hasBcFn) continue;
    const infos = analyseFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpBcmathPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildBcmathInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No bcmath pattern issues found in src/.' }] };
    }

    let text = `PHP bcmath Arbitrary-Precision Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n\n`;

    const byFile = new Map<string, BcmathPatternInfo[]>();
    for (const info of infos) {
      const existing = byFile.get(info.file) ?? [];
      existing.push(info);
      byFile.set(info.file, existing);
    }

    for (const [file, entries] of byFile) {
      text += `${file}\n`;
      for (const entry of entries) {
        text += `  Line ${entry.line}  [${entry.fn}]  ${entry.issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBcmathPatternsStats(appPath: string): McpToolResult {
  try {
    const infos = buildBcmathInfos(appPath);

    const countByFn: Record<string, number> = {};
    for (const info of infos) {
      countByFn[info.fn] = (countByFn[info.fn] ?? 0) + 1;
    }

    const countByIssue: Record<string, number> = {
      'missing-bcscale': 0,
      'bcdiv-no-zero-check': 0,
      'large-bcscale': 0,
      'bccomp-usage': 0,
      'number_format-precision-loss': 0,
      'mixed-float-bcmath': 0,
    };
    for (const info of infos) {
      const key = info.issue.split(':')[0];
      if (key in countByIssue) countByIssue[key] = (countByIssue[key] ?? 0) + 1;
    }

    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP bcmath Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:                  ${infos.length}\n`;
    text += `Files affected:                  ${filesAffected}\n\n`;
    text += `By issue type:\n`;
    text += `  missing-bcscale:               ${countByIssue['missing-bcscale'] ?? 0}\n`;
    text += `  bcdiv-no-zero-check:           ${countByIssue['bcdiv-no-zero-check'] ?? 0}\n`;
    text += `  large-bcscale:                 ${countByIssue['large-bcscale'] ?? 0}\n`;
    text += `  bccomp-usage (info):           ${countByIssue['bccomp-usage'] ?? 0}\n`;
    text += `  number_format-precision-loss:  ${countByIssue['number_format-precision-loss'] ?? 0}\n`;
    text += `  mixed-float-bcmath:            ${countByIssue['mixed-float-bcmath'] ?? 0}\n\n`;
    text += `By function:\n`;
    for (const [fn, count] of Object.entries(countByFn)) {
      text += `  ${fn}:${' '.repeat(Math.max(1, 22 - fn.length))}${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpBcmathPatternsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_bcmath_patterns',
      description: 'Scan PHP files for bcmath arbitrary-precision issues: missing bcscale() (default scale 0 → integer division), bcdiv() without zero-check, large bcscale values (> 20), bccomp() usage, number_format(bcmul(...)) precision loss, native float mixed with bcmath on same line',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_bcmath_patterns_stats',
      description: 'Statistics for PHP bcmath patterns: total findings, files affected, counts by issue type (missing-bcscale, bcdiv-no-zero-check, large-bcscale, bccomp-usage, number_format-precision-loss, mixed-float-bcmath) and by function name',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
