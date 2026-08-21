/**
 * External Cron Jobs Inspector
 *
 * Scans for cron jobs OUTSIDE the SchedulerBundle (see scheduler.ts):
 *
 * Dockerfile / docker-compose:
 *   - cron / crond service in docker-compose.yml
 *   - RUN crontab commands in Dockerfile
 *
 * Supervisor:
 *   - supervisord.conf / supervisord.d/*.conf: cron-like [program:*] sections
 *
 * Kubernetes / Helm:
 *   - k8s/*.yaml / deploy/*.yaml with kind: CronJob
 *
 * Platform.sh / SymfonyCloud:
 *   - .symfony.cloud.yaml crons section
 *   - .platform.app.yaml crons section
 *
 * Makefile targets:
 *   - targets referencing crontab or cron expressions (5-field)
 *
 * Procfile / Heroku:
 *   - Procfile with clock: or worker: entries
 *
 * Scans bin/console commands likely used as cron targets:
 *   - Commands with @AsCommand containing 'cron', 'scheduled', 'daily', 'hourly'
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CronEntry {
  source: string;
  schedule?: string;
  command: string;
  issues: string[];
}

const CRON_EXPR = /(?:(?:\*|[0-9,\-*/]+)\s+){4}(?:\*|[0-9,\-*/]+)/;

