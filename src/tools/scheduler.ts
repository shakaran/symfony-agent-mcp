/**
 * Symfony Scheduler Inspector
 *
 * Discovers scheduled tasks registered via:
 *   - #[AsPeriodicTask] attribute (Symfony 6.3+)
 *   - #[AsCronTask] attribute (Symfony 6.3+)
 *   - #[AsSchedule] provider classes
 *   - config/packages/scheduler.yaml (if present)
 *
 * Reports task class, schedule expression, timezone, jitter, and
 * the message/callable dispatched. Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ScheduledTask {
  class: string;
  file: string;
  type: 'periodic' | 'cron' | 'schedule_provider';
  expression: string;
  timezone?: string;
  jitter?: number;
  message?: string;
  method?: string;
}

// ─── File scanning ─────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

// ─── Attribute parsing ─────────────────────────────────────────────────────

function parseSchedulerAttributes(filePath: string): ScheduledTask[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const tasks: ScheduledTask[] = [];
  const className = extractClassName(content);
  if (!className) return [];

  const isScheduleProvider = content.includes('AsSchedule') ||
                              content.includes('ScheduleProviderInterface');

  // #[AsPeriodicTask(frequency: '5 minutes', timezone: 'UTC', jitter: 60)]
  const periodicPattern = /#\[AsPeriodicTask\s*\(([^)]*)\)\]/g;
  let m: RegExpExecArray | null;
  while ((m = periodicPattern.exec(content)) !== null) {
    const args = m[1];
    const freq = /frequency\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1] ??
                 /(?:^|,\s*)['"]([^'"]+)['"]/.exec(args)?.[1] ?? '';
    const tz = /timezone\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
    const jitter = /jitter\s*:\s*(\d+)/.exec(args)?.[1];

    // Find the method it decorates
    const afterAttr = content.slice(m.index);
    const methodM = /function\s+(\w+)/.exec(afterAttr);

    tasks.push({
      class: className,
      file: path.basename(filePath),
      type: 'periodic',
      expression: freq,
      timezone: tz,
      jitter: jitter ? parseInt(jitter, 10) : undefined,
      method: methodM?.[1],
    });
  }

  // #[AsCronTask(expression: '0 * * * *', timezone: 'UTC')]
  const cronPattern = /#\[AsCronTask\s*\(([^)]*)\)\]/g;
  while ((m = cronPattern.exec(content)) !== null) {
    const args = m[1];
    const expr = /expression\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1] ??
                 /(?:^|,\s*)['"]([^'"]+)['"]/.exec(args)?.[1] ?? '';
    const tz = /timezone\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
    const jitter = /jitter\s*:\s*(\d+)/.exec(args)?.[1];

    const afterAttr = content.slice(m.index);
    const methodM = /function\s+(\w+)/.exec(afterAttr);

    tasks.push({
      class: className,
      file: path.basename(filePath),
      type: 'cron',
      expression: expr,
      timezone: tz,
      jitter: jitter ? parseInt(jitter, 10) : undefined,
      method: methodM?.[1],
    });
  }

  if (isScheduleProvider && tasks.length === 0) {
    tasks.push({
      class: className,
      file: path.basename(filePath),
      type: 'schedule_provider',
      expression: '(dynamic — see getSchedule())',
    });
  }

  return tasks;
}

function loadScheduledTasks(appPath: string): ScheduledTask[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Scheduler'),
    path.join(appPath, 'src', 'Schedule'),
    path.join(appPath, 'src', 'Task'),
    path.join(appPath, 'src', 'MessageHandler'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const tasks: ScheduledTask[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('AsPeriodicTask') &&
          !content.includes('AsCronTask') &&
          !content.includes('AsSchedule') &&
          !content.includes('ScheduleProviderInterface')) continue;

      tasks.push(...parseSchedulerAttributes(file));
    }
  }

  return tasks.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Human-readable frequency ──────────────────────────────────────────────

function describeExpression(task: ScheduledTask): string {
  if (task.type === 'cron') {
    return `cron: ${task.expression}`;
  }
  return `every ${task.expression}`;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listScheduledTasks(appPath: string): McpToolResult {
  try {
    const tasks = loadScheduledTasks(appPath);

    if (tasks.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No scheduled tasks found.\n\nCreate with Symfony Scheduler (6.3+):\n  #[AsPeriodicTask(frequency: \'5 minutes\')]\n  public function myTask(): void { ... }\n\n  #[AsCronTask(expression: \'0 * * * *\')]\n  public function hourlyTask(): void { ... }\n\nInstall: composer require symfony/scheduler',
        }],
      };
    }

    let text = `Scheduled Tasks (${tasks.length})\n${'='.repeat(50)}\n`;

    const byType: Record<string, ScheduledTask[]> = {};
    for (const t of tasks) {
      (byType[t.type] ??= []).push(t);
    }

    for (const [type, group] of Object.entries(byType)) {
      const label = type === 'periodic' ? 'Periodic Tasks' :
                    type === 'cron' ? 'Cron Tasks' : 'Schedule Providers';
      text += `\n  ${label} (${group.length})\n`;
      for (const t of group) {
        const method = t.method ? `::${t.method}()` : '';
        text += `    ${t.class}${method}  (${t.file})\n`;
        text += `      ${describeExpression(t)}`;
        if (t.timezone) text += `  [${t.timezone}]`;
        if (t.jitter) text += `  jitter: ${t.jitter}s`;
        text += '\n';
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

export function getSchedulerStats(appPath: string): McpToolResult {
  try {
    const tasks = loadScheduledTasks(appPath);

    let text = `Scheduler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total tasks:       ${tasks.length}\n`;
    text += `Periodic tasks:    ${tasks.filter((t) => t.type === 'periodic').length}\n`;
    text += `Cron tasks:        ${tasks.filter((t) => t.type === 'cron').length}\n`;
    text += `Schedule providers:${tasks.filter((t) => t.type === 'schedule_provider').length}\n`;
    text += `With timezone:     ${tasks.filter((t) => t.timezone).length}\n`;
    text += `With jitter:       ${tasks.filter((t) => t.jitter).length}\n`;

    if (tasks.length === 0) {
      text += '\nNo tasks configured. Install: composer require symfony/scheduler\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getSchedulerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_scheduled_tasks',
      description: 'List all Symfony Scheduler tasks: #[AsPeriodicTask] and #[AsCronTask] with frequency/expression, timezone, jitter, and method name',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_scheduler_stats',
      description: 'Show scheduler statistics: periodic vs cron task count, tasks with timezone/jitter configured',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
