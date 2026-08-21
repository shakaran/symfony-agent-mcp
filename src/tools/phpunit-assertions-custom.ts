/**
 * PHPUnit Custom Assertions Inspector
 *
 * Detects custom PHPUnit assertion and constraint implementations.
 * Pure static analysis — reads PHP test source files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CustomAssertionInfo {
  file: string;
  className: string;
  assertionMethods: string[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseCustomAssertionFile(filePath: string): CustomAssertionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isCustomConstraint = content.includes('extends Constraint') ||
    content.includes('extends Assert') ||
    content.includes('assertThat(');

  const hasAssertMethods = /(?:public\s+)?static\s+function\s+assert\w{1,80}\s*\(/.test(content) ||
    /(?:public\s+)?function\s+assert\w{1,80}\s*\(/.test(content);

  if (!isCustomConstraint && !hasAssertMethods) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  // Collect assertion method names
  const assertionMethods: string[] = [];
  const methodPattern = /(?:static\s+)?function\s+(assert\w{1,80})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodPattern.exec(content)) !== null) {
    if (!assertionMethods.includes(m[1])) assertionMethods.push(m[1]);
  }

  const issues: string[] = [];

  if (content.includes('extends Constraint')) {
    const hasToString = content.includes('function toString()');
    if (!hasToString) {
      issues.push('Custom Constraint does not implement toString() — error messages will be empty/unreadable on failure');
    }

    const toStringContent = hasToString
      ? content.slice(content.indexOf('function toString()'), content.indexOf('function toString()') + 300)
      : '';
    const hasEmptyToString = hasToString && (
      toStringContent.includes("return '';") ||
      toStringContent.includes('return "";') ||
      toStringContent.includes("return ''") && toStringContent.includes(';')
    );
    if (hasEmptyToString) {
      issues.push('Custom Constraint toString() returns empty string — assertion failure message is unreadable');
    }

    const hasParentEvaluate = content.includes('parent::evaluate(');
    if (hasParentEvaluate) {
      issues.push('Custom Constraint calls parent::evaluate() — override evaluate() fully without calling parent; calling parent causes double evaluation');
    }
  }

  if (hasAssertMethods && assertionMethods.length > 0) {
    // Check if custom assertion methods call $this->fail() or Assert::fail()
    for (const method of assertionMethods) {
      const methodStart = content.indexOf(`function ${method}(`);
      if (methodStart === -1) continue;
      const methodBody = content.slice(methodStart, methodStart + 800);
      const hasFail = methodBody.includes('$this->fail(') ||
        methodBody.includes('Assert::fail(') ||
        methodBody.includes('self::fail(') ||
        methodBody.includes('static::fail(') ||
        methodBody.includes('assertThat(') ||
        methodBody.includes('$this->assert');
      if (!hasFail) {
        issues.push(`Custom assertion ${method}() does not call fail() on failure — assertion may always pass silently`);
      }
    }
  }

  if (content.includes('assertThat(')) {
    // Check assertThat usage
    const assertThatPattern = /assertThat\s*\(\s*\$[^,]{0,80},\s*(\$[^)]{0,80})\)/g;
    while ((m = assertThatPattern.exec(content)) !== null) {
      const constraintArg = m[1].trim();
      if (!constraintArg.includes('->') && !constraintArg.includes('new ') && !constraintArg.includes('::')) {
        issues.push(`assertThat() used with potentially wrong constraint type "${constraintArg}" — verify it is a PHPUnit Constraint instance`);
      }
    }
  }

  // Check if custom assertion in trait/class is documented
  const hasDocComment = content.includes('/**');
  if (assertionMethods.length > 0 && !hasDocComment) {
    issues.push('Custom assertion methods have no PHPDoc — parameter purpose and expected behavior are unclear to consumers');
  }

  return {
    file: path.basename(filePath),
    className: classM[1],
    assertionMethods,
    issues,
  };
}

export function listPhpUnitCustomAssertions(appPath: string): McpToolResult {
  try {
    const results: CustomAssertionInfo[] = [];

    for (const dir of ['tests', 'src/Tests', 'test']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseCustomAssertionFile(file);
        if (info) results.push(info);
      }
    }

    results.sort((a, b) => a.className.localeCompare(b.className));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No custom PHPUnit assertions or constraints found in tests/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHPUnit Custom Assertion Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      text += `\n  ${r.className.padEnd(45)} (${r.file})\n`;
      if (r.assertionMethods.length > 0) {
        text += `    methods: ${r.assertionMethods.join(', ')}\n`;
      }
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitCustomAssertionStats(appPath: string): McpToolResult {
  try {
    const results: CustomAssertionInfo[] = [];

    for (const dir of ['tests', 'src/Tests', 'test']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseCustomAssertionFile(file);
        if (info) results.push(info);
      }
    }

    let text = `PHPUnit Custom Assertion Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:          ${results.length}\n`;
    text += `  Extend Constraint:    ${results.filter((r) => r.assertionMethods.some((m) => m.toLowerCase().includes('assert'))).length}\n`;
    text += `  Total methods:        ${results.reduce((s, r) => s + r.assertionMethods.length, 0)}\n`;
    text += `Total issues:           ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitCustomAssertionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_custom_assertions',
      description: 'Detect custom PHPUnit assertion and constraint implementations: extends Constraint, extends Assert, static assertX() methods in test traits/classes, assertThat(); warns on missing fail() call (assertion always passes), empty toString() on Constraint (unreadable error), missing doc comment, parent::evaluate() call, assertThat() with wrong constraint type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_custom_assertion_stats',
      description: 'Statistics for custom PHPUnit assertions: total classes, method count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
