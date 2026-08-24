// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Infection PHP Mutation Testing Inspector
 *
 * Detects Infection PHP mutation testing configuration and results.
 * Reads infection.json5/json/yaml, composer.json, and build/var log files.
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface InfectionInfo {
  hasConfig: boolean;
  msiThreshold: number;
  mutators: string[];
  hasLogFile: boolean;
  issues: string[];
}

function readFileOr(filePath: string, fallback: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return fallback; }
}

function findInfectionConfig(appPath: string): { filePath: string; content: string } {
  const candidates = [
    path.join(appPath, 'infection.json5'),
    path.join(appPath, 'infection.json'),
    path.join(appPath, 'infection.yaml'),
    path.join(appPath, 'infection.yml'),
  ];
  for (const c of candidates) {
    const content = readFileOr(c, '');
    if (content.length > 0) return { filePath: c, content };
  }
  return { filePath: '', content: '' };
}

function findLogFile(appPath: string): string {
  const candidates = [
    path.join(appPath, 'var', 'infection-log.txt'),
    path.join(appPath, 'var', 'infection-log.json'),
    path.join(appPath, 'build', 'infection-log.txt'),
    path.join(appPath, 'build', 'infection-log.json'),
    path.join(appPath, 'infection-log.txt'),
    path.join(appPath, 'infection-log.json'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* skip */ }
  }
  return '';
}

