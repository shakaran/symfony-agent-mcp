// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Constructor Promotion Inspector
 *
 * Scans src/ PHP for:
 *   - Constructor parameters with visibility (public/protected/private) — constructor property promotion
 *   - Classes where constructor assigns $this->x = $x (could use promotion)
 *   - readonly promoted properties
 *
 * Detects:
 *   - Classes fully using promotion vs partially vs not at all (PHP 8.0+ classes)
 *
 * Warns:
 *   - Mixing promoted and non-promoted properties in same constructor (inconsistency)
 *   - Promoted property without type hint (loses static analysis benefit)
 *   - Class using $this->x = $x assignment pattern that could be promotion (migration opportunity)
 *   - Abstract constructor with promoted properties (works but unusual)
 *   - Readonly promoted without PHP 8.1 feature flag check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpConstructorPromotionInfo {
  file: string;
  class: string;
  promotedCount: number;
  unpromotedCount: number;
  readonlyPromotedCount: number;
  couldBePromoted: number;
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

// ─── Constructor extractor ────────────────────────────────────────────────────

function extractConstructorBlock(content: string): { params: string; body: string } | null {
  const re = /function\s+__construct\s*\(([^)]{0,600})\)\s*(?::\s*[\w?\\]{1,80}\s*)?\{([\s\S]{0,3000}?)\n\s*\}/;
  const m = re.exec(content);
  if (!m) return null;
  return { params: m[1] ?? '', body: m[2] ?? '' };
}

// ─── Promoted parameter detection ────────────────────────────────────────────

function countPromotedParams(params: string): { promoted: number; readonly: number } {
  let promoted = 0;
  let readonly = 0;
  // Match: public/protected/private [readonly] [?TypeHint] $varName
  const re = /(?:public|protected|private)\s+(?:(readonly)\s+)?(?:[\w\\?|]{1,80}\s+)?\$\w{1,60}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    promoted++;
    if (m[1] === 'readonly') readonly++;
  }
  return { promoted, readonly };
}

function countUnpromotedParams(params: string): number {
  // Parameters that look like normal (non-promoted) parameters
  const parts = params.split(',').map((s) => s.trim());
  let count = 0;
  for (const part of parts) {
    if (!part) continue;
    // Promoted: starts with public/protected/private
    if (/^(?:public|protected|private)\b/.test(part)) continue;
    // Has a $varName
    if (/\$\w{1,60}/.test(part)) count++;
  }
  return count;
}

function countPromotedWithoutTypeHint(params: string): number {
  let count = 0;
  // Match: public/protected/private $varName (no type hint between visibility and $)
  const re = /(?:public|protected|private)\s+(?:readonly\s+)?\$\w{1,60}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    void m;
    count++;
  }
  return count;
}

// ─── Assignment pattern detection ────────────────────────────────────────────

