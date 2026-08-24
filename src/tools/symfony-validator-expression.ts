// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Validator Expression Inspector
 *
 * Scans src/ PHP for Assert\Expression usages:
 *   - Expression string content extraction
 *   - @this.property usage, @value usage
 *   - is_null(), matches(), complex expressions
 *   - Warns on non-public property references, long expressions,
 *     missing 'message' option, invalid ExpressionLanguage functions
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

interface ValidatorExpressionInfo {
  file: string;
  class: string;
  property: string;
  expression: string;
  hasMessage: boolean;
  referencesNonPublic: boolean;
  isComplex: boolean;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function extractStringArg(text: string): string {
  // Grab first single- or double-quoted string (bounded to 500 chars)
  const m = /['"]([^'"]{0,500})['"]/u.exec(text);
  return m ? m[1] : '';
}

function scanExpressions(appPath: string): ValidatorExpressionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: ValidatorExpressionInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    // Skip test/fixture directories
    if (file.includes('/Tests/') || file.includes('/Test/') || file.includes('/DataFixtures/')) continue;

    const content = safeRead(file, srcDir);
    if (content === null) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    // Find all Assert\Expression occurrences
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      const isExpressionAttr = /#\[Assert\\Expression\b/.test(line) ||
        /Assert\\Expression\s*\(/.test(line) ||
        /new\s+Expression\s*\(/.test(line);

      if (!isExpressionAttr) continue;

      // Gather context block (up to 10 lines)
      const block = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');

      // Extract expression string
      const exprMatch = /expression\s*[:=]\s*['"]([^'"]{0,500})['"]/u.exec(block) ??
        /new\s+Expression\s*\(\s*['"]([^'"]{0,500})['"]/u.exec(block) ??
        /Assert\\Expression\s*\(\s*['"]([^'"]{0,500})['"]/u.exec(block);

      const expression = exprMatch ? exprMatch[1] : extractStringArg(block);

      if (!expression) continue;

      // Detect property name (line above the attribute, or $property pattern)
      let property = 'unknown';
      if (i > 0) {
        const prevLine = lines[i - 1] ?? '';
        const propM = /(?:private|protected|public)\s+(?:\?\w+\s+)?\$(\w{1,80})/.exec(prevLine) ??
          /\$(\w{1,80})/.exec(prevLine);
        if (propM) property = propM[1];
      }

      const hasMessage = /message\s*[:=]/.test(block);
      const referencesNonPublic = /this\.\w/.test(expression) && !/public\s+\$/.test(block);
      const isComplex = expression.length > 100 ||
        /&&|\|\|/.test(expression) ||
        /\?\s*/.test(expression);

      const issues: string[] = [];

      if (!hasMessage) {
        issues.push('No "message" option — clients receive a generic error message');
      }
      if (referencesNonPublic) {
        issues.push('@this.property reference: fragile if property is renamed or non-public');
      }
      if (expression.length > 200) {
        issues.push(`Expression is ${expression.length} chars — consider extracting to a custom constraint`);
      }
      if (/\bdate\b|\btime\b|\bstrtotime\b/.test(expression)) {
        issues.push('date/time/strtotime not available in ExpressionLanguage context');
      }

      results.push({
        file: path.relative(appPath, file),
        class: className,
        property,
        expression,
        hasMessage,
        referencesNonPublic,
        isComplex,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listValidatorExpressions(appPath: string): McpToolResult {
  try {
    const items = scanExpressions(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No Assert\\Expression constraints found in src/.' }] };
    }

    let text = `Validator Expression Constraints\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} expression constraint(s):\n\n`;

    for (const item of items) {
      text += `  ${item.class}::$${item.property}\n`;
      text += `    File:       ${item.file}\n`;
      text += `    Expression: ${item.expression.slice(0, 120)}${item.expression.length > 120 ? '...' : ''}\n`;
      text += `    Has message: ${item.hasMessage ? 'yes' : 'NO'}\n`;
      text += `    Complex:     ${item.isComplex ? 'yes' : 'no'}\n`;
      if (item.issues.length > 0) {
        text += `    Issues:\n`;
        for (const issue of item.issues) {
          text += `      - ${issue}\n`;
        }
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

export function getValidatorExpressionStats(appPath: string): McpToolResult {
  try {
    const items = scanExpressions(appPath);

    const withIssues = items.filter((i) => i.issues.length > 0).length;
    const withMessage = items.filter((i) => i.hasMessage).length;
    const complex = items.filter((i) => i.isComplex).length;
    const nonPublicRef = items.filter((i) => i.referencesNonPublic).length;

    let text = `Validator Expression Stats\n${'='.repeat(40)}\n\n`;
    text += `Total expressions:          ${items.length}\n`;
    text += `With explicit message:      ${withMessage}\n`;
    text += `Complex expressions:        ${complex}\n`;
    text += `Non-public @this refs:      ${nonPublicRef}\n`;
    text += `Expressions with issues:    ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getValidatorExpressionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_validator_expressions',
      description: 'Scan src/ for Assert\\Expression constraints: expression string, @this usage, message option presence, fragility warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_validator_expression_stats',
      description: 'Statistics for Assert\\Expression constraints: total count, message coverage, complexity, non-public property references',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
