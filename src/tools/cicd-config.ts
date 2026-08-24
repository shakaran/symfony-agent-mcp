// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * CI/CD Pipeline Inspector
 *
 * Scans common CI/CD configuration files for Symfony-relevant steps:
 *
 * GitHub Actions (.github/workflows/*.yml):
 *   - PHP version matrix, composer install steps
 *   - bin/console commands (migrate, cache:warmup, etc.)
 *   - PHPUnit / PHPStan / Rector / CS-Fixer steps
 *   - Deploy steps (rsync, SSH, Platform.sh, Heroku, Docker)
 *
 * GitLab CI (.gitlab-ci.yml):
 *   - Same analysis as GitHub Actions
 *   - Stages and environments
 *
 * Makefile / justfile:
 *   - Symfony-related targets (test, migrate, deploy, cs, stan)
 *
 * Analysis:
 *   - Database migration run in CI (good practice check)
 *   - Tests run in CI
 *   - Static analysis run in CI
 *   - Production deploy gated on tests
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CiPipeline {
  provider: string;
  file: string;
  phpVersions: string[];
  hasComposerInstall: boolean;
  hasTests: boolean;
  hasStaticAnalysis: boolean;
  hasMigrations: boolean;
  hasCacheWarmup: boolean;
  hasDeploy: boolean;
  deployEnvs: string[];
  consoleCommands: string[];
  stages: string[];
}

interface MakeTarget {
  name: string;
  isSymfonyRelated: boolean;
  command: string;
}

// ─── YAML pipeline parsing ───────────────────────────────────────────────────

function analyzeJobSteps(stepsContent: string): {
  hasTests: boolean;
  hasStaticAnalysis: boolean;
  hasMigrations: boolean;
  hasCacheWarmup: boolean;
  hasDeploy: boolean;
  consoleCommands: string[];
} {
  const lower = stepsContent.toLowerCase();
  const consoleCommands: string[] = [];

  for (const m of stepsContent.matchAll(/bin\/console\s+([\w:]+)/g)) {
    consoleCommands.push(m[1]);
  }

  return {
    hasTests:          lower.includes('phpunit') || lower.includes('vendor/bin/phpunit') || lower.includes('behat'),
    hasStaticAnalysis: lower.includes('phpstan') || lower.includes('psalm') || lower.includes('php-cs-fixer') || lower.includes('rector'),
    hasMigrations:     consoleCommands.some((c) => c.includes('migrate') || c.includes('doctrine:migrations')),
    hasCacheWarmup:    consoleCommands.some((c) => c.includes('cache:warmup') || c.includes('cache:clear')),
    hasDeploy:         lower.includes('deploy') || lower.includes('rsync') || lower.includes('ssh') ||
                       lower.includes('platform.sh') || lower.includes('heroku') || lower.includes('kubernetes'),
    consoleCommands: [...new Set(consoleCommands)],
  };
}

function parsePhpVersions(content: string): string[] {
  const versions: string[] = [];
  for (const m of content.matchAll(/'(8\.[0-9]+)'|"(8\.[0-9]+)"|\b(8\.[0-9]+)\b/g)) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v && !versions.includes(v)) versions.push(v);
  }
  return versions.sort();
}

function parseGitHubActions(appPath: string): CiPipeline[] {
  const dir = path.join(appPath, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];

  const pipelines: CiPipeline[] = [];

  try {
    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.yml') && !fname.endsWith('.yaml')) continue;
      const filePath = path.join(dir, fname);
      const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
      if (!raw) continue;

      const allContent = JSON.stringify(raw);
      const phpVersions = parsePhpVersions(allContent);
      const hasComposerInstall = allContent.includes('composer install') || allContent.includes('composer update');

      const stages: string[] = [];
      const jobsRaw = raw['jobs'] as Record<string, unknown> | undefined;
      if (jobsRaw) stages.push(...Object.keys(jobsRaw));

      const analysis = analyzeJobSteps(allContent);

      const deployEnvs: string[] = [];
      if (analysis.hasDeploy) {
        const envM = allContent.match(/environment['":\s]+(?:name['":\s]+)?['"]([^'"]+)['"]/g) ?? [];
        for (const m of envM) {
          const e = /['"]([^'"]+)['"]/.exec(m);
          if (e && !deployEnvs.includes(e[1])) deployEnvs.push(e[1]);
        }
      }

      pipelines.push({
        provider: 'GitHub Actions',
        file: `.github/workflows/${fname}`,
        phpVersions,
        hasComposerInstall,
        ...analysis,
        deployEnvs,
        stages,
      });
    }
  } catch { /* skip */ }

  return pipelines;
}

function parseGitLabCi(appPath: string): CiPipeline | null {
  const filePath = path.join(appPath, '.gitlab-ci.yml');
  if (!fs.existsSync(filePath)) return null;

  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return null;

  const allContent = JSON.stringify(raw);
  const stagesRaw = raw['stages'] as string[] | undefined;
  const analysis = analyzeJobSteps(allContent);

  const deployEnvs: string[] = [];
  for (const m of allContent.matchAll(/"environment"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/g)) {
    deployEnvs.push(m[1]);
  }

  return {
    provider: 'GitLab CI',
    file: '.gitlab-ci.yml',
    phpVersions: parsePhpVersions(allContent),
    hasComposerInstall: allContent.includes('composer install') || allContent.includes('composer update'),
    ...analysis,
    deployEnvs,
    stages: stagesRaw ?? [],
  };
}

