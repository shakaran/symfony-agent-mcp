/**
 * PHP Array Function Inspector
 *
 * Scans src/ PHP for:
 *   array_map, array_filter, array_reduce, array_walk, array_column,
 *   array_combine, array_flip, array_unique, usort/uasort/uksort
 *
 * Detects:
 *   - Patterns that could use generators (foreach on large array with filter+map)
 *   - Nested array_map calls
 *   - array_filter then array_values (extra call)
 *   - array_map with null callback (zip pattern, rarely intentional)
 *
 * Warns:
 *   - array_map returning null callback (zip, unusual intent)
 *   - array_filter without callback (removes falsy — may accidentally remove 0 or '')
 *   - Nested array_map on large data (memory: creates intermediate array)
 *   - usort on large array without cache key (O(n log n) with expensive comparator)
 *   - array_unique on non-sorted array (O(n^2) behavior)
 *   - array_walk modifying by reference without & (no effect)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpArrayFunctionInfo {
  file: string;
  function: string;
  usageCount: number;
  hasNullCallback: boolean;
  hasNestedMap: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

// ─── Function list ─────────────────────────────────────────────────────────────

const ARRAY_FUNCTIONS = [
  'array_map',
  'array_filter',
  'array_reduce',
  'array_walk',
  'array_column',
  'array_combine',
  'array_flip',
  'array_unique',
  'usort',
  'uasort',
  'uksort',
] as const;

// ─── Usage counter ─────────────────────────────────────────────────────────────

function countUsages(content: string, fnName: string): number {
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  const matches = content.match(re);
  return matches ? matches.length : 0;
}

// ─── Specific pattern detectors ───────────────────────────────────────────────

function detectNullCallback(content: string, fnName: string): boolean {
  // array_map(null, $arr, $arr2) — null callback = zip
  const re = new RegExp(`\\b${fnName}\\s*\\(\\s*null\\s*,`, 'g');
  return re.test(content);
}

function detectNestedMap(content: string): boolean {
  // array_map( ... array_map( ...
  return /array_map\s*\([^)]{0,300}array_map\s*\(/.test(content);
}

function detectFilterWithoutCallback(content: string): boolean {
  // array_filter($arr) — no callback argument
  return /array_filter\s*\(\s*\$[\w]{1,60}\s*\)/.test(content);
}

function detectWalkWithoutRef(content: string): boolean {
  // array_walk($arr, function($item) { ... }) — callback without &$item
  // Heuristic: array_walk with callback that has no & on first param
  const walkRe = /array_walk\s*\([^,]{0,100},\s*(?:function\s*\(|fn\s*\()(\$\w{1,60})/g;
  let m: RegExpExecArray | null;
  while ((m = walkRe.exec(content)) !== null) {
    // If first param does not start with &
    if (!m[1].startsWith('&')) return true;
  }
  return false;
}

function detectArrayFilterThenValues(content: string): boolean {
  // array_values(array_filter( ... )) — extra call pattern
  return /array_values\s*\(\s*array_filter\s*\(/.test(content);
}

function detectUsortWithComplexComparator(content: string, fnName: string): boolean {
  // usort($arr, function($a, $b) { ... complex body ... })
  const re = new RegExp(
    `\\b${fnName}\\s*\\([^,]{0,100},\\s*(?:function\\s*\\([^)]{0,100}\\)|fn\\s*\\([^)]{0,100}\\)\\s*=>)\\s*(?:\\{[^}]{100,}\\}|[^;]{50,})`,
    'g',
  );
  return re.test(content);
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): PhpArrayFunctionInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (content.length > 500_000) return [];

  const hasArrayFn = ARRAY_FUNCTIONS.some((fn) => content.includes(fn));
  if (!hasArrayFn) return [];

  const results: PhpArrayFunctionInfo[] = [];

  for (const fnName of ARRAY_FUNCTIONS) {
    const usageCount = countUsages(content, fnName);
    if (usageCount === 0) continue;

    const issues: string[] = [];
    let hasNullCallback = false;
    let hasNestedMap = false;

    if (fnName === 'array_map') {
      hasNullCallback = detectNullCallback(content, fnName);
      hasNestedMap = detectNestedMap(content);

      if (hasNullCallback) {
        issues.push(
          `array_map(null, ...) zip pattern detected. ` +
          `This is rarely intentional — use array_map(fn($a, $b) => [$a, $b], ...) for clarity.`,
        );
      }
      if (hasNestedMap) {
        issues.push(
          `Nested array_map() calls detected. ` +
          `Each level creates an intermediate array — high memory usage on large datasets. ` +
          `Consider a single loop or generator.`,
        );
      }
    }

    if (fnName === 'array_filter') {
      const noCallback = detectFilterWithoutCallback(content);
      if (noCallback) {
        issues.push(
          `array_filter($arr) without callback removes all falsy values (0, '', false, null, []). ` +
          `If 0 or empty string are valid values, use an explicit callback.`,
        );
      }
      if (detectArrayFilterThenValues(content)) {
        issues.push(
          `array_values(array_filter(...)) pattern detected. ` +
          `array_filter preserves keys — array_values reindexes. ` +
          `Pass ARRAY_FILTER_USE_BOTH or use array_values only when needed.`,
        );
      }
    }

    if (fnName === 'array_walk') {
      if (detectWalkWithoutRef(content)) {
        issues.push(
          `array_walk() callback may not use & on first parameter. ` +
          `Without &$item the callback cannot modify the array values.`,
        );
      }
    }

    if (fnName === 'array_unique') {
      // array_unique on large arrays is O(n^2) with SORT_STRING (default)
      issues.push(
        `array_unique() detected. On large arrays, array_unique() can be O(n^2). ` +
        `Consider array_flip(array_flip($arr)) or array_keys(array_flip($arr)) for unique string values.`,
      );
    }

    if (fnName === 'usort' || fnName === 'uasort' || fnName === 'uksort') {
      if (detectUsortWithComplexComparator(content, fnName)) {
        issues.push(
          `${fnName}() with complex comparator detected. ` +
          `PHP calls the comparator O(n log n) times — cache expensive computed values ` +
          `using Schwartzian transform (usort after array_map to add sort key).`,
        );
      }
    }

    results.push({
      file: path.basename(filePath),
      function: fnName,
      usageCount,
      hasNullCallback,
      hasNestedMap,
      issues,
    });
  }

  return results;
}

function loadAll(appPath: string): PhpArrayFunctionInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpArrayFunctionInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    results.push(...analyzeFile(file));
  }
  return results;
}

// ─── Aggregation helper ────────────────────────────────────────────────────────

function aggregateByFunction(items: PhpArrayFunctionInfo[]): Map<string, PhpArrayFunctionInfo[]> {
  const map = new Map<string, PhpArrayFunctionInfo[]>();
  for (const item of items) {
    const existing = map.get(item.function) ?? [];
    existing.push(item);
    map.set(item.function, existing);
  }
  return map;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpArrayFunctions(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP array function usage found in src/.\n\n' +
            'Tracked functions: array_map, array_filter, array_reduce, array_walk, ' +
            'array_column, array_combine, array_flip, array_unique, usort/uasort/uksort',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);
    const byFn = aggregateByFunction(items);

    let text = `PHP Array Function Analysis\n${'='.repeat(55)}\n`;
    text += `  Total usages across files: ${items.reduce((s, i) => s + i.usageCount, 0)}\n`;
    text += `  Files with issues:         ${new Set(withIssues.map((i) => i.file)).size}\n\n`;

    for (const [fn, fnItems] of [...byFn.entries()].sort()) {
      const totalUsages = fnItems.reduce((s, i) => s + i.usageCount, 0);
      const issueCount = fnItems.filter((i) => i.issues.length > 0).length;
      text += `${fn}:  ${totalUsages} total usages  ${issueCount > 0 ? issueCount + ' files with issues' : 'no issues'}\n`;
      for (const item of fnItems.filter((i) => i.issues.length > 0)) {
        text += `  ${item.file}\n`;
        for (const issue of item.issues) {
          text += `    WARN: ${issue}\n`;
        }
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

export function getPhpArrayFunctionStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    const byFn = aggregateByFunction(items);

    let text = `PHP Array Function Statistics\n${'='.repeat(40)}\n\n`;

    for (const fn of ARRAY_FUNCTIONS) {
      const fnItems = byFn.get(fn) ?? [];
      const total = fnItems.reduce((s, i) => s + i.usageCount, 0);
      text += `${fn.padEnd(20)} ${String(total).padStart(4)} usages`;
      const issueFiles = fnItems.filter((i) => i.issues.length > 0).length;
      if (issueFiles > 0) text += `  (${issueFiles} files with issues)`;
      text += '\n';
    }

    text += `\nTotal usages:              ${items.reduce((s, i) => s + i.usageCount, 0)}\n`;
    text += `Null callback (map):       ${items.filter((i) => i.hasNullCallback).length}\n`;
    text += `Nested map:                ${items.filter((i) => i.hasNestedMap).length}\n`;
    text += `Files with issues:         ${new Set(items.filter((i) => i.issues.length > 0).map((i) => i.file)).size}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpArrayFunctionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_array_functions',
      description: 'List PHP array function usage: array_map/filter/reduce/walk/column/combine/flip/unique/usort detection, null callback zip pattern, nested map memory warnings, filter-without-callback falsy trap, array_walk without &ref, usort complex comparator, array_unique O(n^2)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_array_function_stats',
      description: 'Show PHP array function statistics: per-function usage counts, null callback count, nested map count, files with issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
