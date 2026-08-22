/**
 * PHP First-Class Callables Inspector
 *
 * Scans src/ PHP for first-class callable syntax (PHP 8.1+):
 *   - method(...), function_name(...), $obj->method(...), ClassName::staticMethod(...)
 *   - Closure::fromCallable() (old style, replaceable by first-class callable)
 *   - Array callables [$obj, 'method'] (old style)
 *
 * Warns about:
 *   - Mixing first-class callables with array callables in same file (inconsistency)
 *   - First-class callable used on nullable object (null->method(...) TypeError)
 *   - Closure::fromCallable() that could be replaced by first-class callable
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

interface FirstClassCallableInfo {
  file: string;
  count: number;
  closureFromCallableCount: number;
  arrayCallableCount: number;
  examples: string[];
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

function parseFirstClassCallableFile(filePath: string, appPath: string): FirstClassCallableInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  // Quick check — look for the ... ellipsis pattern inside call
  const hasFirstClass = /\w{1,80}\(\.\.\.\)/.test(content) ||
    /\$\w{1,80}->\w{1,80}\(\.\.\.\)/.test(content) ||
    /\w{1,80}::\w{1,80}\(\.\.\.\)/.test(content);
  const hasClosureFrom = content.includes('Closure::fromCallable(');
  const hasArrayCallable = /\[\s*\$\w{1,80}\s*,\s*['"][^'"]{1,80}['"]\s*\]/.test(content) ||
    /\[\s*\$this\s*,\s*['"][^'"]{1,80}['"]\s*\]/.test(content) ||
    /\[\s*[A-Z]\w{0,80}::class\s*,\s*['"][^'"]{1,80}['"]\s*\]/.test(content);

  if (!hasFirstClass && !hasClosureFrom && !hasArrayCallable) return null;

  const issues: string[] = [];
  const examples: string[] = [];

  // Count first-class callables
  let count = 0;
  const fccRe = /(?:\$\w{1,80}->\w{1,80}|[A-Z]\w{0,80}::\w{1,80}|\b\w{1,80})\(\.\.\.\)/g;
  let m: RegExpExecArray | null;
  while ((m = fccRe.exec(content)) !== null) {
    count++;
    if (examples.length < 5) examples.push(m[0]);
  }

  // Count Closure::fromCallable
  let closureFromCallableCount = 0;
  const cloRe = /Closure::fromCallable\s*\([^)]{0,200}\)/g;
  while (cloRe.exec(content) !== null) {
    closureFromCallableCount++;
  }

  // Count array callables
  let arrayCallableCount = 0;
  const arrRe = /\[\s*(?:\$\w{1,80}|\$this|[A-Z]\w{0,80}::class)\s*,\s*['"][^'"]{1,80}['"]\s*\]/g;
  while ((m = arrRe.exec(content)) !== null) {
    arrayCallableCount++;
  }

  // Issue: mixing styles
  if (count > 0 && arrayCallableCount > 0) {
    issues.push(`Mixes first-class callables (${count}) with array callables (${arrayCallableCount}) — use consistent callable style throughout the file`);
  }

  // Issue: Closure::fromCallable replaceable
  if (closureFromCallableCount > 0) {
    issues.push(`${closureFromCallableCount} Closure::fromCallable() call(s) found — replace with first-class callable syntax: fn(...) or $obj->method(...)`);
  }

  // Issue: nullable object before ->method(...)
  // Detect pattern like $nullable?->something or check if variable could be null
  const nullableMethodRe = /\$\w{0,80}\s*\?->\w{1,80}\s*\(\.\.\.\)/g;
  const nullableResults: string[] = [];
  while ((m = nullableMethodRe.exec(content)) !== null) {
    nullableResults.push(m[0]);
  }
  // Also detect patterns where variable is typed as nullable and used with (...)
  const nullableTypeRe = /\?\w{1,80}\s+\$(\w{1,80})[^;{]{0,200}\$\1->\w{1,80}\(\.\.\.\)/gs;
  while ((m = nullableTypeRe.exec(content)) !== null) {
    if (!nullableResults.includes(m[0].slice(-30))) {
      issues.push(`Nullable variable $${m[1]} used as first-class callable — call will throw TypeError if null`);
      break;
    }
  }

  if (count === 0 && closureFromCallableCount === 0 && arrayCallableCount === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    count,
    closureFromCallableCount,
    arrayCallableCount,
    examples: examples.slice(0, 5),
    issues,
  };
}

function loadFirstClassCallableInfos(appPath: string): FirstClassCallableInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FirstClassCallableInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseFirstClassCallableFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

export function listFirstClassCallables(appPath: string): McpToolResult {
  try {
    const infos = loadFirstClassCallableInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No first-class callables found in src/.\n\nPHP 8.1+ first-class callable syntax:\n  $fn = strlen(...);            // built-in function\n  $fn = $obj->method(...);      // instance method\n  $fn = MyClass::static(...);   // static method\n  array_map(strtolower(...), $arr); // inline usage\n\nReplaces:\n  Closure::fromCallable(\'strlen\')\n  [$obj, \'method\']',
        }],
      };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    const totalFcc = infos.reduce((s, i) => s + i.count, 0);
    const totalClosure = infos.reduce((s, i) => s + i.closureFromCallableCount, 0);
    const totalArray = infos.reduce((s, i) => s + i.arrayCallableCount, 0);

    let text = `PHP First-Class Callables (${infos.length} files, ${totalFcc} callables)\n${'='.repeat(65)}\n`;
    text += `  Closure::fromCallable: ${totalClosure}\n`;
    text += `  Array callables:       ${totalArray}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}\n`;
      text += `    First-class: ${info.count}  Closure::from: ${info.closureFromCallableCount}  Array: ${info.arrayCallableCount}\n`;
      if (info.examples.length > 0) {
        text += `    Examples: ${info.examples.slice(0, 3).join(', ')}\n`;
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nFiles with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFirstClassCallableStats(appPath: string): McpToolResult {
  try {
    const infos = loadFirstClassCallableInfos(appPath);

    let text = `PHP First-Class Callable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using callables:       ${infos.length}\n`;
    text += `Total first-class callables: ${infos.reduce((s, i) => s + i.count, 0)}\n`;
    text += `Closure::fromCallable:       ${infos.reduce((s, i) => s + i.closureFromCallableCount, 0)}\n`;
    text += `Array callables:             ${infos.reduce((s, i) => s + i.arrayCallableCount, 0)}\n`;
    text += `Files mixing styles:         ${infos.filter((i) => i.count > 0 && i.arrayCallableCount > 0).length}\n`;
    text += `Files with issues:           ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFirstClassCallableTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_first_class_callables',
      description: 'List PHP 8.1+ first-class callable syntax usage: fn(...)/method(...)/Class::method(...), Closure::fromCallable() detection, array callable detection, mixed-style warnings, nullable object usage detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_first_class_callable_stats',
      description: 'Show first-class callable statistics: total count, Closure::fromCallable count, array callable count, mixed-style files, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
