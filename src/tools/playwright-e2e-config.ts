/**
 * Playwright E2E Config Static Analyzer
 *
 * Scans playwright.config.ts, playwright.config.js, e2e/, tests/e2e/
 * for Playwright configuration issues:
 *
 * - Missing use.baseURL
 * - No globalSetup / globalTeardown configured
 * - Missing retries or CI-conditional retries pattern
 * - fullyParallel: true without workers limit
 * - Missing reporter config
 * - use.ignoreHTTPSErrors: true (security risk)
 * - No testDir specified
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PlaywrightE2eConfigInfo {
  file: string;
  type: 'baseurl' | 'setup' | 'retries' | 'parallel' | 'reporter' | 'security' | 'testdir';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzePlaywrightConfig(filePath: string, appPath: string): PlaywrightE2eConfigInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const results: PlaywrightE2eConfigInfo[] = [];

  // Missing use.baseURL
  if (!/\bbaseURL\b/.test(content)) {
    results.push({
      file: relFile,
      type: 'baseurl',
      issues: ['use.baseURL is not configured — page.goto() calls will require absolute URLs'],
    });
  }

  // No globalSetup / globalTeardown
  const hasGlobalSetup = /\bglobalSetup\b/.test(content);
  const hasGlobalTeardown = /\bglobalTeardown\b/.test(content);
  if (!hasGlobalSetup && !hasGlobalTeardown) {
    results.push({
      file: relFile,
      type: 'setup',
      issues: ['Neither globalSetup nor globalTeardown is configured — test environment initialization will be done per-test'],
    });
  } else if (!hasGlobalSetup) {
    results.push({
      file: relFile,
      type: 'setup',
      issues: ['globalSetup is not configured — consider adding for environment preparation'],
    });
  } else if (!hasGlobalTeardown) {
    results.push({
      file: relFile,
      type: 'setup',
      issues: ['globalTeardown is not configured — consider adding for environment cleanup'],
    });
  }

  // Missing retries or CI-conditional retries pattern
  const hasRetries = /\bretries\b/.test(content);
  const hasCiConditional = /process\.env\.CI\s*\?\s*\d/.test(content) || /process\.env\['CI'\]\s*\?\s*\d/.test(content);
  if (!hasRetries) {
    results.push({
      file: relFile,
      type: 'retries',
      issues: ['No retries configured — add retries: process.env.CI ? 2 : 0 for CI resilience'],
    });
  } else if (!hasCiConditional) {
    results.push({
      file: relFile,
      type: 'retries',
      issues: ['retries is set but does not use CI-conditional pattern (process.env.CI ? 2 : 0) — local runs may retry unnecessarily'],
    });
  }

  // fullyParallel: true without workers limit
  const hasFullyParallel = /fullyParallel\s*[=:]\s*true/.test(content);
  const hasWorkers = /\bworkers\b/.test(content);
  if (hasFullyParallel && !hasWorkers) {
    results.push({
      file: relFile,
      type: 'parallel',
      issues: ['fullyParallel: true without workers limit — may overwhelm CI resources; add workers: process.env.CI ? 1 : undefined'],
    });
  }

  // Missing reporter config
  if (!/\breporter\b/.test(content)) {
    results.push({
      file: relFile,
      type: 'reporter',
      issues: ['No reporter configured — add reporter for CI integration (e.g. html, junit, github)'],
    });
  }

  // use.ignoreHTTPSErrors: true
  if (/ignoreHTTPSErrors\s*[=:]\s*true/.test(content)) {
    results.push({
      file: relFile,
      type: 'security',
      issues: ['use.ignoreHTTPSErrors: true bypasses TLS verification — fix SSL certificate issues instead'],
    });
  }

  // No testDir specified
  if (!/\btestDir\b/.test(content)) {
    results.push({
      file: relFile,
      type: 'testdir',
      issues: ['testDir is not specified — Playwright will use its default discovery, which may pick up unintended files'],
    });
  }

  return results;
}

function collectAllIssues(appPath: string): PlaywrightE2eConfigInfo[] {
  const configFileNames = ['playwright.config.ts', 'playwright.config.js'];
  const allIssues: PlaywrightE2eConfigInfo[] = [];

  for (const name of configFileNames) {
    const filePath = path.join(appPath, name);
    if (fs.existsSync(filePath)) {
      allIssues.push(...analyzePlaywrightConfig(filePath, appPath));
    }
  }

  // Scan e2e/ and tests/e2e/ for any local playwright config overrides
  const e2eDirs = [path.join(appPath, 'e2e'), path.join(appPath, 'tests', 'e2e')];
  for (const dir of e2eDirs) {
    const tsConfigs = scanDirRecursive(dir, '.ts').filter((f) => f.includes('playwright') || f.includes('config'));
    const jsConfigs = scanDirRecursive(dir, '.js').filter((f) => f.includes('playwright') || f.includes('config'));
    for (const file of [...tsConfigs, ...jsConfigs]) {
      allIssues.push(...analyzePlaywrightConfig(file, appPath));
    }
  }

  return allIssues;
}

export function listPlaywrightE2eConfig(appPath: string): McpToolResult {
  try {
    const allIssues = collectAllIssues(appPath);

    if (allIssues.length === 0) {
      return { content: [{ type: 'text', text: 'No Playwright E2E configuration issues found. ✓' }] };
    }

    const byFile = new Map<string, PlaywrightE2eConfigInfo[]>();
    for (const issue of allIssues) {
      const existing = byFile.get(issue.file) ?? [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }

    let text = `Playwright E2E Configuration Issues\n${'='.repeat(50)}\n`;
    text += `\nFiles with issues: ${byFile.size}  Total issue groups: ${allIssues.length}\n`;

    for (const [file, issues] of byFile) {
      text += `\n${file} (${issues.length}):\n`;
      for (const info of issues) {
        text += `  [${info.type}]\n`;
        for (const issue of info.issues) {
          text += `    - ${issue}\n`;
        }
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

export function getPlaywrightE2eConfigStats(appPath: string): McpToolResult {
  try {
    const allIssues = collectAllIssues(appPath);

    const counts: Record<string, number> = {
      baseurl: 0,
      setup: 0,
      retries: 0,
      parallel: 0,
      reporter: 0,
      security: 0,
      testdir: 0,
    };
    for (const info of allIssues) {
      counts[info.type] = (counts[info.type] ?? 0) + 1;
    }

    const totalIssues = allIssues.reduce((sum, info) => sum + info.issues.length, 0);

    let text = `Playwright E2E Configuration Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issue groups:       ${allIssues.length}\n`;
    text += `Total individual issues:  ${totalIssues}\n\n`;
    text += `By pattern type:\n`;
    text += `  baseurl (missing use.baseURL):        ${counts['baseurl']}\n`;
    text += `  setup (no globalSetup/Teardown):      ${counts['setup']}\n`;
    text += `  retries (missing/no CI conditional):  ${counts['retries']}\n`;
    text += `  parallel (fullyParallel no workers):  ${counts['parallel']}\n`;
    text += `  reporter (no reporter configured):    ${counts['reporter']}\n`;
    text += `  security (ignoreHTTPSErrors true):    ${counts['security']}\n`;
    text += `  testdir (no testDir specified):       ${counts['testdir']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPlaywrightE2eConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_playwright_e2e_config',
      description: 'Scan playwright.config.ts/js and e2e/ directories for Playwright config issues: missing use.baseURL, no globalSetup/globalTeardown, missing retries or CI conditional, fullyParallel without workers, no reporter, ignoreHTTPSErrors:true, no testDir',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_playwright_e2e_config_stats',
      description: 'Show statistics for Playwright E2E config issues grouped by type: baseurl/setup/retries/parallel/reporter/security/testdir counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
