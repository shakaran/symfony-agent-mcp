/**
 * PHPUnit Test Double Inspector
 *
 * Detects test double type differentiation (stub, mock, spy, fake, dummy).
 * Pure static analysis — reads PHP test files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TestDoubleInfo {
  file: string;
  doubleType: 'stub' | 'mock' | 'spy' | 'fake' | 'dummy';
  className: string;
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

interface DoubleBlock {
  type: 'stub' | 'mock' | 'spy' | 'fake' | 'dummy';
  rawName: string;
  issues: string[];
}

function classifyDoubleInContent(content: string): DoubleBlock[] {
  const doubles: DoubleBlock[] = [];

  // Detect manual fakes: class FakeX implements Interface
  const fakePattern = /class\s+(Fake\w{1,80})\s+implements\s+(\w{1,80})/g;
  let m: RegExpExecArray | null;
  while ((m = fakePattern.exec(content)) !== null) {
    const fakeName = m[1];
    const interfaceName = m[2];
    const issues: string[] = [];

    // Check that all interface methods might be implemented — heuristic: look for at least 2 public functions
    const publicMethods = (content.match(/public\s+function\s+\w{1,80}\s*\(/g) ?? []).length;
    if (publicMethods < 2) {
      issues.push(`Fake "${fakeName}" implements ${interfaceName} but only has ${publicMethods} public method(s) — partial fake may cause surprises`);
    }

    doubles.push({ type: 'fake', rawName: fakeName, issues });
  }

  // Detect createStub — stub pattern
  const stubPattern = /createStub\s*\(\s*([^)]{1,200})\)/g;
  while ((m = stubPattern.exec(content)) !== null) {
    const arg = m[1].trim();
    const issues: string[] = [];
    // Stubs with expects() are actually mocks
    const nearbyExpects = content.slice(Math.max(0, (m.index ?? 0) - 50), (m.index ?? 0) + 300);
    if (nearbyExpects.includes('expects(') && !nearbyExpects.includes('any()')) {
      issues.push(`createStub() combined with expects() — use createMock() instead; stubs should not have call expectations`);
    }
    doubles.push({ type: 'stub', rawName: arg.replace(/['"]/g, ''), issues });
  }

  // Detect getMockBuilder — mock pattern
  const mockBuilderPattern = /getMockBuilder\s*\(\s*([^)]{1,200})\)/g;
  while ((m = mockBuilderPattern.exec(content)) !== null) {
    const arg = m[1].trim();
    const issues: string[] = [];

    // Check for expects(any()) — effectively a stub
    const nearbyContent = content.slice((m.index ?? 0), (m.index ?? 0) + 500);
    if (nearbyContent.includes('expects($this->any())') || nearbyContent.includes('expects(self::any())')) {
      issues.push(`getMockBuilder() with expects(any()) — this is effectively a stub; use createStub() instead`);
    }

    // Check multiple expects on same method
    const expectsCount = (nearbyContent.match(/->expects\s*\(/g) ?? []).length;
    if (expectsCount > 2) {
      issues.push(`Mock has ${expectsCount} expects() calls — consider splitting into separate test cases`);
    }

    doubles.push({ type: 'mock', rawName: arg.replace(/['"]/g, ''), issues });
  }

  // Detect createMock — mock pattern
  const createMockPattern = /createMock\s*\(\s*([^)]{1,200})\)/g;
  while ((m = createMockPattern.exec(content)) !== null) {
    const arg = m[1].trim();
    const issues: string[] = [];

    // Check for expects(any()) — effectively a stub
    const nearbyContent = content.slice((m.index ?? 0), (m.index ?? 0) + 500);
    if (nearbyContent.includes('expects($this->any())') || nearbyContent.includes('expects(self::any())')) {
      issues.push(`createMock() with expects(any()) — effectively a stub; use createStub() instead`);
    }

    // Check if no expects at all — this is a stub
    if (!nearbyContent.includes('expects(') && nearbyContent.includes('willReturn(')) {
      doubles.push({ type: 'stub', rawName: arg.replace(/['"]/g, ''), issues });
      continue;
    }

    doubles.push({ type: 'mock', rawName: arg.replace(/['"]/g, ''), issues });
  }

  // Detect Prophecy
  const prophecyPattern = /\$this->prophesize\s*\(\s*([^)]{1,200})\)/g;
  while ((m = prophecyPattern.exec(content)) !== null) {
    const arg = m[1].trim();
    doubles.push({ type: 'mock', rawName: arg.replace(/['"]/g, ''), issues: [] });
  }

  // Detect spy pattern (capturing calls to array/variable)
  if ((content.includes('$calls[]') || content.includes('$invocations[]') ||
    content.includes('$recorded') || content.includes('->getCalls()')) &&
    (content.includes('createMock') || content.includes('getMockBuilder'))) {
    doubles.push({ type: 'spy', rawName: '(spy pattern)', issues: ['Spy accessing internal state of SUT — prefer observable side effects or event-driven assertions'] });
  }

  return doubles;
}

function parseTestDoubleFile(filePath: string): TestDoubleInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const isTestFile = content.includes('TestCase') || filePath.includes('Test.php') ||
    filePath.includes('/tests/') || filePath.includes('/test/');
  if (!isTestFile) return [];

  const hasDoubles = content.includes('createMock') || content.includes('createStub') ||
    content.includes('getMockBuilder') || content.includes('prophesize') ||
    content.includes('class Fake') || content.includes('$calls[]');
  if (!hasDoubles) return [];

  const classM = /class\s+(\w{1,100})/.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  const doubles = classifyDoubleInContent(content);
  if (doubles.length === 0) return [];

  return doubles.map((d) => ({
    file: path.basename(filePath),
    doubleType: d.type,
    className: `${className}::${d.rawName}`,
    issues: d.issues,
  }));
}

export function listPhpUnitTestDoubles(appPath: string): McpToolResult {
  try {
    const results: TestDoubleInfo[] = [];

    for (const dir of ['tests', 'src/Tests', 'test']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        results.push(...parseTestDoubleFile(file));
      }
    }

    results.sort((a, b) => a.file.localeCompare(b.file));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPUnit test doubles found in tests/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHPUnit Test Double Analysis\n${'='.repeat(55)}\n`;
    text += `\nDoubles: ${results.length}  Issues: ${totalIssues}\n`;

    const byType: Record<string, TestDoubleInfo[]> = {};
    for (const r of results) {
      (byType[r.doubleType] ??= []).push(r);
    }

    for (const type of ['mock', 'stub', 'fake', 'spy', 'dummy']) {
      const group = byType[type] ?? [];
      if (group.length === 0) continue;
      text += `\n${type.toUpperCase()} (${group.length}):\n`;
      for (const r of group) {
        text += `  ${r.className.padEnd(60)} (${r.file})\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
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

export function getPhpUnitTestDoubleStats(appPath: string): McpToolResult {
  try {
    const results: TestDoubleInfo[] = [];

    for (const dir of ['tests', 'src/Tests', 'test']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        results.push(...parseTestDoubleFile(file));
      }
    }

    let text = `PHPUnit Test Double Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total doubles:  ${results.length}\n`;
    for (const type of ['mock', 'stub', 'fake', 'spy', 'dummy']) {
      text += `  ${type.padEnd(10)} ${results.filter((r) => r.doubleType === type).length}\n`;
    }
    text += `Total issues:   ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitTestDoubleTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_test_doubles',
      description: 'Detect and classify test double types (stub/mock/spy/fake/dummy): createStub(), createMock(), getMockBuilder(), willReturn(), expects($this->once()), Prophecy prophesize, spy call-capturing patterns, manual Fake classes; warns on mock with expects(any()) (use stub), multiple expects on same method, partial fake implementations, spy on SUT internal state',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_test_double_stats',
      description: 'Statistics for PHPUnit test doubles: total count, breakdown by type (mock/stub/fake/spy/dummy), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
