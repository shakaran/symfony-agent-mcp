/**
 * PHP Closure Inspector
 *
 * Scans src/ PHP for:
 *   Closure::bind(, Closure::fromCallable(, Closure::bindTo(,
 *   static function(, function() use (, $fn = function(, fn(
 *
 * Detects:
 *   - Closures capturing $this vs static closures
 *   - Closures capturing by reference (use (&$var))
 *   - Closure::fromCallable usage for first-class callable syntax
 *
 * Warns:
 *   - Non-static closure in static context (PHP fatal)
 *   - Closure capturing $this unnecessarily (should be static)
 *   - Use-by-reference in closure that escapes scope (memory leak risk)
 *   - Closure::bind() with null scope (loses method access)
 *   - Very large closure (>50 lines, should be extracted to method)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpClosureInfo {
  file: string;
  class?: string;
  type: 'arrow' | 'anonymous' | 'static' | 'bind' | 'fromCallable';
  capturesThis: boolean;
  capturesByRef: boolean;
  isInStaticContext: boolean;
  lineCount: number;
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

// ─── Closure detection ────────────────────────────────────────────────────────

type ClosureType = PhpClosureInfo['type'];

interface ClosureMatch {
  type: ClosureType;
  index: number;
  snippet: string;
}

function findClosures(content: string): ClosureMatch[] {
  const closures: ClosureMatch[] = [];

  // Closure::bind( or Closure::fromCallable(
  const bindRe = /Closure::(bind|fromCallable|bindTo)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = bindRe.exec(content)) !== null) {
    const t = m[1] === 'fromCallable' ? 'fromCallable' : 'bind';
    closures.push({ type: t as ClosureType, index: m.index, snippet: content.slice(m.index, m.index + 200) });
  }

  // static function(
  const staticRe = /\bstatic\s+function\s*\(/g;
  while ((m = staticRe.exec(content)) !== null) {
    closures.push({ type: 'static', index: m.index, snippet: content.slice(m.index, m.index + 200) });
  }

  // fn( arrow functions
  const arrowRe = /\bfn\s*\(/g;
  while ((m = arrowRe.exec(content)) !== null) {
    closures.push({ type: 'arrow', index: m.index, snippet: content.slice(m.index, m.index + 100) });
  }

  // function() use ( or $fn = function(
  const anonRe = /(?:\$\w{1,60}\s*=\s*)?function\s*\([^)]{0,200}\)\s*(?:use\s*\([^)]{0,200}\))?/g;
  while ((m = anonRe.exec(content)) !== null) {
    // Skip if preceded by 'static' (already captured)
    const before = content.slice(Math.max(0, m.index - 8), m.index);
    if (/static\s*$/.test(before)) continue;
    // Skip named function declarations (preceded by function name pattern)
    if (/function\s+\w/.test(m[0])) continue;
    closures.push({ type: 'anonymous', index: m.index, snippet: content.slice(m.index, m.index + 200) });
  }

  return closures;
}

function countLines(snippet: string): number {
  return (snippet.match(/\n/g) ?? []).length + 1;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): PhpClosureInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const hasClosureActivity =
    content.includes('function(') ||
    content.includes('function (') ||
    content.includes('Closure::') ||
    /\bfn\s*\(/.test(content);

  if (!hasClosureActivity) return [];

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  const className = classM ? classM[1] : undefined;

  const isStaticClass = /\bstatic\s+class\b/.test(content);
  const closures = findClosures(content);

  return closures.map((c): PhpClosureInfo => {
    const snippet = c.snippet;

    const capturesThis = snippet.includes('$this');
    const capturesByRef = /use\s*\([^)]{0,200}&\$/.test(snippet);

    // Is this closure inside a static method?
    // Simple heuristic: look for 'static function' or 'static public function' around index
    const contextBefore = content.slice(Math.max(0, c.index - 500), c.index);
    const isInStaticContext = isStaticClass ||
      /static\s+(?:public|protected|private)?\s*function\s+\w{1,80}\s*\([^)]{0,200}\)[^{]{0,100}\{[^}]{0,300}$/.test(contextBefore);

    const lineCount = countLines(snippet.slice(0, 300));

    const issues: string[] = [];

    if (c.type === 'anonymous' && capturesThis && isInStaticContext) {
      issues.push(
        `Non-static closure capturing $this in a static context — PHP fatal error. ` +
        `Use static function() or remove $this reference.`,
      );
    }
    if ((c.type === 'anonymous' || c.type === 'bind') && capturesThis && !isInStaticContext) {
      issues.push(
        `Closure captures $this — if $this is not used, mark closure as static to avoid circular reference.`,
      );
    }
    if (capturesByRef) {
      issues.push(
        `Closure captures variable by reference (use (&$var)). ` +
        `If closure outlives scope, the referenced variable leaks in memory.`,
      );
    }
    if (c.type === 'bind' && /Closure::bind\s*\([^,]{0,100},\s*null/.test(snippet)) {
      issues.push(
        `Closure::bind() called with null scope — the closure loses access to protected/private members.`,
      );
    }
    if (lineCount > 50) {
      issues.push(
        `Closure body appears large (${lineCount}+ lines). ` +
        `Consider extracting to a named method for readability and testability.`,
      );
    }

    return {
      file: path.basename(filePath),
      class: className,
      type: c.type,
      capturesThis,
      capturesByRef,
      isInStaticContext,
      lineCount,
      issues,
    };
  });
}

function loadAll(appPath: string): PhpClosureInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpClosureInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    results.push(...analyzeFile(file));
  }
  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpClosures(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP closures found in src/.\n\n' +
            'PHP closures: function() use ($var) { ... }, static function() { ... }, fn($x) => $x * 2',
        }],
      };
    }

    const withIssues   = items.filter((i) => i.issues.length > 0);
    const byType: Record<string, number> = {};
    for (const item of items) byType[item.type] = (byType[item.type] ?? 0) + 1;

    let text = `PHP Closure Analysis\n${'='.repeat(55)}\n`;
    text += `  Total closures: ${items.length}\n`;
    for (const [t, count] of Object.entries(byType)) {
      text += `    ${t}: ${count}\n`;
    }
    text += `  Captures $this:   ${items.filter((i) => i.capturesThis).length}\n`;
    text += `  Captures by ref:  ${items.filter((i) => i.capturesByRef).length}\n`;
    text += `  With issues:      ${withIssues.length}\n\n`;

    const shown = items.filter((i) => i.issues.length > 0);
    for (const item of shown) {
      text += `[${item.type}] ${item.class ? item.class + ' — ' : ''}${item.file}\n`;
      text += `  capturesThis: ${item.capturesThis}  capturesByRef: ${item.capturesByRef}  `;
      text += `staticContext: ${item.isInStaticContext}  lines: ~${item.lineCount}\n`;
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

export function getPhpClosureStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Closure Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total closures:       ${items.length}\n`;
    text += `  Arrow (fn):         ${items.filter((i) => i.type === 'arrow').length}\n`;
    text += `  Anonymous:          ${items.filter((i) => i.type === 'anonymous').length}\n`;
    text += `  Static:             ${items.filter((i) => i.type === 'static').length}\n`;
    text += `  Closure::bind:      ${items.filter((i) => i.type === 'bind').length}\n`;
    text += `  fromCallable:       ${items.filter((i) => i.type === 'fromCallable').length}\n`;
    text += `Captures $this:       ${items.filter((i) => i.capturesThis).length}\n`;
    text += `Captures by-ref:      ${items.filter((i) => i.capturesByRef).length}\n`;
    text += `In static context:    ${items.filter((i) => i.isInStaticContext).length}\n`;
    text += `Large (>50 lines):    ${items.filter((i) => i.lineCount > 50).length}\n`;
    text += `With issues:          ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpClosureTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_closures',
      description: 'List PHP closure usage: arrow/anonymous/static/bind/fromCallable types, $this capture, by-reference capture, static context violations, large closure warnings, null-scope Closure::bind()',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_closure_stats',
      description: 'Show PHP closure statistics: type counts (arrow/anonymous/static/bind/fromCallable), $this/by-ref capture counts, large closure count, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
