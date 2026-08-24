// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Named Constructor (Static Factory Method) Inspector
 *
 * Detects named constructor patterns: public static function create/from/of/build/make
 * returning new static()/self()/ClassName().
 *
 * Warns on: missing return type hint, direct parent::__construct call,
 * too many named constructors (>5), non-final class without @psalm-consistent-constructor.
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

interface NamedConstructorClass {
  file: string;
  className: string;
  factoryMethods: string[];
  issues: string[];
}

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

function parseNamedConstructors(filePath: string, appPath: string): NamedConstructorClass | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Match: public static function create|from|of|build|make... (any suffix)
  const factoryRegex = /public\s+static\s+function\s+((?:create|from|of|build|make)\w{0,60})\s*\(/gm;
  const factoryMethods: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = factoryRegex.exec(content)) !== null) {
    // Verify method body contains new static|self|ClassName
    const methodName = fm[1];
    // Find method body start (opening brace after signature)
    const sigEnd = fm.index + fm[0].length;
    const bodyChunk = content.slice(sigEnd, sigEnd + 800);
    if (/\bnew\s+(?:static|self|\w{1,80})\s*\(/.test(bodyChunk)) {
      factoryMethods.push(methodName);
    }
  }

  if (factoryMethods.length === 0) return null;

  const isFinal = /\bfinal\s+class\b/m.test(content);
  const hasPsalmConsistent = content.includes('@psalm-consistent-constructor');

  const issues: string[] = [];

  // Check return type hint for each factory method
  for (const method of factoryMethods) {
    // Look for: public static function methodName(...): ReturnType
    const retTypeRegex = new RegExp(
      `public\\s+static\\s+function\\s+${method}\\s*\\([^)]{0,400}\\)\\s*:\\s*(\\S{1,80})`,
      'm'
    );
    const retM = retTypeRegex.exec(content);
    if (!retM) {
      issues.push(`${className}::${method}() missing return type hint (should be static or self)`);
    }

    // Check for parent::__construct in method body
    const parentCallRegex = new RegExp(
      `function\\s+${method}\\s*\\([^)]{0,400}\\)[^{]{0,100}\\{[^}]{0,1000}parent::__construct`,
      'm'
    );
    if (parentCallRegex.test(content)) {
      issues.push(`${className}::${method}() calls parent::__construct directly — use new static() instead`);
    }
  }

  if (factoryMethods.length > 5) {
    issues.push(`${className} has ${factoryMethods.length} named constructors (>5) — consider consolidating`);
  }

  if (!isFinal && !hasPsalmConsistent) {
    issues.push(`${className} is not final and lacks @psalm-consistent-constructor — subclasses may return wrong type`);
  }

  return { file: path.relative(appPath, filePath), className, factoryMethods, issues };
}

export function listPhpNamedConstructors(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: NamedConstructorClass[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const nc = parseNamedConstructors(file, appPath);
      if (nc) classes.push(nc);
    }

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No named constructors found in src/.\n\nExample:\n  final class Money\n  {\n    private function __construct(private int $amount) {}\n    public static function of(int $amount): static { return new static($amount); }\n  }',
        }],
      };
    }

    const totalMethods = classes.reduce((s, c) => s + c.factoryMethods.length, 0);
    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0);

    let text = `PHP Named Constructors\n${'='.repeat(55)}\n`;
    text += `\nClasses: ${classes.length}  Factory methods: ${totalMethods}  Issues: ${totalIssues}\n`;

    for (const c of classes.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      text += `\n  ${c.className.padEnd(35)} methods: ${c.factoryMethods.join(', ')}\n`;
      text += `    ${c.file}\n`;
      for (const issue of c.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpNamedConstructorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: NamedConstructorClass[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const nc = parseNamedConstructors(file, appPath);
        if (nc) classes.push(nc);
      }
    }

    let text = `PHP Named Constructor Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:   ${classes.length}\n`;
    text += `Factory methods: ${classes.reduce((s, c) => s + c.factoryMethods.length, 0)}\n`;
    text += `With issues:     ${classes.filter((c) => c.issues.length > 0).length}\n`;
    text += `Total issues:    ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpNamedConstructorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_named_constructors',
      description: 'List PHP named constructor (static factory method) patterns: create/from/of/build/make methods, missing return type hints, parent::__construct usage, too many constructors, non-final without psalm annotation',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_named_constructor_stats',
      description: 'Statistics for PHP named constructors: total classes, total factory methods, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
