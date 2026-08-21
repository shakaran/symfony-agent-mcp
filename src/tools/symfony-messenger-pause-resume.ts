/**
 * Symfony Messenger Pause/Resume Inspector
 *
 * Scans src/**\/*.php for worker stop/pause middleware:
 *   - StopWorkerOnMessageLimitMiddleware
 *   - StopWorkerOnTimeLimitMiddleware
 *   - StopWorkerOnFailureLimitMiddleware
 *   - StopWorkerOnCustomStopExceptionMiddleware
 *
 * Checks config/packages/messenger.yaml for worker middleware config.
 * Flags: only supervisorctl restart as pause mechanism (manual approach),
 *        missing stop conditions, no graceful shutdown mechanism.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PauseResumeInfo {
  file: string;
  transport: string;
  pattern: 'signal' | 'file-lock' | 'database-flag' | 'redis-flag';
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function detectPattern(content: string): 'signal' | 'file-lock' | 'database-flag' | 'redis-flag' {
  if (content.includes('SIGTERM') || content.includes('SIGINT') || content.includes('pcntl_signal')) return 'signal';
  if (content.includes('LockInterface') || content.includes('FlockStore') || content.includes('SemaphoreStore')) return 'file-lock';
  if (content.includes('RedisAdapter') || content.includes('redis') || content.includes('Redis')) return 'redis-flag';
  return 'database-flag';
}

function analyzeMessengerMiddlewareFile(filePath: string, appPath: string): PauseResumeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasStopMiddleware = content.includes('StopWorkerOnMessageLimitMiddleware') ||
    content.includes('StopWorkerOnTimeLimitMiddleware') ||
    content.includes('StopWorkerOnFailureLimitMiddleware') ||
    content.includes('StopWorkerOnCustomStopExceptionMiddleware') ||
    content.includes('StopWorkerOn');

  const hasWorkerPattern = content.includes('WorkerStartedEvent') ||
    content.includes('WorkerStoppedEvent') ||
    content.includes('WorkerMessageReceivedEvent') ||
    content.includes('WorkerRunningEvent');

  if (!hasStopMiddleware && !hasWorkerPattern) return null;
  if (content.includes('namespace Symfony\\Component\\Messenger')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const pattern = detectPattern(content);
  const issues: string[] = [];

  // Detect transport name from injection or const
  let transport = 'unknown';
  const transportM = /'([a-z_]+)'\s*=>\s*\[/.exec(content);
  if (transportM) transport = transportM[1];

  // Flag: no graceful shutdown signal handling
  if (!content.includes('SIGTERM') && !content.includes('pcntl') && hasStopMiddleware) {
    if (content.includes('StopWorkerOnMessageLimitMiddleware') || content.includes('StopWorkerOnTimeLimitMiddleware')) {
      issues.push('Stop middleware configured without SIGTERM signal handling — workers may not stop gracefully on deployment');
    }
  }

  // Flag: StopWorkerOnCustomStopExceptionMiddleware without custom exception
  if (content.includes('StopWorkerOnCustomStopExceptionMiddleware') && !content.includes('CustomStopExceptionInterface')) {
    issues.push('StopWorkerOnCustomStopExceptionMiddleware used but no class implementing CustomStopExceptionInterface found — worker will never stop via this mechanism');
  }

  // Flag: very low message limit (potential high restart overhead)
  const msgLimitM = /StopWorkerOnMessageLimitMiddleware\s*\(\s*(\d+)/.exec(content);
  if (msgLimitM) {
    const limit = parseInt(msgLimitM[1], 10);
    if (limit < 10) {
      issues.push(`StopWorkerOnMessageLimitMiddleware limit is ${limit} — very low; worker restarts frequently, increasing overhead`);
    }
  }

  // Flag: very short time limit
  const timeLimitM = /StopWorkerOnTimeLimitMiddleware\s*\(\s*(\d+)/.exec(content);
  if (timeLimitM) {
    const seconds = parseInt(timeLimitM[1], 10);
    if (seconds < 30) {
      issues.push(`StopWorkerOnTimeLimitMiddleware limit is ${seconds}s — very short; consider at least 60 seconds to process in-flight messages`);
    }
  }

  return {
    file: path.relative(appPath, filePath),
    transport,
    pattern,
    issues,
  };
}

function checkMessengerYaml(appPath: string): PauseResumeInfo[] {
  const results: PauseResumeInfo[] = [];
  const yamlPath = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const resolved = path.resolve(yamlPath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep)) return results;
  let content = '';
  try { content = fs.readFileSync(yamlPath, 'utf-8'); } catch { return results; }

  if (!content.includes('messenger')) return results;

  const issues: string[] = [];

  // Check for stop-on-failure config
  const hasStopOnFailure = content.includes('stop_worker_on_failure');
  if (!hasStopOnFailure && content.includes('failure_transport')) {
    issues.push('failure_transport configured but stop_worker_on_failure not set — workers continue despite repeated failures');
  }

  // Check if only supervisorctl restart is documented (comment-based detection)
  if (content.includes('supervisorctl') && !content.includes('StopWorker')) {
    issues.push('messenger.yaml references supervisorctl but no stop middleware — workers can only be paused by manual process restart');
  }

  // Check for no middleware at all
  if (!content.includes('middleware') && content.includes('transports')) {
    issues.push('messenger.yaml defines transports but no middleware — no stop conditions, retry limits, or pause mechanisms configured');
  }

  if (issues.length > 0) {
    results.push({
      file: 'config/packages/messenger.yaml',
      transport: 'all',
      pattern: 'signal',
      issues,
    });
  }

  return results;
}

function buildPauseResumeInfos(appPath: string): PauseResumeInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: PauseResumeInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const file of collectPhpFiles(srcDir, srcDir)) {
      const info = analyzeMessengerMiddlewareFile(file, appPath);
      if (info) results.push(info);
    }
  }

  results.push(...checkMessengerYaml(appPath));

  return results;
}

export function listSymfonyMessengerPauseResume(appPath: string): McpToolResult {
  try {
    const infos = buildPauseResumeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Messenger stop/pause middleware or worker event patterns found.\n\nConsider adding:\n  StopWorkerOnTimeLimitMiddleware — stop after N seconds\n  StopWorkerOnMessageLimitMiddleware — stop after N messages\n  StopWorkerOnFailureLimitMiddleware — stop after N failures' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Messenger Pause/Resume Analysis\n${'='.repeat(55)}\n\n`;
    text += `Worker stop/pause patterns found: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  ${info.file}\n`;
      text += `    Transport: ${info.transport}\n`;
      text += `    Pattern:   ${info.pattern}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerPauseResumeStats(appPath: string): McpToolResult {
  try {
    const infos = buildPauseResumeInfos(appPath);

    const byPattern: Record<string, number> = {};
    for (const info of infos) {
      byPattern[info.pattern] = (byPattern[info.pattern] ?? 0) + 1;
    }

    let text = `Symfony Messenger Pause/Resume Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total worker stop/pause patterns: ${infos.length}\n\n`;
    text += `By pattern type:\n`;
    for (const [pattern, count] of Object.entries(byPattern).sort()) {
      text += `  ${pattern.padEnd(18)}  ${count}\n`;
    }
    text += `\nTotal issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    text += `Files with issues: ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerPauseResumeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_messenger_pause_resume',
      description: 'List Symfony Messenger worker stop/pause patterns: StopWorkerOnMessageLimit/TimeLimit/FailureLimit/CustomStopException middleware usage; flags missing SIGTERM handling, unimplemented CustomStopException, very low limits, manual-only supervisorctl restart',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_messenger_pause_resume_stats',
      description: 'Show Symfony Messenger pause/resume statistics: count by pattern type (signal/file-lock/database-flag/redis-flag), total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
