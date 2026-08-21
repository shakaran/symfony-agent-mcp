/**
 * Symfony ConsoleEvents Subscriber/Listener Inspector
 *
 * Detects Symfony ConsoleEvents subscriber/listener usage.
 * Scans src/ PHP for: ConsoleEvents::COMMAND, ConsoleEvents::TERMINATE,
 *   ConsoleEvents::ERROR, ConsoleEvents::SIGNAL.
 * Scans services.yaml/event subscribers for console event subscriptions.
 *
 * Warns on:
 *   - console error listener not re-throwing (swallows error silently)
 *   - command event listener modifying input after Command::configure() (already parsed)
 *   - terminate listener with heavy I/O (blocks process exit)
 *   - signal listener not calling $event->abortExit() when needed
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

interface ConsoleEventInfo {
  file: string;
  className: string;
  events: string[];
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

const CONSOLE_EVENT_CONSTANTS: Record<string, string> = {
  'ConsoleEvents::COMMAND': 'command',
  'ConsoleEvents::TERMINATE': 'terminate',
  'ConsoleEvents::ERROR': 'error',
  'ConsoleEvents::SIGNAL': 'signal',
  "'console.command'": 'command',
  '"console.command"': 'command',
  "'console.terminate'": 'terminate',
  '"console.terminate"': 'terminate',
  "'console.error'": 'error',
  '"console.error"': 'error',
  "'console.signal'": 'signal',
  '"console.signal"': 'signal',
};

function parseConsoleEventFile(filePath: string): ConsoleEventInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasConsoleEvent = Object.keys(CONSOLE_EVENT_CONSTANTS).some((k) => content.includes(k));
  if (!hasConsoleEvent) return null;

  const isSubscriberOrListener =
    content.includes('EventSubscriberInterface') ||
    content.includes('getSubscribedEvents') ||
    content.includes('ConsoleEvents') ||
    content.includes('EventListener') ||
    content.includes('console.command') ||
    content.includes('console.terminate') ||
    content.includes('console.error') ||
    content.includes('console.signal');

  if (!isSubscriberOrListener) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const events: string[] = [];
  const issues: string[] = [];

  for (const [key, eventName] of Object.entries(CONSOLE_EVENT_CONSTANTS)) {
    if (content.includes(key) && !events.includes(eventName)) {
      events.push(eventName);
    }
  }

  // Check error listener re-throwing
  if (events.includes('error')) {
    const hasThrow = content.includes('throw ') || content.includes('$event->setThrowable(');
    if (!hasThrow) {
      issues.push('Console error listener does not re-throw the exception or set throwable — error may be silently swallowed');
    }
  }

  // Check command listener modifying input
  if (events.includes('command')) {
    const hasInputModification =
      content.includes('$event->getInput()->setArgument') ||
      content.includes('$event->getInput()->setOption') ||
      content.includes('getInput()->bind(') ||
      content.includes('getInput()->validate(');
    if (hasInputModification) {
      issues.push('Command event listener modifies input after Command::configure() — input is already parsed; modifications may be ignored or cause errors');
    }
  }

  // Check terminate listener for heavy I/O
  if (events.includes('terminate')) {
    const heavyIo =
      content.includes('file_put_contents(') ||
      content.includes('fwrite(') ||
      content.includes('curl_exec(') ||
      content.includes('sleep(') ||
      content.includes('usleep(') ||
      content.includes('->flush(') ||
      content.includes('executeQuery(') ||
      content.includes('getConnection()->');
    if (heavyIo) {
      issues.push('Terminate listener contains heavy I/O operations — this blocks process exit and delays command completion');
    }
  }

  // Check signal listener for abortExit
  if (events.includes('signal')) {
    if (!content.includes('abortExit(')) {
      issues.push('Signal listener does not call $event->abortExit() — process may exit prematurely without cleanup on signal');
    }
  }

  return { file: filePath, className, events, issues };
}

function loadConsoleEventInfos(appPath: string): ConsoleEventInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: ConsoleEventInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseConsoleEventFile(f);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyConsoleEvents(appPath: string): McpToolResult {
  try {
    const infos = loadConsoleEventInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No ConsoleEvents subscribers/listeners found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony ConsoleEvents Inspector (${infos.length} subscribers/listeners)\n${'='.repeat(58)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      text += `    events: [${info.events.join(', ')}]\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyConsoleEventStats(appPath: string): McpToolResult {
  try {
    const infos = loadConsoleEventInfos(appPath);

    const allEvents = infos.flatMap((i) => i.events);
    const count = (e: string): number => allEvents.filter((x) => x === e).length;

    let text = `ConsoleEvents Statistics\n${'='.repeat(40)}\n\n`;
    text += `Console event subscribers/listeners:  ${infos.length}\n`;
    text += `  console.command listeners:           ${count('command')}\n`;
    text += `  console.terminate listeners:         ${count('terminate')}\n`;
    text += `  console.error listeners:             ${count('error')}\n`;
    text += `  console.signal listeners:            ${count('signal')}\n`;
    text += `Issues:                                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_console_events',
      description: 'List Symfony ConsoleEvents subscribers and listeners: detects COMMAND/TERMINATE/ERROR/SIGNAL handlers; warns on error not re-thrown (silent swallow), command input modified after configure(), heavy I/O in terminate (blocks exit), signal handler missing abortExit()',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_console_event_stats',
      description: 'Show console event statistics: total subscribers/listeners, per-event counts (command/terminate/error/signal), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
