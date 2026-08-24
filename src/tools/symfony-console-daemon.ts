// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Console Daemon Inspector
 *
 * Scans src/**\/*.php for daemon/long-running command patterns:
 *   pcntl_signal, pcntl_fork, cli_set_process_title, while(true),
 *   while ($this->running), $this->shouldStop.
 *
 * Flags: infinite loop without signal handler, missing SIGTERM/SIGINT handling,
 *        no sleep() to prevent CPU burn.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ConsoleDaemonInfo {
  command: string;
  file: string;
  pattern: 'signal-handler' | 'pcntl' | 'infinite-loop' | 'process-title';
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

interface DaemonFileAnalysis {
  commandName: string;
  hasPcntlSignal: boolean;
  hasPcntlFork: boolean;
  hasProcessTitle: boolean;
  hasInfiniteLoop: boolean;
  hasSigterm: boolean;
  hasSigint: boolean;
  hasSleep: boolean;
  hasRunningFlag: boolean;
  hasShouldStop: boolean;
  patterns: Array<'signal-handler' | 'pcntl' | 'infinite-loop' | 'process-title'>;
}

function analyzeDaemonFile(content: string): DaemonFileAnalysis | null {
  // Only analyze files that look like daemon commands
  const isDaemon = /pcntl_signal|pcntl_fork|cli_set_process_title|while\s*\(\s*true\s*\)|while\s*\(\s*\$this->running\s*\)|\$this->shouldStop/.test(content);
  if (!isDaemon) return null;

  const commandMatch = /protected\s+static\s+\$defaultName\s*=\s*['"]([^'"]{1,100})['"]/.exec(content)
    ?? /->setName\s*\(\s*['"]([^'"]{1,100})['"]/.exec(content)
    ?? /#\[AsCommand\s*\(\s*name\s*:\s*['"]([^'"]{1,100})['"]/.exec(content)
    ?? /class\s+(\w{1,80})/.exec(content);

  const commandName = commandMatch ? commandMatch[1] : 'unknown';

  const hasPcntlSignal = /\bpcntl_signal\s*\(/.test(content);
  const hasPcntlFork = /\bpcntl_fork\s*\(/.test(content);
  const hasProcessTitle = /\bcli_set_process_title\s*\(/.test(content);
  const hasInfiniteLoop = /while\s*\(\s*true\s*\)/.test(content);
  const hasRunningFlag = /while\s*\(\s*\$this->running\s*\)/.test(content);
  const hasShouldStop = /\$this->shouldStop/.test(content);
  const hasSigterm = /SIGTERM/.test(content);
  const hasSigint = /SIGINT/.test(content);
  const hasSleep = /\bsleep\s*\(|\busleep\s*\(/.test(content);

  const patterns: Array<'signal-handler' | 'pcntl' | 'infinite-loop' | 'process-title'> = [];
  if (hasPcntlSignal || hasSigterm || hasSigint) patterns.push('signal-handler');
  if (hasPcntlFork || hasPcntlSignal) patterns.push('pcntl');
  if (hasInfiniteLoop || hasRunningFlag) patterns.push('infinite-loop');
  if (hasProcessTitle) patterns.push('process-title');

  return {
    commandName,
    hasPcntlSignal,
    hasPcntlFork,
    hasProcessTitle,
    hasInfiniteLoop,
    hasSigterm,
    hasSigint,
    hasSleep,
    hasRunningFlag,
    hasShouldStop,
    patterns,
  };
}

function buildConsoleDaemonInfos(appPath: string): ConsoleDaemonInfo[] {
  const infos: ConsoleDaemonInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const srcDirR = path.resolve(srcDir);
  if (!srcDirR.startsWith(path.resolve(appPath) + path.sep)) return infos;
  let stat;
  try { stat = fs.lstatSync(srcDir); } catch { return infos; }
  if (stat.isSymbolicLink()) return infos;
  if (!stat.isDirectory()) return infos;

  for (const file of collectPhpFiles(srcDir, appPath)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const analysis = analyzeDaemonFile(content);
    if (!analysis) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    // Infinite loop without signal handler
    if ((analysis.hasInfiniteLoop) && !analysis.hasPcntlSignal && !analysis.hasShouldStop) {
      issues.push('Infinite loop without pcntl_signal() or shouldStop flag — daemon cannot be cleanly stopped');
    }

    // Missing SIGTERM
    if ((analysis.hasInfiniteLoop || analysis.hasRunningFlag) && !analysis.hasSigterm) {
      issues.push('No SIGTERM handler — process cannot be gracefully terminated by supervisor or systemd');
    }

    // Missing SIGINT
    if ((analysis.hasInfiniteLoop || analysis.hasRunningFlag) && !analysis.hasSigint) {
      issues.push('No SIGINT handler — Ctrl+C will abruptly kill the daemon without cleanup');
    }

    // No sleep to prevent CPU burn
    if ((analysis.hasInfiniteLoop || analysis.hasRunningFlag) && !analysis.hasSleep) {
      issues.push('Infinite loop without sleep() or usleep() — may cause 100% CPU usage if queue is empty');
    }

    // pcntl_fork without pcntl_signal
    if (analysis.hasPcntlFork && !analysis.hasPcntlSignal) {
      issues.push('pcntl_fork() used without pcntl_signal() — zombie child processes may accumulate (missing SIGCHLD handler)');
    }

    for (const pattern of analysis.patterns) {
      infos.push({
        command: analysis.commandName,
        file: relFile,
        pattern,
        issues,
      });
    }
  }

  return infos;
}

export function listSymfonyConsoleDaemon(appPath: string): McpToolResult {
  try {
    const infos = buildConsoleDaemonInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No daemon-pattern console commands found in src/ (no pcntl_signal/while(true)/shouldStop patterns).' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony Console Daemon Inspector\n${'='.repeat(55)}\n\n`;
    text += `Daemon patterns found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    // Deduplicate by file for display
    const byFile = new Map<string, ConsoleDaemonInfo[]>();
    for (const info of infos) {
      const bucket = byFile.get(info.file) ?? [];
      bucket.push(info);
      byFile.set(info.file, bucket);
    }

    for (const [file, items] of byFile) {
      const patterns = [...new Set(items.map(i => i.pattern))].join(', ');
      const allIssues = [...new Set(items.flatMap(i => i.issues))];
      text += `  Command: ${items[0].command}\n`;
      text += `  File:    ${file}\n`;
      text += `  Patterns: ${patterns}\n`;
      for (const issue of allIssues) {
        text += `  ! ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyConsoleDaemonStats(appPath: string): McpToolResult {
  try {
    const infos = buildConsoleDaemonInfos(appPath);
    const uniqueFiles = new Set(infos.map(i => i.file)).size;
    const signalHandlers = infos.filter(i => i.pattern === 'signal-handler').length;
    const pcntlUsage = infos.filter(i => i.pattern === 'pcntl').length;
    const infiniteLoops = infos.filter(i => i.pattern === 'infinite-loop').length;
    const processTitles = infos.filter(i => i.pattern === 'process-title').length;
    const withIssues = new Set(infos.filter(i => i.issues.length > 0).map(i => i.file)).size;

    let text = `Symfony Console Daemon Statistics\n${'='.repeat(40)}\n\n`;
    text += `Daemon command files: ${uniqueFiles}\n`;
    text += `  With issues:         ${withIssues}\n`;
    text += `Pattern breakdown:\n`;
    text += `  Signal handlers:     ${signalHandlers}\n`;
    text += `  PCNTL usage:         ${pcntlUsage}\n`;
    text += `  Infinite loops:      ${infiniteLoops}\n`;
    text += `  Process titles:      ${processTitles}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyConsoleDaemonTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_console_daemon',
      description: 'List Symfony console daemon commands: pcntl/signal-handler/infinite-loop/process-title patterns, issues with missing SIGTERM/SIGINT handlers or CPU-burning loops',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_console_daemon_stats',
      description: 'Get Symfony console daemon statistics: count of daemon files, pattern breakdown (signal/pcntl/loop/title), files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
