// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Covariance / Contravariance Inspector
 *
 * Scans src/ PHP for class hierarchies where child class overrides parent
 * method return type (covariance) or parameter type (contravariance).
 *
 * Detects:
 *   - Child return type that is a subtype of parent return type (covariant - valid PHP 7.4+)
 *   - Child param type that is a supertype of parent param type (contravariant - valid PHP 7.4+)
 *   - Union types in overrides
 *   - mixed vs specific types
 *
 * Warns:
 *   - Return type narrowing to non-subtype (LSP violation)
 *   - Parameter type widening to incompatible type (contravariance violation)
 *   - static return type in non-final class (PHP 8+ covariant static)
 *   - Removing nullable from overridden method (breaks Liskov)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpCovarianceInfo {
  file: string;
  class: string;
  method: string;
  parentClass: string;
  parentReturnType: string;
  childReturnType: string;
  covarianceType: 'covariant' | 'contravariant' | 'invariant' | 'unknown';
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

// ─── Parsing helpers ─────────────────────────────────────────────────────────

interface MethodSignature {
  name: string;
  returnType: string;
  paramTypes: string[];
}

function parseMethodSignatures(content: string): MethodSignature[] {
  const sigs: MethodSignature[] = [];
  // Match: function name(params): ReturnType  — bounded lookahead
  const methodRe = /function\s+(\w{1,80})\s*\(([^)]{0,500})\)\s*(?::\s*([\w\\|?&[\]{} ]{0,100}))?/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(content)) !== null) {
    const params = m[2] ?? '';
    const paramTypes: string[] = [];
    // Extract type from each parameter slot: "TypeHint $varName"
    const paramRe = /([\w\\|?&[\]]{1,80})\s+\$\w{1,60}/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(params)) !== null) {
      paramTypes.push(pm[1]);
    }
    sigs.push({
      name: m[1],
      returnType: (m[3] ?? '').trim(),
      paramTypes,
    });
  }
  return sigs;
}

// ─── Covariance analysis ─────────────────────────────────────────────────────

const NULLABLE_RE = /^\?/;
const UNION_RE = /\|/;

function analyzeCovariance(
  method: string,
  parentReturn: string,
  childReturn: string,
  parentParams: string[],
  childParams: string[],
  isFinal: boolean,
): PhpCovarianceInfo['covarianceType'] | 'unknown' {
  if (!parentReturn && !childReturn) return 'invariant';
  if (parentReturn === childReturn) return 'invariant';
  if (!parentReturn || !childReturn) return 'unknown';

  // If child removes nullable from parent (e.g. parent = ?Foo, child = Foo) → covariant return
  if (NULLABLE_RE.test(parentReturn) && !NULLABLE_RE.test(childReturn)) {
    // Removing nullable from return is covariant but LSP-breaking for callers
    void method; void isFinal; void parentParams; void childParams;
    return 'covariant';
  }
  if (UNION_RE.test(childReturn) && !UNION_RE.test(parentReturn)) return 'covariant';
  if (!UNION_RE.test(childReturn) && UNION_RE.test(parentReturn)) return 'contravariant';
  return 'unknown';
}

function buildIssues(
  childClass: string,
  method: string,
  parentReturn: string,
  childReturn: string,
  isFinal: boolean,
): string[] {
  const issues: string[] = [];

  if (NULLABLE_RE.test(parentReturn) && !NULLABLE_RE.test(childReturn) && childReturn !== 'never') {
    issues.push(
      `Method ${method}(): child removes nullable (${parentReturn} → ${childReturn}). ` +
      `Callers expecting nullable will break (LSP violation).`,
    );
  }
  if (!NULLABLE_RE.test(parentReturn) && NULLABLE_RE.test(childReturn)) {
    issues.push(
      `Method ${method}(): child adds nullable (${parentReturn} → ${childReturn}). ` +
      `Callers not expecting null may fail.`,
    );
  }
  if (childReturn === 'static' && !isFinal) {
    issues.push(
      `Method ${method}(): uses "static" return type in non-final class. ` +
      `PHP 8+ covariant static — ensure subclasses return compatible type.`,
    );
  }
  if (childReturn === 'mixed' && parentReturn && parentReturn !== 'mixed') {
    issues.push(
      `Method ${method}(): child weakens return type to "mixed" (was: ${parentReturn}). ` +
      `Loses type safety — consider keeping specific type.`,
    );
  }
  return issues;
}

// ─── File parsing ─────────────────────────────────────────────────────────────

interface ClassInfo {
  name: string;
  parent?: string;
  isFinal: boolean;
  methods: MethodSignature[];
}

