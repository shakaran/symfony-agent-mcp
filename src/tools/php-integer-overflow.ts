/**
 * PHP Integer Overflow Pattern Scanner
 *
 * Scans src/**\/*.php for integer overflow patterns:
 *   - Arithmetic on values that could exceed PHP_INT_MAX (2147483647 on 32-bit) without BCMath
 *   - intval() on values from user input that could be large
 *   - Bitwise shift << / >> by more than 63 bits
 *   - Array index from user input cast to int without range check
 *   - strlen() result used in arithmetic that could overflow
 *   - Large literal constants without _ grouping (only if > PHP_INT_MAX on 32-bit)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface IntegerOverflowInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

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

// ─── Constants ────────────────────────────────────────────────────────────────

// PHP_INT_MAX on 32-bit is 2147483647; on 64-bit is 9223372036854775807
const PHP_INT_MAX_32 = 2147483647;

// ─── Pattern detectors ────────────────────────────────────────────────────────

function detectIntvalOnUserInput(line: string): boolean {
  // intval($_GET[...]) / intval($_POST[...]) / intval($_REQUEST[...])
  return /\bintval\s*\(\s*\$_(GET|POST|REQUEST|COOKIE|SERVER)/.test(line);
}

function detectBitwiseShiftExcessive(line: string): boolean {
  // Look for << or >> followed by a literal number > 63
  const shiftRe = /<<|>>/;
  if (!shiftRe.test(line)) return false;
  // Find shift amount
  const amountRe = /(?:<<|>>)\s*(\d{1,10})/g;
  let m: RegExpExecArray | null;
  while ((m = amountRe.exec(line)) !== null) {
    const amount = parseInt(m[1], 10);
    if (amount > 63) return true;
  }
  return false;
}

function detectArrayIndexFromUserInput(line: string): boolean {
  // (int)$_GET['key'] / (int)$_POST['key'] used as array index
  // or $arr[(int)$_GET[...]]
  return /\[\s*\(int\)\s*\$_(GET|POST|REQUEST)/.test(line) ||
    /\(int\)\s*\$_(GET|POST|REQUEST)\s*\[/.test(line);
}

function detectStrlenInArithmetic(line: string): boolean {
  // strlen($x) + / - / * something — result could be large if string is huge
  return /\bstrlen\s*\([^)]{0,100}\)\s*[+\-*]/.test(line) ||
    /[+\-*]\s*\bstrlen\s*\(/.test(line);
}

function detectLargeLiteralConstant(line: string): boolean {
  // Integer literals > PHP_INT_MAX_32 without underscore grouping
  const literalRe = /\b(\d{10,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(line)) !== null) {
    const val = parseInt(m[1], 10);
    if (val > PHP_INT_MAX_32 && !m[1].includes('_')) return true;
  }
  return false;
}

function detectArithmeticWithoutBcmath(line: string): boolean {
  // Arithmetic involving PHP_INT_MAX literal or very large numbers without bcmath
  return /PHP_INT_MAX\s*[+\-*]/.test(line) || /[+\-*]\s*PHP_INT_MAX/.test(line);
}

function hasBcmathNearby(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 5);
  const end = Math.min(lines.length - 1, lineIdx + 2);
  for (let i = start; i <= end; i++) {
    if (/\bbc(add|sub|mul|div|pow|mod|scale|comp)\s*\(/.test(lines[i])) return true;
  }
  return false;
}

function hasRangeCheckNearby(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 3);
  const end = Math.min(lines.length - 1, lineIdx + 1);
  for (let i = start; i <= end; i++) {
    if (/\b(filter_var|is_numeric|range|min\s*\(|max\s*\(|assert|throw|if\s*\()\b/.test(lines[i])) return true;
  }
  return false;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): IntegerOverflowInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: IntegerOverflowInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    if (detectArithmeticWithoutBcmath(line) && !hasBcmathNearby(lines, i)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'php-int-max-arithmetic',
        issue: 'Arithmetic involving PHP_INT_MAX without BCMath — result overflows to float on 32-bit PHP; use bcadd()/bcmul() for arbitrary-precision arithmetic',
        severity: 'high',
      });
    }

    if (detectIntvalOnUserInput(line) && !hasRangeCheckNearby(lines, i)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'intval-user-input',
        issue: 'intval() on superglobal without range check — user-controlled large number is silently truncated to PHP_INT_MAX or PHP_INT_MIN; validate with filter_var(FILTER_VALIDATE_INT, [\'options\' => [\'min_range\' => ..., \'max_range\' => ...]])',
        severity: 'medium',
      });
    }

    if (detectBitwiseShiftExcessive(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'bitshift-overflow',
        issue: 'Bitwise shift by more than 63 bits — on 64-bit PHP, shifting 64+ bits produces undefined behavior or zero; the shift amount must be 0-63',
        severity: 'high',
      });
    }

    if (detectArrayIndexFromUserInput(line) && !hasRangeCheckNearby(lines, i)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'array-index-user-input',
        issue: 'Array index from user input cast to int without range check — a very large or negative value can cause unexpected array access or memory issues; add min/max bounds check',
        severity: 'medium',
      });
    }

    if (detectStrlenInArithmetic(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'strlen-arithmetic',
        issue: 'strlen() result used in arithmetic — if the string comes from user input with no length limit, the product/sum may overflow PHP_INT_MAX; apply mb_strimwidth or validate length first',
        severity: 'low',
      });
    }

    if (detectLargeLiteralConstant(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'large-literal',
        issue: `Large integer literal (> ${PHP_INT_MAX_32} / PHP_INT_MAX on 32-bit) without underscore grouping — will silently become a float on 32-bit PHP; use PHP_INT_MAX constant or BCMath for values exceeding 2^31-1`,
        severity: 'low',
      });
    }
  }

  return results;
}

function loadAll(appPath: string): IntegerOverflowInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: IntegerOverflowInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath));
  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpIntegerOverflow(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No integer overflow patterns found in src/.\n\n' +
            'Checked: PHP_INT_MAX arithmetic, intval() on user input, bitwise shift > 63, ' +
            'array index from user input, strlen() in arithmetic, large literals > 2147483647.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `PHP Integer Overflow Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High severity:   ${high.length}\n`;
    text += `  Medium severity: ${medium.length}\n`;
    text += `  Low severity:    ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpIntegerOverflowStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `PHP Integer Overflow Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High severity:   ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium severity: ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low severity:    ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getPhpIntegerOverflowTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_integer_overflow',
      description: 'Scan src/**/*.php for integer overflow patterns: PHP_INT_MAX arithmetic without BCMath, intval() on superglobals without range check, bitshift > 63 bits, array index from user input, strlen() in arithmetic, large literals > 2147483647',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_integer_overflow_stats',
      description: 'Statistics for PHP integer overflow findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
