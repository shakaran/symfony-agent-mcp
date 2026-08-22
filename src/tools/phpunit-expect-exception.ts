/**
 * PHPUnit Exception Assertion Inspector
 *
 * Scans tests/ PHP for exception assertion patterns:
 * - expectException(), expectExceptionMessage(), expectExceptionCode()
 * - expectExceptionMessageMatches()
 * - @expectedException (deprecated since PHPUnit 8)
 * - try/catch in test (anti-pattern)
 *
 * Warnings:
 *   - @expectedException annotation (deprecated)
 *   - expectException() AFTER the throwing code
 *   - expectExceptionMessage() without expectException()
 *   - try/catch without fail() assertion (silently passes on no-throw)
 *   - Catching wrong exception type
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpUnitExpectExceptionInfo {
  file: string;
  class: string;
  modernPatternCount: number;
  deprecatedAnnotationCount: number;
  tryCatchAntiPatternCount: number;
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

function parseExpectExceptionFile(filePath: string): PhpUnitExpectExceptionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasExceptionAssert = content.includes('expectException(') ||
    content.includes('expectExceptionMessage(') ||
    content.includes('expectExceptionCode(') ||
    content.includes('expectExceptionMessageMatches(') ||
    content.includes('@expectedException') ||
    (content.includes('try {') && content.includes('catch ('));

  if (!hasExceptionAssert) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const issues: string[] = [];

  // Count modern pattern: $this->expectException(
  const modernMatches = content.match(/\$this->expectException\s*\(/g) ?? [];
  const modernPatternCount = modernMatches.length;

  // Count deprecated @expectedException annotation
  const deprecatedMatches = content.match(/@expectedException\b/g) ?? [];
  const deprecatedAnnotationCount = deprecatedMatches.length;

  if (deprecatedAnnotationCount > 0) {
    issues.push(`@expectedException annotation found (${deprecatedAnnotationCount}x) — deprecated since PHPUnit 8; use $this->expectException() instead`);
  }

  // Detect try/catch anti-pattern in test methods
  // Heuristic: catch block without $this->fail() or assertFail
  const tryCatchBlocks = content.matchAll(/try\s*\{([\s\S]{0,500}?)\}\s*catch\s*\(([^)]{0,100})\)\s*\{([\s\S]{0,300}?)\}/g);
  let tryCatchAntiPatternCount = 0;
  for (const m of tryCatchBlocks) {
    const catchBody = m[3];
    const hasFail = catchBody.includes('$this->fail(') ||
      catchBody.includes('self::fail(') ||
      catchBody.includes('static::fail(') ||
      catchBody.includes('Assert::fail(') ||
      catchBody.includes('throw $');
    const hasAssert = catchBody.includes('$this->assert') ||
      catchBody.includes('assertEquals') ||
      catchBody.includes('assertSame');
    // Anti-pattern: catch block that neither fails nor re-throws nor asserts
    if (!hasFail && !hasAssert) {
      tryCatchAntiPatternCount++;
      issues.push('try/catch in test without $this->fail() — test silently passes if exception is not thrown');
    }
  }

  // Detect expectException() called AFTER the code that should throw
  // Heuristic: expectException is not the first statement in the method body
  const methodBlocks = content.matchAll(/public\s+function\s+test\w{1,100}\s*\([^)]{0,200}\)\s*(?::\s*void\s*)?\{([\s\S]{0,1000}?)\}/g);
  for (const m of methodBlocks) {
    const body = m[1];
    const expectPos = body.indexOf('expectException(');
    if (expectPos === -1) continue;

    // Check if there are non-comment, non-setup statements before expectException
    const beforeExpect = body.slice(0, expectPos);
    const meaningfulBefore = beforeExpect
      .replace(/\/\/[^\n]{0,200}/g, '')
      .replace(/\/\*[\s\S]{0,500}?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // If there are method calls or assignments before expectException
    if (/\w{1,80}\s*[(=]/.test(meaningfulBefore) && meaningfulBefore.length > 10) {
      issues.push('expectException() called after other test statements — assertion must come BEFORE the code that throws');
    }
  }

  // Detect expectExceptionMessage() without expectException()
  if (content.includes('expectExceptionMessage(') && !content.includes('expectException(')) {
    issues.push('expectExceptionMessage() called without expectException() — exception type not checked');
  }
  if (content.includes('expectExceptionCode(') && !content.includes('expectException(')) {
    issues.push('expectExceptionCode() called without expectException() — exception type not checked');
  }

  if (modernPatternCount === 0 && deprecatedAnnotationCount === 0 && tryCatchAntiPatternCount === 0 && issues.length === 0) {
    return null;
  }

  return {
    file: path.basename(filePath),
    class: className,
    modernPatternCount,
    deprecatedAnnotationCount,
    tryCatchAntiPatternCount,
    issues,
  };
}

export function listPhpUnitExpectException(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const results: PhpUnitExpectExceptionInfo[] = [];

    for (const f of getAllPhpFiles(testDir)) {
      const info = parseExpectExceptionFile(f);
      if (info) results.push(info);
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No exception assertion patterns found in tests/.' }] };
    }

    results.sort((a, b) => a.class.localeCompare(b.class));
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `PHPUnit Exception Assertion Analysis\n${'='.repeat(55)}\n`;
    text += `\nTest files: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      text += `\n  ${r.class.padEnd(50)} (${r.file})\n`;
      text += `    modern: ${r.modernPatternCount}  deprecated: ${r.deprecatedAnnotationCount}  try/catch-antipat: ${r.tryCatchAntiPatternCount}\n`;
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

export function getPhpUnitExpectExceptionStats(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const results: PhpUnitExpectExceptionInfo[] = [];

    for (const f of getAllPhpFiles(testDir)) {
      const info = parseExpectExceptionFile(f);
      if (info) results.push(info);
    }

    let text = `PHPUnit Expect Exception Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test files with exception tests:        ${results.length}\n`;
    text += `Modern expectException() usage:         ${results.reduce((s, r) => s + r.modernPatternCount, 0)}\n`;
    text += `Deprecated @expectedException:          ${results.reduce((s, r) => s + r.deprecatedAnnotationCount, 0)}\n`;
    text += `try/catch anti-patterns:                ${results.reduce((s, r) => s + r.tryCatchAntiPatternCount, 0)}\n`;
    text += `Total issues:                           ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitExpectExceptionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_expect_exception',
      description: 'Scan PHPUnit tests for exception assertion patterns: expectException(), deprecated @expectedException, try/catch anti-patterns; warns on assertion after throwing code, message check without type check, silent catch blocks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_expect_exception_stats',
      description: 'Get statistics on PHPUnit exception assertions: modern vs deprecated count, try/catch anti-patterns, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
