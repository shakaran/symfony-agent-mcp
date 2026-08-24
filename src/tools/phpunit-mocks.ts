// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MockUsageInfo {
  file: string;
  class?: string;
  createMockCount: number;
  getMockBuilderCount: number;
  createStubCount: number;
  createPartialMockCount: number;
  hasExpectsAny: boolean;
  issues: string[];
}

function getAllPhpTestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpTestFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseMockUsage(filePath: string, appPath: string): MockUsageInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('createMock') && !content.includes('getMockBuilder') && !content.includes('createStub')) return null;
  if (!content.includes('TestCase') && !content.includes('PHPUnit')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const createMockCount = [...content.matchAll(/\$this->createMock\s*\(/g)].length;
  const getMockBuilderCount = [...content.matchAll(/\$this->getMockBuilder\s*\(/g)].length;
  const createStubCount = [...content.matchAll(/\$this->createStub\s*\(/g)].length;
  const createPartialMockCount = [...content.matchAll(/\$this->createPartialMock\s*\(/g)].length;
  const hasExpectsAny = content.includes('->expects($this->any())') || content.includes('->expects(self::any())');
  const issues: string[] = [];
  if (getMockBuilderCount > 0 && !content.includes('->onlyMethods(')) issues.push('getMockBuilder() without onlyMethods() — all methods mocked; specify onlyMethods() to avoid over-mocking');
  if (hasExpectsAny) issues.push('->expects($this->any()) found — use createStub() instead for stubs that return values without assertions');
  if (getMockBuilderCount > 2) issues.push(`High getMockBuilder() count (${getMockBuilderCount}) — prefer createMock() for simpler stubs`);
  return { file: path.relative(appPath, filePath), class: classM?.[1], createMockCount, getMockBuilderCount, createStubCount, createPartialMockCount, hasExpectsAny, issues };
}

export function listPhpUnitMocks(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    if (!fs.existsSync(testDir)) return { content: [{ type: 'text', text: 'No tests/ directory found.' }] };
    const all: MockUsageInfo[] = [];
    for (const file of getAllPhpTestFiles(testDir)) {
      const m = parseMockUsage(file, appPath);
      if (m) all.push(m);
    }
    if (all.length === 0) return { content: [{ type: 'text', text: 'No PHPUnit mock usage found.' }] };
    const totalIssues = all.reduce((s, m) => s + m.issues.length, 0);
    let text = `PHPUnit Mocks\n${'='.repeat(55)}\n\nFiles: ${all.length}  Issues: ${totalIssues}\n`;
    text += `  createMock: ${all.reduce((s, m) => s + m.createMockCount, 0)}  getMockBuilder: ${all.reduce((s, m) => s + m.getMockBuilderCount, 0)}  createStub: ${all.reduce((s, m) => s + m.createStubCount, 0)}\n`;
    for (const m of all.filter((x) => x.issues.length > 0).sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${m.class ?? '(file)'}  mock: ${m.createMockCount}  builder: ${m.getMockBuilderCount}  stub: ${m.createStubCount}  (${m.file})\n`;
      for (const i of m.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitMockStats(appPath: string): McpToolResult {
  try {
    const testDir = path.join(appPath, 'tests');
    const all: MockUsageInfo[] = [];
    if (fs.existsSync(testDir)) {
      for (const file of getAllPhpTestFiles(testDir)) {
        const m = parseMockUsage(file, appPath);
        if (m) all.push(m);
      }
    }
    let text = `PHPUnit Mock Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${all.length}\n  createMock: ${all.reduce((s, m) => s + m.createMockCount, 0)}\n  getMockBuilder: ${all.reduce((s, m) => s + m.getMockBuilderCount, 0)}\n  createStub: ${all.reduce((s, m) => s + m.createStubCount, 0)}\n  expects($this->any()): ${all.filter((m) => m.hasExpectsAny).length}\nIssues: ${all.reduce((s, m) => s + m.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpUnitMockTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_phpunit_mocks', description: 'Show PHPUnit mock usage: createMock/getMockBuilder/createStub counts, getMockBuilder without onlyMethods warning, expects($this->any()) anti-pattern, high builder count warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_phpunit_mock_stats', description: 'Show PHPUnit mock statistics: file count, per-method type counts, expects-any count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
