// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AzurePipelinesConfigInfo {
  file: string;
  stage: string;
  job: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

const SECRET_KEY_PATTERN = /password|secret|token|api_key|private|credential|access_key|\bpass\b|\bkey\b|\bcert\b|\bdsn\b|\bauth\b/i;

function parseAzurePipelinesYaml(content: string, relPath: string): AzurePipelinesConfigInfo[] {
  const results: AzurePipelinesConfigInfo[] = [];

  // trigger
  const hasTrigger = /^trigger\s*:/m.test(content);
  if (hasTrigger) {
    // Check for branch filters
    const hasBranchFilter = /branches\s*:|include\s*:|exclude\s*:/.test(content);
    const info: AzurePipelinesConfigInfo = { file: relPath, stage: 'global', job: 'trigger', issues: [] };
    if (!hasBranchFilter) {
      info.issues.push('trigger has no branches filter — add branches: include: [main, develop] to limit which branches trigger the pipeline');
    }
    results.push(info);
  } else {
    results.push({
      file: relPath,
      stage: 'global',
      job: 'trigger',
      issues: ['No trigger defined — add a trigger block to control when the pipeline runs (default triggers on all branches)'],
    });
  }

  // pool
  const poolMatch = content.match(/^pool\s*:([\s\S]{0,300}?)(?=^[a-z]|$)/m);
  if (poolMatch) {
    const poolBlock = poolMatch[1];
    const vmImageMatch = poolBlock.match(/vmImage\s*:\s*["']?([^"'\n]{1,80})["']?/);
    results.push({
      file: relPath,
      stage: 'global',
      job: `pool: ${vmImageMatch ? vmImageMatch[1].trim() : 'agent-pool'}`,
      issues: [],
    });
  }

  // variables — check for secrets in plain text
  const varsMatch = content.match(/^variables\s*:([\s\S]{0,2000}?)(?=^stages\s*:|^jobs\s*:|^steps\s*:|^pool\s*:|$)/m);
  if (varsMatch) {
    const varsBlock = varsMatch[1];
    const lines = varsBlock.split('\n');
    for (const line of lines) {
      // Inline variable: - name: FOO / value: bar pattern
      const nameMatch = line.match(/^\s*-?\s*name\s*:\s*([A-Za-z0-9_]{1,80})/);
      if (!nameMatch) {
        // key: value form
        const kvMatch = line.match(/^\s{2,}([A-Za-z0-9_]{1,80})\s*:\s*["']?([^"'\n]{0,200})["']?/);
        if (kvMatch) {
          const [, varKey, varVal] = kvMatch;
          if (SECRET_KEY_PATTERN.test(varKey) && varVal.trim().length > 0 && !varVal.includes('$(')) {
            results.push({
              file: relPath,
              stage: 'global',
              job: `variables.${varKey}`,
              issues: [`Variable "${varKey}" looks like a secret stored in plain text — use variable groups or Azure Key Vault linking instead of hardcoded values`],
            });
          }
        }
      }
    }
    // If variable groups referenced — that's good
    if (/group\s*:/.test(varsBlock)) {
      results.push({ file: relPath, stage: 'global', job: 'variable-group', issues: [] });
    }
  }

  // stages
  const hasStages = /^stages\s*:/m.test(content);
  if (hasStages) {
    const stagePattern = /^\s*-\s*stage\s*:\s*(\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = stagePattern.exec(content)) !== null) {
      const stageName = m[1];
      const stageStart = m.index;
      const stageWindow = content.slice(stageStart, stageStart + 3000);

      // jobs within stage
      const jobPattern = /^\s*-\s*job\s*:\s*(\S+)/gm;
      let jobMatch: RegExpExecArray | null;
      while ((jobMatch = jobPattern.exec(stageWindow)) !== null) {
        const jobName = jobMatch[1];
        const jobStart = jobMatch.index;
        const jobWindow = stageWindow.slice(jobStart, jobStart + 2000);

        const jobInfo: AzurePipelinesConfigInfo = { file: relPath, stage: stageName, job: jobName, issues: [] };

        // timeout
        if (!/timeoutInMinutes\s*:/.test(jobWindow)) {
          jobInfo.issues.push(`Job "${jobName}" in stage "${stageName}" has no timeoutInMinutes set — add timeoutInMinutes to prevent hung jobs consuming agent capacity`);
        }

        // steps with potential secrets
        const scriptMatches = jobWindow.match(/(?:script|bash|powershell)\s*:\s*["']?([^\n]{1,300})/g) ?? [];
        for (const scriptLine of scriptMatches) {
          if (SECRET_KEY_PATTERN.test(scriptLine) && !scriptLine.includes('$(')) {
            jobInfo.issues.push(`Job "${jobName}": possible hardcoded secret in script step — reference secrets via $(<variable-group-var>) or environment variables`);
            break;
          }
        }

        results.push(jobInfo);
      }

      // Stage without any jobs
      if (!/^\s*-\s*job\s*:/m.test(stageWindow.slice(0, 500))) {
        // Maybe it has deployment jobs
        if (!/^\s*-\s*deployment\s*:/m.test(stageWindow.slice(0, 500))) {
          results.push({ file: relPath, stage: stageName, job: 'stage-config', issues: [] });
        }
      }
    }
  } else {
    // Flat pipeline — jobs or steps directly
    const jobPattern = /^\s*-\s*job\s*:\s*(\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = jobPattern.exec(content)) !== null) {
      const jobName = m[1];
      const jobStart = m.index;
      const jobWindow = content.slice(jobStart, jobStart + 2000);

      const jobInfo: AzurePipelinesConfigInfo = { file: relPath, stage: 'root', job: jobName, issues: [] };

      if (!/timeoutInMinutes\s*:/.test(jobWindow)) {
        jobInfo.issues.push(`Job "${jobName}" has no timeoutInMinutes — add timeoutInMinutes to prevent hung jobs`);
      }

      results.push(jobInfo);
    }

    // Steps-only pipeline (no stages/jobs)
    if (!/^\s*-\s*job\s*:/m.test(content) && /^\s*steps\s*:/m.test(content)) {
      const timeoutInfo: AzurePipelinesConfigInfo = { file: relPath, stage: 'root', job: 'steps', issues: [] };
      if (!/timeoutInMinutes\s*:/.test(content)) {
        timeoutInfo.issues.push('No timeoutInMinutes set at pipeline level — add timeoutInMinutes to prevent hung runs');
      }
      results.push(timeoutInfo);
    }
  }

  return results;
}

