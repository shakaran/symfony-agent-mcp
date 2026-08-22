import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface GithubActionsInfo {
  file: string;
  type: 'permission' | 'mutable-ref' | 'secret' | 'trigger' | 'runner' | 'cache';
  pattern: string;
  issues: string[];
}

function analyseWorkflow(filePath: string, relPath: string): GithubActionsInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const results: GithubActionsInfo[] = [];

  // Mutable action refs: uses@main or uses@master
  const mutableRefPattern = /uses:\s*[^\s@]+@(main|master)\b/g;
  let m: RegExpExecArray | null;
  while ((m = mutableRefPattern.exec(content)) !== null) {
    results.push({
      file: relPath,
      type: 'mutable-ref',
      pattern: `uses: ...@${m[1]}`,
      issues: ['GitHub Action reference uses branch name (main/master) — pin to a specific tag or SHA for reproducible builds; e.g. uses: actions/checkout@v4.1.1'],
    });
    break; // one finding per file
  }

  // Broad write permissions
  if (/permissions:\s*write-all|actions:\s*write/.test(content)) {
    results.push({
      file: relPath,
      type: 'permission',
      pattern: 'write-all / actions: write permissions',
      issues: ['GitHub Actions workflow with broad write permissions — follow least-privilege; use specific permissions: { contents: read }'],
    });
  }

  // pull_request_target with checkout
  if (/pull_request_target/.test(content) && /actions\/checkout/.test(content)) {
    results.push({
      file: relPath,
      type: 'trigger',
      pattern: 'pull_request_target with actions/checkout',
      issues: ['pull_request_target trigger with checkout — this runs in the context of the base repo with write permissions; untrusted PR code with write access is a security risk'],
    });
  }

  // Self-hosted runners
  if (/runs-on:\s*self-hosted/.test(content)) {
    results.push({
      file: relPath,
      type: 'runner',
      pattern: 'runs-on: self-hosted',
      issues: ['Self-hosted runner in GitHub Actions — self-hosted runners persist state between runs and have less isolation than GitHub-hosted runners; ensure proper cleanup and isolation'],
    });
  }

  // Cache with potentially sensitive paths
  if (/actions\/cache/.test(content) && /path:/.test(content)) {
    results.push({
      file: relPath,
      type: 'cache',
      pattern: 'actions/cache usage',
      issues: ['Sensitive data potentially in GitHub Actions cache — verify no credentials, tokens, or secrets are included in cached paths'],
    });
  }

  // Hardcoded secret values in env section (not using ${{ secrets.X }})
  const envSectionMatch = content.match(/env:\s*\n((?:\s+\w+:.+\n)*)/);
  if (envSectionMatch) {
    const envBlock = envSectionMatch[1];
    const lines = envBlock.split('\n');
    for (const line of lines) {
      // Detect lines that look like KEY: value but NOT ${{ secrets.X }} or ${{ vars.X }}
      if (/\w+:\s*\S+/.test(line) && !/\$\{\{/.test(line)) {
        if (/password|secret|token|key|api_key|auth/i.test(line)) {
          results.push({
            file: relPath,
            type: 'secret',
            pattern: 'Hardcoded value in env section',
            issues: ['Hardcoded secret value in workflow env — use ${{ secrets.SECRET_NAME }} to reference secrets, never hardcode values'],
          });
          break;
        }
      }
    }
  }

  return results;
}

function buildGithubActionsConfigInfos(appPath: string): GithubActionsInfo[] {
  const results: GithubActionsInfo[] = [];
  const workflowDir = path.join(appPath, '.github', 'workflows');

  if (!fs.existsSync(workflowDir)) {
    results.push({
      file: '.github/workflows',
      type: 'trigger',
      pattern: 'No GitHub Actions configured',
      issues: [],
    });
    return results;
  }

  try {
    for (const entry of fs.readdirSync(workflowDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;
      const fullPath = path.join(workflowDir, entry.name);
      const relPath = path.relative(appPath, fullPath);
      results.push(...analyseWorkflow(fullPath, relPath));
    }
  } catch { /* skip */ }

  return results;
}

export function listGithubActionsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildGithubActionsConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GitHub Actions workflows found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GitHub Actions Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubActionsConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildGithubActionsConfigInfos(appPath);
    let text = `GitHub Actions Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Permission:  ${infos.filter((i) => i.type === 'permission').length}\n`;
    text += `Mutable-ref: ${infos.filter((i) => i.type === 'mutable-ref').length}\n`;
    text += `Secret:      ${infos.filter((i) => i.type === 'secret').length}\n`;
    text += `Trigger:     ${infos.filter((i) => i.type === 'trigger').length}\n`;
    text += `Runner:      ${infos.filter((i) => i.type === 'runner').length}\n`;
    text += `Cache:       ${infos.filter((i) => i.type === 'cache').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubActionsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_github_actions_config',
      description: 'Analyse GitHub Actions workflows for mutable action refs, broad write permissions, pull_request_target risks, self-hosted runner isolation, cache secrets, and hardcoded env values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_github_actions_config_stats',
      description: 'Statistics for GitHub Actions configuration: counts by type (permission/mutable-ref/secret/trigger/runner/cache) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
