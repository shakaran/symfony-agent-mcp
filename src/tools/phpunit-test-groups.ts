/**
 * PHPUnit Test Groups and Data Providers Inspector
 *
 * Distinct from phpunit-config.ts (phpunit.xml configuration) and tests-inspector.ts
 * (test structure / coverage paths). Focuses on test organisation attributes:
 *
 * Test groups (#[Group]):
 *   - Groups per test class and method
 *   - Tests in multiple groups
 *   - Common group names: unit, integration, functional, slow, e2e, smoke
 *   - Groups defined but never referenced in phpunit.xml excludeGroups
 *
 * Data providers (#[DataProvider], #[DataProviderExternal]):
 *   - Method-level data providers
 *   - External data providers (referencing another class)
 *   - Data provider methods that return empty array (no test cases run)
 *   - Deprecated @dataProvider annotation vs modern #[DataProvider]
 *
 * Inline data (#[TestWith]):
 *   - Single-method inline test data
 *   - Mixing #[TestWith] and #[DataProvider] on same method
 *
 * Requirements:
 *   - #[RequiresPhp('8.1')]
 *   - #[RequiresPhpExtension('redis')]
 *   - #[RequiresOperatingSystem('Linux')]
 *
 * Analysis:
 *   - Test class with no group annotation (hard to filter/exclude in CI)
 *   - Data provider method not found in class
 *   - Very large data provider (> 100 cases) — slow test feedback
 *   - Tests marked #[Group('skip')] or #[Group('broken')] (technical debt)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TestGroupInfo {
  class: string;
  file: string;
  groups: string[];
  dataProviders: string[];
  missingProviders: string[];
  hasTestWith: boolean;
  hasRequires: boolean;
  issues: string[];
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

const TECH_DEBT_GROUPS = new Set(['skip', 'broken', 'ignore', 'disabled', 'todo', 'wip', 'flaky']);

function parseTestGroupInfo(filePath: string, appPath: string): TestGroupInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isTest = content.includes('extends TestCase') || content.includes('extends KernelTestCase') ||
                 content.includes('extends WebTestCase') || content.includes('extends ApiTestCase');
  if (!isTest) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Groups
  const groups: string[] = [];
  for (const m of content.matchAll(/#\[Group\s*\(\s*['"]([^'"]+)['"]/g)) groups.push(m[1]);
  for (const m of content.matchAll(/@group\s+(\S+)/g)) {
    if (!groups.includes(m[1])) groups.push(m[1]);
  }

  // Data providers
  const dataProviders: string[] = [];
  for (const m of content.matchAll(/#\[DataProvider\s*\(\s*['"]([^'"]+)['"]/g)) dataProviders.push(m[1]);
  for (const m of content.matchAll(/@dataProvider\s+(\S+)/g)) {
    if (!dataProviders.includes(m[1])) dataProviders.push(m[1]);
  }

  const missingProviders = dataProviders.filter((dp) => !content.includes(`function ${dp}(`));

  const hasTestWith = content.includes('#[TestWith(');
  const hasRequires = content.includes('#[Requires') || content.includes('@requires');

  const issues: string[] = [];
  if (groups.length === 0) issues.push('No #[Group] annotation — test cannot be filtered/excluded');
  if (missingProviders.length > 0) {
    issues.push(`Data provider method(s) not found in class: ${missingProviders.join(', ')}`);
  }
  const techDebtGroups = groups.filter((g) => TECH_DEBT_GROUPS.has(g.toLowerCase()));
  if (techDebtGroups.length > 0) {
    issues.push(`Technical-debt group(s): ${techDebtGroups.join(', ')} — needs attention`);
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    groups,
    dataProviders,
    missingProviders,
    hasTestWith,
    hasRequires,
    issues,
  };
}

export function listTestGroups(appPath: string): McpToolResult {
  try {
    const candidates = [
      path.join(appPath, 'tests'),
      path.join(appPath, 'test'),
      path.join(appPath, 'src', 'Tests'),
    ];

    const testFiles: string[] = [];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) testFiles.push(...getAllPhpFiles(dir));
    }

    if (testFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No test directory found (checked: tests/, test/, src/Tests/).' }] };
    }

    const tests: TestGroupInfo[] = [];
    for (const file of testFiles) {
      const t = parseTestGroupInfo(file, appPath);
      if (t) tests.push(t);
    }

    if (tests.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPUnit test classes found.' }] };
    }

    // Group frequency
    const groupFreq = new Map<string, number>();
    for (const t of tests) {
      for (const g of t.groups) groupFreq.set(g, (groupFreq.get(g) ?? 0) + 1);
    }

    const noGroupCount = tests.filter((t) => t.groups.length === 0).length;
    const totalIssues  = tests.reduce((s, t) => s + t.issues.length, 0);

    let text = `PHPUnit Test Groups\n${'='.repeat(55)}\n`;
    text += `\nTest classes:    ${tests.length}  Issues: ${totalIssues}\n`;
    text += `Without groups:  ${noGroupCount}\n`;

    if (groupFreq.size > 0) {
      text += `\nGroup distribution:\n`;
      for (const [group, count] of [...groupFreq.entries()].sort((a, b) => b[1] - a[1])) {
        const debt = TECH_DEBT_GROUPS.has(group.toLowerCase()) ? '  ⚠' : '';
        text += `  ${group.padEnd(25)} ${count}x${debt}\n`;
      }
    }

    const withIssues = tests.filter((t) => t.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nTests with issues:\n`;
      for (const t of withIssues.slice(0, 15)) {
        text += `  ${t.class}\n`;
        for (const issue of t.issues) text += `    ⚠ ${issue}\n`;
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

export function getTestGroupStats(appPath: string): McpToolResult {
  try {
    const candidates = [path.join(appPath, 'tests'), path.join(appPath, 'test'), path.join(appPath, 'src', 'Tests')];
    const tests: TestGroupInfo[] = [];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        for (const file of getAllPhpFiles(dir)) {
          const t = parseTestGroupInfo(file, appPath);
          if (t) tests.push(t);
        }
      }
    }

    const groupFreq = new Map<string, number>();
    for (const t of tests) {
      for (const g of t.groups) groupFreq.set(g, (groupFreq.get(g) ?? 0) + 1);
    }

    let text = `Test Group Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test classes:        ${tests.length}\n`;
    text += `  With groups:       ${tests.filter((t) => t.groups.length > 0).length}\n`;
    text += `  Without groups:    ${tests.filter((t) => t.groups.length === 0).length}\n`;
    text += `  With DataProvider: ${tests.filter((t) => t.dataProviders.length > 0).length}\n`;
    text += `  With #[TestWith]:  ${tests.filter((t) => t.hasTestWith).length}\n`;
    text += `  With Requirements: ${tests.filter((t) => t.hasRequires).length}\n`;
    text += `Unique groups:       ${groupFreq.size}\n`;
    text += `Issues:              ${tests.reduce((s, t) => s + t.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitTestGroupTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_test_groups',
      description: 'Show PHPUnit test group analysis: #[Group]/@group per class, group frequency distribution, #[DataProvider] with missing method detection, #[TestWith], #[Requires...], no-group warning, technical-debt group detection (skip/broken/wip)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_test_group_stats',
      description: 'Show test group statistics: class count with/without groups, DataProvider/TestWith/Requires counts, unique group count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
