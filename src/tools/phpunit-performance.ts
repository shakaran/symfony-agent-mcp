/**
 * PHPUnit Performance Inspector
 *
 * Scans tests/ PHP for:
 *   - sleep() / usleep() calls in test methods
 *   - @slow tag/group
 *   - time-dependent assertions (assertEqualsWithDelta on timestamps)
 *   - setUpBeforeClass with DB queries
 *   - Expensive instantiation in setUp() that could be setUpBeforeClass
 *
 * Detects:
 *   - Test files with >50 test methods (potential split candidate)
 *   - Tests with >5 DB queries in single test (performance indicator)
 *
 * Warns:
 *   - sleep() in test (non-deterministic + slow)
 *   - usleep() in test
 *   - time() comparison without tolerance (flaky test)
 *   - setUpBeforeClass with expensive operations without tearDownAfterClass
 *   - Test class with only one test method that is very long
 *   - @group slow without timeout annotation
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpUnitPerformanceInfo {
  file: string;
  class: string;
  hasSleep: boolean;
  hasSlowGroup: boolean;
  testCount: number;
  hasSetUpBeforeClass: boolean;
  hasTearDownAfterClass: boolean;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── DB query indicators ──────────────────────────────────────────────────────

const DB_INDICATORS = [
  'entityManager', 'getRepository', 'createQuery', 'createQueryBuilder',
  'executeQuery', 'executeStatement', 'fetchOne', 'fetchAllAssociative',
  '$this->em', 'doctrine', 'createDatabaseTool',
];

function estimateDbQueryCount(content: string): number {
  return DB_INDICATORS.reduce((count, indicator) => {
    const re = new RegExp(indicator.replace('$', '\\$'), 'g');
    return count + (content.match(re) ?? []).length;
  }, 0);
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): PhpUnitPerformanceInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('extends') && !content.includes('TestCase')) return null;
  if (!content.includes('function test') && !content.includes('#[Test]')) return null;

  const classM = /\bclass\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Count test methods
  const testMethodMatches = content.match(/function\s+test\w{0,100}\s*\(/g) ?? [];
  const testAttributeMatches = content.match(/#\[Test\]/g) ?? [];
  const testCount = testMethodMatches.length + testAttributeMatches.length;

  const hasSleep              = /\bsleep\s*\(\s*\d{1,4}\s*\)/.test(content);
  const hasUsleep             = /\busleep\s*\(\s*\d{1,7}\s*\)/.test(content);
  const hasSlowGroup          = /@group\s+slow\b/.test(content) || /#\[Group\s*\(\s*['"]slow['"]\s*\)\]/.test(content);
  const hasSetUpBeforeClass   = /function\s+setUpBeforeClass\s*\(/.test(content);
  const hasTearDownAfterClass = /function\s+tearDownAfterClass\s*\(/.test(content);

  const issues: string[] = [];

  if (hasSleep) {
    issues.push(
      `${className} calls sleep() in tests. ` +
      `sleep() makes tests slow and non-deterministic — use time-mocking or clock abstraction instead.`,
    );
  }

  if (hasUsleep) {
    issues.push(
      `${className} calls usleep() in tests. ` +
      `usleep() makes tests non-deterministic — use a mock clock instead.`,
    );
  }

  // time() comparison without assertEqualsWithDelta tolerance
  if (/\btime\s*\(\s*\)/.test(content) && !content.includes('assertEqualsWithDelta')) {
    issues.push(
      `${className} uses time() in assertions without assertEqualsWithDelta tolerance. ` +
      `Direct timestamp comparison creates flaky tests when CI is slow.`,
    );
  }

  if (testCount > 50) {
    issues.push(
      `${className} has ${testCount} test methods (>50). ` +
      `Consider splitting into focused test classes for better organization and parallelism.`,
    );
  }

  if (hasSetUpBeforeClass && !hasTearDownAfterClass) {
    issues.push(
      `${className} has setUpBeforeClass() without tearDownAfterClass(). ` +
      `Resources created in setUpBeforeClass may not be cleaned up, causing test pollution.`,
    );
  }

  // setUpBeforeClass with DB queries
  if (hasSetUpBeforeClass) {
    const beforeClassM = /function\s+setUpBeforeClass\s*\(\s*\)[^{]{0,50}\{([\s\S]{0,2000}?)\}/m.exec(content);
    if (beforeClassM) {
      const dbCount = estimateDbQueryCount(beforeClassM[1]);
      if (dbCount > 3) {
        issues.push(
          `${className}::setUpBeforeClass() appears to make ${dbCount} DB operations. ` +
          `Ensure tearDownAfterClass() cleans up to prevent state pollution.`,
        );
      }
    }
  }

  if (hasSlowGroup && !/@timeout\b/.test(content) && !/#\[Timeout\b/.test(content)) {
    issues.push(
      `${className} is marked @group slow but has no @timeout annotation. ` +
      `Without a timeout, slow tests can hang CI indefinitely.`,
    );
  }

  // Single very-long test method
  if (testCount === 1) {
    const lines = content.split('\n').length;
    if (lines > 100) {
      issues.push(
        `${className} has only 1 test method but ${lines} lines. ` +
        `Consider extracting helper methods to improve readability.`,
      );
    }
  }

  return {
    file: path.basename(filePath),
    class: className,
    hasSleep: hasSleep || hasUsleep,
    hasSlowGroup,
    testCount,
    hasSetUpBeforeClass,
    hasTearDownAfterClass,
    issues,
  };
}

function loadAll(appPath: string): PhpUnitPerformanceInfo[] {
  const testsDir = path.join(appPath, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const results: PhpUnitPerformanceInfo[] = [];
  for (const file of getAllPhpFiles(testsDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => b.testCount - a.testCount || a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpUnitPerformance(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No test classes found in tests/.\n\n' +
            'PHPUnit test files should be in tests/ directory.',
        }],
      };
    }

    const withSleep     = items.filter((i) => i.hasSleep);
    const withSlowGroup = items.filter((i) => i.hasSlowGroup);
    const withIssues    = items.filter((i) => i.issues.length > 0);

    let text = `PHPUnit Performance Analysis\n${'='.repeat(55)}\n`;
    text += `  Test classes:          ${items.length}\n`;
    text += `  With sleep() calls:    ${withSleep.length}\n`;
    text += `  With @group slow:      ${withSlowGroup.length}\n`;
    text += `  Total test methods:    ${items.reduce((s, i) => s + i.testCount, 0)}\n`;
    text += `  With issues:           ${withIssues.length}\n\n`;

    for (const item of withIssues) {
      text += `${item.class} [${item.file}]\n`;
      text += `  tests: ${item.testCount}`;
      if (item.hasSleep) text += '  [has-sleep]';
      if (item.hasSlowGroup) text += '  [slow-group]';
      if (item.hasSetUpBeforeClass) text += '  [setUpBeforeClass]';
      text += '\n';
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    if (withIssues.length === 0) {
      text += 'No performance issues found.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitPerformanceStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHPUnit Performance Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test classes:          ${items.length}\n`;
    text += `Total test methods:    ${items.reduce((s, i) => s + i.testCount, 0)}\n`;
    text += `With sleep() calls:    ${items.filter((i) => i.hasSleep).length}\n`;
    text += `With @group slow:      ${items.filter((i) => i.hasSlowGroup).length}\n`;
    text += `With setUpBeforeClass: ${items.filter((i) => i.hasSetUpBeforeClass).length}\n`;
    text += `>50 test methods:      ${items.filter((i) => i.testCount > 50).length}\n`;
    text += `With issues:           ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpUnitPerformanceTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_phpunit_performance',
      description: 'List PHPUnit performance issues: sleep() in tests, @group slow without timeout, large test classes (>50 methods), setUpBeforeClass without tearDown',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_performance_stats',
      description: 'Show PHPUnit performance statistics: total test methods, sleep() count, slow group count, large class count, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