function countAssignablePatterns(body: string, params: string): number {
  // Find $this->x = $x; patterns in body where $x is a constructor param
  let count = 0;
  const paramNames: string[] = [];
  const pRe = /\$(\w{1,60})/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(params)) !== null) {
    paramNames.push(pm[1]);
  }
  for (const name of paramNames) {
    const assignRe = new RegExp(`\\$this\\s*->\\s*${name}\\s*=\\s*\\$${name}\\s*;`);
    if (assignRe.test(body)) count++;
  }
  return count;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): PhpConstructorPromotionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('__construct')) return null;

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const ctor = extractConstructorBlock(content);
  if (!ctor) return null;

  const { promoted, readonly } = countPromotedParams(ctor.params);
  const unpromoted = countUnpromotedParams(ctor.params);
  const couldBePromoted = countAssignablePatterns(ctor.body, ctor.params);
  const promotedWithoutType = countPromotedWithoutTypeHint(ctor.params);
  const isAbstractConstructor = /abstract\s+(?:public|protected)?\s*function\s+__construct/.test(content);

  const issues: string[] = [];

  // Mixing promoted and non-promoted
  if (promoted > 0 && unpromoted > 0) {
    issues.push(
      `${className}::__construct() mixes ${promoted} promoted and ${unpromoted} non-promoted parameters. ` +
      `Consider making all parameters promoted for consistency.`,
    );
  }

  // Promoted without type hint
  if (promotedWithoutType > 0) {
    issues.push(
      `${className} has ${promotedWithoutType} promoted constructor parameter(s) without a type hint. ` +
      `Type hints on promoted properties are critical for static analysis.`,
    );
  }

  // Could be promoted (migration opportunity)
  if (couldBePromoted > 0 && promoted === 0) {
    issues.push(
      `${className}::__construct() has ${couldBePromoted} assignment(s) like $this->x = $x ` +
      `that could be simplified to constructor property promotion (PHP 8.0+).`,
    );
  }

  // Abstract constructor with promoted properties
  if (isAbstractConstructor && promoted > 0) {
    issues.push(
      `${className} has an abstract constructor with promoted properties. ` +
      `This works in PHP but is unusual — abstract constructors are rarely needed.`,
    );
  }

  // Readonly promoted without type (readonly requires type hint)
  if (readonly > 0 && promotedWithoutType > 0) {
    issues.push(
      `${className} has readonly promoted properties without type hints. ` +
      `PHP 8.1 requires a type declaration on readonly properties.`,
    );
  }

  if (promoted === 0 && couldBePromoted === 0) return null;

  return {
    file: path.basename(filePath),
    class: className,
    promotedCount: promoted,
    unpromotedCount: unpromoted,
    readonlyPromotedCount: readonly,
    couldBePromoted,
    issues,
  };
}

function loadAll(appPath: string): PhpConstructorPromotionInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpConstructorPromotionInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpConstructorPromotion(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No constructor promotion usage found in src/.\n\n' +
            'PHP 8.0 constructor promotion example:\n' +
            '  class User {\n' +
            '    public function __construct(\n' +
            '      private readonly string $name,\n' +
            '      private string $email,\n' +
            '    ) {}\n' +
            '  }',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);
    const fullyPromoted = items.filter((i) => i.promotedCount > 0 && i.unpromotedCount === 0);
    const couldMigrate = items.filter((i) => i.couldBePromoted > 0);

    let text = `PHP Constructor Promotion Analysis\n${'='.repeat(55)}\n`;
    text += `  Classes with constructors:   ${items.length}\n`;
    text += `  Fully promoted:              ${fullyPromoted.length}\n`;
    text += `  Could be promoted:           ${couldMigrate.length}\n`;
    text += `  With issues:                 ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.class} [${item.file}]\n`;
      text += `  promoted: ${item.promotedCount}  unpromoted: ${item.unpromotedCount}  `;
      text += `readonlyPromoted: ${item.readonlyPromotedCount}  couldBePromoted: ${item.couldBePromoted}\n`;
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

export function getPhpConstructorPromotionStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Constructor Promotion Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with constructors:         ${items.length}\n`;
    text += `Fully promoted:                    ${items.filter((i) => i.promotedCount > 0 && i.unpromotedCount === 0).length}\n`;
    text += `Partially promoted:                ${items.filter((i) => i.promotedCount > 0 && i.unpromotedCount > 0).length}\n`;
    text += `Total promoted params:             ${items.reduce((s, i) => s + i.promotedCount, 0)}\n`;
    text += `Total readonly promoted:           ${items.reduce((s, i) => s + i.readonlyPromotedCount, 0)}\n`;
    text += `Migration opportunities:           ${items.reduce((s, i) => s + i.couldBePromoted, 0)}\n`;
    text += `With issues:                       ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpConstructorPromotionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_constructor_promotion',
      description: 'List PHP 8.0 constructor property promotion: promoted/unpromoted counts, readonly promoted, migration opportunities ($this->x = $x patterns), missing type hints, mixed promotion warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_constructor_promotion_stats',
      description: 'Show PHP constructor promotion statistics: fully/partially promoted counts, total promoted params, readonly promoted count, migration opportunities, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