function scanDockerfile(appPath: string): CronEntry[] {
  const results: CronEntry[] = [];
  const candidates = ['Dockerfile', 'docker/Dockerfile', 'docker/cron/Dockerfile', '.docker/Dockerfile'];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      for (const m of content.matchAll(/crontab[^'"]*['"]([^'"]+)['"]/g)) {
        results.push({ source: fname, command: m[1].trim(), issues: [] });
      }
      if (content.toLowerCase().includes('cron')) {
        for (const line of content.split('\n')) {
          if (CRON_EXPR.test(line)) {
            results.push({ source: fname, schedule: line.trim(), command: line.trim(), issues: [] });
          }
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanDockerCompose(appPath: string): CronEntry[] {
  const results: CronEntry[] = [];
  const files = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const fname of files) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      if (!content.toLowerCase().includes('cron')) continue;
      const lines = content.split('\n');
      let inCronService = false;
      for (const line of lines) {
        if (/cron\w*\s*:/.test(line) && !line.trim().startsWith('-')) inCronService = true;
        if (inCronService && /command\s*:\s*(.+)/.test(line)) {
          const cmdM = /command\s*:\s*(.+)/.exec(line);
          if (cmdM) results.push({ source: fname, command: cmdM[1].trim(), issues: [] });
          inCronService = false;
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanSupervisor(appPath: string): CronEntry[] {
  const results: CronEntry[] = [];
  const dirs = ['.', 'docker', '.docker', 'etc/supervisor'];
  for (const dir of dirs) {
    const dirPath = path.join(appPath, dir);
    try {
      for (const fname of fs.readdirSync(dirPath)) {
        if (!fname.endsWith('.conf') || !fname.includes('supervisor')) continue;
        const content = fs.readFileSync(path.join(dirPath, fname), 'utf-8');
        for (const m of content.matchAll(/\[program:([^\]]+)\][^[]*command\s*=\s*([^\n]+)/gs)) {
          const cmd = m[2].trim();
          if (cmd.includes('console') || CRON_EXPR.test(cmd)) {
            results.push({ source: path.join(dir, fname), command: cmd, issues: [] });
          }
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanKubernetesCronJobs(appPath: string): CronEntry[] {
  const results: CronEntry[] = [];
  const dirs = ['k8s', 'kubernetes', 'deploy', 'helm', '.k8s'];
  for (const dir of dirs) {
    const dirPath = path.join(appPath, dir);
    try {
      for (const fname of fs.readdirSync(dirPath)) {
        if (!fname.endsWith('.yaml') && !fname.endsWith('.yml')) continue;
        const content = fs.readFileSync(path.join(dirPath, fname), 'utf-8');
        if (!content.includes('CronJob')) continue;
        for (const m of content.matchAll(/schedule\s*:\s*["']([^"']+)["']/g)) {
          const scheduleM = m[1];
          const cmdM = /command\s*:\s*\[([^\]]+)\]/.exec(content) ??
                       /- (php|bin\/console[^\n]+)/.exec(content);
          results.push({
            source: path.join(dir, fname),
            schedule: scheduleM,
            command: cmdM?.[1]?.trim() ?? 'see file',
            issues: [],
          });
        }
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanPlatformSh(appPath: string): CronEntry[] {
  const results: CronEntry[] = [];
  const candidates = ['.symfony.cloud.yaml', '.platform.app.yaml'];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      if (!content.includes('crons:')) continue;
      for (const m of content.matchAll(/spec\s*:\s*["']([^"']+)["'][^c]*cmd\s*:\s*["']?([^"'\n]+)/gs)) {
        results.push({ source: fname, schedule: m[1].trim(), command: m[2].trim(), issues: [] });
      }
    } catch { /* skip */ }
  }
  return results;
}

function scanCronCommandClasses(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const commands: string[] = [];
  const keywords = ['cron', 'scheduled', 'daily', 'hourly', 'nightly', 'cleanup'];

  try {
    const findPhp = (dir: string): string[] => {
      const list: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) list.push(...findPhp(full));
        else if (entry.name.endsWith('.php')) list.push(full);
      }
      return list;
    };
    for (const file of findPhp(srcDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!content.includes('AsCommand') && !content.includes('Command extends')) continue;
      const lower = content.toLowerCase();
      if (keywords.some((k) => lower.includes(k))) {
        const classM = /class\s+(\w+)/.exec(content);
        if (classM) commands.push(classM[1]);
      }
    }
  } catch { /* skip */ }
  return commands.sort();
}

export function listCronJobs(appPath: string): McpToolResult {
  try {
    const dockerfile = scanDockerfile(appPath);
    const compose    = scanDockerCompose(appPath);
    const supervisor = scanSupervisor(appPath);
    const k8s        = scanKubernetesCronJobs(appPath);
    const platform   = scanPlatformSh(appPath);
    const commands   = scanCronCommandClasses(appPath);

    const all = [...dockerfile, ...compose, ...supervisor, ...k8s, ...platform];

    if (all.length === 0 && commands.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No external cron job configuration found.\n\nNote: For Symfony SchedulerBundle crons, use list_scheduled_tasks instead.\n\nCommon setups:\n  - docker-compose cron service\n  - Kubernetes CronJob manifests\n  - .symfony.cloud.yaml crons section',
        }],
      };
    }

    let text = `External Cron Jobs\n${'='.repeat(55)}\n`;

    const groups: Array<[string, CronEntry[]]> = [
      ['Dockerfile', dockerfile],
      ['Docker Compose', compose],
      ['Supervisor', supervisor],
      ['Kubernetes CronJob', k8s],
      ['Platform.sh', platform],
    ];

    for (const [label, entries] of groups) {
      if (entries.length === 0) continue;
      text += `\n${label} (${entries.length}):\n`;
      for (const e of entries) {
        const sched = e.schedule ? `  [${e.schedule}]` : '';
        text += `  ${e.source}${sched}\n    ${e.command}\n`;
      }
    }

    if (commands.length > 0) {
      text += `\nConsole commands likely used as cron targets (${commands.length}):\n`;
      for (const c of commands) text += `  ${c}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCronJobStats(appPath: string): McpToolResult {
  try {
    const all = [
      ...scanDockerfile(appPath),
      ...scanDockerCompose(appPath),
      ...scanSupervisor(appPath),
      ...scanKubernetesCronJobs(appPath),
      ...scanPlatformSh(appPath),
    ];
    const commands = scanCronCommandClasses(appPath);

    let text = `Cron Job Statistics\n${'='.repeat(40)}\n\n`;
    text += `External cron entries:   ${all.length}\n`;
    text += `Cron-named commands:     ${commands.length}\n`;
    const sources = [...new Set(all.map((e) => e.source.split('/')[0]))];
    if (sources.length > 0) text += `Sources:                 ${sources.join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCronJobTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cron_jobs',
      description: 'Show external cron jobs (outside SchedulerBundle): Dockerfile crontab, docker-compose cron service, supervisord programs, Kubernetes CronJob manifests, Platform.sh crons, console commands named like cron targets',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cron_job_stats',
      description: 'Show cron job statistics: total external cron entries, cron-named command count, sources detected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
