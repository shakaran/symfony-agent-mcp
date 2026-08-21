/**
 * Symfony Form Callback Constraint Inspector
 *
 * Scans src/ PHP for:
 *   - new Callback(function  — inline closure
 *   - new Callback(['methods' => ...])  — method reference
 *   - new Assert\Callback(
 *   - new Expression(  — expression language constraint
 *   - new Assert\Expression(
 *   in configureOptions() or validation config
 *
 * Detects:
 *   - Callback pointing to method name vs inline closure
 *   - Service callbacks
 *
 * Warns about:
 *   - Callback constraint with static method (loses dependency injection)
 *   - Expression constraint with complex expression >100 chars (hard to maintain)
 *   - Callback without $context->addViolation() call (constraint never fails — no-op)
 *   - Expression using @this on non-public property (fragile)
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

interface CallbackConstraintInfo {
  file: string;
  class?: string;
  type: 'Callback' | 'Expression';
  isInlineClosure: boolean;
  isStaticMethod: boolean;
  hasViolationCall: boolean;
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

function parseCallbackConstraintFile(filePath: string, appPath: string): CallbackConstraintInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const hasCallback = content.includes('new Callback(') || content.includes('new Assert\\Callback(') ||
    content.includes('Assert\\Callback(') || content.includes('Constraints\\Callback(');
  const hasExpression = content.includes('new Expression(') || content.includes('new Assert\\Expression(') ||
    content.includes('Assert\\Expression(') || content.includes('Constraints\\Expression(');

  if (!hasCallback && !hasExpression) return [];
  if (content.includes('namespace Symfony\\Component\\Validator')) return [];

  const classM = /class\s+(\w{1,120})/.exec(content);
  const results: CallbackConstraintInfo[] = [];

  // Process Callback constraints
  if (hasCallback) {
    const issues: string[] = [];

    // Inline closure detection
    const isInlineClosure = /new\s+(?:Assert\\|Constraints\\)?Callback\s*\(\s*(?:function|\[function|static\s+function)/.test(content);
    // Static method detection
    const isStaticMethod = /new\s+(?:Assert\\|Constraints\\)?Callback\s*\(\s*\[\s*['"]\w{1,100}['"]/.test(content) ||
      /new\s+(?:Assert\\|Constraints\\)?Callback\s*\(\s*\[\s*(?:self|static|\w{1,100})::\s*class/.test(content);

    if (isStaticMethod) {
      issues.push('Callback constraint uses static method reference — static methods cannot use dependency injection');
    }

    // Check if addViolation is called within callback context
    const hasViolationCall = content.includes('addViolation(') || content.includes('->addViolation');
    if (!hasViolationCall) {
      issues.push('Callback constraint without $context->addViolation() call — constraint will never fail (no-op)');
    }

    results.push({
      file: path.relative(appPath, filePath),
      class: classM?.[1],
      type: 'Callback',
      isInlineClosure,
      isStaticMethod,
      hasViolationCall,
      issues,
    });
  }

  // Process Expression constraints
  if (hasExpression) {
    const issues: string[] = [];

    const isInlineClosure = false;
    const isStaticMethod = false;

    // Extract expression string to check length
    const exprM = /new\s+(?:Assert\\|Constraints\\)?Expression\s*\(\s*['"]([^'"]{1,500})['"]/.exec(content);
    const exprStr = exprM ? exprM[1] : '';
    if (exprStr.length > 100) {
      issues.push(`Expression constraint is ${exprStr.length} chars — complex expressions are hard to maintain; consider using a Callback instead`);
    }

    // Check for @this on non-public property heuristic
    if (content.includes('@this.') || content.includes('this.')) {
      // Look for private/protected property access pattern
      const propM = /(?:@this|this)\.(\w{1,60})/.exec(exprStr);
      if (propM) {
        const propName = propM[1];
        // Check if property is declared as private/protected
        if (new RegExp(`private\\s+[^;]{0,100}\\$${propName}`).test(content) ||
          new RegExp(`protected\\s+[^;]{0,100}\\$${propName}`).test(content)) {
          issues.push(`Expression uses @this.${propName} on private/protected property — works but fragile, prefer public getter`);
        }
      }
    }

    const hasViolationCall = false; // Expression constraints don't use addViolation

    results.push({
      file: path.relative(appPath, filePath),
      class: classM?.[1],
      type: 'Expression',
      isInlineClosure,
      isStaticMethod,
      hasViolationCall: hasViolationCall || hasExpression, // Expression constraints work differently
      issues,
    });
  }

  return results;
}

function loadCallbackConstraintInfos(appPath: string): CallbackConstraintInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: CallbackConstraintInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseCallbackConstraintFile(f, appPath);
    results.push(...r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listFormCallbackConstraints(appPath: string): McpToolResult {
  try {
    const infos = loadCallbackConstraintInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Callback or Expression constraints found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Callback/Expression Constraints (${infos.length} found)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      text += `  [${info.type}]\n`;
      const flags = [
        info.isInlineClosure ? 'inline-closure' : '',
        info.isStaticMethod ? 'static-method' : '',
        info.hasViolationCall ? 'has-addViolation' : 'no-addViolation',
      ].filter(Boolean).join(', ');
      if (flags) text += `    flags: [${flags}]\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormCallbackConstraintStats(appPath: string): McpToolResult {
  try {
    const infos = loadCallbackConstraintInfos(appPath);

    let text = `Callback/Expression Constraint Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total constraints:            ${infos.length}\n`;
    text += `  Callback:                   ${infos.filter((i) => i.type === 'Callback').length}\n`;
    text += `  Expression:                 ${infos.filter((i) => i.type === 'Expression').length}\n`;
    text += `  Inline closures:            ${infos.filter((i) => i.isInlineClosure).length}\n`;
    text += `  Static methods:             ${infos.filter((i) => i.isStaticMethod).length}\n`;
    text += `  Without addViolation:       ${infos.filter((i) => !i.hasViolationCall && i.type === 'Callback').length}\n`;
    text += `Issues:                       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormCallbackConstraintTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_callback_constraints',
      description: 'List Symfony Callback and Expression constraints: inline closures, static methods, service callbacks; warns about missing addViolation(), static DI loss, overly complex expressions, @this on non-public properties',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_callback_constraint_stats',
      description: 'Show Callback/Expression constraint statistics: counts by type, inline vs static, missing addViolation count, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
