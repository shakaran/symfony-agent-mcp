// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Type Coercion Risk Inspector
 *
 * Checks declare(strict_types=1) presence per file.
 * Detects: settype(), intval/floatval/strval, casts, == comparisons,
 * json_decode without JSON_THROW_ON_ERROR, settype on object property.
 *
 * Warns on: missing strict_types + == comparison, json_decode without null check,
 * settype by reference, (int) cast risks.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TypeCoercionFile {
  file: string;
  hasStrictTypes: boolean;
  coercions: string[];
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

function parseTypeCoercion(filePath: string, appPath: string): TypeCoercionFile | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasStrictTypes = /declare\s*\(\s*strict_types\s*=\s*1\s*\)/.test(content);

  const coercions: string[] = [];

  if (/\bsettype\s*\(/.test(content)) coercions.push('settype()');
  if (/\bintval\s*\(/.test(content)) coercions.push('intval()');
  if (/\bfloatval\s*\(/.test(content)) coercions.push('floatval()');
  if (/\bstrval\s*\(/.test(content)) coercions.push('strval()');
  if (/\(int\)\s*\$/.test(content)) coercions.push('(int) cast');
  if (/\(float\)\s*\$/.test(content)) coercions.push('(float) cast');
  if (/\(string\)\s*\$/.test(content)) coercions.push('(string) cast');
  if (/\bjson_decode\s*\(/.test(content)) coercions.push('json_decode()');
  // == comparison (loose)
  if (/[^=!<>]==[^=]/.test(content)) coercions.push('== loose comparison');

  if (coercions.length === 0) return null;

  const issues: string[] = [];
  const relFile = path.relative(appPath, filePath);

  if (!hasStrictTypes && /[^=!<>]==[^=]/.test(content)) {
    issues.push(`${relFile}: == loose comparison in file without strict_types — type coercion may cause unexpected equality`);
  }

  // json_decode result used without null check
  if (/\bjson_decode\s*\(/.test(content) && !content.includes('JSON_THROW_ON_ERROR')) {
    issues.push(`${relFile}: json_decode() without JSON_THROW_ON_ERROR — returns null on failure silently`);
  }

  // settype on variable
  if (/\bsettype\s*\(\s*&/.test(content) || /\bsettype\s*\(\s*\$/.test(content)) {
    issues.push(`${relFile}: settype() mutates variable by reference — consider explicit cast instead`);
  }

  // (int) cast risk on non-numeric
  if (/\(int\)\s*\$/.test(content)) {
    issues.push(`${relFile}: (int) cast silently returns 0 for non-numeric strings`);
  }

  return { file: relFile, hasStrictTypes, coercions, issues };
}

export function listPhpTypeCoercions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: TypeCoercionFile[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseTypeCoercion(file, appPath);
      if (r) results.push(r);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No type coercion patterns found in src/.' }] };
    }

    const withoutStrict = results.filter((r) => !r.hasStrictTypes).length;
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `PHP Type Coercion Risks\n${'='.repeat(55)}\n`;
    text += `\nFiles with coercions: ${results.length}  Without strict_types: ${withoutStrict}  Issues: ${totalIssues}\n`;

    for (const r of results.sort((a, b) => b.issues.length - a.issues.length || a.file.localeCompare(b.file))) {
      const strictTag = r.hasStrictTypes ? 'strict' : 'NO-strict_types';
      text += `\n  ${r.file}\n`;
      text += `    ${strictTag}  coercions: ${r.coercions.join(', ')}\n`;
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpTypeCoercionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: TypeCoercionFile[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseTypeCoercion(file, appPath);
        if (r) results.push(r);
      }
    }

    const coercionCounts: Record<string, number> = {};
    for (const r of results) {
      for (const c of r.coercions) {
        coercionCounts[c] = (coercionCounts[c] ?? 0) + 1;
      }
    }

    let text = `PHP Type Coercion Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with coercions:    ${results.length}\n`;
    text += `  Without strict_types:  ${results.filter((r) => !r.hasStrictTypes).length}\n`;
    text += `  With strict_types:     ${results.filter((r) => r.hasStrictTypes).length}\n`;
    text += `\nCoercion type counts:\n`;
    for (const [type, count] of Object.entries(coercionCounts).sort((a, b) => b[1] - a[1])) {
      text += `  ${type.padEnd(25)} ${count}\n`;
    }
    text += `\nWith issues:  ${results.filter((r) => r.issues.length > 0).length}\n`;
    text += `Total issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpTypeCoercionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_type_coercions',
      description: 'List PHP type coercion risks: files missing strict_types, settype/intval/floatval/strval usage, loose == comparisons, json_decode without JSON_THROW_ON_ERROR, (int) cast risks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_type_coercion_stats',
      description: 'Statistics for PHP type coercions: files without strict_types, coercion type counts, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