function buildAzurePipelinesConfigInfos(appPath: string): AzurePipelinesConfigInfo[] {
  const results: AzurePipelinesConfigInfo[] = [];
  const candidates = [
    'azure-pipelines.yml',
    'azure-pipelines.yaml',
    path.join('.azure', 'pipelines.yml'),
  ];

  for (const rel of candidates) {
    const fullPath = path.join(appPath, rel);
    const content = safeReadFile(fullPath, appPath);
    if (content !== null) {
      results.push(...parseAzurePipelinesYaml(content, rel));
    }
  }

  return results;
}

export function listAzurePipelinesConfig(appPath: string): McpToolResult {
  try {
    const infos = buildAzurePipelinesConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Azure Pipelines configuration found (azure-pipelines.yml, azure-pipelines.yaml, .azure/pipelines.yml).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Azure Pipelines Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.stage}] Job: ${info.job}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAzurePipelinesConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildAzurePipelinesConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const stages = [...new Set(infos.map((i) => i.stage).filter((s) => s !== 'global'))];
    const files = [...new Set(infos.map((i) => i.file))];
    let text = `Azure Pipelines Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files found:         ${files.length}\n`;
    text += `Stages detected:     ${stages.length}\n`;
    text += `Job entries:         ${infos.length}\n`;
    text += `Trigger issues:      ${infos.filter((i) => i.job === 'trigger' && i.issues.length > 0).length}\n`;
    text += `Secret issues:       ${infos.filter((i) => i.issues.some((x) => x.includes('secret') || x.includes('plain text'))).length}\n`;
    text += `Timeout issues:      ${infos.filter((i) => i.issues.some((x) => x.includes('timeout') || x.includes('timeoutInMinutes'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    if (stages.length > 0) text += `\nStages:\n${stages.map((s) => `  ${s}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAzurePipelinesConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_azure_pipelines_config',
      description: 'Analyse Azure Pipelines YAML (azure-pipelines.yml, azure-pipelines.yaml, .azure/pipelines.yml) for missing trigger branch filters, secrets in variables, no timeoutInMinutes, and job configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_azure_pipelines_config_stats',
      description: 'Statistics for Azure Pipelines configuration: file/stage/job counts, trigger/secret/timeout issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
