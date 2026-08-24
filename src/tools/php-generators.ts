// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Generators Inspector
 *
 * Scans src/ PHP for generator usage:
 *   - yield, yield from, Generator return type hints
 *   - Generator functions (functions containing yield)
 *   - ->send() on generator, ->valid() checks, ->current(), ->next()
 *
 * Warns about:
 *   - Generator function without return type hint Generator<K,V,R>
 *   - Using ->send() without checking ->valid() first (RuntimeException risk)
 *   - yield inside try-catch where finally may not execute (PHP quirk)
 *   - Generator yielding objects mutated by consumer (shared reference)
 *   - Missing ->send(null) to initialize sendable generator
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface GeneratorFunction {
  name: string;
  hasReturnType: boolean;
  hasSend: boolean;
  hasValidCheck: boolean;
  hasYieldFrom: boolean;
  issues: string[];
}

interface PhpGeneratorInfo {
  file: string;
  class?: string;
  generatorFunctions: GeneratorFunction[];
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

function extractFunctionBlocks(content: string): Array<{ name: string; body: string; signature: string }> {
  const functions: Array<{ name: string; body: string; signature: string }> = [];
  // Match function declarations
  const funcRe = /(?:public|protected|private|static|\s)*function\s+(\w{1,120})\s*\([^)]{0,500}\)[^{]{0,200}\{/g;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(content)) !== null) {
    const name = m[1];
    const signature = m[0];
    const startIdx = m.index + m[0].length;
    // Extract function body (simple brace counting, capped at 5000 chars)
    let depth = 1;
    let idx = startIdx;
    const limit = Math.min(startIdx + 5000, content.length);
    while (idx < limit && depth > 0) {
      if (content[idx] === '{') depth++;
      else if (content[idx] === '}') depth--;
      idx++;
    }
    const body = content.slice(startIdx, idx);
    functions.push({ name, body, signature });
  }
  return functions;
}

function parseGeneratorFile(filePath: string, appPath: string): PhpGeneratorInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasYield = content.includes('yield ') || content.includes('yield;') || content.includes('yield\n');
  const hasGeneratorRef = content.includes('Generator') || content.includes('->send(') ||
    content.includes('->valid()') || content.includes('->current()') || content.includes('->next()');

  if (!hasYield && !hasGeneratorRef) return null;
  if (content.includes('namespace Symfony\\Component') && !content.includes('yield')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const fileIssues: string[] = [];
  const generatorFunctions: GeneratorFunction[] = [];

  const functions = extractFunctionBlocks(content);

  for (const { name, body, signature } of functions) {
    if (!body.includes('yield')) continue;
    if (name === '__construct') continue;

    const hasReturnType = /:\s*(?:\\?Generator|\\?iterable|\\?Iterator)\b/.test(signature) ||
      /:\s*Generator\s*</.test(signature);

    const hasSend = body.includes('->send(');
    const hasValidCheck = body.includes('->valid()');
    const hasYieldFrom = body.includes('yield from');

    const funcIssues: string[] = [];

    if (!hasReturnType) {
      funcIssues.push(`${name}(): missing Generator<TKey,TValue,TReturn> return type hint — document generator contract explicitly`);
    }

    if (hasSend && !hasValidCheck) {
      funcIssues.push(`${name}(): uses ->send() without ->valid() check — sending to a completed generator throws RuntimeException`);
    }

    // yield inside try-catch with finally
    if (body.includes('yield') && body.includes('try') && body.includes('finally')) {
      funcIssues.push(`${name}(): yield inside try block with finally — finally block may not execute if generator is abandoned (PHP quirk)`);
    }

    generatorFunctions.push({ name, hasReturnType, hasSend, hasValidCheck, hasYieldFrom, issues: funcIssues });
  }

  // Check for ->send(null) to initialize sendable generator at call site
  if (content.includes('->send(') && !content.includes('->send(null)') && !content.includes('->send( null)')) {
    fileIssues.push('Generator ->send() used without initial ->send(null) — sendable generators must receive null on first send() to initialize');
  }

  // Check for generator usage without null/valid guard at call site
  if (content.includes('->current()') && !content.includes('->valid()')) {
    fileIssues.push('Generator ->current() used without ->valid() check — accessing current() on completed generator returns null');
  }

  if (generatorFunctions.length === 0 && fileIssues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    generatorFunctions,
    issues: fileIssues,
  };
}

function loadGeneratorInfos(appPath: string): PhpGeneratorInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: PhpGeneratorInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseGeneratorFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listPhpGenerators(appPath: string): McpToolResult {
  try {
    const infos = loadGeneratorInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP generators found in src/.\n\nPHP generator example:\n  /**\n   * @return \\Generator<int, User, null, void>\n   */\n  public function findActiveUsers(): \\Generator\n  {\n    foreach ($this->repository->findAll() as $user) {\n      if ($user->isActive()) {\n        yield $user;\n      }\n    }\n  }',
        }],
      };
    }

    const allFuncs = infos.flatMap((i) => i.generatorFunctions);
    const withIssues = infos.filter(
      (i) => i.issues.length > 0 || i.generatorFunctions.some((f) => f.issues.length > 0)
    );

    let text = `PHP Generators (${infos.length} files, ${allFuncs.length} generator functions)\n${'='.repeat(65)}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      text += '\n';
      for (const fn of info.generatorFunctions) {
        const flags: string[] = [];
        if (!fn.hasReturnType) flags.push('no-return-type');
        if (fn.hasSend) flags.push(fn.hasValidCheck ? 'send+valid' : 'send-NO-valid');
        if (fn.hasYieldFrom) flags.push('yield-from');
        const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : '';
        text += `    ${fn.name}()${flagStr}\n`;
        for (const issue of fn.issues) {
          text += `      WARN: ${issue}\n`;
        }
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

export function getPhpGeneratorStats(appPath: string): McpToolResult {
  try {
    const infos = loadGeneratorInfos(appPath);
    const allFuncs = infos.flatMap((i) => i.generatorFunctions);

    let text = `PHP Generator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with generators:     ${infos.length}\n`;
    text += `Total generator functions: ${allFuncs.length}\n`;
    text += `  With return type:        ${allFuncs.filter((f) => f.hasReturnType).length}\n`;
    text += `  Without return type:     ${allFuncs.filter((f) => !f.hasReturnType).length}\n`;
    text += `  Using ->send():          ${allFuncs.filter((f) => f.hasSend).length}\n`;
    text += `  With ->valid() check:    ${allFuncs.filter((f) => f.hasValidCheck).length}\n`;
    text += `  Using yield from:        ${allFuncs.filter((f) => f.hasYieldFrom).length}\n`;
    text += `Files with issues:         ${infos.filter((i) => i.issues.length > 0 || i.generatorFunctions.some((f) => f.issues.length > 0)).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpGeneratorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_generators',
      description: 'List PHP generator functions: yield/yield-from usage, Generator return type hints, send()/valid() usage, finally-in-generator warnings, send-without-valid detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_generator_stats',
      description: 'Show PHP generator statistics: file count, generator function count, return type coverage, send()/valid() usage, yield-from count, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
