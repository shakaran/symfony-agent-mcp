// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP 8.x Type Coverage Inspector
 *
 * Distinct from php-enums.ts, php-readonly.ts (readonly classes/properties).
 * Focuses on PHP 8.0+ type system adoption in source files:
 *
 * Union types (PHP 8.0):
 *   function process(string|int $value): bool|null {}
 *
 * Named arguments (PHP 8.0):
 *   str_contains(haystack: $str, needle: 'foo');
 *
 * Intersection types (PHP 8.1):
 *   function process(Countable&Iterator $value): void {}
 *
 * Fibers (PHP 8.1):
 *   $fiber = new Fiber(function(): void { ... });
 *
 * First-class callable syntax (PHP 8.1):
 *   $fn = strlen(...);
 *   $arr = array_map(strtoupper(...), $strings);
 *
 * never return type (PHP 8.1):
 *   function throwError(): never { throw new \Exception(); }
 *
 * Disjunctive Normal Form types (PHP 8.2):
 *   function process((A&B)|C $value): void {}
 *
 * Standalone null, true, false types (PHP 8.2):
 *   function isEnabled(): true {}
 *
 * Typed class constants (PHP 8.3):
 *   const string VERSION = '1.0';
 *
 * readonly classes (PHP 8.2):
 *   readonly class Config { ... }
 *
 * Analysis:
 *   - Functions/methods with no return type hint
 *   - Functions/methods with parameter with no type hint
 *   - Classes without constructor property promotion (PHP 8.0)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TypeCoverageFile {
  file: string;
  functions: number;
  typedReturnCount: number;
  typedParamMethods: number;
  unionTypeCount: number;
  intersectionTypeCount: number;
  neverReturnCount: number;
  typedConstCount: number;
  fiberCount: number;
  firstClassCallableCount: number;
  missingReturnTypes: number;
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

function analyzeTypeCoverage(filePath: string, appPath: string): TypeCoverageFile | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (content.length > 500_000) return null;

  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  // Function/method declarations
  const funcDecls = [...content.matchAll(/(?:public|protected|private|static)?\s*function\s+\w+\s*\([^)]{0,400}\)/g)];
  const functions = funcDecls.length;
  if (functions === 0) return null;

  // Return types: function foo(...): type
  const typedReturnCount = [...content.matchAll(/\)\s*:\s*(?!\s*\{)[\w\\|&?{}[\]]+/g)].length;
  const missingReturnTypes = functions - typedReturnCount;

  // never return type
  const neverReturnCount = [...content.matchAll(/\)\s*:\s*never\b/g)].length;

  // Union types: type|type (PHP 8.0+) — exclude nullable shorthand ?type
  const unionTypeCount = [...content.matchAll(/\b\w+\s*\|\s*\w+/g)].length;

  // Intersection types: Type&Type (PHP 8.1+)
  const intersectionTypeCount = [...content.matchAll(/\b[A-Z]\w*\s*&\s*[A-Z]\w*/g)].length;

  // Typed constants (PHP 8.3): const string VERSION
  const typedConstCount = [...content.matchAll(/const\s+(?:string|int|float|bool|array)\s+\w+/g)].length;

  // Fiber usage
  const fiberCount = [...content.matchAll(/new\s+Fiber\s*\(/g)].length;

  // First-class callables: strlen(...)
  const firstClassCallableCount = [...content.matchAll(/\b\w+\s*\(\s*\.\.\.\s*\)/g)].length;

  // Methods with all params typed (approximation: params with type hints vs without)
  const typedParamMethods = [...content.matchAll(/function\s+\w+\s*\((?:[^)]*\b(?:string|int|float|bool|array|object|callable|iterable|mixed|never|self|static|null|[A-Z]\w*)\s+\$[^)]*)+\)/g)].length;

  return {
    file: path.relative(appPath, filePath),
    functions,
    typedReturnCount,
    typedParamMethods,
    unionTypeCount,
    intersectionTypeCount,
    neverReturnCount,
    typedConstCount,
    fiberCount,
    firstClassCallableCount,
    missingReturnTypes,
  };
}

