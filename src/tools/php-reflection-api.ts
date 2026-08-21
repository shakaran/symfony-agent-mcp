/**
 * PHP Reflection API Usage Inspector
 *
 * Detects ReflectionClass, ReflectionMethod, ReflectionProperty,
 * ReflectionFunction, ReflectionParameter usage.
 *
 * Warns on: use in non-test code (performance), newInstanceWithoutConstructor,
 * setAccessible(true) without restore, use inside loops.
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

interface ReflectionUsage {
  file: string;
  className: string;
  reflectionTypes: string[];
  isInLoop: boolean;
  isTestFile: boolean;
  issues: string[];
}

const REFLECTION_TYPES = [
  'ReflectionClass',
  'ReflectionMethod',
  'ReflectionProperty',
  'ReflectionFunction',
  'ReflectionParameter',
  'ReflectionNamedType',
  'ReflectionExtension',
];

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseReflectionUsage(filePath: string, appPath: string): ReflectionUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const foundTypes: string[] = [];
  for (const t of REFLECTION_TYPES) {
    if (content.includes(t)) foundTypes.push(t);
  }
  if (foundTypes.length === 0) return null;

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  const isTestFile = filePath.includes('/test') || filePath.includes('/Test')
    || filePath.includes('/spec') || className.endsWith('Test');

  // Check if reflection is used inside a loop (foreach, for, while)
  const isInLoop = ((): boolean => {
    // Look for reflection inside a foreach/for/while block
    // Simple heuristic: reflection type appears within 10 lines of a loop keyword
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\b(foreach|for|while)\s*\(/.test(line)) {
        // Check next 15 lines for reflection usage
        const lookahead = lines.slice(i + 1, i + 16).join('\n');
        if (REFLECTION_TYPES.some((t) => lookahead.includes(t))) return true;
      }
    }
    return false;
  })();

  const issues: string[] = [];

  if (!isTestFile) {
    issues.push(`${className}: Reflection API used in non-test code — performance impact on hot paths`);
  }

  if (content.includes('newInstanceWithoutConstructor')) {
    issues.push(`${className}: ReflectionClass::newInstanceWithoutConstructor() bypasses initialization`);
  }

  if (content.includes('setAccessible(true)') && !content.includes('setAccessible(false)')) {
    issues.push(`${className}: ReflectionProperty::setAccessible(true) without restoring to false — breaks encapsulation`);
  }

  if (isInLoop) {
    issues.push(`${className}: Reflection API used inside loop — cache ReflectionClass instances outside the loop`);
  }

  if (content.includes('ReflectionClass::export')) {
    issues.push(`${className}: ReflectionClass::export() is deprecated since PHP 7.4`);
  }

  return { file: path.relative(appPath, filePath), className, reflectionTypes: foundTypes, isInLoop, isTestFile, issues };
}

export function listPhpReflectionApi(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const testDirs: string[] = [];
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) testDirs.push(p);
    }

    const allDirs: string[] = [];
    if (fs.existsSync(srcDir)) allDirs.push(srcDir);
    allDirs.push(...testDirs);

    if (allDirs.length === 0) {
      return { content: [{ type: 'text', text: 'No src/ or test/ directory found.' }] };
    }

    const usages: ReflectionUsage[] = [];
    for (const dir of allDirs) {
      for (const file of getAllPhpFiles(dir)) {
        const u = parseReflectionUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    if (usages.length === 0) {
      return { content: [{ type: 'text', text: 'No Reflection API usage found.' }] };
    }

    const nonTest = usages.filter((u) => !u.isTestFile).length;
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `PHP Reflection API Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles with Reflection: ${usages.length}  Non-test: ${nonTest}  Issues: ${totalIssues}\n`;

    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      const tags: string[] = [];
      if (u.isTestFile) tags.push('test');
      if (u.isInLoop) tags.push('in-loop');
      text += `\n  ${u.className.padEnd(35)} ${tags.join(', ')}\n`;
      text += `    types: ${u.reflectionTypes.join(', ')}\n`;
      text += `    ${u.file}\n`;
      for (const issue of u.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpReflectionApiStats(appPath: string): McpToolResult {
  try {
    const allDirs: string[] = [];
    const srcDir = path.join(appPath, 'src');
    if (fs.existsSync(srcDir)) allDirs.push(srcDir);
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) allDirs.push(p);
    }

    const usages: ReflectionUsage[] = [];
    for (const dir of allDirs) {
      for (const file of getAllPhpFiles(dir)) {
        const u = parseReflectionUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `PHP Reflection API Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with Reflection:  ${usages.length}\n`;
    text += `  Non-test files:       ${usages.filter((u) => !u.isTestFile).length}\n`;
    text += `  Test files:           ${usages.filter((u) => u.isTestFile).length}\n`;
    text += `  In loop:              ${usages.filter((u) => u.isInLoop).length}\n`;
    text += `Total issues:           ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpReflectionApiTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_reflection_api',
      description: 'List PHP Reflection API usage: ReflectionClass/Method/Property/Function/Parameter, non-test usage warning, newInstanceWithoutConstructor, setAccessible without restore, usage inside loops',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_reflection_api_stats',
      description: 'Statistics for PHP Reflection API usage: files with reflection, non-test files, in-loop usage, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
