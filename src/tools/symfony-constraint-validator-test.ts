// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Constraint Validator Test Inspector
 *
 * Scans tests/ and src/Tests/ for ConstraintValidatorTestCase subclasses:
 *   - buildViolation() calls, assertViolation()/assertNoViolation()
 *   - createConstraint(), validate()
 *   - Naming convention check (test class vs tested validator)
 *   - Missing null/empty value tests
 *   - Unfinalised buildViolation() chains
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ConstraintValidatorTestInfo {
  file: string;
  class: string;
  validatorClass?: string;
  violationTests: number;
  noViolationTests: number;
  hasNullTest: boolean;
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

function scanConstraintValidatorTests(appPath: string): ConstraintValidatorTestInfo[] {
  const dirs = [
    path.join(appPath, 'tests'),
    path.join(appPath, 'src', 'Tests'),
  ];

  const results: ConstraintValidatorTestInfo[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of getAllPhpFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('ConstraintValidatorTestCase')) continue;

      const classMatch = /class\s+(\w{1,100})\s+extends\s+ConstraintValidatorTestCase/.exec(content);
      if (!classMatch) continue;

      const className = classMatch[1];

      // Detect which validator class is being tested (naming convention: FooValidatorTest -> FooValidator)
      let validatorClass: string | undefined;
      const validatorM = /getValidatorClass\s*\(\s*\)[^{]{0,50}\{[^}]{0,200}return\s+(\w{1,100})::class/.exec(content) ??
        /createConstraint\s*\(\s*\)[^{]{0,50}\{[^}]{0,200}return\s+new\s+(\w{1,100})/.exec(content);
      if (validatorM) {
        validatorClass = validatorM[1];
      } else {
        // Infer from class name
        const inferred = className.replace(/Test$/, '');
        if (inferred !== className) validatorClass = inferred;
      }

      // Count violation/no-violation assertions
      const buildViolationCount = (content.match(/buildViolation\s*\(/g) ?? []).length;
      const assertRaisedCount = (content.match(/->assertRaised\s*\(\s*\)/g) ?? []).length;
      const noViolationCount = (content.match(/assertNoViolation\s*\(\s*\)/g) ?? []).length;
      const hasNullTest = /null\s*\)|validate\s*\(\s*null/.test(content) ||
        /empty.*validate|validate.*empty/.test(content);

      const issues: string[] = [];

      // Naming convention check
      if (validatorClass && className !== `${validatorClass}Test`) {
        issues.push(`Test class "${className}" doesn't follow naming convention for "${validatorClass}" (expected: ${validatorClass}Test)`);
      }

      if (noViolationCount === 0) {
        issues.push('No assertNoViolation() calls — valid input cases are not tested');
      }

      if (!hasNullTest) {
        issues.push('No test for null/empty value handling');
      }

      // buildViolation() chains without ->assertRaised()
      if (buildViolationCount > assertRaisedCount) {
        issues.push(`${buildViolationCount - assertRaisedCount} buildViolation() call(s) without ->assertRaised() — assertion never finalised`);
      }

      // Check if multiple constraints tested per method
      const methods = content.match(/(?:public\s+)?function\s+test\w{1,80}\s*\([^)]{0,200}\)\s*:[^{]{0,80}\{[^}]{0,1000}\}/gu) ?? [];
      for (const method of methods) {
        const validateCalls = (method.match(/->validate\s*\(/g) ?? []).length;
        if (validateCalls > 2) {
          issues.push('Test method calls validate() more than twice — consider splitting into multiple tests for better isolation');
          break;
        }
      }

      results.push({
        file: path.relative(appPath, file),
        class: className,
        validatorClass,
        violationTests: assertRaisedCount,
        noViolationTests: noViolationCount,
        hasNullTest,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listConstraintValidatorTests(appPath: string): McpToolResult {
  try {
    const items = scanConstraintValidatorTests(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No ConstraintValidatorTestCase subclasses found in tests/ or src/Tests/.' }] };
    }

    let text = `Constraint Validator Tests\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} test class(es):\n\n`;

    for (const item of items) {
      text += `  ${item.class}\n`;
      text += `    File:             ${item.file}\n`;
      if (item.validatorClass) text += `    Validator:        ${item.validatorClass}\n`;
      text += `    Violation tests:  ${item.violationTests}\n`;
      text += `    No-violation tests: ${item.noViolationTests}\n`;
      text += `    Tests null input: ${item.hasNullTest ? 'yes' : 'NO'}\n`;
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

export function getConstraintValidatorTestStats(appPath: string): McpToolResult {
  try {
    const items = scanConstraintValidatorTests(appPath);

    const withIssues = items.filter((i) => i.issues.length > 0).length;
    const withNoViolation = items.filter((i) => i.noViolationTests > 0).length;
    const withNullTest = items.filter((i) => i.hasNullTest).length;
    const totalViolation = items.reduce((s, i) => s + i.violationTests, 0);

    let text = `Constraint Validator Test Stats\n${'='.repeat(40)}\n\n`;
    text += `Total test classes:        ${items.length}\n`;
    text += `With no-violation tests:   ${withNoViolation}\n`;
    text += `With null input test:      ${withNullTest}\n`;
    text += `Total violation assertions: ${totalViolation}\n`;
    text += `Classes with issues:       ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getConstraintValidatorTestTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_constraint_validator_tests',
      description: 'Scan tests/ for ConstraintValidatorTestCase subclasses: violation/no-violation test counts, null tests, naming convention, unfinalised assertions',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_constraint_validator_test_stats',
      description: 'Statistics for ConstraintValidatorTestCase tests: total count, coverage gaps, violation assertion totals',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
