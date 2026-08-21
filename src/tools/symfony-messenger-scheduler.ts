import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MessengerSchedulerInfo {
  file: string;
  class: string;
  scheduleType: 'cron' | 'every' | 'unknown';
  expression?: string;
  messageClass?: string;
  hasTimezone: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseSchedulerFile(filePath: string, appPath: string): MessengerSchedulerInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const hasScheduler = content.includes('RecurringMessage') ||
    content.includes('ScheduleProviderInterface') ||
    content.includes('AsSchedule') ||
    content.includes('Schedule::with') ||
    content.includes('Schedule(');
  if (!hasScheduler) return [];
  if (content.includes('namespace Symfony\\')) return [];

  const classM = /class\s+(\w{1,100})/.exec(content);
  const className = classM ? classM[1] : path.basename(filePath, '.php');

  const results: MessengerSchedulerInfo[] = [];

  // Detect cron-based scheduling
  const cronMatches = [...content.matchAll(/RecurringMessage::cron\s*\(\s*['"]([^'"]{1,100})['"]/g)];
  for (const m of cronMatches) {
    const expression = m[1];
    const msgM = /RecurringMessage::cron\s*\([^,]{1,100},\s*new\s+(\w{1,80})/s.exec(content);
    const issues: string[] = [];
    if (!content.includes('timezone') && !content.includes('new \\DateTimeZone')) {
      issues.push('RecurringMessage without timezone specification — uses server default (non-reproducible across environments)');
    }
    if (expression === '* * * * *') {
      issues.push('Cron expression "* * * * *" runs every minute — very frequent; consider if this is intentional');
    }
    results.push({
      file: path.relative(appPath, filePath),
      class: className,
      scheduleType: 'cron',
      expression,
      messageClass: msgM ? msgM[1] : undefined,
      hasTimezone: content.includes('timezone') || content.includes('DateTimeZone'),
      issues,
    });
  }

  // Detect every()-based scheduling
  const everyMatches = [...content.matchAll(/RecurringMessage::every\s*\(\s*['"]([^'"]{1,100})['"]/g)];
  for (const m of everyMatches) {
    const expression = m[1];
    const issues: string[] = [];
    if (!content.includes('timezone') && !content.includes('DateTimeZone')) {
      issues.push('RecurringMessage without timezone specification — uses server default (non-reproducible across environments)');
    }
    results.push({
      file: path.relative(appPath, filePath),
      class: className,
      scheduleType: 'every',
      expression,
      hasTimezone: content.includes('timezone') || content.includes('DateTimeZone'),
      issues,
    });
  }

  // ScheduleProviderInterface without AsSchedule
  if (content.includes('ScheduleProviderInterface') && content.includes('implements')) {
    if (!content.includes('AsSchedule')) {
      const issues = ['ScheduleProviderInterface without #[AsSchedule] attribute — not auto-discovered by the scheduler'];
      results.push({
        file: path.relative(appPath, filePath),
        class: className,
        scheduleType: 'unknown',
        hasTimezone: false,
        issues,
      });
    }
  }

  return results;
}

function loadSchedulerConfig(appPath: string): {
  infos: MessengerSchedulerInfo[];
  hasTransport: boolean;
  hasSchedulerPackage: boolean;
} {
  let hasSchedulerPackage = false;
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
    const req = (raw['require'] ?? {}) as Record<string, unknown>;
    const reqDev = (raw['require-dev'] ?? {}) as Record<string, unknown>;
    hasSchedulerPackage = 'symfony/scheduler' in req || 'symfony/scheduler' in reqDev;
  } catch { /* skip */ }

  let hasTransport = false;
  const schedulerYaml = path.join(appPath, 'config', 'packages', 'scheduler.yaml');
  const raw = parseYamlFile(schedulerYaml) as Record<string, unknown> | null;
  if (raw) {
    hasTransport = JSON.stringify(raw).includes('transport');
  }

  const srcDir = path.join(appPath, 'src');
  const infos: MessengerSchedulerInfo[] = [];
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      infos.push(...parseSchedulerFile(file, appPath));
    }
  }

  // Cross-check: warn if no transport configured but schedulers exist
  if (infos.length > 0 && !hasTransport) {
    for (const info of infos) {
      if (!info.issues.some((i) => i.includes('transport'))) {
        info.issues.push('Scheduler without transport configured — messages will not be dispatched');
      }
    }
  }

  return { infos, hasTransport, hasSchedulerPackage };
}

export function listMessengerScheduler(appPath: string): McpToolResult {
  try {
    const { infos, hasTransport, hasSchedulerPackage } = loadSchedulerConfig(appPath);
    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Symfony Scheduler usage found.\n\nPackage installed: ${hasSchedulerPackage ? 'yes (symfony/scheduler)' : 'no'}\n\nExample:\n  #[AsSchedule]\n  class AppSchedule implements ScheduleProviderInterface {\n    public function getSchedule(): Schedule {\n      return (new Schedule())->with(\n        RecurringMessage::cron('0 * * * *', new SendReport())\n      );\n    }\n  }`,
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Scheduler\n${'='.repeat(55)}\n\nPackage: ${hasSchedulerPackage ? 'symfony/scheduler installed' : 'not detected in composer.json'}\n`;
    text += `Transport configured: ${hasTransport ? 'yes' : 'no'}\n`;
    text += `Scheduled entries: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${info.file})\n`;
      text += `    type: ${info.scheduleType}\n`;
      if (info.expression) text += `    expression: ${info.expression}\n`;
      if (info.messageClass) text += `    message: ${info.messageClass}\n`;
      text += `    timezone: ${info.hasTimezone ? 'specified' : 'not specified (server default)'}\n`;
      for (const issue of info.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerSchedulerStats(appPath: string): McpToolResult {
  try {
    const { infos, hasTransport, hasSchedulerPackage } = loadSchedulerConfig(appPath);
    const cronCount = infos.filter((i) => i.scheduleType === 'cron').length;
    const everyCount = infos.filter((i) => i.scheduleType === 'every').length;
    const withTimezone = infos.filter((i) => i.hasTimezone).length;

    let text = `Messenger Scheduler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Package installed:       ${hasSchedulerPackage ? 'yes' : 'no'}\n`;
    text += `Transport configured:    ${hasTransport ? 'yes' : 'no'}\n`;
    text += `Total scheduled entries: ${infos.length}\n`;
    text += `  Cron-based:            ${cronCount}\n`;
    text += `  Frequency-based:       ${everyCount}\n`;
    text += `  With timezone:         ${withTimezone}\n`;
    text += `  Without timezone:      ${infos.length - withTimezone}\n`;
    text += `Issues:                  ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerSchedulerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_scheduler',
      description: 'Show Symfony Scheduler usage: RecurringMessage::cron/every entries, ScheduleProviderInterface, #[AsSchedule]; warns on missing timezone, every-minute cron, missing transport, ScheduleProviderInterface without #[AsSchedule]',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_scheduler_stats',
      description: 'Show Symfony Scheduler statistics: package installed, transport configured, cron/frequency entry count, timezone coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
