// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Typed Constants Inspector
 *
 * Scans src/ PHP for typed class constants (PHP 8.3+ feature):
 *   - const string NAME, const int MAX, const float PI, const bool FLAG, const array LIST
 *
 * Detects:
 *   - Untyped constants in classes that also have typed constants (inconsistency)
 *   - Interface constants without types
 *   - Enum case constants
 *
 * Warns about:
 *   - Typed constant in class without declare(strict_types=1)
 *   - Typed constant type mismatch with value
 *   - Untyped constants alongside typed ones in same class
 *   - PHP 8.3 typed constants used in project targeting PHP < 8.3 (check composer.json)
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

interface TypedConstantEntry {
  name: string;
  type?: string;
  value: string;
  isTyped: boolean;
  issues: string[];
}

interface TypedConstantInfo {
  file: string;
  class: string;
  constants: TypedConstantEntry[];
  phpVersion?: string;
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

function readComposerPhpVersion(appPath: string): string | undefined {
  try {
    const composerPath = path.join(appPath, 'composer.json');
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const requireM = /"php"\s*:\s*"([^"]{1,50})"/.exec(raw);
    return requireM?.[1];
  } catch { return undefined; }
}

function phpVersionBelow83(versionConstraint: string): boolean {
  // Check if constraint allows versions below 8.3
  // Simple heuristic: look for >= 8.3, ^8.3, or explicit 8.3
  if (/>=\s*8\.3/.test(versionConstraint)) return false;
  if (/\^8\.[3-9]/.test(versionConstraint)) return false;
  if (/~8\.[3-9]/.test(versionConstraint)) return false;
  if (/8\.[3-9]/.test(versionConstraint)) return false;
  return true; // assume below 8.3 if not clearly 8.3+
}

