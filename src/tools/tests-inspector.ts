/**
 * Symfony Test Suite Inspector
 *
 * Scans tests/ directory to provide:
 *   - Test class inventory grouped by layer (Unit / Integration / Functional / E2E)
 *   - Coverage mapping: which src/ classes have a corresponding test file
 *   - Statistics: test count per layer, untested services/controllers/entities
 *   - PHPUnit configuration summary (phpunit.xml / phpunit.xml.dist)
 *
 * Pure static analysis — no test execution required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type TestLayer = 'Unit' | 'Integration' | 'Functional' | 'E2E' | 'Other';

interface TestClass {
  name: string;
  file: string;
  relativePath: string;
  layer: TestLayer;
  methodCount: number;
  extends?: string;
  dataProviders: number;
}

interface CoverageEntry {
  srcClass: string;
  srcFile: string;
  hasTest: boolean;
  testFiles: string[];
}

// ─── File scanning ─────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch {
    // Skip
  }
  return files;
}

function detectLayer(relativePath: string, content: string): TestLayer {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/');

  if (lower.includes('/e2e/') || lower.includes('/end-to-end/') || content.includes('Panther'))
    return 'E2E';
  if (lower.includes('/functional/') || lower.includes('/controller/') || lower.includes('WebTestCase'))
    return 'Functional';
  if (lower.includes('/integration/') || content.includes('KernelTestCase'))
    return 'Integration';
  if (lower.includes('/unit/') || content.includes('extends TestCase') || content.includes('extends MockeryTestCase'))
    return 'Unit';

  // Fallback: if it extends KernelTestCase → Integration, WebTestCase → Functional
  if (/extends\s+KernelTestCase/.test(content)) return 'Integration';
  if (/extends\s+WebTestCase/.test(content)) return 'Functional';

  return 'Other';
}

function parseTestFile(filePath: string, baseDir: string): TestClass | null {
  const content = safeRead(filePath, baseDir);
  if (content === null) return null;

  // Must have at least one test method
  if (!content.includes('#[Test]') && !content.includes('@test') && !/function test\w+/.test(content)) {
    return null;
  }

  const classMatch = /class\s+(\w+)/.exec(content);
  if (!classMatch) return null;

  const extendsMatch = /extends\s+(\w+)/.exec(content);
  const relativePath = path.relative(baseDir, filePath);
  const layer = detectLayer(relativePath, content);

  // Count test methods: function testXxx() or #[Test] functions
  const testMethodMatches = [
    ...content.matchAll(/function\s+(test\w+)\s*\(/g),
    ...content.matchAll(/#\[Test\]\s*(?:public\s+)?function\s+(\w+)\s*\(/g),
  ];
  const methodCount = testMethodMatches.length;

  // Count data providers
  const dataProviderCount = (content.match(/#\[DataProvider|@dataProvider/g) ?? []).length;

  return {
    name: classMatch[1],
    file: path.basename(filePath),
    relativePath,
    layer,
    methodCount,
    extends: extendsMatch ? extendsMatch[1] : undefined,
    dataProviders: dataProviderCount,
  };
}

function loadTestClasses(appPath: string): TestClass[] {
  const testDirs = [
    path.join(appPath, 'tests'),
    path.join(appPath, 'test'),
  ];

  const classes: TestClass[] = [];
  for (const dir of testDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      const tc = parseTestFile(file, dir);
      if (tc) classes.push(tc);
    }
  }
  return classes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// ─── Coverage mapping ──────────────────────────────────────────────────────

function buildCoverageMap(appPath: string, tests: TestClass[]): CoverageEntry[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const testFileIndex = new Map<string, string[]>();
  for (const t of tests) {
    const stem = t.file.toLowerCase().replace(/test\.php$/, '.php').replace(/\.php$/, '');
    const arr = testFileIndex.get(stem) ?? [];
    arr.push(t.file);
    testFileIndex.set(stem, arr);
  }

  const entries: CoverageEntry[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const base = path.basename(file).toLowerCase();
    // Skip interfaces, abstract classes, DTOs, etc.
    const content = safeRead(file, srcDir);
    if (content === null) continue;
    if (/^\s*interface\s+/m.test(content) || /^\s*abstract\s+class\s+/m.test(content)) continue;
    if (/^\s*trait\s+/m.test(content)) continue;

    const stem = base.replace('.php', '');
    const testStem = stem + 'test';

    const matchingTests = tests.filter(
      (t) =>
        t.file.toLowerCase() === `${stem}test.php` ||
        t.file.toLowerCase() === `${testStem}.php` ||
        t.name.toLowerCase() === `${stem}test` ||
        t.name.toLowerCase() === testStem
    );

    entries.push({
      srcClass: path.basename(file, '.php'),
      srcFile: path.relative(srcDir, file),
      hasTest: matchingTests.length > 0,
      testFiles: matchingTests.map((t) => t.file),
    });
  }

  return entries.sort((a, b) => a.srcFile.localeCompare(b.srcFile));
}

// ─── PHPUnit config ────────────────────────────────────────────────────────

function parsePhpUnitConfig(appPath: string): Record<string, string> {
  const candidates = [
    path.join(appPath, 'phpunit.xml'),
    path.join(appPath, 'phpunit.xml.dist'),
  ];

  for (const file of candidates) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const info: Record<string, string> = { file: path.basename(file) };

      const bootstrapMatch = /bootstrap="([^"]+)"/.exec(content);
      if (bootstrapMatch) info['bootstrap'] = bootstrapMatch[1];

      const cacheMatch = /cacheDirectory="([^"]+)"/.exec(content);
      if (cacheMatch) info['cacheDirectory'] = cacheMatch[1];

      const colorsMatch = /colors="([^"]+)"/.exec(content);
      if (colorsMatch) info['colors'] = colorsMatch[1];

      // Count test suites
      const suites = (content.match(/<testsuite\s/g) ?? []).length;
      info['testSuites'] = String(suites);

      return info;
    } catch {
      continue;
    }
  }

  return {};
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listTestClasses(appPath: string): McpToolResult {
  try {
    const tests = loadTestClasses(appPath);

    if (tests.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No test classes found.\n\nExpected: tests/\n\nCreate with: php bin/console make:test',
        }],
      };
    }

    const layers: Record<TestLayer, TestClass[]> = {
      Unit: [], Integration: [], Functional: [], E2E: [], Other: [],
    };
    for (const t of tests) (layers[t.layer] ??= []).push(t);

    const totalMethods = tests.reduce((s, t) => s + t.methodCount, 0);

    let text = `Test Suite (${tests.length} classes, ${totalMethods} test methods)\n${'─'.repeat(60)}\n`;

    for (const layer of ['Unit', 'Integration', 'Functional', 'E2E', 'Other'] as TestLayer[]) {
      const group = layers[layer];
      if (group.length === 0) continue;
      const methodSum = group.reduce((s, t) => s + t.methodCount, 0);
      text += `\n  ${layer} (${group.length} classes, ${methodSum} methods)\n`;
      for (const t of group) {
        const dp = t.dataProviders > 0 ? `  [${t.dataProviders} providers]` : '';
        text += `    ${t.name.padEnd(45)} ${String(t.methodCount).padStart(3)} tests${dp}\n`;
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

export function getTestCoverageMap(appPath: string): McpToolResult {
  try {
    const tests = loadTestClasses(appPath);
    const coverage = buildCoverageMap(appPath, tests);

    if (coverage.length === 0) {
      return { content: [{ type: 'text', text: 'No src/ PHP classes found to analyze.' }] };
    }

    const tested = coverage.filter((c) => c.hasTest);
    const untested = coverage.filter((c) => !c.hasTest);
    const pct = Math.round((tested.length / coverage.length) * 100);

    let text = `Test Coverage Map\n${'='.repeat(50)}\n\n`;
    text += `Src classes: ${coverage.length}   Tested: ${tested.length}   Untested: ${untested.length}   Coverage: ${pct}%\n`;

    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    text += `  ${bar} ${pct}%\n`;

    if (untested.length > 0) {
      text += `\nUntested classes (${untested.length}):\n`;
      // Group by directory
      const byDir: Record<string, CoverageEntry[]> = {};
      for (const c of untested) {
        const dir = path.dirname(c.srcFile).replace(/\\/g, '/');
        (byDir[dir] ??= []).push(c);
      }
      for (const [dir, entries] of Object.entries(byDir).sort()) {
        text += `  ${dir}/\n`;
        for (const e of entries.slice(0, 10)) {
          text += `    ${e.srcClass}\n`;
        }
        if (entries.length > 10) text += `    ... and ${entries.length - 10} more\n`;
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

export function getTestStats(appPath: string): McpToolResult {
  try {
    const tests = loadTestClasses(appPath);
    const phpunitConfig = parsePhpUnitConfig(appPath);

    if (tests.length === 0) {
      return { content: [{ type: 'text', text: 'No test classes found.' }] };
    }

    const byLayer: Record<string, number> = {};
    let totalMethods = 0;
    let totalProviders = 0;

    for (const t of tests) {
      byLayer[t.layer] = (byLayer[t.layer] ?? 0) + 1;
      totalMethods += t.methodCount;
      totalProviders += t.dataProviders;
    }

    const coverage = buildCoverageMap(appPath, tests);
    const testedCount = coverage.filter((c) => c.hasTest).length;
    const coveragePct = coverage.length > 0
      ? Math.round((testedCount / coverage.length) * 100)
      : 0;

    let text = `Test Suite Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test classes:    ${tests.length}\n`;
    text += `Test methods:    ${totalMethods}\n`;
    text += `Data providers:  ${totalProviders}\n`;

    text += `\nBy layer:\n`;
    for (const layer of ['Unit', 'Integration', 'Functional', 'E2E', 'Other']) {
      if (byLayer[layer]) text += `  ${layer.padEnd(15)} ${byLayer[layer]}\n`;
    }

    if (coverage.length > 0) {
      text += `\nSource coverage:\n`;
      text += `  Src classes:   ${coverage.length}\n`;
      text += `  With tests:    ${testedCount}\n`;
      text += `  Coverage:      ${coveragePct}%\n`;
    }

    if (Object.keys(phpunitConfig).length > 0) {
      text += `\nPHPUnit config (${phpunitConfig['file'] ?? 'unknown'}):\n`;
      if (phpunitConfig['bootstrap']) text += `  Bootstrap:    ${phpunitConfig['bootstrap']}\n`;
      if (phpunitConfig['testSuites']) text += `  Test suites:  ${phpunitConfig['testSuites']}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getTestInspectorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_test_classes',
      description: 'List all test classes grouped by layer (Unit/Integration/Functional/E2E) with method counts and data providers',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_test_coverage_map',
      description: 'Show which src/ classes have a corresponding test file and which are untested, with coverage percentage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_test_stats',
      description: 'Aggregate test statistics: class count by layer, total methods, data providers, and source coverage percentage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
