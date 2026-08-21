/**
 * Symfony Scheduler Task Inspector
 *
 * Detects #[AsPeriodicTask], #[AsCronTask], #[AsSchedule], TaskInterface
 * implementations and scheduler.yaml task definitions.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SchedulerTaskEntry {
  file: string;
  className: string;
  taskType: 'cron' | 'periodic' | 'config';
  expression: string;
  issues: string[];
}

// ─── Cron expression validation ──────────────────────────────────────────────

function isValidCronPart(part: string, min: number, max: number): boolean {
  if (part === '*') return true;
  if (/^\d{1,6}$/u.test(part)) {
    const n = parseInt(part, 10);
    return n >= min && n <= max;
  }
  if (/^\*\/\d{1,4}$/u.test(part)) return true;
  if (/^\d{1,4}-\d{1,4}$/u.test(part)) return true;
  return false;
}

function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/u);
  if (parts.length !== 5) return false;
  return (
    isValidCronPart(parts[0], 0, 59) && // minute
    isValidCronPart(parts[1], 0, 23) && // hour
    isValidCronPart(parts[2], 1, 31) && // day
    isValidCronPart(parts[3], 1, 12) && // month
    isValidCronPart(parts[4], 0, 7)    // weekday
  );
}

// ─── Interval parsing ────────────────────────────────────────────────────────

function parseIntervalSeconds(expr: string): number {
  // e.g. "PT30S", "PT1M", "P1D", "1 minute", "30 seconds", "every 10 seconds"
  const pt = /PT(\d{1,8})S/ui.exec(expr);
  if (pt) return parseInt(pt[1], 10);
  const ptm = /PT(\d{1,8})M/ui.exec(expr);
  if (ptm) return parseInt(ptm[1], 10) * 60;
  const pth = /PT(\d{1,8})H/ui.exec(expr);
  if (pth) return parseInt(pth[1], 10) * 3600;
  const secs = /(\d{1,8})\s*second/ui.exec(expr);
  if (secs) return parseInt(secs[1], 10);
  const mins = /(\d{1,8})\s*minute/ui.exec(expr);
  if (mins) return parseInt(mins[1], 10) * 60;
  return 9999;
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

function extractAttributeArg(content: string, attrName: string): string {
  const re = new RegExp(`#\\[${attrName}\\s*\\(\\s*['"]?([^'")]{0,200})['"]?`, 'u');
  const m = re.exec(content);
  return m ? m[1].trim() : '';
}

function scanPhpForTasks(appPath: string): SchedulerTaskEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: SchedulerTaskEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const isScheduler =
      /#\[AsPeriodicTask/u.test(content) ||
      /#\[AsCronTask/u.test(content) ||
      /#\[AsSchedule/u.test(content) ||
      /implements\s+TaskInterface/u.test(content) ||
      /Task::new\s*\(/u.test(content);

    if (!isScheduler) continue;

    const className = extractClassName(content, file);
    const issues: string[] = [];

    if (/#\[AsCronTask/u.test(content)) {
      const expr = extractAttributeArg(content, 'AsCronTask');
      if (expr && !isValidCronExpression(expr)) {
        issues.push(
          `#[AsCronTask] has invalid cron expression "${expr}" — task will never be dispatched`
        );
      }
      const hasErrorHandler =
        /onError|handleError|catch\s*\(|try\s*\{/u.test(content);
      if (!hasErrorHandler) {
        issues.push(
          '#[AsCronTask] without error handling — failures are silently ignored; add onError or wrap in try/catch'
        );
      }
      results.push({
        file: path.relative(appPath, file),
        className,
        taskType: 'cron',
        expression: expr || '(unknown)',
        issues,
      });
    }

    if (/#\[AsPeriodicTask/u.test(content)) {
      const freq = extractAttributeArg(content, 'AsPeriodicTask');
      const seconds = parseIntervalSeconds(freq);
      if (seconds < 60) {
        issues.push(
          `#[AsPeriodicTask] with interval "${freq}" (${seconds}s) — intervals under 60s are too frequent for the Scheduler; use Messenger for sub-minute tasks`
        );
      }
      const hasErrorHandler =
        /onError|handleError|catch\s*\(|try\s*\{/u.test(content);
      if (!hasErrorHandler) {
        issues.push(
          '#[AsPeriodicTask] without error handling — failures are silently ignored; add onError or wrap in try/catch'
        );
      }
      results.push({
        file: path.relative(appPath, file),
        className,
        taskType: 'periodic',
        expression: freq || '(unknown)',
        issues,
      });
    }
  }

  return results;
}

// ─── YAML config scanning ────────────────────────────────────────────────────

function scanSchedulerYaml(appPath: string): SchedulerTaskEntry[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'scheduler.yaml'),
    path.join(appPath, 'config', 'scheduler.yaml'),
  ];

  const results: SchedulerTaskEntry[] = [];

  for (const candidate of candidates) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!raw) continue;

    const scheduler = (raw['framework']
      ? (raw['framework'] as Record<string, unknown>)['scheduler']
      : raw['scheduler']) as Record<string, unknown> | undefined;

    if (!scheduler) continue;

    const schedules = scheduler['schedules'] as Record<string, unknown> | undefined;
    if (!schedules) continue;

    for (const [name, def] of Object.entries(schedules)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const tasks = (d['tasks'] ?? []) as Array<Record<string, unknown>>;

      for (const task of tasks) {
        const expression = String(task['expression'] ?? task['frequency'] ?? '');
        const issues: string[] = [];

        if (expression && !isValidCronExpression(expression) && parseIntervalSeconds(expression) === 9999) {
          issues.push(
            `Config task "${name}" has unrecognized expression "${expression}"`
          );
        }

        const hasTransport = 'transport' in d || 'transport' in task;
        if (!hasTransport) {
          issues.push(
            `Config task "${name}" has no transport configured — tasks will never be dispatched`
          );
        }

        results.push({
          file: path.relative(appPath, candidate),
          className: String(task['id'] ?? name),
          taskType: 'config',
          expression: expression || '(unknown)',
          issues,
        });
      }
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonySchedulerTasks(appPath: string): McpToolResult {
  try {
    const phpTasks = scanPhpForTasks(appPath);
    const configTasks = scanSchedulerYaml(appPath);
    const allTasks = [...phpTasks, ...configTasks];

    if (allTasks.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Scheduler tasks found in src/ or scheduler.yaml.',
        }],
      };
    }

    // Detect duplicate (same class appears in both PHP attributes and config)
    const phpClassNames = new Set(phpTasks.map((t) => t.className));
    const configClassNames = new Set(configTasks.map((t) => t.className));
    const duplicates = [...phpClassNames].filter((n) => configClassNames.has(n));

    let text = `Symfony Scheduler Tasks  (${allTasks.length} found)\n${'='.repeat(55)}\n`;

    if (duplicates.length > 0) {
      text += `\n[!] Tasks defined in BOTH attributes AND config (duplicate execution): ${duplicates.join(', ')}\n`;
    }

    for (const t of allTasks) {
      const prefix = t.issues.length > 0 ? '[!]' : '   ';
      text += `\n${prefix} ${t.className}  [${t.taskType}]\n`;
      text += `    File:       ${t.file}\n`;
      text += `    Expression: ${t.expression}\n`;
      for (const issue of t.issues) {
        text += `    [!] ${issue}\n`;
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

export function getSymfonySchedulerTaskStats(appPath: string): McpToolResult {
  try {
    const phpTasks = scanPhpForTasks(appPath);
    const configTasks = scanSchedulerYaml(appPath);
    const allTasks = [...phpTasks, ...configTasks];

    const withIssues = allTasks.filter((t) => t.issues.length > 0);
    const cronTasks = allTasks.filter((t) => t.taskType === 'cron');
    const periodicTasks = allTasks.filter((t) => t.taskType === 'periodic');

    let text = `Symfony Scheduler Task Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total tasks found:    ${allTasks.length}\n`;
    text += `  Cron tasks:         ${cronTasks.length}\n`;
    text += `  Periodic tasks:     ${periodicTasks.length}\n`;
    text += `  Config tasks:       ${configTasks.length}\n`;
    text += `Tasks with issues:    ${withIssues.length}\n`;
    text += `Total issues:         ${allTasks.reduce((s, t) => s + t.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonySchedulerTaskTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_scheduler_tasks',
      description: 'Detect Symfony Scheduler task definitions via #[AsPeriodicTask], #[AsCronTask], and scheduler.yaml; warns on sub-60s periodic tasks, invalid cron expressions, missing error handlers, duplicate task definitions, and missing transport',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_scheduler_task_stats',
      description: 'Statistics on Symfony Scheduler tasks: count by type (cron/periodic/config), issues detected',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
