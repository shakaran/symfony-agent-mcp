// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GitlabCiInfo {
  file: string;
  type: 'variable' | 'artifact' | 'security-scan' | 'environment' | 'trigger' | 'image';
  pattern: string;
  issues: string[];
}

function buildGitlabCiConfigInfos(appPath: string): GitlabCiInfo[] {
  const results: GitlabCiInfo[] = [];
  const ciPath = path.join(appPath, '.gitlab-ci.yml');

  if (!fs.existsSync(ciPath)) {
    results.push({
      file: '.gitlab-ci.yml',
      type: 'trigger',
      pattern: 'No GitLab CI configured',
      issues: [],
    });
    return results;
  }

  let content = '';
  try { content = fs.readFileSync(ciPath, 'utf-8'); } catch { return results; }

  // Variables section with potential hardcoded secrets
  const variablesMatch = content.match(/^variables:\s*\n((?:\s+\w+:.+\n)*)/m);
  if (variablesMatch) {
    const block = variablesMatch[1];
    const lines = block.split('\n');
    for (const line of lines) {
      if (/password|secret|token|key|auth|passwd/i.test(line) && /:\s*\S/.test(line) && !line.trim().startsWith('#')) {
        results.push({
          file: '.gitlab-ci.yml',
          type: 'variable',
          pattern: 'Potential hardcoded secret in variables',
          issues: ['GitLab CI variable with potential hardcoded secret — use protected/masked CI/CD variables in GitLab UI instead of plain values in .gitlab-ci.yml'],
        });
        break;
      }
    }
  }

  // Artifacts exposing sensitive paths
  const artifactPaths = content.match(/paths:\s*\n((?:\s+-\s*.+\n)*)/g) ?? [];
  for (const block of artifactPaths) {
    if (/\.env|\.log|config\//.test(block)) {
      results.push({
        file: '.gitlab-ci.yml',
        type: 'artifact',
        pattern: 'Artifact includes sensitive paths',
        issues: ['GitLab CI artifact includes potentially sensitive paths — review artifact paths to ensure no credentials or sensitive configs are exposed'],
      });
      break;
    }
  }

  // No SAST/DAST/dependency scanning
  if (!/sast|dast|dependency.scanning|Security\/SAST/i.test(content)) {
    results.push({
      file: '.gitlab-ci.yml',
      type: 'security-scan',
      pattern: 'No security scanning stages',
      issues: ['GitLab CI without security scanning stages — add include: template: Security/SAST.gitlab-ci.yml and Dependency-Scanning.gitlab-ci.yml for automated vulnerability scanning'],
    });
  }

  // Docker image using :latest tag
  const imageLatestPattern = /image:\s*[\w./:-]+:latest/g;
  if (imageLatestPattern.test(content)) {
    results.push({
      file: '.gitlab-ci.yml',
      type: 'image',
      pattern: 'Docker image with :latest tag',
      issues: ['Docker image uses :latest tag in GitLab CI — use specific image versions (php:8.3-fpm-alpine) for reproducible builds'],
    });
  }

  // Deploy stage without environment protection
  if (/stage:\s*deploy/.test(content) && !/environment:\s*\n\s+name:/.test(content)) {
    results.push({
      file: '.gitlab-ci.yml',
      type: 'environment',
      pattern: 'Deploy stage without environment block',
      issues: ['Deployment job without protected environment — configure environment: { name: production, url: ... } and set protection rules in GitLab UI'],
    });
  }

  // Trigger for downstream pipelines (informational)
  if (/^trigger:|\btrigger:\s*\n/m.test(content)) {
    results.push({
      file: '.gitlab-ci.yml',
      type: 'trigger',
      pattern: 'Downstream pipeline trigger configured',
      issues: [],
    });
  }

  return results;
}

export function listGitlabCiConfig(appPath: string): McpToolResult {
  try {
    const infos = buildGitlabCiConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GitLab CI configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GitLab CI Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGitlabCiConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildGitlabCiConfigInfos(appPath);
    let text = `GitLab CI Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Variable:     ${infos.filter((i) => i.type === 'variable').length}\n`;
    text += `Artifact:     ${infos.filter((i) => i.type === 'artifact').length}\n`;
    text += `Security-scan: ${infos.filter((i) => i.type === 'security-scan').length}\n`;
    text += `Environment:  ${infos.filter((i) => i.type === 'environment').length}\n`;
    text += `Trigger:      ${infos.filter((i) => i.type === 'trigger').length}\n`;
    text += `Image:        ${infos.filter((i) => i.type === 'image').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGitlabCiConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_gitlab_ci_config',
      description: 'Analyse .gitlab-ci.yml for hardcoded secrets in variables, sensitive artifact paths, missing security scanning, :latest image tags, unprotected deploy environments, and trigger configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_gitlab_ci_config_stats',
      description: 'Statistics for GitLab CI configuration: counts by type (variable/artifact/security-scan/environment/trigger/image) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
