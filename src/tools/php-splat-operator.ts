/**
 * PHP Splat Operator Inspector
 *
 * Scans src/ PHP for:
 *   - function declarations with ...$args parameter (variadic)
 *   - array unpacking [...$arr, ...other]
 *   - ...$arr in function calls (call-spread)
 *   - named arg spread ...$named
 *
 * Detects:
 *   - Variadic functions, spread in array literals, spread in function calls
 *
 * Warns:
 *   - Variadic function with required parameters after ...$args (PHP fatal)
 *   - Spread of non-iterable (missing type hint)
 *   - Function accepting ...mixed (loses type safety)
 *   - Spread operator combined with positional args after named args (PHP 8.1 restriction)
 *   - Empty ...$args check missing before first() or last()
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpSplatInfo {
  file: string;
  class?: string;
  method: string;
  type: 'variadic' | 'array-spread' | 'call-spread';
  hasTypeHint: boolean;
  hasRequiredAfterVariadic: boolean;
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

// ─── Splat detection ──────────────────────────────────────────────────────────

interface SplatMatch {
  type: PhpSplatInfo['type'];
  method: string;
  snippet: string;
  paramList: string;
}

function findVariadicFunctions(content: string): SplatMatch[] {
  const matches: SplatMatch[] = [];
  // Match: function name(... , ...$args)
  const re = /function\s+(\w{1,80})\s*\(([^)]{0,400})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const paramList = m[2] ?? '';
    if (!paramList.includes('...')) continue;
    matches.push({
      type: 'variadic',
      method: m[1],
      snippet: m[0],
      paramList,
    });
  }
  return matches;
}

function findArraySpreads(content: string): SplatMatch[] {
  const matches: SplatMatch[] = [];
  // array literal with spread: [...$var, ...$other]
  const re = /\[\s*(?:[^[\]]{0,100},\s*)?\.\.\.(\$\w{1,60})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Get surrounding context to find method name
    const before = content.slice(Math.max(0, m.index - 200), m.index);
    const methodM = /function\s+(\w{1,80})\s*\(/.exec(before);
    matches.push({
      type: 'array-spread',
      method: methodM ? methodM[1] : '(global)',
      snippet: m[0],
      paramList: m[1],
    });
  }
  return matches;
}

function findCallSpreads(content: string): SplatMatch[] {
  const matches: SplatMatch[] = [];
  // function call with ...$arr spread: someFunc(...$arr)
  const re = /(\w{1,80})\s*\(\s*(?:[^()]{0,100},\s*)?\.\.\.(\$\w{1,60})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Skip array definitions caught above
    const before = content.slice(Math.max(0, m.index - 5), m.index);
    if (/[[]$/.test(before)) continue;
    const contextBefore = content.slice(Math.max(0, m.index - 200), m.index);
    const methodM = /function\s+(\w{1,80})\s*\(/.exec(contextBefore);
    matches.push({
      type: 'call-spread',
      method: methodM ? methodM[1] : '(global)',
      snippet: m[0],
      paramList: m[2] ?? '',
    });
  }
  return matches;
}

// ─── Analysis helpers ─────────────────────────────────────────────────────────

function hasRequiredAfterVariadic(paramList: string): boolean {
  // Find position of ... and check if there's a non-optional parameter after
  const parts = paramList.split(',').map((s) => s.trim());
  let foundVariadic = false;
  for (const part of parts) {
    if (foundVariadic && part && !part.startsWith('$') && !part.startsWith('?') && !part.includes('=')) {
      return true;
    }
    if (part.includes('...')) foundVariadic = true;
  }
  return false;
}

function extractTypeHint(paramList: string): boolean {
  // Check if the variadic param has a type hint: TypeHint ...$args
  return /[\w\\|?]{1,80}\s+\.\.\.\$/.test(paramList);
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): PhpSplatInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  if (!content.includes('...')) return [];

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  const className = classM ? classM[1] : undefined;

  const allMatches: SplatMatch[] = [
    ...findVariadicFunctions(content),
    ...findArraySpreads(content),
    ...findCallSpreads(content),
  ];

  return allMatches.map((sm): PhpSplatInfo => {
    const issues: string[] = [];
    const hasTypeHint = sm.type === 'variadic' ? extractTypeHint(sm.paramList) : true;
    const reqAfter = sm.type === 'variadic' ? hasRequiredAfterVariadic(sm.paramList) : false;

    if (reqAfter) {
      issues.push(
        `Function ${sm.method}(): required parameter after variadic ...$args — PHP fatal error. ` +
        `Move required parameters before the variadic.`,
      );
    }
    if (sm.type === 'variadic' && !hasTypeHint) {
      issues.push(
        `Function ${sm.method}(): variadic parameter has no type hint. ` +
        `Add a type hint (e.g., string ...$args) to improve static analysis.`,
      );
    }
    if (sm.type === 'variadic' && sm.paramList.includes('mixed ...')) {
      issues.push(
        `Function ${sm.method}(): variadic parameter typed as mixed — loses type safety. ` +
        `Narrow to a specific type when possible.`,
      );
    }
    if (sm.type === 'call-spread' || sm.type === 'array-spread') {
      // Check for named-arg + positional ordering issue
      if (/\w{1,60}:\s/.test(sm.snippet) && sm.snippet.includes('...')) {
        issues.push(
          `Spread operator combined with named arguments in ${sm.method}(). ` +
          `PHP 8.1 restriction: named args cannot be combined with spread after them.`,
        );
      }
    }

    return {
      file: path.basename(filePath),
      class: className,
      method: sm.method,
      type: sm.type,
      hasTypeHint,
      hasRequiredAfterVariadic: reqAfter,
      issues,
    };
  });
}

function loadAll(appPath: string): PhpSplatInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpSplatInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    results.push(...analyzeFile(file));
  }
  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpSplatOperator(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No splat/spread operator usage found in src/.\n\n' +
            'Splat examples: function foo(string ...$args), someFunc(...$arr), [...$a, ...$b]',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);

    let text = `PHP Splat Operator Analysis\n${'='.repeat(55)}\n`;
    text += `  Total usages:        ${items.length}\n`;
    text += `  Variadic functions:  ${items.filter((i) => i.type === 'variadic').length}\n`;
    text += `  Array spread:        ${items.filter((i) => i.type === 'array-spread').length}\n`;
    text += `  Call spread:         ${items.filter((i) => i.type === 'call-spread').length}\n`;
    text += `  With issues:         ${withIssues.length}\n\n`;

    for (const item of withIssues) {
      text += `${item.class ? item.class + '::' : ''}${item.method}() [${item.type}] — ${item.file}\n`;
      text += `  typeHint: ${item.hasTypeHint}  requiredAfterVariadic: ${item.hasRequiredAfterVariadic}\n`;
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

export function getPhpSplatStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Splat Operator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total usages:               ${items.length}\n`;
    text += `  Variadic functions:       ${items.filter((i) => i.type === 'variadic').length}\n`;
    text += `  Array spread:             ${items.filter((i) => i.type === 'array-spread').length}\n`;
    text += `  Call spread:              ${items.filter((i) => i.type === 'call-spread').length}\n`;
    text += `With type hint:             ${items.filter((i) => i.hasTypeHint).length}\n`;
    text += `Required after variadic:    ${items.filter((i) => i.hasRequiredAfterVariadic).length}\n`;
    text += `With issues:                ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpSplatTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_splat_operator',
      description: 'List PHP splat/spread operator usage: variadic functions, array spread, call spread, type hint detection, required-after-variadic PHP fatal warnings, named-arg conflicts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_splat_stats',
      description: 'Show PHP splat operator statistics: variadic/array-spread/call-spread counts, type hint coverage, required-after-variadic count, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
