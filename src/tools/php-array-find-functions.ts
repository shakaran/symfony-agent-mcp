/**
 * PHP Array Find/Search Function Inspector
 *
 * Scans src/**\/*.php for PHP 8.4 array find/search functions and older equivalents:
 *   - array_find() / array_find_key() / array_any() / array_all() usage (PHP 8.4+)
 *   - array_filter() used as array_find substitute — suggest array_find if PHP 8.4+
 *   - array_search() with strict === vs == comparison (common bug)
 *   - in_array() without 3rd true argument (type-unsafe)
 *   - Check composer.json for PHP version to flag PHP 8.4 function availability
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ArrayFindInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low' | 'info';
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

// ─── PHP version detection ────────────────────────────────────────────────────

interface PhpVersionInfo {
  raw: string;
  major: number;
  minor: number;
  isAtLeast84: boolean;
}

function detectPhpVersion(appPath: string): PhpVersionInfo | null {
  const composerPath = path.join(appPath, 'composer.json');
  const resolved = path.resolve(composerPath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) return null;

  let content = '';
  try { content = fs.readFileSync(composerPath, 'utf-8'); } catch { return null; }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { return null; }

  const require = parsed['require'];
  if (!require || typeof require !== 'object') return null;

  const phpConstraint = (require as Record<string, unknown>)['php'];
  if (typeof phpConstraint !== 'string') return null;

  // Extract first version number from constraint like ">=8.2", "^8.1", "~8.3.0"
  const verMatch = /(\d+)\.(\d+)/.exec(phpConstraint);
  if (!verMatch) return null;

  const major = parseInt(verMatch[1], 10);
  const minor = parseInt(verMatch[2], 10);

  return {
    raw: phpConstraint,
    major,
    minor,
    isAtLeast84: major > 8 || (major === 8 && minor >= 4),
  };
}

// ─── Pattern detectors ────────────────────────────────────────────────────────

function detectPhp84Functions(line: string): string | null {
  if (/\barray_find\s*\(/.test(line)) return 'array_find';
  if (/\barray_find_key\s*\(/.test(line)) return 'array_find_key';
  if (/\barray_any\s*\(/.test(line)) return 'array_any';
  if (/\barray_all\s*\(/.test(line)) return 'array_all';
  return null;
}

function detectArrayFilterAsFind(line: string): boolean {
  // array_filter used to find first matching element — pattern: take result of array_filter and get first
  // Heuristic: array_filter followed immediately by reset() / current() / array_shift() on same or next few lines
  return /\barray_filter\s*\(/.test(line);
}

function detectArraySearchWithoutStrict(line: string): boolean {
  // array_search without strict mode — array_search($needle, $haystack) — 3rd arg missing or false
  // array_search accepts needle, haystack[, strict]
  // Flag if 3rd arg is absent or explicitly false
  if (!/\barray_search\s*\(/.test(line)) return false;
  // If line contains === or ,\s*true it has strict mode
  // Heuristic: if no third arg or third arg is false
  const strictRe = /\barray_search\s*\([^,)]{0,100},[^,)]{0,100},\s*true\s*\)/;
  return !strictRe.test(line);
}

function detectInArrayWithoutStrict(line: string): boolean {
  // in_array($needle, $haystack) without 3rd true argument — type-unsafe
  if (!/\bin_array\s*\(/.test(line)) return false;
  // Check if 3rd arg true is present
  const strictRe = /\bin_array\s*\([^)]{0,200},\s*true\s*\)/;
  return !strictRe.test(line);
}

// ─── File analysis ─────────────────────────────────────────────────────────────

function analyzeFile(
  filePath: string,
  base: string,
  phpVersion: PhpVersionInfo | null,
): ArrayFindInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: ArrayFindInfo[] = [];

  // Track array_filter lines to check if followed by reset/current/array_shift
  const filterLineIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    // PHP 8.4 functions
    const php84fn = detectPhp84Functions(line);
    if (php84fn !== null) {
      if (phpVersion !== null && !phpVersion.isAtLeast84) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: `php84-${php84fn}`,
          issue: `${php84fn}() is a PHP 8.4+ function but composer.json requires PHP ${phpVersion.raw} — this function does not exist on your platform and will throw a fatal error`,
          severity: 'high',
        });
      } else {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: `php84-${php84fn}`,
          issue: `${php84fn}() PHP 8.4+ function used — good practice; ensure production PHP version meets the requirement`,
          severity: 'info',
        });
      }
    }

    // array_filter as find substitute
    if (detectArrayFilterAsFind(line)) {
      filterLineIndices.push(i);
    }

    // array_search without strict
    if (detectArraySearchWithoutStrict(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'array-search-loose',
        issue: 'array_search() without strict=true uses loose (==) comparison — may return wrong index when needle is 0 or false due to type coercion; add true as third argument: array_search($needle, $haystack, true)',
        severity: 'medium',
      });
    }

    // in_array without strict
    if (detectInArrayWithoutStrict(line)) {
      // Check for common false-positive: if the needle is clearly a string literal
      const hasStringNeedle = /\bin_array\s*\(\s*['"]/.test(line);
      if (!hasStringNeedle) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'in-array-loose',
          issue: 'in_array() without strict mode (3rd arg true) uses loose (==) comparison — in_array(0, ["a", "b"]) returns true on PHP < 8.0 because 0 == "a"; add true as 3rd argument: in_array($value, $array, true)',
          severity: 'medium',
        });
      }
    }
  }

  // Check array_filter lines followed by reset/current/array_shift (find substitute pattern)
  for (const filterIdx of filterLineIndices) {
    const nextLines = lines.slice(filterIdx + 1, filterIdx + 4).join('\n');
    const currentLine = lines[filterIdx];
    const isUsedAsFindSubstitute =
      /\b(reset|current|array_shift)\s*\(/.test(nextLines) ||
      /\b(reset|current|array_shift)\s*\(/.test(currentLine);

    if (isUsedAsFindSubstitute) {
      const suffix = phpVersion?.isAtLeast84
        ? ' — since you are on PHP 8.4+, replace with array_find() which returns the first matching element directly'
        : ' — consider extracting to a helper function; on PHP 8.4+ you can use array_find()';
      results.push({
        file: relFile,
        line: filterIdx + 1,
        pattern: 'array-filter-as-find',
        issue: `array_filter() used as array_find substitute (followed by reset/current/array_shift)${suffix}`,
        severity: 'low',
      });
    }
  }

  return results;
}

function loadAll(appPath: string): { items: ArrayFindInfo[]; phpVersion: PhpVersionInfo | null } {
  const phpVersion = detectPhpVersion(appPath);
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: ArrayFindInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath, phpVersion));
  return { items: results, phpVersion };
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpArrayFindFunctions(appPath: string): McpToolResult {
  try {
    const { items, phpVersion } = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP array find/search issues found in src/.\n\n' +
            'Checked: array_find/find_key/any/all (PHP 8.4+), array_filter as find substitute, ' +
            'array_search without strict mode, in_array without strict mode.\n' +
            `PHP version from composer.json: ${phpVersion ? phpVersion.raw : 'not detected'}`,
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');
    const info = items.filter((i) => i.severity === 'info');

    let text = `PHP Array Find Function Analysis\n${'='.repeat(55)}\n\n`;
    text += `  PHP version (composer.json): ${phpVersion ? phpVersion.raw : 'not detected'}\n`;
    text += `  PHP 8.4+ available:          ${phpVersion ? String(phpVersion.isAtLeast84) : 'unknown'}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Info:            ${info.length}\n\n`;

    for (const item of items) {
      if (item.severity === 'info') continue;
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    if (info.length > 0) {
      text += `PHP 8.4+ function usages (informational):\n`;
      for (const item of info) {
        text += `  ${item.file}:${item.line}  ${item.pattern}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpArrayFindFunctionsStats(appPath: string): McpToolResult {
  try {
    const { items, phpVersion } = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `PHP Array Find Function Statistics\n${'='.repeat(40)}\n\n`;
    text += `PHP version:     ${phpVersion ? phpVersion.raw : 'not detected'}\n`;
    text += `PHP 8.4+:        ${phpVersion ? String(phpVersion.isAtLeast84) : 'unknown'}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Info:            ${items.filter((i) => i.severity === 'info').length}\n`;
    text += `Files affected:  ${new Set(items.filter((i) => i.severity !== 'info').map((i) => i.file)).size}\n\n`;
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

export function getPhpArrayFindFunctionsTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_array_find_functions',
      description: 'Scan src/**/*.php for PHP 8.4 array find functions and older equivalents: array_find/find_key/any/all (PHP 8.4+) availability vs composer.json PHP version, array_filter used as find substitute (suggest array_find), array_search without strict===, in_array without strict mode',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_array_find_functions_stats',
      description: 'Statistics for PHP array find function findings: PHP version from composer.json, PHP 8.4+ flag, total findings by severity (high/medium/low/info) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