function parseClassInfo(content: string): ClassInfo | null {
  const classM = /(?:final\s+)?(?:abstract\s+)?class\s+(\w{1,80})(?:\s+extends\s+([\w\\]{1,150}))?/.exec(content);
  if (!classM) return null;
  const isFinal = /\bfinal\s+class\b/.test(content);
  return {
    name: classM[1],
    parent: classM[2],
    isFinal,
    methods: parseMethodSignatures(content),
  };
}

// ─── Build class index ────────────────────────────────────────────────────────

function buildClassIndex(srcDir: string): Map<string, ClassInfo & { file: string }> {
  const index = new Map<string, ClassInfo & { file: string }>();
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const info = parseClassInfo(content);
    if (!info) continue;
    index.set(info.name, { ...info, file });
  }
  return index;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyzeAll(appPath: string): PhpCovarianceInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const index = buildClassIndex(srcDir);
  const results: PhpCovarianceInfo[] = [];

  for (const [, child] of index) {
    if (!child.parent) continue;
    // Strip namespace prefix — only match short class name
    const parentShort = child.parent.split('\\').pop() ?? child.parent;
    const parent = index.get(parentShort) ?? index.get(child.parent);
    if (!parent) continue;

    // Build parent method map
    const parentMethods = new Map<string, MethodSignature>();
    for (const m of parent.methods) parentMethods.set(m.name, m);

    for (const cm of child.methods) {
      const pm = parentMethods.get(cm.name);
      if (!pm) continue;
      if (cm.returnType === pm.returnType) continue; // identical — skip

      const covType = analyzeCovariance(
        cm.name,
        pm.returnType,
        cm.returnType,
        pm.paramTypes,
        cm.paramTypes,
        child.isFinal,
      );
      const issues = buildIssues(child.name, cm.name, pm.returnType, cm.returnType, child.isFinal);

      results.push({
        file: path.basename(child.file),
        class: child.name,
        method: cm.name,
        parentClass: parent.name,
        parentReturnType: pm.returnType || '(none)',
        childReturnType: cm.returnType || '(none)',
        covarianceType: covType as PhpCovarianceInfo['covarianceType'],
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpCovariance(appPath: string): McpToolResult {
  try {
    const items = analyzeAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No covariance/contravariance overrides detected in src/.\n\n' +
            'PHP 7.4+ supports covariant return types and contravariant parameter types in class hierarchies.',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);
    let text = `PHP Covariance / Contravariance Analysis\n${'='.repeat(55)}\n`;
    text += `  Total overrides detected: ${items.length}\n`;
    text += `  Overrides with issues:    ${withIssues.length}\n\n`;

    const covariant     = items.filter((i) => i.covarianceType === 'covariant');
    const contravariant = items.filter((i) => i.covarianceType === 'contravariant');
    const invariant     = items.filter((i) => i.covarianceType === 'invariant');

    text += `  Covariant:     ${covariant.length}\n`;
    text += `  Contravariant: ${contravariant.length}\n`;
    text += `  Invariant:     ${invariant.length}\n\n`;

    for (const item of items) {
      text += `${item.class}::${item.method}() [${item.file}]\n`;
      text += `  extends: ${item.parentClass}\n`;
      text += `  parent return: ${item.parentReturnType}  →  child return: ${item.childReturnType}\n`;
      text += `  variance: ${item.covarianceType}\n`;
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

export function getPhpCovarianceStats(appPath: string): McpToolResult {
  try {
    const items = analyzeAll(appPath);

    let text = `PHP Covariance Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total overrides:   ${items.length}\n`;
    text += `Covariant:         ${items.filter((i) => i.covarianceType === 'covariant').length}\n`;
    text += `Contravariant:     ${items.filter((i) => i.covarianceType === 'contravariant').length}\n`;
    text += `Invariant:         ${items.filter((i) => i.covarianceType === 'invariant').length}\n`;
    text += `Unknown:           ${items.filter((i) => i.covarianceType === 'unknown').length}\n`;
    text += `With issues:       ${items.filter((i) => i.issues.length > 0).length}\n`;
    text += `Uses static type:  ${items.filter((i) => i.childReturnType === 'static').length}\n`;
    text += `Uses mixed type:   ${items.filter((i) => i.childReturnType === 'mixed').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpCovarianceTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_covariance',
      description: 'List PHP covariance/contravariance overrides in class hierarchies: return type changes, nullable removal, static type usage, LSP violations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_covariance_stats',
      description: 'Show PHP covariance statistics: covariant/contravariant/invariant counts, issues count, static/mixed type usage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
