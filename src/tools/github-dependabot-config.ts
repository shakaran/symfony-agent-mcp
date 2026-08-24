// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DependabotConfigInfo {
  type: 'ecosystem' | 'limit' | 'assignee' | 'schedule' | 'groups';
  ecosystem?: string;
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildGithubDependabotConfigInfos(appPath: string): DependabotConfigInfo[] {
  const results: DependabotConfigInfo[] = [];

  const dependabotPath = path.join(appPath, '.github', 'dependabot.yml');
  const content = safeRead(dependabotPath, appPath);

  if (!content) {
    results.push({
      type: 'ecosystem',
      detail: '.github/dependabot.yml not found',
      issue: 'No .github/dependabot.yml file found — Dependabot is not configured; create the file to enable automated dependency updates for composer, npm, docker, and github-actions',
    });
    return results;
  }

  // Check for each required ecosystem
  const ecosystems: Array<{ name: string; key: string; description: string }> = [
    { name: 'composer', key: 'composer', description: 'PHP dependencies (composer.json)' },
    { name: 'npm', key: 'npm', description: 'JS/TS dependencies (package.json)' },
    { name: 'docker', key: 'docker', description: 'Docker base images (Dockerfile)' },
    { name: 'github-actions', key: 'github-actions', description: 'GitHub Actions workflow dependencies' },
  ];

  for (const eco of ecosystems) {
    const hasEco = content.includes(`package-ecosystem: "${eco.key}"`) || content.includes(`package-ecosystem: '${eco.key}'`) || content.includes(`package-ecosystem: ${eco.key}`);
    if (!hasEco) {
      results.push({
        type: 'ecosystem',
        ecosystem: eco.name,
        detail: `Missing ${eco.name} ecosystem`,
        issue: `Dependabot missing "${eco.name}" ecosystem entry — ${eco.description} will not receive automated security/version updates; add a package-ecosystem: "${eco.name}" update block`,
      });
    } else {
      results.push({ type: 'ecosystem', ecosystem: eco.name, detail: `${eco.name} ecosystem configured`, issue: null });
    }
  }

  // open-pull-requests-limit not set
  const hasLimit = content.includes('open-pull-requests-limit');
  if (!hasLimit) {
    results.push({
      type: 'limit',
      detail: 'open-pull-requests-limit not set',
      issue: 'No open-pull-requests-limit set in dependabot.yml — defaults to 5 which may be too few for active projects or too many for small teams; set explicitly (e.g., open-pull-requests-limit: 10)',
    });
  } else {
    results.push({ type: 'limit', detail: 'open-pull-requests-limit configured', issue: null });
  }

  // Missing reviewers: or assignees:
  const hasReviewers = content.includes('reviewers:');
  const hasAssignees = content.includes('assignees:');
  if (!hasReviewers && !hasAssignees) {
    results.push({
      type: 'assignee',
      detail: 'No reviewers or assignees configured',
      issue: 'dependabot.yml missing reviewers: and assignees: — Dependabot PRs will be created without any assigned reviewer; add reviewers: or assignees: to ensure PRs get reviewed promptly',
    });
  } else {
    results.push({ type: 'assignee', detail: 'reviewers/assignees configured', issue: null });
  }

  // schedule.interval: daily for all ecosystems (suggest weekly)
  const dailyCount = (content.match(/interval:\s*["']?daily["']?/g) ?? []).length;
  if (dailyCount > 0) {
    results.push({
      type: 'schedule',
      detail: `${dailyCount} ecosystem(s) with daily schedule`,
      issue: `${dailyCount} ecosystem(s) use schedule interval: daily — daily updates create high PR noise; consider changing to interval: weekly to reduce churn while still getting timely security updates`,
    });
  } else {
    results.push({ type: 'schedule', detail: 'No daily schedule detected', issue: null });
  }

  // Missing groups: for bundling minor/patch updates
  const hasGroups = content.includes('groups:');
  if (!hasGroups) {
    results.push({
      type: 'groups',
      detail: 'No groups: configuration for bundling updates',
      issue: 'dependabot.yml missing groups: configuration — without groups, each dependency gets its own PR; add groups: to bundle minor/patch updates together and reduce PR noise (e.g., group all patch updates in one PR)',
    });
  } else {
    results.push({ type: 'groups', detail: 'groups: configuration found', issue: null });
  }

  return results;
}

export function listGithubDependabotConfig(appPath: string): McpToolResult {
  try {
    const infos = buildGithubDependabotConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Dependabot configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `GitHub Dependabot Configuration Analysis\n${'='.repeat(55)}\n\nChecks: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubDependabotConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildGithubDependabotConfigInfos(appPath);
    const ecosystems = infos.filter((i) => i.type === 'ecosystem');
    const configuredEco = ecosystems.filter((i) => i.issue === null);
    const missingEco = ecosystems.filter((i) => i.issue !== null);
    let text = `GitHub Dependabot Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Ecosystems configured: ${configuredEco.length}\n`;
    text += `Ecosystems missing:    ${missingEco.length}\n`;
    text += `Limit issues:          ${infos.filter((i) => i.type === 'limit' && i.issue !== null).length}\n`;
    text += `Assignee issues:       ${infos.filter((i) => i.type === 'assignee' && i.issue !== null).length}\n`;
    text += `Schedule issues:       ${infos.filter((i) => i.type === 'schedule' && i.issue !== null).length}\n`;
    text += `Groups issues:         ${infos.filter((i) => i.type === 'groups' && i.issue !== null).length}\n`;
    text += `Total issues:          ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubDependabotConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_github_dependabot_config',
      description: 'Scan .github/dependabot.yml for Dependabot configuration issues: missing composer/npm/docker/github-actions ecosystem entries, no open-pull-requests-limit, missing reviewers/assignees, schedule interval: daily for all ecosystems (suggest weekly), missing groups: for bundling minor/patch updates.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_github_dependabot_config_stats',
      description: 'Statistics for GitHub Dependabot configuration: ecosystem/limit/assignee/schedule/groups issue counts.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
