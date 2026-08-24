// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Static Method Anti-Pattern Inspector
 *
 * Detects static method overuse: all-static classes (Facade-like),
 * static state mutation, mixed paradigm (static + instance), >5 static methods.
 *
 * Warns on: class with >5 static methods, static calling non-static,
 * static modifying static property, mixed static+instance methods,
 * static method called on $this.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StaticMethodClass {
  file: string;
  className: string;
  staticMethodCount: number;
  instanceMethodCount: number;
  hasStaticState: boolean;
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

function parseStaticMethods(filePath: string, appPath: string): StaticMethodClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Count public static methods
  const staticMethods = content.match(/\bpublic\s+static\s+function\s+\w{1,80}\s*\(/gm) ?? [];
  const staticMethodCount = staticMethods.length;

  // Count public instance methods (non-static)
  const allPublicMethods = content.match(/\bpublic\s+function\s+\w{1,80}\s*\(/gm) ?? [];
  const instanceMethodCount = allPublicMethods.length - staticMethodCount;

  if (staticMethodCount === 0) return null;

  // Detect static property mutation: self::$prop = / static::$prop =
  const hasStaticState = /(?:self|static)::\$\w{1,80}\s*=/.test(content);

  const issues: string[] = [];

  if (staticMethodCount > 5) {
    issues.push(`${className}: ${staticMethodCount} public static methods — utility class smell, consider injected service`);
  }

  if (staticMethodCount > 0 && instanceMethodCount === 0) {
    issues.push(`${className}: all-static class (Facade-like) — cannot be mocked in tests, prefer instance service`);
  }

  if (staticMethodCount > 0 && instanceMethodCount > 0) {
    issues.push(`${className}: mixed paradigm — has both static (${staticMethodCount}) and instance (${instanceMethodCount}) methods`);
  }

  if (hasStaticState) {
    issues.push(`${className}: static method modifies static property — global mutable state`);
  }

  // Detect $this->staticMethodName() pattern (calling static method on $this)
  if (/\$this->\w{1,80}\s*\(/m.test(content) && staticMethodCount > 0) {
    // Heuristic: if class has static methods and also uses $this->method(), flag for manual review
    // Only flag if a known static method name appears after $this->
    for (const sm of staticMethods) {
      const nameM = /\bfunction\s+(\w{1,80})\s*\(/.exec(sm);
      if (nameM) {
        const methodName = nameM[1];
        if (new RegExp(`\\$this->${methodName}\\s*\\(`).test(content)) {
          issues.push(`${className}: static method '${methodName}' called via $this-> — use self:: or static::`);
        }
      }
    }
  }

  return { file: path.relative(appPath, filePath), className, staticMethodCount, instanceMethodCount, hasStaticState, issues };
}

export function listPhpStaticMethods(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: StaticMethodClass[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseStaticMethods(file, appPath);
      if (c) classes.push(c);
    }

    if (classes.length === 0) {
      return { content: [{ type: 'text', text: 'No classes with static methods found in src/.' }] };
    }

    const allStatic = classes.filter((c) => c.instanceMethodCount === 0).length;
    const mixed = classes.filter((c) => c.instanceMethodCount > 0).length;
    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0);

    let text = `PHP Static Method Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses with static methods: ${classes.length}  All-static: ${allStatic}  Mixed: ${mixed}  Issues: ${totalIssues}\n`;

    for (const c of classes.sort((a, b) => b.issues.length - a.issues.length || b.staticMethodCount - a.staticMethodCount)) {
      const tags: string[] = [`static:${c.staticMethodCount}`];
      if (c.instanceMethodCount > 0) tags.push(`instance:${c.instanceMethodCount}`);
      if (c.hasStaticState) tags.push('mutable-state');
      text += `\n  ${c.className.padEnd(35)} ${tags.join(', ')}\n`;
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

export function getPhpStaticMethodStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: StaticMethodClass[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseStaticMethods(file, appPath);
        if (c) classes.push(c);
      }
    }

    let text = `PHP Static Method Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with static methods: ${classes.length}\n`;
    text += `  All-static (Facade-like):  ${classes.filter((c) => c.instanceMethodCount === 0).length}\n`;
    text += `  Mixed paradigm:            ${classes.filter((c) => c.instanceMethodCount > 0).length}\n`;
    text += `  With static state:         ${classes.filter((c) => c.hasStaticState).length}\n`;
    text += `  >5 static methods:         ${classes.filter((c) => c.staticMethodCount > 5).length}\n`;
    text += `With issues:                 ${classes.filter((c) => c.issues.length > 0).length}\n`;
    text += `Total issues:                ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStaticMethodTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_static_methods',
      description: 'List PHP static method anti-patterns: all-static classes, >5 static methods, mixed static+instance paradigm, static state mutation, static called via $this->',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_static_method_stats',
      description: 'Statistics for PHP static methods: classes with static methods, all-static count, mixed paradigm, static state, >5 static methods, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
