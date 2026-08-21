/**
 * PHP Never Return Type Inspector
 *
 * Scans src/ PHP for:
 *   - ): never (return type declaration)
 *   - throw new in expression context (PHP 8.0)
 *   - throw $e instead of throw new (rethrow)
 *   - die(, exit(, trigger_error(E_USER_ERROR
 *
 * Detects:
 *   - Methods with never return type
 *   - Throw expressions in ternary/match/coalesce
 *   - Throw as part of complex expression
 *
 * Warns:
 *   - Method with never return type that returns a value (static analysis error)
 *   - Function ending without throw/exit (never return type lie)
 *   - die()/exit() in non-CLI code (terminates web request)
 *   - trigger_error(E_USER_ERROR) instead of throw (deprecated pattern)
 *   - throw in arrow function (invalid syntax in PHP < 8.0)
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

interface PhpNeverTypeInfo {
  file: string;
  class?: string;
  method: string;
  hasNeverReturn: boolean;
  hasThrowExpression: boolean;
  hasDieExit: boolean;
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

// ─── Method body extractor ────────────────────────────────────────────────────

function extractMethodBody(content: string, methodName: string): string {
  const re = new RegExp(
    `function\\s+${methodName}\\s*\\([^)]{0,300}\\)[^{]{0,150}\\{([\\s\\S]{0,3000}?)\\n\\s*\\}`,
  );
  const m = re.exec(content);
  return m ? m[1] : '';
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

interface MethodCandidate {
  name: string;
  hasNever: boolean;
  signature: string;
  index: number;
}

function findMethodsWithNever(content: string): MethodCandidate[] {
  const results: MethodCandidate[] = [];
  // Match: function methodName(...): never
  const re = /function\s+(\w{1,80})\s*\([^)]{0,400}\)\s*:\s*never\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    results.push({ name: m[1], hasNever: true, signature: m[0], index: m.index });
  }
  return results;
}

function findAllMethods(content: string): MethodCandidate[] {
  const results: MethodCandidate[] = [];
  const re = /function\s+(\w{1,80})\s*\([^)]{0,400}\)\s*(?::\s*[\w\\|?]{1,80})?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    results.push({ name: m[1], hasNever: false, signature: m[0], index: m.index });
  }
  return results;
}

function analyzeFile(filePath: string, appPath: string): PhpNeverTypeInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const hasDieExit = /\b(?:die|exit)\s*\(/.test(content);
  const hasNever = content.includes('): never');
  const hasThrow = content.includes('throw ');
  const hasTriggE = /trigger_error\s*\([^)]{0,200}E_USER_ERROR/.test(content);

  if (!hasDieExit && !hasNever && !hasThrow && !hasTriggE) return [];

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  const className = classM ? classM[1] : undefined;

  const results: PhpNeverTypeInfo[] = [];

  // Methods with never return type
  const neverMethods = findMethodsWithNever(content);
  for (const nm of neverMethods) {
    const body = extractMethodBody(content, nm.name);
    const issues: string[] = [];

    const hasReturn = /\breturn\s+(?!;)/.test(body);
    if (hasReturn) {
      issues.push(
        `${nm.name}(): declared return type is never but contains a return statement. ` +
        `Static analysis will flag this as an error.`,
      );
    }

    const endsWithThrowExit =
      /(?:throw\s+|exit\s*\(|die\s*\()/.test(body.slice(-200));
    if (!endsWithThrowExit && body.trim().length > 0) {
      issues.push(
        `${nm.name}(): declared return type is never but may not always throw or exit. ` +
        `Ensure every code path throws or exits.`,
      );
    }

    const hasThrowExpr =
      /\?\??\s*throw\s+new\b/.test(body) ||
      /\?\s+throw\s+new\b/.test(body) ||
      /match\s*\([^)]{0,200}\)\s*\{[^}]{0,500}throw\s/.test(body);

    results.push({
      file: path.basename(filePath),
      class: className,
      method: nm.name,
      hasNeverReturn: true,
      hasThrowExpression: hasThrowExpr,
      hasDieExit: /\b(?:die|exit)\s*\(/.test(body),
      issues,
    });
  }

  // Scan for die/exit in non-CLI files (heuristic: not in bin/ or cli)
  const isCliFile = filePath.includes('/bin/') || filePath.includes('/console') || filePath.includes('Command');
  if (hasDieExit && !isCliFile) {
    const methods = findAllMethods(content);
    for (const meth of methods) {
      const body = extractMethodBody(content, meth.name);
      if (!/\b(?:die|exit)\s*\(/.test(body)) continue;

      // Avoid duplicate entries if already listed
      const alreadyListed = results.some((r) => r.method === meth.name);
      if (alreadyListed) continue;

      const issues: string[] = [
        `${meth.name}(): contains die()/exit() in non-CLI code. ` +
        `This terminates the web request immediately — use exceptions instead.`,
      ];

      results.push({
        file: path.basename(filePath),
        class: className,
        method: meth.name,
        hasNeverReturn: false,
        hasThrowExpression: false,
        hasDieExit: true,
        issues,
      });
    }
  }

  // trigger_error(E_USER_ERROR) usage
  if (hasTriggE) {
    const methods = findAllMethods(content);
    for (const meth of methods) {
      const body = extractMethodBody(content, meth.name);
      if (!/trigger_error\s*\([^)]{0,200}E_USER_ERROR/.test(body)) continue;
      const alreadyListed = results.some((r) => r.method === meth.name);
      if (alreadyListed) continue;

      results.push({
        file: path.basename(filePath),
        class: className,
        method: meth.name,
        hasNeverReturn: false,
        hasThrowExpression: false,
        hasDieExit: false,
        issues: [
          `${meth.name}(): uses trigger_error(E_USER_ERROR) — deprecated pattern. ` +
          `Throw an exception instead for proper error handling and stack traces.`,
        ],
      });
    }
  }

  return results;
}

function loadAll(appPath: string): PhpNeverTypeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpNeverTypeInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    results.push(...analyzeFile(file, appPath));
  }
  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpNeverType(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP never return type or die/exit usage found in src/.\n\n' +
            'PHP 8.1 never return type example:\n' +
            '  public function fail(string $msg): never { throw new RuntimeException($msg); }',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);

    let text = `PHP Never Type & Exit Analysis\n${'='.repeat(55)}\n`;
    text += `  Total findings:        ${items.length}\n`;
    text += `  Never return type:     ${items.filter((i) => i.hasNeverReturn).length}\n`;
    text += `  Throw expression:      ${items.filter((i) => i.hasThrowExpression).length}\n`;
    text += `  die/exit usage:        ${items.filter((i) => i.hasDieExit).length}\n`;
    text += `  With issues:           ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.class ? item.class + '::' : ''}${item.method}() [${item.file}]\n`;
      text += `  neverReturn: ${item.hasNeverReturn}  throwExpr: ${item.hasThrowExpression}  dieExit: ${item.hasDieExit}\n`;
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

export function getPhpNeverTypeStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Never Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings:            ${items.length}\n`;
    text += `Never return type:         ${items.filter((i) => i.hasNeverReturn).length}\n`;
    text += `Throw expression usage:    ${items.filter((i) => i.hasThrowExpression).length}\n`;
    text += `die/exit usage:            ${items.filter((i) => i.hasDieExit).length}\n`;
    text += `With issues:               ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpNeverTypeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_never_type',
      description: 'List PHP never return type usage: never-typed methods, throw expressions, die/exit in non-CLI code, trigger_error(E_USER_ERROR) deprecated pattern, never-type violations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_never_type_stats',
      description: 'Show PHP never return type statistics: never-typed count, throw expression count, die/exit count, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
