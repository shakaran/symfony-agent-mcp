import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CircleCiConfigInfo {
  file: string;
  job: string;
  step: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function parseCircleCiConfig(content: string, relPath: string): CircleCiConfigInfo[] {
  const results: CircleCiConfigInfo[] = [];

  // version
  const versionMatch = content.match(/^version\s*:\s*(\S+)/m);
  const version = versionMatch ? versionMatch[1] : 'unknown';
  results.push({ file: relPath, job: 'global', step: `version: ${version}`, issues: [] });

  // orbs
  if (/^orbs\s*:/m.test(content)) {
    const orbMatches = content.match(/^\s{2}(\w[\w-]{0,60})\s*:/gm) ?? [];
    for (const orb of orbMatches.slice(0, 10)) {
      results.push({ file: relPath, job: 'orbs', step: orb.trim(), issues: [] });
    }
  }

  // jobs — extract job names
  const jobSectionMatch = content.match(/^jobs\s*:([\s\S]{0,10000}?)(?=^workflows\s*:|^orbs\s*:|$)/m);
  const jobSection = jobSectionMatch ? jobSectionMatch[1] : content;

  // Simple job name extraction: lines with 2-space indent + word:
  const jobNamePattern = /^ {2}(\w[\w-]{0,60})\s*:/gm;
  let jobMatch: RegExpExecArray | null;
  const jobNames: string[] = [];
  while ((jobMatch = jobNamePattern.exec(jobSection)) !== null) {
    jobNames.push(jobMatch[1]);
  }

  for (const jobName of jobNames) {
    // Extract block for this job (heuristic: find the job block)
    const jobBlockPattern = new RegExp(`^ {2}${jobName}\\s*:[\\s\\S]{0,3000}?(?=^ {2}\\w|$)`, 'm');
    const jobBlockMatch = jobSection.match(jobBlockPattern);
    const jobBlock = jobBlockMatch ? jobBlockMatch[0] : '';

    const info: CircleCiConfigInfo = { file: relPath, job: jobName, step: 'job-config', issues: [] };

    // PHP version pinned?
    if (/php/i.test(jobName) || /php/i.test(jobBlock)) {
      if (!/php:\s*\d+\.\d+|\bphp:\s*["']\d/.test(jobBlock)) {
        if (!/image\s*:.*php:\d+\.\d+/.test(jobBlock)) {
          info.issues.push(`Job "${jobName}": PHP version not pinned — use a specific tag like php:8.3 to ensure reproducible builds`);
        }
      }
    }

    // composer install with --no-dev in prod?
    if (/composer.*install/i.test(jobBlock) && !/--no-dev/.test(jobBlock)) {
      if (/prod|deploy|release/i.test(jobName)) {
        info.issues.push(`Job "${jobName}": composer install without --no-dev — add --no-dev --optimize-autoloader for production builds`);
      }
    }

    // Caching of vendor/
    if (/composer.*install|composer.*update/i.test(jobBlock)) {
      if (!/restore_cache|save_cache/.test(jobBlock)) {
        info.issues.push(`Job "${jobName}": No caching configured for vendor/ — add restore_cache/save_cache steps keyed on composer.lock hash`);
      }
    }

    // Test parallelism
    if (/phpunit|phpspec|behat|pest/i.test(jobBlock)) {
      if (!/parallelism\s*:\s*[2-9]|parallelism\s*:\s*\d{2,}/.test(jobBlock)) {
        info.issues.push(`Job "${jobName}": No test parallelism configured — add "parallelism: N" to speed up test execution`);
      }
    }

    results.push(info);

    // Check for steps
    const stepPattern = /- (run|checkout|setup_remote_docker|restore_cache|save_cache|store_artifacts|store_test_results)[\s\S]{0,300}?(?=\s+- |\s{4}[a-z]|$)/g;
    let stepMatch: RegExpExecArray | null;
    while ((stepMatch = stepPattern.exec(jobBlock)) !== null) {
      const stepContent = stepMatch[0];
      const stepInfo: CircleCiConfigInfo = { file: relPath, job: jobName, step: stepMatch[1], issues: [] };

      // Secrets in plain text
      if (stepMatch[1] === 'run') {
        const commandMatch = stepContent.match(/command\s*:\s*([^\n]{1,200})/);
        const command = commandMatch ? commandMatch[1] : stepContent;
        if (/password|secret|api_key|token/i.test(command) && !command.includes('$')) {
          stepInfo.issues.push(`Job "${jobName}" step "run": Possible secret in plain text command — use context variables or environment variable references ($VAR)`);
        }
      }

      results.push(stepInfo);
    }
  }

  // workflows
  if (!/^workflows\s*:/m.test(content)) {
    results.push({
      file: relPath,
      job: 'workflows',
      step: 'missing',
      issues: ['No workflows section found — define workflows to orchestrate job execution order'],
    });
  }

  return results;
}

function buildCircleCiConfigInfos(appPath: string): CircleCiConfigInfo[] {
  const results: CircleCiConfigInfo[] = [];
  const configPath = path.join(appPath, '.circleci', 'config.yml');
  const content = safeReadFile(configPath, appPath);
  if (content !== null) {
    results.push(...parseCircleCiConfig(content, '.circleci/config.yml'));
  }
  return results;
}

export function listCircleCiConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCircleCiConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No CircleCI configuration file found (.circleci/config.yml).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `CircleCI Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      if (info.issues.length === 0 && info.step !== 'job-config') continue;
      text += `\n  [${info.job}] ${info.step}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCircleCiConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCircleCiConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const jobs = [...new Set(infos.map((i) => i.job).filter((j) => j !== 'global' && j !== 'orbs' && j !== 'workflows'))];
    let text = `CircleCI Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config found:        ${infos.length > 0 ? 'yes' : 'no'}\n`;
    text += `Jobs detected:       ${jobs.length}\n`;
    text += `Entries analyzed:    ${infos.length}\n`;
    text += `Caching issues:      ${infos.filter((i) => i.issues.some((x) => x.includes('caching') || x.includes('cache'))).length}\n`;
    text += `Parallelism issues:  ${infos.filter((i) => i.issues.some((x) => x.includes('parallelism'))).length}\n`;
    text += `Secret issues:       ${infos.filter((i) => i.issues.some((x) => x.includes('secret') || x.includes('plain text'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    if (jobs.length > 0) text += `\nJobs:\n${jobs.map((j) => `  ${j}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCircleCiConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_circleci_config',
      description: 'Analyse .circleci/config.yml for PHP version pinning, composer --no-dev in prod, vendor/ caching, test parallelism, and secrets in plain text commands',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_circleci_config_stats',
      description: 'Statistics for CircleCI configuration: job count, caching/parallelism/secret issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
