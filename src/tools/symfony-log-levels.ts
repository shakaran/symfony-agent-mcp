/**
 * Symfony Log Level Usage Inspector
 *
 * Distinct from monolog.ts (handler config) and code-quality.ts (general code smells).
 * Focuses on log level distribution and misuse across the codebase:
 *
 * - Reads monolog.yaml: handler configurations with levels, channels, bubble settings
 * - Scans src/ PHP for: $logger->debug/info/warning/error/critical/emergency/notice/log calls
 *
 * Warnings:
 *   - debug() calls in non-dev code (performance + data leak risk)
 *   - error() used for business exceptions (should be warning/notice)
 *   - critical/emergency overused (lose meaning when cry-wolf)
 *   - handler with level: debug in non-dev environment
 *   - loggers using string level instead of LogLevel constants
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface LogLevelInfo {
  file: string;
  levelCounts: Record<string, number>;
  channels: string[];
  issues: string[];
}

interface MonologHandler {
  name: string;
  type: string;
  level?: string;
  channels?: string[];
  bubble?: boolean;
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

const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency', 'log'];

function parseLogUsage(filePath: string): LogLevelInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasLogger = content.includes('->debug(') || content.includes('->info(') ||
    content.includes('->warning(') || content.includes('->error(') ||
    content.includes('->critical(') || content.includes('->emergency(') ||
    content.includes('->notice(') || content.includes('->log(') ||
    content.includes('->alert(');

  if (!hasLogger) return null;

  const levelCounts: Record<string, number> = {};
  for (const level of LOG_LEVELS) {
    const re = new RegExp(`->${level}\\s*\\(`, 'g');
    const matches = content.match(re);
    if (matches && matches.length > 0) {
      levelCounts[level] = matches.length;
    }
  }

  if (Object.keys(levelCounts).length === 0) return null;

  const channels: string[] = [];
  const channelMatches = content.matchAll(/LoggerInterface\s+\$(\w{1,80})Logger/g);
  for (const m of channelMatches) {
    channels.push(m[1]);
  }
  const namedLoggerM = content.matchAll(/#\[Autowire\([^)]{0,200}channel['":\s]+['"](\w{1,80})['"]/g);
  for (const m of namedLoggerM) {
    if (!channels.includes(m[1])) channels.push(m[1]);
  }

  const issues: string[] = [];
  const isDevFile = filePath.includes('/dev/') || filePath.includes('_dev') ||
    filePath.includes('Test.php') || filePath.includes('test/') || filePath.includes('tests/');

  if (!isDevFile && levelCounts['debug'] && levelCounts['debug'] > 0) {
    issues.push(`${levelCounts['debug']} debug() call(s) in production code — performance and data leak risk`);
  }

  const errorCount = levelCounts['error'] ?? 0;
  if (errorCount > 3) {
    issues.push(`${errorCount} error() calls — verify these are not business exceptions (use warning/notice instead)`);
  }

  const criticalCount = levelCounts['critical'] ?? 0;
  const emergencyCount = levelCounts['emergency'] ?? 0;
  if (criticalCount + emergencyCount > 5) {
    issues.push(`${criticalCount + emergencyCount} critical/emergency calls — overuse dilutes alerting significance`);
  }

  const logCount = levelCounts['log'] ?? 0;
  if (logCount > 0) {
    const stringLevelM = /->log\s*\(\s*['"][a-z]{1,20}['"]/.exec(content);
    if (stringLevelM) {
      issues.push('->log() with string level — use LogLevel constants (LogLevel::ERROR) instead');
    }
  }

  return {
    file: path.relative(process.cwd(), filePath),
    levelCounts,
    channels,
    issues,
  };
}

function loadMonologHandlers(appPath: string): MonologHandler[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml'),
  ];

  const handlers: MonologHandler[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const monolog = (raw['monolog'] ?? raw) as Record<string, unknown>;
    const handlersRaw = (monolog['handlers'] ?? {}) as Record<string, unknown>;

    for (const [name, def] of Object.entries(handlersRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const channelsRaw = d['channels'];
      const channels = Array.isArray(channelsRaw) ? channelsRaw.map(String) : undefined;
      handlers.push({
        name,
        type: d['type'] ? String(d['type']) : 'unknown',
        level: d['level'] ? String(d['level']) : undefined,
        channels,
        bubble: d['bubble'] !== false,
      });
    }
  }
  return handlers;
}

export function listLogLevelUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: LogLevelInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseLogUsage(file);
      if (info) usages.push(info);
    }

    const handlers = loadMonologHandlers(appPath);

    if (usages.length === 0 && handlers.length === 0) {
      return { content: [{ type: 'text', text: 'No logger usage found in src/ and no monolog.yaml found.' }] };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    const globalCounts: Record<string, number> = {};
    for (const u of usages) {
      for (const [lvl, cnt] of Object.entries(u.levelCounts)) {
        globalCounts[lvl] = (globalCounts[lvl] ?? 0) + cnt;
      }
    }

    let text = `Log Level Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles with logger: ${usages.length}  Issues: ${totalIssues}\n`;

    if (Object.keys(globalCounts).length > 0) {
      text += `\nGlobal level distribution:\n`;
      const sorted = Object.entries(globalCounts).sort(([, a], [, b]) => b - a);
      for (const [lvl, cnt] of sorted) {
        text += `  ${lvl.padEnd(12)} ${cnt}\n`;
      }
    }

    if (handlers.length > 0) {
      text += `\nMonolog handlers (${handlers.length}):\n`;
      for (const h of handlers) {
        const lvl = h.level ? ` level:${h.level}` : '';
        const ch = h.channels ? ` channels:[${h.channels.join(',')}]` : '';
        const bubble = h.bubble === false ? ' no-bubble' : '';
        text += `  ${h.name.padEnd(25)} type:${h.type}${lvl}${ch}${bubble}\n`;
        if (h.level === 'debug') {
          text += `    ⚠ handler level:debug — logs all debug messages (high volume, sensitive data)\n`;
        }
      }
    }

    const filesWithIssues = usages.filter((u) => u.issues.length > 0);
    if (filesWithIssues.length > 0) {
      text += `\nFiles with issues (${filesWithIssues.length}):\n`;
      for (const u of filesWithIssues) {
        text += `\n  ${u.file}\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
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

export function getLogLevelStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: LogLevelInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseLogUsage(file);
      if (info) usages.push(info);
    }

    const handlers = loadMonologHandlers(appPath);

    const globalCounts: Record<string, number> = {};
    for (const u of usages) {
      for (const [lvl, cnt] of Object.entries(u.levelCounts)) {
        globalCounts[lvl] = (globalCounts[lvl] ?? 0) + cnt;
      }
    }

    let text = `Log Level Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with logger:   ${usages.length}\n`;
    text += `Monolog handlers:    ${handlers.length}\n`;
    text += `  Debug handlers:    ${handlers.filter((h) => h.level === 'debug').length}\n`;

    const levels = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
    for (const lvl of levels) {
      if (globalCounts[lvl]) {
        text += `${lvl.padEnd(20)} ${globalCounts[lvl]}\n`;
      }
    }

    text += `Issues:              ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLogLevelTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_log_level_usage',
      description: 'Show log level distribution across Symfony codebase: debug/info/warning/error/critical/emergency calls per file, monolog handler levels and channels; warns on debug() in production, error() for business logic, critical/emergency overuse, string log levels instead of LogLevel constants',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_log_level_stats',
      description: 'Show log level statistics: total files with logger, global call counts per level, monolog handler count, debug handler count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
