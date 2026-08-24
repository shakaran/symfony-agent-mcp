// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Cypress E2E Config Static Analyzer
 *
 * Scans cypress.config.js, cypress.config.ts, cypress.json, and cypress/
 * directory for Cypress configuration issues:
 *
 * - Missing baseUrl in e2e config section
 * - No fixture files in cypress/fixtures/
 * - Spec pattern too broad (**\/*.cy.js) without excluding node_modules
 * - Missing retries config
 * - chromeWebSecurity: false (security risk)
 * - No setupNodeEvents for custom tasks
 * - Missing video: false in CI config
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CypressE2eConfigInfo {
  file: string;
  type: 'baseurl' | 'fixtures' | 'specpattern' | 'retries' | 'security' | 'tasks' | 'video';
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

function analyzeCypressConfig(filePath: string, appPath: string): CypressE2eConfigInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const results: CypressE2eConfigInfo[] = [];

  // Missing baseUrl in e2e config
  const hasE2eSection = /\be2e\s*[:{]/.test(content) || /"e2e"\s*:/.test(content);
  const hasBaseUrl = /\bbaseUrl\b/.test(content);
  if (hasE2eSection && !hasBaseUrl) {
    results.push({
      file: relFile,
      type: 'baseurl',
      issues: ['e2e config section found but baseUrl is not set — tests will need full URLs in cy.visit()'],
    });
  } else if (!hasBaseUrl) {
    results.push({
      file: relFile,
      type: 'baseurl',
      issues: ['No baseUrl configured — cy.visit() calls will require absolute URLs'],
    });
  }

  // Spec pattern too broad without node_modules exclusion
  const specPatternIssues: string[] = [];
  const specPatternMatch = /specPattern\s*[=:]\s*['"`]([^'"`]+)['"`]/.exec(content);
  if (specPatternMatch) {
    const pattern = specPatternMatch[1] ?? '';
    if (pattern.includes('**') && !content.includes('node_modules')) {
      specPatternIssues.push(`specPattern "${pattern}" is broad and does not exclude node_modules — may pick up vendor test files`);
    }
  }
  if (specPatternIssues.length > 0) {
    results.push({ file: relFile, type: 'specpattern', issues: specPatternIssues });
  }

  // Missing retries config
  if (!/\bretries\b/.test(content)) {
    results.push({
      file: relFile,
      type: 'retries',
      issues: ['No retries configured — consider setting retries for CI stability'],
    });
  }

  // chromeWebSecurity: false
  if (/chromeWebSecurity\s*[=:]\s*false/.test(content)) {
    results.push({
      file: relFile,
      type: 'security',
      issues: ['chromeWebSecurity: false disables same-origin policy — fix cross-origin issues properly instead'],
    });
  }

  // No setupNodeEvents
  if (!/setupNodeEvents\b/.test(content)) {
    results.push({
      file: relFile,
      type: 'tasks',
      issues: ['No setupNodeEvents configured — custom Cypress tasks (e.g. database seeding) will not be available'],
    });
  }

  // Missing video: false
  if (!/\bvideo\s*[=:]\s*false/.test(content)) {
    results.push({
      file: relFile,
      type: 'video',
      issues: ['video: false not set — CI runs will record videos, increasing disk usage and run time'],
    });
  }

  return results;
}

function checkFixtures(appPath: string): CypressE2eConfigInfo | null {
  const fixturesDir = path.join(appPath, 'cypress', 'fixtures');
  if (!fs.existsSync(fixturesDir)) {
    return {
      file: 'cypress/fixtures/',
      type: 'fixtures',
      issues: ['cypress/fixtures/ directory does not exist — no fixture files available for tests'],
    };
  }
  try {
    const entries = fs.readdirSync(fixturesDir);
    const hasFiles = entries.some((e) => {
      try {
        return fs.statSync(path.join(fixturesDir, e)).isFile();
      } catch { return false; }
    });
    if (!hasFiles) {
      return {
        file: 'cypress/fixtures/',
        type: 'fixtures',
        issues: ['cypress/fixtures/ directory is empty — add fixture files for test data'],
      };
    }
  } catch { /* skip */ }
  return null;
}

function collectAllIssues(appPath: string): CypressE2eConfigInfo[] {
  const configFileNames = ['cypress.config.js', 'cypress.config.ts', 'cypress.json'];
  const allIssues: CypressE2eConfigInfo[] = [];

  for (const name of configFileNames) {
    const filePath = path.join(appPath, name);
    if (fs.existsSync(filePath)) {
      allIssues.push(...analyzeCypressConfig(filePath, appPath));
    }
  }

  // Also scan cypress/ subdirectory config files
  const cypressDir = path.join(appPath, 'cypress');
  const cypressConfigFiles = scanDirRecursive(cypressDir, '.json')
    .concat(scanDirRecursive(cypressDir, '.js'))
    .concat(scanDirRecursive(cypressDir, '.ts'))
    .filter((f) => path.basename(f).startsWith('cypress') || path.basename(f) === 'config.js' || path.basename(f) === 'config.ts');

  for (const file of cypressConfigFiles) {
    allIssues.push(...analyzeCypressConfig(file, appPath));
  }

  const fixtureIssue = checkFixtures(appPath);
  if (fixtureIssue !== null) {
    allIssues.push(fixtureIssue);
  }

  return allIssues;
}

export function listCypressE2eConfig(appPath: string): McpToolResult {
  try {
    const allIssues = collectAllIssues(appPath);

    if (allIssues.length === 0) {
      return { content: [{ type: 'text', text: 'No Cypress E2E configuration issues found. ✓' }] };
    }

    const byFile = new Map<string, CypressE2eConfigInfo[]>();
    for (const issue of allIssues) {
      const existing = byFile.get(issue.file) ?? [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }

    let text = `Cypress E2E Configuration Issues\n${'='.repeat(50)}\n`;
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

export function getCypressE2eConfigStats(appPath: string): McpToolResult {
  try {
    const allIssues = collectAllIssues(appPath);

    const counts: Record<string, number> = {
      baseurl: 0,
      fixtures: 0,
      specpattern: 0,
      retries: 0,
      security: 0,
      tasks: 0,
      video: 0,
    };
    for (const info of allIssues) {
      counts[info.type] = (counts[info.type] ?? 0) + 1;
    }

    const totalIssues = allIssues.reduce((sum, info) => sum + info.issues.length, 0);

    let text = `Cypress E2E Configuration Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issue groups:       ${allIssues.length}\n`;
    text += `Total individual issues:  ${totalIssues}\n\n`;
    text += `By pattern type:\n`;
    text += `  baseurl (missing baseUrl):         ${counts['baseurl']}\n`;
    text += `  fixtures (missing fixture files):  ${counts['fixtures']}\n`;
    text += `  specpattern (broad spec glob):     ${counts['specpattern']}\n`;
    text += `  retries (missing retries):         ${counts['retries']}\n`;
    text += `  security (chromeWebSecurity off):  ${counts['security']}\n`;
    text += `  tasks (no setupNodeEvents):        ${counts['tasks']}\n`;
    text += `  video (video not disabled):        ${counts['video']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCypressE2eConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cypress_e2e_config',
      description: 'Scan cypress.config.js/ts, cypress.json and cypress/ directory for Cypress config issues: missing baseUrl, no fixtures, broad specPattern, missing retries, chromeWebSecurity:false, no setupNodeEvents, video not disabled for CI',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cypress_e2e_config_stats',
      description: 'Show statistics for Cypress E2E config issues grouped by type: baseurl/fixtures/specpattern/retries/security/tasks/video counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
