// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHPUnit Parallel Execution Inspector
 *
 * Reads phpunit.xml: processIsolation, forceCoversAnnotation, testSuiteCount.
 * Checks composer.json for: brianium/paratest, infection/infection.
 * Reads phpunit.xml test suite count and total test estimation.
 * Scans tests/ for tests with static state (static properties = parallel unsafe).
 *
 * Warns:
 *   - Large test suite (>200 tests) without paratest
 *   - processIsolation: true (slow, each test in own process)
 *   - Test class with static properties (unsafe in parallel)
 *   - paratest installed but no parallel config in phpunit.xml
 *   - infection configured without paratest
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpUnitParallelInfo {
  hasParatest: boolean;
  hasInfection: boolean;
  processIsolation: boolean;
  testSuiteCount: number;
  hasStaticTestState: boolean;
  estimatedTests: number;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Composer.json reading ────────────────────────────────────────────────────

interface ComposerDeps {
  hasParatest: boolean;
  hasInfection: boolean;
}

function readComposerDeps(appPath: string): ComposerDeps {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const allDeps = {
      ...(json['require'] as Record<string, unknown> ?? {}),
      ...(json['require-dev'] as Record<string, unknown> ?? {}),
    };
    return {
      hasParatest: 'brianium/paratest' in allDeps,
      hasInfection: 'infection/infection' in allDeps,
    };
  } catch { return { hasParatest: false, hasInfection: false }; }
}

// ─── phpunit.xml reading ──────────────────────────────────────────────────────

interface PhpUnitConfig {
  processIsolation: boolean;
  testSuiteCount: number;
  hasParatestConfig: boolean;
}

function readPhpUnitConfig(appPath: string): PhpUnitConfig {
  const candidates = ['phpunit.xml', 'phpunit.xml.dist'];
  for (const name of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, name), 'utf-8');
      const processIsolation = /processIsolation\s*=\s*["']true["']/i.test(content);
      const suiteMatches = content.match(/<testsuite\b/g) ?? [];
      const hasParatestConfig = content.includes('paratest') || content.includes('parallel');
      return {
        processIsolation,
        testSuiteCount: suiteMatches.length,
        hasParatestConfig,
      };
    } catch { /* try next */ }
  }
  return { processIsolation: false, testSuiteCount: 0, hasParatestConfig: false };
}

// ─── Static test state detection ─────────────────────────────────────────────

function hasStaticProperties(testsDir: string): boolean {
  for (const file of getAllPhpFiles(testsDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!/extends\s+\w{1,80}TestCase|TestCase/.test(content)) continue;
    // Detect static properties in test classes (not static final or static readonly)
    if (/(?:private|protected|public)\s+static\s+(?!final\s+)(?!\$_).{0,50}\$\w{1,60}\s*[=;]/.test(content)) {
      return true;
    }
  }
  return false;
}

// ─── Test count estimation ────────────────────────────────────────────────────

function estimateTestCount(testsDir: string): number {
  let count = 0;
  for (const file of getAllPhpFiles(testsDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      count += (content.match(/function\s+test\w{0,100}\s*\(/g) ?? []).length;
      count += (content.match(/#\[Test\]/g) ?? []).length;
    } catch { /* skip */ }
  }
  return count;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyze(appPath: string): PhpUnitParallelInfo {
  const testsDir     = path.join(appPath, 'tests');
  const composer     = readComposerDeps(appPath);
  const phpunitConf  = readPhpUnitConfig(appPath);
  const estimatedTests = fs.existsSync(testsDir) ? estimateTestCount(testsDir) : 0;
  const hasStaticTestState = fs.existsSync(testsDir) ? hasStaticProperties(testsDir) : false;

  const issues: string[] = [];

  if (estimatedTests > 200 && !composer.hasParatest) {
    issues.push(
      `Test suite has ~${estimatedTests} tests but brianium/paratest is not installed. ` +
      `Parallel execution could significantly reduce test time.`,
    );
  }

  if (phpunitConf.processIsolation) {
    issues.push(
      `phpunit.xml has processIsolation="true". ` +
      `Each test runs in its own process — this is very slow for large suites. ` +
      `Disable unless absolutely needed for truly isolated tests.`,
    );
  }

  if (hasStaticTestState) {
    issues.push(
      `Test classes with static properties detected. ` +
      `Static state is shared across test class instances — unsafe when running in parallel with paratest.`,
    );
  }

  if (composer.hasParatest && !phpunitConf.hasParatestConfig) {
    issues.push(
      `brianium/paratest is installed but phpunit.xml has no parallel configuration. ` +
      `Add a parallel attribute or use a paratest-specific config to enable parallel runs.`,
    );
  }

  if (composer.hasInfection && !composer.hasParatest) {
    issues.push(
      `infection/infection is installed but paratest is not. ` +
      `Mutation testing is very slow single-threaded for large suites — consider adding paratest.`,
    );
  }

  return {
    hasParatest: composer.hasParatest,
    hasInfection: composer.hasInfection,
    processIsolation: phpunitConf.processIsolation,
    testSuiteCount: phpunitConf.testSuiteCount,
    hasStaticTestState,
    estimatedTests,
    issues,
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpUnitParallel(appPath: string): McpToolResult {
  try {
    const info = analyze(appPath);

    let text = `PHPUnit Parallel Execution Analysis\n${'='.repeat(55)}\n\n`;
    text += `paratest installed:     ${info.hasParatest ? 'yes' : 'no'}\n`;
    text += `infection installed:    ${info.hasInfection ? 'yes' : 'no'}\n`;
    text += `processIsolation:       ${info.processIsolation ? 'yes (SLOW)' : 'no'}\n`;
    text += `test suites (phpunit):  ${info.testSuiteCount}\n`;
    text += `estimated test count:   ${info.estimatedTests}\n`;
    text += `static test properties: ${info.hasStaticTestState ? 'yes (parallel unsafe)' : 'no'}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) {
        text += `  WARN: ${issue}\n`;
      }
    } else {
      text += `\nNo parallel-execution issues found.\n`;
    }

    if (!info.hasParatest && info.estimatedTests > 0) {
      text += `\nTo enable parallel test execution:\n`;
      text += `  composer require --dev brianium/paratest\n`;
      text += `  vendor/bin/paratest --processes=4\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitParallelStats(appPath: string): McpToolResult {
  try {
    const info = analyze(appPath);

    let text = `PHPUnit Parallel Execution Statistics\n${'='.repeat(40)}\n\n`;
    text += `paratest installed:     ${info.hasParatest ? 'yes' : 'no'}\n`;
    text += `infection installed:    ${info.hasInfection ? 'yes' : 'no'}\n`;
    text += `processIsolation:       ${info.processIsolation ? 'yes' : 'no'}\n`;
    text += `test suite count:       ${info.testSuiteCount}\n`;
    text += `estimated tests:        ${info.estimatedTests}\n`;
    text += `static test state:      ${info.hasStaticTestState ? 'yes' : 'no'}\n`;
    text += `issues:                 ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpUnitParallelTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_phpunit_parallel',
      description: 'Analyze PHPUnit parallel execution setup: paratest/infection detection, processIsolation warning, static test state, parallel config validation',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_parallel_stats',
      description: 'Show PHPUnit parallel execution statistics: paratest/infection installed, processIsolation, test count estimate, static state, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
