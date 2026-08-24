// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SignalHandlingInfo {
  file: string;
  line: number;
  signal: string;
  pattern: string;
  issue: string | null;
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full, base));
    } else if (entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function buildSignalHandlingInfos(appPath: string): SignalHandlingInfo[] {
  const results: SignalHandlingInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('pcntl_')) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    const hasPcntlSignal = content.includes('pcntl_signal(');
    const hasPcntlAsyncSignals = content.includes('pcntl_async_signals(');
    const hasPcntlFork = content.includes('pcntl_fork(');
    const hasPcntlWaitpid = content.includes('pcntl_waitpid(');

    // Collect all handled signals via pcntl_signal(
    const handledSignals: string[] = [];
    const sigRegex = /pcntl_signal\s*\(\s*(SIG[A-Z0-9_]{1,20})/g;
    let sigMatch: RegExpExecArray | null;
    while ((sigMatch = sigRegex.exec(content)) !== null) {
      handledSignals.push(sigMatch[1]);
    }

    // File-level: missing async signals
    if (hasPcntlSignal && !hasPcntlAsyncSignals) {
      results.push({
        file: relFile,
        line: 0,
        signal: 'ALL',
        pattern: 'pcntl_signal( without pcntl_async_signals(true)',
        issue: 'missing-async-signals: pcntl_async_signals(true) not found — signals won\'t be delivered asynchronously in PHP 7.1+; add pcntl_async_signals(true) at bootstrap or call pcntl_signal_dispatch() in loops',
      });
    }

    // File-level: missing SIGTERM handler
    if (hasPcntlSignal && !handledSignals.includes('SIGTERM')) {
      results.push({
        file: relFile,
        line: 0,
        signal: 'SIGTERM',
        pattern: 'pcntl_signal( without SIGTERM handler',
        issue: 'missing-sigterm-handler: SIGTERM is not handled — add a SIGTERM handler for graceful shutdown (flush buffers, close connections, remove PID files)',
      });
    }

    // File-level: fork without waitpid
    if (hasPcntlFork && !hasPcntlWaitpid) {
      results.push({
        file: relFile,
        line: 0,
        signal: 'FORK',
        pattern: 'pcntl_fork( without pcntl_waitpid(',
        issue: 'fork-without-waitpid: pcntl_fork() used but pcntl_waitpid() not found — child processes may become zombies; add pcntl_waitpid() or a SIGCHLD handler with WNOHANG',
      });
    }

    // Per-line analysis
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('pcntl_async_signals(true)')) {
        results.push({
          file: relFile,
          line: lineNum,
          signal: 'ALL',
          pattern: 'pcntl_async_signals(true)',
          issue: null,
        });
        continue;
      }

      if (line.includes('pcntl_signal(')) {
        const m = /pcntl_signal\s*\(\s*(SIG[A-Z0-9_]{1,20})/.exec(line);
        const signalName = m ? m[1] : 'UNKNOWN';
        const isSigIgn = /pcntl_signal\s*\([^,]{1,40},\s*SIG_IGN/.test(line);
        results.push({
          file: relFile,
          line: lineNum,
          signal: signalName,
          pattern: line.trim().slice(0, 120),
          issue: isSigIgn
            ? 'Signal ignored: SIG_IGN suppresses default handling; document why this signal is intentionally ignored'
            : null,
        });
        continue;
      }

      if (line.includes('pcntl_signal_dispatch(')) {
        // Check if within 5 lines before there's a loop keyword
        const contextStart = Math.max(0, i - 5);
        const contextLines = lines.slice(contextStart, i);
        const inLoop = contextLines.some(l => /\b(for|while|foreach)\b/.test(l));
        results.push({
          file: relFile,
          line: lineNum,
          signal: 'ALL',
          pattern: 'pcntl_signal_dispatch()',
          issue: inLoop
            ? 'pcntl_signal_dispatch-in-loop: calling pcntl_signal_dispatch() inside a loop — this is correct when pcntl_async_signals is not set; verify async signals are intentionally disabled'
            : null,
        });
        continue;
      }

      if (line.includes('pcntl_fork(')) {
        results.push({
          file: relFile,
          line: lineNum,
          signal: 'FORK',
          pattern: line.trim().slice(0, 120),
          issue: hasPcntlWaitpid
            ? null
            : 'Child process created with pcntl_fork() — ensure parent calls pcntl_waitpid() or installs a SIGCHLD handler to reap the child and avoid zombie processes',
        });
      }
    }
  }

  return results;
}

export function listPhpSignalHandling(appPath: string): McpToolResult {
  try {
    const infos = buildSignalHandlingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP POSIX signal handling patterns found.' }] };
    }
    const issues = infos.filter(i => i.issue !== null);
    const good = infos.filter(i => i.issue === null);
    let text = `PHP Signal Handling Analysis\n${'='.repeat(55)}\n\nTotal findings: ${infos.length}  Issues: ${issues.length}  Good patterns: ${good.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.signal}] ${info.file}:${info.line}\n    Pattern: ${info.pattern}\n`;
      if (info.issue) text += `    ISSUE: ${info.issue}\n`;
      else text += `    OK: good signal handling pattern\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSignalHandlingStats(appPath: string): McpToolResult {
  try {
    const infos = buildSignalHandlingInfos(appPath);
    const bySignal: Record<string, number> = {};
    for (const i of infos) {
      bySignal[i.signal] = (bySignal[i.signal] ?? 0) + 1;
    }
    const filesWithPcntlSignal = new Set(
      infos.filter(i => i.pattern.includes('pcntl_signal(')).map(i => i.file)
    );
    const filesMissingSignterm = new Set(
      infos.filter(i => i.issue?.includes('missing-sigterm-handler')).map(i => i.file)
    );
    const filesUsingAsyncSignals = new Set(
      infos.filter(i => i.pattern.includes('pcntl_async_signals(true)')).map(i => i.file)
    );
    const stats = {
      total: infos.length,
      issues: infos.filter(i => i.issue !== null).length,
      bySignal,
      filesWithPcntlSignal: filesWithPcntlSignal.size,
      filesMissingSignterm: filesMissingSignterm.size,
      filesUsingAsyncSignals: filesUsingAsyncSignals.size,
    };
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpSignalHandlingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_signal_handling',
      description: 'Scan PHP files for POSIX signal handling patterns: pcntl_signal(), pcntl_async_signals(), pcntl_fork() — flags missing SIGTERM handlers, missing async signals setup, fork without waitpid, and ignored signals.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_signal_handling_stats',
      description: 'Statistics for PHP signal handling: total findings, issue count, counts by signal name, files with pcntl_signal, files missing SIGTERM handler, files using async signals.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
