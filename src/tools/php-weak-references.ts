// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Weak References Inspector
 *
 * Scans src/ PHP for:
 *   - WeakReference::create(), ->get() on WeakReference
 *   - WeakMap usage, new WeakMap()
 *
 * Detects:
 *   - WeakReference->get() without null check (object may have been GC'd)
 *   - WeakMap used as identity map
 *
 * Warns about:
 *   - WeakReference->get() result used directly without null check (null dereference)
 *   - WeakMap key not an object (TypeError)
 *   - Using SplObjectStorage when WeakMap would prevent memory leak
 *   - WeakReference stored in static property (defeats the purpose)
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

interface WeakReferenceInfo {
  file: string;
  weakRefCount: number;
  weakMapCount: number;
  hasNullCheck: boolean;
  usagesWithoutNullCheck: number;
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

function parseWeakReferenceFile(filePath: string, appPath: string): WeakReferenceInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const hasWeakRef = content.includes('WeakReference') || content.includes('WeakMap');
  if (!hasWeakRef) return null;

  // Count WeakReference::create() calls
  let weakRefCount = 0;
  const createRe = /WeakReference::create\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(content)) !== null) {
    weakRefCount++;
    void m;
  }

  // Count WeakMap usages
  let weakMapCount = 0;
  const wmRe = /new\s+WeakMap\s*\(\s*\)/g;
  while ((m = wmRe.exec(content)) !== null) {
    weakMapCount++;
    void m;
  }
  // Also count WeakMap type hints / declarations
  if (content.includes('WeakMap') && weakMapCount === 0) {
    weakMapCount = (content.match(/\bWeakMap\b/g) ?? []).length > 0 ? 1 : 0;
  }

  const issues: string[] = [];

  // Detect ->get() usage on WeakReference and check for null checks
  let usagesWithoutNullCheck = 0;
  let hasNullCheck = false;

  const getCallRe = /(\$\w{1,80})\s*->\s*get\s*\(\s*\)/g;
  while ((m = getCallRe.exec(content)) !== null) {
    const varName = m[1];
    const idx = m.index;
    // Look at surrounding context (300 chars before and after)
    const before = content.slice(Math.max(0, idx - 300), idx);
    const after = content.slice(idx, Math.min(content.length, idx + 300));

    // Check if this variable is associated with WeakReference
    const isWeakRef = before.includes('WeakReference') || before.includes(`${varName} = `);
    if (!isWeakRef) continue;

    const contextSnippet = before.slice(-200) + after;
    const hasCheck = contextSnippet.includes('=== null') || contextSnippet.includes('!== null') ||
      contextSnippet.includes('?? ') || contextSnippet.includes('is_null(') ||
      contextSnippet.includes('null !==') || contextSnippet.includes('null ===') ||
      /if\s*\([^)]{0,100}get\s*\(\s*\)/.test(contextSnippet);

    if (hasCheck) {
      hasNullCheck = true;
    } else {
      usagesWithoutNullCheck++;
    }
  }

  if (usagesWithoutNullCheck > 0) {
    issues.push(`${usagesWithoutNullCheck} WeakReference->get() call(s) without null check — object may have been garbage collected`);
  }

  // Check for WeakMap with non-object keys (scalar key assignment)
  if (weakMapCount > 0) {
    // Look for patterns like $weakMap['key'] or $weakMap[0] — scalar keys
    const wmVarRe = /(\$\w{1,80})\s*=\s*new\s+WeakMap\s*\(\s*\)/g;
    const wmVars: string[] = [];
    let wmVm: RegExpExecArray | null;
    while ((wmVm = wmVarRe.exec(content)) !== null) {
      wmVars.push(wmVm[1]);
    }
    for (const wmVar of wmVars) {
      if (new RegExp(`\\${wmVar}\\s*\\[\\s*(?:['"\\d])`).test(content)) {
        issues.push(`WeakMap ${wmVar} may be accessed with scalar key — WeakMap keys must be objects (PHP TypeError)`);
      }
    }
  }

  // Check for SplObjectStorage that could be WeakMap
  if (content.includes('SplObjectStorage') && !content.includes('WeakMap')) {
    issues.push('SplObjectStorage used — if storing temporary object associations, WeakMap prevents memory leaks (objects GC\'d automatically)');
  }

  // Check WeakReference in static property
  if (content.includes('static') && content.includes('WeakReference')) {
    const staticWeakRe = /static\s+(?:\??\w{1,80}\s+)?\$\w{0,80}\s*=\s*(?:null|WeakReference)/g;
    if (staticWeakRe.test(content)) {
      issues.push('WeakReference stored in static property — static properties prevent garbage collection, defeating WeakReference purpose');
    }
  }

  if (weakRefCount === 0 && weakMapCount === 0 && issues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    weakRefCount,
    weakMapCount,
    hasNullCheck,
    usagesWithoutNullCheck,
    issues,
  };
}

function loadWeakReferenceInfos(appPath: string): WeakReferenceInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: WeakReferenceInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseWeakReferenceFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listPhpWeakReferences(appPath: string): McpToolResult {
  try {
    const infos = loadWeakReferenceInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No WeakReference or WeakMap usage found in src/.\n\nPHP WeakReference example:\n  $ref = WeakReference::create($object);\n  // Later:\n  $obj = $ref->get();\n  if ($obj === null) {\n    // Object was garbage collected\n  }\n\nPHP WeakMap example:\n  $map = new WeakMap();\n  $map[$object] = $computedValue; // auto-removed when $object is GC\'d',
        }],
      };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);

    let text = `PHP Weak References & WeakMap (${infos.length} files)\n${'='.repeat(60)}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}\n`;
      text += `    WeakReference::create: ${info.weakRefCount}  WeakMap: ${info.weakMapCount}\n`;
      if (info.usagesWithoutNullCheck > 0) {
        text += `    ->get() without null check: ${info.usagesWithoutNullCheck}\n`;
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

export function getPhpWeakReferenceStats(appPath: string): McpToolResult {
  try {
    const infos = loadWeakReferenceInfos(appPath);

    let text = `PHP Weak Reference Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using WeakRef/WeakMap:   ${infos.length}\n`;
    text += `Total WeakReference::create:   ${infos.reduce((s, i) => s + i.weakRefCount, 0)}\n`;
    text += `Total WeakMap instances:       ${infos.reduce((s, i) => s + i.weakMapCount, 0)}\n`;
    text += `->get() without null check:    ${infos.reduce((s, i) => s + i.usagesWithoutNullCheck, 0)}\n`;
    text += `Files with issues:             ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpWeakReferenceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_weak_references',
      description: 'List PHP WeakReference and WeakMap usage: WeakReference::create(), ->get() null check detection, WeakMap instantiation, scalar key warning, SplObjectStorage-to-WeakMap migration hint, static property warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_weak_reference_stats',
      description: 'Show PHP weak reference statistics: file count, WeakReference::create count, WeakMap count, ->get() without null check count, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