// ─── Makefile parsing ────────────────────────────────────────────────────────

const SYMFONY_MAKE_PATTERNS = [
  'phpunit', 'phpstan', 'psalm', 'cs-fixer', 'rector',
  'bin/console', 'doctrine', 'migrate', 'behat', 'deploy',
];

function parseMakefile(appPath: string): MakeTarget[] {
  const candidates = [
    path.join(appPath, 'Makefile'),
    path.join(appPath, 'makefile'),
    path.join(appPath, 'GNUmakefile'),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const targets: MakeTarget[] = [];
    for (const m of content.matchAll(/^([a-zA-Z0-9_-]+)\s*:[^=]([^\n]*)/gm)) {
      const name    = m[1];
      const command = m[2].trim();
      if (name.startsWith('.') || name === 'PHONY') continue;
      const isSymfonyRelated = SYMFONY_MAKE_PATTERNS.some(
        (p) => command.toLowerCase().includes(p) || name.toLowerCase().includes(p)
      );
      targets.push({ name, command, isSymfonyRelated });
    }
    return targets;
  }
  return [];
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listCiCdConfig(appPath: string): McpToolResult {
  try {
    const ghPipelines = parseGitHubActions(appPath);
    const glPipeline  = parseGitLabCi(appPath);
    const makeTargets = parseMakefile(appPath);

    const allPipelines = [...ghPipelines, ...(glPipeline ? [glPipeline] : [])];

    if (allPipelines.length === 0 && makeTargets.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No CI/CD configuration found.\n\nDetected: .github/workflows/*.yml (GitHub Actions), .gitlab-ci.yml (GitLab CI), Makefile',
        }],
      };
    }

    let text = `CI/CD Pipeline Configuration\n${'='.repeat(55)}\n`;

    for (const p of allPipelines) {
      text += `\n${p.provider}  (${p.file})\n`;
      if (p.phpVersions.length > 0) text += `  PHP versions:     ${p.phpVersions.join(', ')}\n`;
      if (p.stages.length > 0)      text += `  Jobs/stages:      ${p.stages.join(', ')}\n`;
      text += `  Composer install: ${p.hasComposerInstall ? '✓' : '✗'}\n`;
      text += `  Tests run:        ${p.hasTests ? '✓' : '✗ ⚠'}\n`;
      text += `  Static analysis:  ${p.hasStaticAnalysis ? '✓' : '✗'}\n`;
      text += `  DB migrations:    ${p.hasMigrations ? '✓' : '✗'}\n`;
      text += `  Cache warmup:     ${p.hasCacheWarmup ? '✓' : '✗'}\n`;
      text += `  Deployment:       ${p.hasDeploy ? `✓ (${p.deployEnvs.join(', ') || 'env unknown'})` : '✗'}\n`;
      if (p.consoleCommands.length > 0) {
        text += `  Console commands: ${p.consoleCommands.join(', ')}\n`;
      }
    }

    const symfonyTargets = makeTargets.filter((t) => t.isSymfonyRelated);
    if (symfonyTargets.length > 0) {
      text += `\nMakefile Symfony targets (${symfonyTargets.length} of ${makeTargets.length}):\n`;
      for (const t of symfonyTargets) {
        text += `  make ${t.name.padEnd(25)} ${t.command.slice(0, 60)}\n`;
      }
    }

    // Quality checks
    for (const p of allPipelines) {
      if (!p.hasTests) {
        text += `\n⚠ ${p.provider}: no test runner found — add phpunit/behat step\n`;
      }
      if (p.hasDeploy && !p.hasTests) {
        text += `⚠ ${p.provider}: deployment runs without a test gate!\n`;
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

export function getCiCdStats(appPath: string): McpToolResult {
  try {
    const ghPipelines = parseGitHubActions(appPath);
    const glPipeline  = parseGitLabCi(appPath);
    const makeTargets = parseMakefile(appPath);

    const allPipelines = [...ghPipelines, ...(glPipeline ? [glPipeline] : [])];

    let text = `CI/CD Statistics\n${'='.repeat(40)}\n\n`;
    text += `Pipelines found:    ${allPipelines.length}\n`;
    text += `GitHub workflows:   ${ghPipelines.length}\n`;
    text += `GitLab CI:          ${glPipeline ? 'yes' : 'no'}\n`;
    text += `Makefile targets:   ${makeTargets.length} (${makeTargets.filter((t) => t.isSymfonyRelated).length} Symfony-related)\n`;
    text += `Tests in CI:        ${allPipelines.some((p) => p.hasTests) ? 'yes' : 'NO'}\n`;
    text += `Static analysis:    ${allPipelines.some((p) => p.hasStaticAnalysis) ? 'yes' : 'no'}\n`;
    text += `DB migrations in CI: ${allPipelines.some((p) => p.hasMigrations) ? 'yes' : 'no'}\n`;
    text += `Deploy pipelines:   ${allPipelines.filter((p) => p.hasDeploy).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getCiCdConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_cicd_config',
      description: 'Show CI/CD configuration: GitHub Actions workflows and GitLab CI stages with PHP versions, Composer, PHPUnit/Behat, PHPStan, migrations, cache warmup, deployment gating checks; Makefile Symfony targets',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_cicd_stats',
      description: 'Show CI/CD statistics: pipeline count, GitHub/GitLab presence, tests-in-CI flag, static analysis flag, migration-in-CI flag, deploy pipeline count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