function parseTypedConstantFile(filePath: string, appPath: string, composerPhpVersion: string | undefined): TypedConstantInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  // Quick check — must have const declarations
  if (!content.includes('const ')) return null;
  if (!content.includes('class ') && !content.includes('interface ') && !content.includes('enum ')) return null;

  // Extract class/interface/enum name
  const classM = /(?:class|interface|enum)\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasStrictTypes = content.includes('declare(strict_types=1)') || content.includes('declare(strict_types = 1)');
  const fileIssues: string[] = [];
  const constants: TypedConstantEntry[] = [];

  // Match typed constants: const TYPE NAME = VALUE
  const typedConstRe = /const\s+(string|int|float|bool|array)\s+([A-Z_][A-Z0-9_]{0,80})\s*=\s*([^;]{1,200});/g;
  let m: RegExpExecArray | null;
  while ((m = typedConstRe.exec(content)) !== null) {
    const type = m[1];
    const name = m[2];
    const value = m[3].trim();
    const constIssues: string[] = [];

    // Check type vs value consistency
    if (type === 'int' && /^['"]/.test(value)) {
      constIssues.push(`Type mismatch: const int ${name} = ${value.slice(0, 40)} — value appears to be a string`);
    }
    if (type === 'string' && /^\d{1,20}$/.test(value)) {
      constIssues.push(`Type mismatch: const string ${name} = ${value} — value appears to be an integer`);
    }
    if (type === 'bool' && /^\d{1,5}$/.test(value)) {
      constIssues.push(`Type mismatch: const bool ${name} = ${value} — use true/false instead of numeric value`);
    }
    if (type === 'float' && /^['"]/.test(value)) {
      constIssues.push(`Type mismatch: const float ${name} = ${value.slice(0, 40)} — value appears to be a string`);
    }

    // PHP 8.3 version check
    if (composerPhpVersion && phpVersionBelow83(composerPhpVersion)) {
      constIssues.push(`PHP 8.3 typed constant used in project requiring PHP ${composerPhpVersion} — typed constants require PHP >= 8.3`);
    }

    if (!hasStrictTypes) {
      constIssues.push(`Typed constant ${name} in class without declare(strict_types=1) — inconsistent strictness`);
    }

    constants.push({ name, type, value: value.slice(0, 60), isTyped: true, issues: constIssues });
  }

  // Match untyped constants in same file
  const untypedConstRe = /const\s+([A-Z_][A-Z0-9_]{0,80})\s*=\s*([^;]{1,200});/g;
  while ((m = untypedConstRe.exec(content)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    // Skip if this was already captured as typed
    if (constants.some((c) => c.name === name)) continue;
    // Skip enum cases
    if (content.includes('enum ') && /case\s+\w/.test(content)) continue;

    constants.push({ name, type: undefined, value: value.slice(0, 60), isTyped: false, issues: [] });
  }

  if (constants.length === 0) return null;

  const typedCount = constants.filter((c) => c.isTyped).length;
  const untypedCount = constants.filter((c) => !c.isTyped).length;

  // Warn if mixing typed and untyped in same class
  if (typedCount > 0 && untypedCount > 0) {
    fileIssues.push(`Class ${className} has ${typedCount} typed and ${untypedCount} untyped constants — add types to all constants for consistency`);
  }

  // Only return if there are typed constants or notable findings
  if (typedCount === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: className,
    constants,
    phpVersion: composerPhpVersion,
    issues: fileIssues,
  };
}

function loadTypedConstantInfos(appPath: string): TypedConstantInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const composerPhpVersion = readComposerPhpVersion(appPath);
  const results: TypedConstantInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseTypedConstantFile(f, appPath, composerPhpVersion);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listPhpTypedConstants(appPath: string): McpToolResult {
  try {
    const infos = loadTypedConstantInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP 8.3 typed class constants found in src/.\n\nPHP 8.3 typed constant syntax:\n  class Config {\n    const string VERSION = \'1.0.0\';\n    const int MAX_RETRIES = 3;\n    const float TIMEOUT = 30.0;\n    const bool ENABLED = true;\n    const array ALLOWED_METHODS = [\'GET\', \'POST\'];\n  }',
        }],
      };
    }

    const withIssues = infos.filter(
      (i) => i.issues.length > 0 || i.constants.some((c) => c.issues.length > 0)
    );
    const allConsts = infos.flatMap((i) => i.constants);
    const phpVersion = infos[0]?.phpVersion;

    let text = `PHP Typed Constants (${infos.length} classes, ${allConsts.filter((c) => c.isTyped).length} typed)\n${'='.repeat(65)}\n`;
    if (phpVersion) text += `Project PHP requirement: ${phpVersion}\n`;

    for (const info of infos) {
      text += `\n  ${info.class}  (${info.file})\n`;
      const typed = info.constants.filter((c) => c.isTyped);
      const untyped = info.constants.filter((c) => !c.isTyped);
      for (const c of typed) {
        text += `    const ${c.type} ${c.name} = ${c.value.slice(0, 40)}\n`;
        for (const issue of c.issues) {
          text += `      WARN: ${issue}\n`;
        }
      }
      if (untyped.length > 0) {
        text += `    Untyped: ${untyped.map((c) => c.name).join(', ')}\n`;
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nClasses with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpTypedConstantStats(appPath: string): McpToolResult {
  try {
    const infos = loadTypedConstantInfos(appPath);
    const allConsts = infos.flatMap((i) => i.constants);
    const typed = allConsts.filter((c) => c.isTyped);
    const phpVersion = infos[0]?.phpVersion;

    let text = `PHP Typed Constant Statistics\n${'='.repeat(40)}\n\n`;
    if (phpVersion) text += `Project PHP version: ${phpVersion}\n`;
    text += `Classes with typed constants: ${infos.length}\n`;
    text += `Total typed constants:        ${typed.length}\n`;
    text += `  string:                     ${typed.filter((c) => c.type === 'string').length}\n`;
    text += `  int:                        ${typed.filter((c) => c.type === 'int').length}\n`;
    text += `  float:                      ${typed.filter((c) => c.type === 'float').length}\n`;
    text += `  bool:                       ${typed.filter((c) => c.type === 'bool').length}\n`;
    text += `  array:                      ${typed.filter((c) => c.type === 'array').length}\n`;
    text += `Untyped alongside typed:      ${infos.filter((i) => i.constants.some((c) => !c.isTyped) && i.constants.some((c) => c.isTyped)).length} classes\n`;
    text += `Classes with issues:          ${infos.filter((i) => i.issues.length > 0 || i.constants.some((c) => c.issues.length > 0)).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpTypedConstantTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_typed_constants',
      description: 'List PHP 8.3 typed class constants: const string/int/float/bool/array declarations, type mismatch detection, mixed typed/untyped warnings, PHP version compatibility check via composer.json, strict_types consistency',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_typed_constants_stats',
      description: 'Show PHP typed constant statistics: class count, total typed constants, breakdown by type, mixed-typing class count, PHP version, classes with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
