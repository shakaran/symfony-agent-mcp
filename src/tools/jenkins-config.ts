// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface JenkinsConfigInfo {
  file: string;
  stage: string;
  type: 'declarative' | 'scripted';
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function detectJenkinsfileType(content: string): 'declarative' | 'scripted' {
  if (/^\s*pipeline\s*\{/m.test(content)) return 'declarative';
  return 'scripted';
}

function parseJenkinsfile(content: string, relPath: string): JenkinsConfigInfo[] {
  const results: JenkinsConfigInfo[] = [];
  const type = detectJenkinsfileType(content);

  // Global-level checks
  const globalInfo: JenkinsConfigInfo = { file: relPath, stage: 'global', type, issues: [] };

  // timeout
  if (!/timeout\s*\(/.test(content)) {
    globalInfo.issues.push('No timeout set in Jenkinsfile — add options { timeout(time: 30, unit: "MINUTES") } to prevent hung builds');
  }

  // post { failure { } }
  if (!/post\s*\{[^}]{0,500}failure\s*\{/s.test(content)) {
    globalInfo.issues.push('No post { failure { } } block found — add failure notifications (e.g. mail/Slack) to alert on broken builds');
  }

  // rm -rf usage
  if (/sh\s+['"]?\s*rm\s+-rf/.test(content)) {
    globalInfo.issues.push('sh "rm -rf ..." found in Jenkinsfile — ensure rm -rf targets are well-scoped to avoid accidental workspace destruction');
  }

  results.push(globalInfo);

  // environment block — check for plain-text credentials
  const envMatch = content.match(/\benvironment\s*\{([^}]{0,2000})\}/s);
  if (envMatch) {
    const envBlock = envMatch[1];
    const lines = envBlock.split('\n');
    for (const line of lines) {
      const kvMatch = line.match(/^\s*(\w{1,80})\s*=\s*["']([^"']{0,200})["']/);
      if (!kvMatch) continue;
      const envKey = kvMatch[1];
      if (/password|secret|token|key|credential|\bpass\b|\bcert\b|\bdsn\b|auth/i.test(envKey) && !/credentials\(/.test(line)) {
        results.push({
          file: relPath,
          stage: 'environment',
          type,
          issues: [`Credential "${envKey}" stored as plain text value — use credentials('id') binding instead`],
        });
      }
    }
    if (!results.some((r) => r.stage === 'environment')) {
      results.push({ file: relPath, stage: 'environment', type, issues: [] });
    }
  }

  // stages
  if (type === 'declarative') {
    const stagePattern = /stage\s*\(\s*["']([^"']{1,100})["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = stagePattern.exec(content)) !== null) {
      const stageName = m[1];
      // Extract a small window around this stage for analysis
      const stageStart = m.index;
      const stageWindow = content.slice(stageStart, stageStart + 1500);

      const stageInfo: JenkinsConfigInfo = { file: relPath, stage: stageName, type, issues: [] };

      // credentials stored as plain text in sh steps
      const shCmds = stageWindow.match(/sh\s+["']([^"']{1,300})["']/g) ?? [];
      for (const shCmd of shCmds) {
        if (/password=|secret=|token=|\bpass=|\bcert=|\bdsn=|auth=/i.test(shCmd) && !shCmd.includes('${')) {
          stageInfo.issues.push(`Stage "${stageName}": possible plain-text credential in sh step — use withCredentials() or env variable reference`);
        }
      }

      results.push(stageInfo);
    }
  } else {
    // scripted: look for node/stage blocks
    const stagePattern = /stage\s*\(\s*["']([^"']{1,100})["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = stagePattern.exec(content)) !== null) {
      results.push({ file: relPath, stage: m[1], type, issues: [] });
    }
  }

  return results;
}

function buildJenkinsConfigInfos(appPath: string): JenkinsConfigInfo[] {
  const results: JenkinsConfigInfo[] = [];
  const candidates = [
    'Jenkinsfile',
    'Jenkinsfile.groovy',
    path.join('jenkins', 'Jenkinsfile'),
  ];

  for (const rel of candidates) {
    const fullPath = path.join(appPath, rel);
    const content = safeReadFile(fullPath, appPath);
    if (content !== null) {
      results.push(...parseJenkinsfile(content, rel));
    }
  }

  return results;
}

export function listJenkinsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildJenkinsConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Jenkinsfile found (Jenkinsfile, Jenkinsfile.groovy, jenkins/Jenkinsfile).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Jenkins Configuration Analysis\n${'='.repeat(55)}\n\nStages: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] Stage: ${info.stage}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getJenkinsConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildJenkinsConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const files = [...new Set(infos.map((i) => i.file))];
    const declarative = infos.filter((i) => i.type === 'declarative').length;
    const scripted = infos.filter((i) => i.type === 'scripted').length;
    let text = `Jenkins Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files found:         ${files.length}\n`;
    text += `Declarative stages:  ${declarative}\n`;
    text += `Scripted stages:     ${scripted}\n`;
    text += `Credential issues:   ${infos.filter((i) => i.issues.some((x) => x.includes('plain text') || x.includes('credential'))).length}\n`;
    text += `Timeout issues:      ${infos.filter((i) => i.issues.some((x) => x.includes('timeout'))).length}\n`;
    text += `Post-failure issues: ${infos.filter((i) => i.issues.some((x) => x.includes('failure'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getJenkinsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_jenkins_config',
      description: 'Analyse Jenkinsfile (Jenkinsfile, Jenkinsfile.groovy, jenkins/Jenkinsfile) for plain-text credentials, missing timeout, missing post failure block, and dangerous rm -rf usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_jenkins_config_stats',
      description: 'Statistics for Jenkins configuration: file count, declarative/scripted stage counts, credential/timeout/post-failure issues, and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
