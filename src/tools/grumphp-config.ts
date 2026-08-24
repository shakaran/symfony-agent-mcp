// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GrumphpInfo {
  configFile: string;
  tasks: string[];
  precommitEnabled: boolean;
  hasPrepushHook: boolean;
  issues: string[];
}

function buildGrumphpInfos(appPath: string): GrumphpInfo[] {
  const configCandidates = [
    path.join(appPath, 'grumphp.yml'),
    path.join(appPath, 'grumphp.dist.yml'),
    path.join(appPath, '.grumphp.yml'),
    path.join(appPath, 'grumphp.yaml'),
    path.join(appPath, 'grumphp.dist.yaml'),
  ];
  const configFile = configCandidates.find((c) => fs.existsSync(c)) ?? null;

  let composerHasGrumphp = false;
  let hookPrepush = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const dev = (composer['require-dev'] ?? {}) as Record<string, string>;
      if (dev['phpro/grumphp']) composerHasGrumphp = true;
      const extra = (composer['extra'] ?? {}) as Record<string, unknown>;
      const grumphpCfg = (extra['grumphp'] ?? {}) as Record<string, unknown>;
      if (grumphpCfg['hooks-preset'] === 'pre-push' || String(grumphpCfg['hooks-dir'] ?? '').includes('push')) {
        hookPrepush = true;
      }
    } catch { /* ignore */ }
  }

  const issues: string[] = [];

  if (!composerHasGrumphp) {
    issues.push('GrumpPHP (phpro/grumphp) not found in composer.json — install to enforce quality gates on commit');
    return [{ configFile: 'none', tasks: [], precommitEnabled: false, hasPrepushHook: false, issues }];
  }

  if (!configFile) {
    issues.push('GrumpPHP installed but no configuration file found (grumphp.yml or grumphp.dist.yml)');
    return [{ configFile: 'none', tasks: [], precommitEnabled: false, hasPrepushHook: false, issues }];
  }

  let content = '';
  try { content = fs.readFileSync(configFile, 'utf-8'); } catch { /* ignore */ }

  const KNOWN_TASKS = ['phpstan', 'phpcs', 'phpunit', 'rector', 'phpcsfixer', 'composer', 'git_commit_message', 'phplint', 'phpcpd', 'phpmd', 'yamllint', 'jsonlint', 'twig_cs', 'eslint'];
  const tasks = KNOWN_TASKS.filter((t) => content.includes(t));
  const precommitEnabled = content.includes('pre_commit') || (!content.includes('pre_commit: false') && composerHasGrumphp);

  if (!tasks.includes('phpstan')) {
    issues.push('phpstan task not configured in GrumpPHP — static analysis not enforced on commit');
  }
  if (!tasks.includes('phpunit') && !tasks.includes('phpcs') && !tasks.includes('phpcsfixer')) {
    issues.push('Neither phpunit nor phpcs/phpcsfixer configured — no tests or coding standards enforced');
  }
  if (!tasks.includes('git_commit_message')) {
    issues.push('git_commit_message task not configured — commit message format not validated (consider conventional commits)');
  }
  if (!hookPrepush) {
    issues.push('No pre-push hook configured — quality gates run only on commit, not before push');
  }

  return [{ configFile: path.relative(appPath, configFile), tasks, precommitEnabled, hasPrepushHook: hookPrepush, issues }];
}

export function listGrumphpConfig(appPath: string): McpToolResult {
  try {
    const infos = buildGrumphpInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GrumpPHP Configuration Analysis\n${'='.repeat(50)}\n\nIssues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  Config: ${info.configFile}\n`;
      text += `    Tasks: ${info.tasks.join(', ') || '(none)'}\n`;
      text += `    pre-commit: ${info.precommitEnabled ? 'yes' : 'no'}  pre-push: ${info.hasPrepushHook ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrumphpStats(appPath: string): McpToolResult {
  try {
    const infos = buildGrumphpInfos(appPath);
    let text = `GrumpPHP Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files:     ${infos.filter((i) => i.configFile !== 'none').length}\n`;
    text += `Tasks configured: ${infos.reduce((s, i) => s + i.tasks.length, 0)}\n`;
    text += `Total issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGrumphpTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_grumphp_config', description: 'Analyze GrumpPHP pre-commit hook configuration; warns on missing phpstan/phpunit tasks, no commit message validation, no pre-push hook', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_grumphp_stats', description: 'Statistics for GrumpPHP: config files, tasks configured, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