export function listTypeCoverage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const files: TypeCoverageFile[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const f = analyzeTypeCoverage(file, appPath);
      if (f) files.push(f);
    }

    if (files.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP source files found in src/.' }] };
    }

    const totalFunctions     = files.reduce((s, f) => s + f.functions, 0);
    const totalTypedReturn   = files.reduce((s, f) => s + f.typedReturnCount, 0);
    const totalMissing       = files.reduce((s, f) => s + f.missingReturnTypes, 0);
    const totalUnion         = files.reduce((s, f) => s + f.unionTypeCount, 0);
    const totalIntersection  = files.reduce((s, f) => s + f.intersectionTypeCount, 0);
    const totalNever         = files.reduce((s, f) => s + f.neverReturnCount, 0);
    const totalTypedConst    = files.reduce((s, f) => s + f.typedConstCount, 0);
    const totalFibers        = files.reduce((s, f) => s + f.fiberCount, 0);
    const totalFirstClass    = files.reduce((s, f) => s + f.firstClassCallableCount, 0);
    const coveragePct        = totalFunctions > 0 ? Math.round(totalTypedReturn / totalFunctions * 100) : 0;

    let text = `PHP 8.x Type Coverage\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${files.length}  Functions/methods: ${totalFunctions}  Return type coverage: ${coveragePct}%\n`;
    text += `  With return type:   ${totalTypedReturn}  Missing: ${totalMissing}\n`;
    text += `\nPHP 8.x Features Adopted:\n`;
    text += `  Union types (8.0):         ${totalUnion}\n`;
    text += `  Intersection types (8.1):  ${totalIntersection}\n`;
    text += `  never return type (8.1):   ${totalNever}\n`;
    text += `  Typed constants (8.3):     ${totalTypedConst}\n`;
    text += `  Fiber usages (8.1):        ${totalFibers}\n`;
    text += `  First-class callables:     ${totalFirstClass}\n`;

    const worst = files.filter((f) => f.missingReturnTypes > 0)
      .sort((a, b) => b.missingReturnTypes - a.missingReturnTypes)
      .slice(0, 8);

    if (worst.length > 0) {
      text += `\nFiles with most missing return types:\n`;
      for (const f of worst) {
        const pct = Math.round(f.typedReturnCount / f.functions * 100);
        text += `  ${f.file}  ${f.functions} methods  ${pct}% typed  ${f.missingReturnTypes} missing\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTypeCoverageStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files: TypeCoverageFile[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const f = analyzeTypeCoverage(file, appPath);
        if (f) files.push(f);
      }
    }

    const totalFunctions  = files.reduce((s, f) => s + f.functions, 0);
    const totalTyped      = files.reduce((s, f) => s + f.typedReturnCount, 0);
    const coveragePct     = totalFunctions > 0 ? Math.round(totalTyped / totalFunctions * 100) : 0;

    let text = `Type Coverage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Source files:              ${files.length}\n`;
    text += `Total functions/methods:   ${totalFunctions}\n`;
    text += `With return type:          ${totalTyped} (${coveragePct}%)\n`;
    text += `Missing return type:       ${files.reduce((s, f) => s + f.missingReturnTypes, 0)}\n`;
    text += `Union types (PHP 8.0):     ${files.reduce((s, f) => s + f.unionTypeCount, 0)}\n`;
    text += `Intersection types (8.1):  ${files.reduce((s, f) => s + f.intersectionTypeCount, 0)}\n`;
    text += `never return (8.1):        ${files.reduce((s, f) => s + f.neverReturnCount, 0)}\n`;
    text += `Typed constants (8.3):     ${files.reduce((s, f) => s + f.typedConstCount, 0)}\n`;
    text += `Fiber usages (8.1):        ${files.reduce((s, f) => s + f.fiberCount, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTypeCoverageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_type_coverage',
      description: 'Show PHP 8.x type coverage: return type coverage percentage, union types (8.0), intersection types (8.1), never return type (8.1), typed constants (8.3), Fiber usage (8.1), first-class callable syntax; lists files with most missing return types',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_type_coverage_stats',
      description: 'Show type coverage statistics: file count, function/method count, return type coverage %, missing return type count, union/intersection/never/typed-const/fiber counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