function analyzeInfection(appPath: string): InfectionInfo {
  const { filePath, content: configContent } = findInfectionConfig(appPath);
  const hasConfig = filePath.length > 0;

  const composerContent = readFileOr(path.join(appPath, 'composer.json'), '');
  const hasInfectionPackage = composerContent.includes('"infection/infection"') ||
    composerContent.includes('"infection/infection-bundle"');

  const logFilePath = findLogFile(appPath);
  const hasLogFile = logFilePath.length > 0;

  const issues: string[] = [];

  let msiThreshold = 0;
  let mutators: string[] = [];

  if (!hasConfig && hasInfectionPackage) {
    issues.push('infection/infection is installed in composer.json but no infection.json5 config file found — create infection.json5 to configure mutation testing');
  }

  if (hasConfig) {
    // Parse MSI threshold
    const msiM = /"minMsi"\s*:\s*(\d{1,3})/.exec(configContent) ??
      /minMsi\s*:\s*(\d{1,3})/.exec(configContent);
    if (msiM) {
      msiThreshold = parseInt(msiM[1], 10);
    } else {
      issues.push('MSI (Mutation Score Indicator) threshold not set — no quality gate; mutations can silently reduce test quality');
    }

    // Parse mutators
    const mutatorsM = /"mutators"\s*:\s*\{([^}]{0,2000})\}/.exec(configContent) ??
      /mutators\s*:\s*\n((?:\s+[^\n]{1,200}\n){0,50})/.exec(configContent);
    if (mutatorsM) {
      const mutatorsBody = mutatorsM[1];
      const mutatorsKeys = mutatorsBody.match(/"(\w{1,80})"/g) ?? mutatorsBody.match(/(\w{1,80}):/g) ?? [];
      mutators = mutatorsKeys.map((k) => k.replace(/["':]/g, '').trim()).filter((k) => k.length > 0);
    }

    if (mutators.length === 0) {
      issues.push('No mutators configured — all mutators run by default, which is very slow for large codebases; configure specific mutators');
    }

    // Check source directories
    const hasSrcLimit = configContent.includes('"source"') || configContent.includes('source:');
    if (!hasSrcLimit) {
      issues.push('Source directories not limited in infection config — infection may attempt to mutate vendor/ or test files');
    }

    // Check if vendor is excluded
    if (configContent.includes('vendor') && !configContent.includes('"exclude"')) {
      issues.push('vendor/ referenced in infection config without explicit exclude — risk of mutating dependencies');
    }

    // Check for log output
    const hasLogs = configContent.includes('"logs"') || configContent.includes('logs:');
    if (!hasLogs) {
      issues.push('No log output configured in infection.json5 — mutation results are lost; add logs section with text/json/html output');
    }

    // Check CI integration
    const ciFiles = [
      path.join(appPath, '.github', 'workflows'),
      path.join(appPath, '.gitlab-ci.yml'),
      path.join(appPath, '.travis.yml'),
      path.join(appPath, 'Makefile'),
    ];

    let hasCiIntegration = false;
    for (const ciPath of ciFiles) {
      const ciContent = readFileOr(ciPath, '');
      if (ciContent.includes('infection')) {
        hasCiIntegration = true;
        break;
      }
    }

    // Check .github workflows directory
    if (!hasCiIntegration) {
      const workflowDir = path.join(appPath, '.github', 'workflows');
      try {
        for (const entry of fs.readdirSync(workflowDir)) {
          const wfContent = readFileOr(path.join(workflowDir, entry), '');
          if (wfContent.includes('infection')) {
            hasCiIntegration = true;
            break;
          }
        }
      } catch { /* no workflows dir */ }
    }

    if (!hasCiIntegration) {
      issues.push('Infection not referenced in CI configuration (.github/workflows, .gitlab-ci.yml, Makefile) — mutation tests not enforced in CI pipeline');
    }
  }

  return {
    hasConfig,
    msiThreshold,
    mutators,
    hasLogFile,
    issues,
  };
}

export function listInfectionConfig(appPath: string): McpToolResult {
  try {
    const info = analyzeInfection(appPath);

    let text = `Infection PHP Mutation Testing Configuration\n${'='.repeat(55)}\n\n`;
    text += `Config file found:  ${info.hasConfig ? 'yes' : 'no'}\n`;
    text += `MSI threshold:      ${info.msiThreshold > 0 ? `${info.msiThreshold}%` : '(not set)'}\n`;
    text += `Mutators:           ${info.mutators.length > 0 ? info.mutators.join(', ') : '(all / not configured)'}\n`;
    text += `Log file exists:    ${info.hasLogFile ? 'yes' : 'no'}\n`;
    text += `Issues:             ${info.issues.length}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of info.issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getInfectionMutantStats(appPath: string): McpToolResult {
  try {
    const info = analyzeInfection(appPath);

    let text = `Infection Mutant Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config present:     ${info.hasConfig ? 'yes' : 'no'}\n`;
    text += `MSI threshold:      ${info.msiThreshold > 0 ? `${info.msiThreshold}%` : 'not set'}\n`;
    text += `Mutator count:      ${info.mutators.length > 0 ? info.mutators.length : 'all (unconfigured)'}\n`;
    text += `Log file present:   ${info.hasLogFile ? 'yes' : 'no'}\n`;
    text += `Issues:             ${info.issues.length}\n`;

    // Show log file content summary if available
    const logFile = findLogFilePublic(appPath);
    if (logFile) {
      const logContent = readFileOr(logFile, '');
      const killedM = /Killed\s*:\s*(\d{1,10})/.exec(logContent);
      const escapedM = /Escaped\s*:\s*(\d{1,10})/.exec(logContent);
      const msiM = /MSI\s*:\s*(\d{1,3}(?:\.\d{1,2})?)/.exec(logContent);
      if (killedM || escapedM || msiM) {
        text += `\nLog summary:\n`;
        if (msiM) text += `  MSI score:     ${msiM[1]}%\n`;
        if (killedM) text += `  Killed:        ${killedM[1]}\n`;
        if (escapedM) text += `  Escaped:       ${escapedM[1]}\n`;
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

function findLogFilePublic(appPath: string): string {
  const candidates = [
    path.join(appPath, 'var', 'infection-log.txt'),
    path.join(appPath, 'var', 'infection-log.json'),
    path.join(appPath, 'build', 'infection-log.txt'),
    path.join(appPath, 'build', 'infection-log.json'),
    path.join(appPath, 'infection-log.txt'),
    path.join(appPath, 'infection-log.json'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* skip */ }
  }
  return '';
}

export function getInfectionMutantTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_infection_config',
      description: 'Detect Infection PHP mutation testing configuration: reads infection.json5/json/yaml, checks composer.json for infection/infection in require-dev, checks var/build for infection log files; warns on missing config when package installed, missing MSI threshold, unconfigured mutators, source dirs not limited, no log output, infection absent from CI pipeline',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_infection_mutant_stats',
      description: 'Statistics for Infection mutation testing: config presence, MSI threshold, mutator count, log file presence, and log summary (killed/escaped/MSI score) if log file exists',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
