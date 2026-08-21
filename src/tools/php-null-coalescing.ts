/**
 * PHP Null Coalescing Inspector
 *
 * Scans src/ PHP for:
 *   - ??= operator
 *   - ?? chains (multiple ??)
 *   - isset() that could be replaced by ??
 *   - array access with ?? default
 *   - $obj?->method() ?? $default (nullsafe + coalesce)
 *
 * Detects:
 *   - Ternary ($x !== null ? $x : $y) that could be $x ?? $y
 *   - Nested ?? chains deeper than 3 levels
 *
 * Warns:
 *   - Ternary with identical condition and value (use ??)
 *   - ??= on property that may not be initialized (undefined)
 *   - Null coalesce chain >3 levels (unclear control flow)
 *   - Mixing ?-> with ?? on same expression (complex nullability)
 *   - isset() check on array key before access (use ?? instead)
 *   - $arr[$key] ?? null where null is also a valid value (ambiguous default)
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

interface PhpNullCoalescingInfo {
  file: string;
  usageCount: number;
  coalescingAssignCount: number;
  longChainCount: number;
  redundantTernaryCount: number;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Analysis helpers ─────────────────────────────────────────────────────────

function countOccurrences(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

function findLongChains(content: string): number {
  // Find expressions with more than 3 ?? operators
  let count = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    const occurrences = (line.match(/\?\?/g) ?? []).length;
    if (occurrences > 3) count++;
  }
  return count;
}

function findRedundantTernaries(content: string): number {
  // Pattern: $x !== null ? $x : $y or $x != null ? $x : $y
  const re = /\$(\w{1,60})\s*!==?\s*null\s*\?\s*\$\1\s*:/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    void m;
    count++;
  }
  return count;
}

function analyzeFile(filePath: string): PhpNullCoalescingInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const usageCount = countOccurrences(content, /\?\?/g);
  if (usageCount === 0) return null;

  const coalescingAssignCount = countOccurrences(content, /\?\?=/g);
  const longChainCount = findLongChains(content);
  const redundantTernaryCount = findRedundantTernaries(content);

  const issues: string[] = [];

  // Redundant ternaries that could be ??
  if (redundantTernaryCount > 0) {
    issues.push(
      `Found ${redundantTernaryCount} ternary expression(s) like ($x !== null ? $x : $y). ` +
      `Replace with $x ?? $y for clarity.`,
    );
  }

  // Long coalescing chains
  if (longChainCount > 0) {
    issues.push(
      `Found ${longChainCount} line(s) with >3 chained ?? operators. ` +
      `Deep null coalesce chains are hard to follow — consider extracting to a method.`,
    );
  }

  // ??= on possibly uninitialized property
  if (coalescingAssignCount > 0) {
    const assignRe = /\$this\s*->\s*(\w{1,60})\s*\?\?=/g;
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(content)) !== null) {
      issues.push(
        `??= on $this->${m[1]} — if the property is not declared in the class, ` +
        `accessing an undefined property causes a warning in PHP 8.x.`,
      );
    }
  }

  // isset() before array access (use ?? instead)
  const issetArrayRe = /isset\s*\(\s*\$(\w{1,60})\s*\[([^\]]{1,80})\]\s*\)\s*\?\s*\$\1\s*\[/g;
  let im: RegExpExecArray | null;
  while ((im = issetArrayRe.exec(content)) !== null) {
    issues.push(
      `isset($${im[1]}[...]) before array access can be replaced with $${im[1]}[${im[2]}] ?? default.`,
    );
  }

  // $arr[$key] ?? null (ambiguous: null is also a valid value)
  const nullDefaultRe = /\$\w{1,60}\s*\[[^\]]{1,80}\]\s*\?\?\s*null\b/g;
  let nm: RegExpExecArray | null;
  while ((nm = nullDefaultRe.exec(content)) !== null) {
    void nm;
    issues.push(
      `$arr[$key] ?? null — if null is a valid value in the array, this pattern is ambiguous. ` +
      `Use array_key_exists() instead for precise existence check.`,
    );
    break; // report once per file to avoid spam
  }

  // Nullsafe + coalesce on same expression (complex nullability)
  const nullsafeCoalesceRe = /\?->[\w>-]{1,80}\(\)\s*\?\?/g;
  if (nullsafeCoalesceRe.test(content)) {
    issues.push(
      `Nullsafe operator (?->) combined with null coalesce (??) on same expression. ` +
      `Ensure intent is clear: ?-> returns null on null object, ?? then provides default.`,
    );
  }

  if (issues.length === 0) return null;

  return {
    file: path.basename(filePath),
    usageCount,
    coalescingAssignCount,
    longChainCount,
    redundantTernaryCount,
    issues,
  };
}

function loadAll(appPath: string): PhpNullCoalescingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpNullCoalescingInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => b.issues.length - a.issues.length);
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpNullCoalescing(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No null coalescing issues found in src/.\n\n' +
            'Null coalescing operators: $x ?? $default, $x ??= $default, $obj?->method() ?? $fallback',
        }],
      };
    }

    const totalUsages = items.reduce((s, i) => s + i.usageCount, 0);
    const totalAssign = items.reduce((s, i) => s + i.coalescingAssignCount, 0);

    let text = `PHP Null Coalescing Analysis\n${'='.repeat(55)}\n`;
    text += `  Files with ?? usage:       ${items.length}\n`;
    text += `  Total ?? usages:           ${totalUsages}\n`;
    text += `  Total ??= usages:          ${totalAssign}\n`;
    text += `  Long chains (>3 ??):       ${items.filter((i) => i.longChainCount > 0).length}\n`;
    text += `  Redundant ternaries:       ${items.reduce((s, i) => s + i.redundantTernaryCount, 0)}\n\n`;

    for (const item of items) {
      text += `${item.file}\n`;
      text += `  usages: ${item.usageCount}  ??= : ${item.coalescingAssignCount}  `;
      text += `longChains: ${item.longChainCount}  redundantTernaries: ${item.redundantTernaryCount}\n`;
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
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

export function getPhpNullCoalescingStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Null Coalescing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with ?? usage:         ${items.length}\n`;
    text += `Total ?? usages:             ${items.reduce((s, i) => s + i.usageCount, 0)}\n`;
    text += `Total ??= usages:            ${items.reduce((s, i) => s + i.coalescingAssignCount, 0)}\n`;
    text += `Files with long chains:      ${items.filter((i) => i.longChainCount > 0).length}\n`;
    text += `Redundant ternaries total:   ${items.reduce((s, i) => s + i.redundantTernaryCount, 0)}\n`;
    text += `Files with issues:           ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpNullCoalescingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_null_coalescing',
      description: 'List PHP null coalescing issues: ??= on uninitialized properties, long chains (>3 ??), redundant ternaries that could be ??, isset() before array access, ambiguous ?? null defaults, nullsafe+coalesce complexity',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_null_coalescing_stats',
      description: 'Show PHP null coalescing statistics: total ?? and ??= usages, long chain files, redundant ternary count, files with issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
