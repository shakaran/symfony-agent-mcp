// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BitbucketPipelinesInfo {
  file: string;
  step: string;
  type: 'build' | 'test' | 'deploy' | 'security';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function classifyStep(name: string, script: string): BitbucketPipelinesInfo['type'] {
  const lower = name.toLowerCase();
  if (lower.includes('deploy') || lower.includes('release')) return 'deploy';
  if (lower.includes('test') || lower.includes('phpunit') || lower.includes('behat')) return 'test';
  if (lower.includes('security') || lower.includes('audit') || lower.includes('snyk')) return 'security';
  if (script.includes('phpunit') || script.includes('behat')) return 'test';
  if (script.includes('deploy') || script.includes('kubectl') || script.includes('helm')) return 'deploy';
  return 'build';
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z0-9_]+=)[^\s$#'"]{6,}/g, '$1***');
}

function buildBitbucketPipelinesInfos(appPath: string): BitbucketPipelinesInfo[] {
  const results: BitbucketPipelinesInfo[] = [];
  const pipelinesFile = path.join(appPath, 'bitbucket-pipelines.yml');
  const content = safeRead(pipelinesFile, appPath);
  if (!content) return results;

  const relFile = path.relative(appPath, pipelinesFile);
  let hasTestStep = false;
  const hasCaches = content.includes('caches:');

  // Parse steps by scanning for "- step:" blocks
  const stepPattern = /- step:([\s\S]*?)(?=\n\s*- step:|\n\s*-\s+parallel:|\n[a-zA-Z]|$)/g;
  let m: RegExpExecArray | null;

  while ((m = stepPattern.exec(content)) !== null) {
    const block = m[1];
    const nameMatch = /name\s*:\s*(.+)/.exec(block);
    const stepName = nameMatch ? nameMatch[1].trim() : 'unnamed-step';

    const scriptMatch = /script\s*:([\s\S]*?)(?=\n\s{0,6}\w|\n\s*-\s+step:|$)/.exec(block);
    const scriptContent = scriptMatch ? scriptMatch[1] : '';
    const stepType = classifyStep(stepName, scriptContent);

    if (stepType === 'test') hasTestStep = true;

    const issues: string[] = [];

    // Check for privileged containers
    if (/privileged\s*:\s*true/.test(block)) {
      issues.push(`Step "${stepName}": privileged: true — grants root-level Docker access; avoid unless strictly required`);
    }

    // Check for plain-text secrets in script (not $VAR references)
    const scriptLines = scriptContent.split('\n');
    for (const line of scriptLines) {
      const maskedLine = maskSecrets(line);
      if (maskedLine !== line) {
        issues.push(`Step "${stepName}": possible plain-text secret in script line — use $SECRET_VAR Bitbucket Pipeline variable instead`);
        break;
      }
      // Also detect patterns like password=abc123 not using $
      if (/(?:password|token|api[_-]?key|secret)\s*=\s*[^$\s"']{6,}/i.test(line)) {
        issues.push(`Step "${stepName}": hardcoded credential pattern in script — use Bitbucket Pipeline environment variable`);
        break;
      }
    }

    results.push({ file: relFile, step: stepName, type: stepType, issues });
  }

  // Global checks
  const globalIssues: string[] = [];
  if (!hasCaches) {
    globalIssues.push('No caches defined — add composer/node caches to speed up pipeline execution');
  }
  if (!hasTestStep && results.length > 0) {
    globalIssues.push('No test step detected — add a PHPUnit/Behat test step to catch regressions before deploy');
  }

  if (globalIssues.length > 0) {
    results.push({ file: relFile, step: 'global', type: 'build', issues: globalIssues });
  }

  // Check services/image
  const imageMatch = /^image\s*:\s*(.+)/m.exec(content);
  if (imageMatch) {
    const imageStr = imageMatch[1].trim();
    if (/php:\s*latest/.test(imageStr) || imageStr === 'php') {
      results.push({
        file: relFile, step: 'image', type: 'build',
        issues: ['Pipeline image uses php:latest — pin to a specific version (e.g. php:8.3) for reproducible builds'],
      });
    }
  }

  return results;
}

export function listBitbucketPipelinesConfig(appPath: string): McpToolResult {
  try {
    const infos = buildBitbucketPipelinesInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No bitbucket-pipelines.yml found in project root.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Bitbucket Pipelines Configuration Analysis\n${'='.repeat(55)}\n\nSteps: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  step:"${info.step}"  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBitbucketPipelinesConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildBitbucketPipelinesInfos(appPath);
    let text = `Bitbucket Pipelines Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total steps:    ${infos.length}\n`;
    text += `  build:        ${infos.filter((i) => i.type === 'build').length}\n`;
    text += `  test:         ${infos.filter((i) => i.type === 'test').length}\n`;
    text += `  deploy:       ${infos.filter((i) => i.type === 'deploy').length}\n`;
    text += `  security:     ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBitbucketPipelinesConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_bitbucket_pipelines_config',
      description: 'Analyze bitbucket-pipelines.yml: parse default/branch/PR pipeline steps, image version, caches, services, deployment environments; flag no caches, plain-text secrets in scripts, privileged containers, missing test step',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_bitbucket_pipelines_config_stats',
      description: 'Statistics for Bitbucket Pipelines configuration: step counts by type (build/test/deploy/security) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
