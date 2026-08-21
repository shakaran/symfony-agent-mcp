import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SignalableCommand {
  class: string;
  file: string;
  subscribedSignals: number[];
  hasHandleSignal: boolean;
  hasGracefulShutdown: boolean;
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

function parseSignalableCommand(filePath: string, appPath: string): SignalableCommand | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('SignalableCommandInterface') && !content.includes('getSubscribedSignals')) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const signalsM = /getSubscribedSignals[^{]*\{([\s\S]{0,400})/.exec(content);
  const subscribedSignals: number[] = [];
  if (signalsM) {
    for (const m of signalsM[1].matchAll(/SIGTERM|SIGINT|SIGHUP/g)) {
      if (m[0] === 'SIGTERM') subscribedSignals.push(15);
      else if (m[0] === 'SIGINT') subscribedSignals.push(2);
      else if (m[0] === 'SIGHUP') subscribedSignals.push(1);
    }
    for (const m of signalsM[1].matchAll(/\b(\d+)\b/g)) subscribedSignals.push(Number(m[1]));
  }
  const hasHandleSignal = content.includes('function handleSignal(');
  const hasGracefulShutdown = content.includes('$this->shouldStop') || content.includes('$this->running = false') || content.includes('shouldContinue');
  const issues: string[] = [];
  if (!hasHandleSignal) issues.push('SignalableCommandInterface without handleSignal() — signals will be received but not handled');
  if (hasHandleSignal && !hasGracefulShutdown) issues.push('handleSignal() without graceful shutdown logic — set a flag to exit loop cleanly');
  return { class: classM[1], file: path.relative(appPath, filePath), subscribedSignals: [...new Set(subscribedSignals)], hasHandleSignal, hasGracefulShutdown, issues };
}

export function listConsoleSignals(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const commands: SignalableCommand[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseSignalableCommand(file, appPath);
      if (c) commands.push(c);
    }
    if (commands.length === 0) return { content: [{ type: 'text', text: 'No SignalableCommandInterface implementations found.\n\nExample for graceful SIGTERM handling:\n  class WorkerCommand extends Command implements SignalableCommandInterface {\n    private bool $shouldStop = false;\n    public function getSubscribedSignals(): array { return [SIGTERM, SIGINT]; }\n    public function handleSignal(int $signal, int|false $previousExitCode = 0): int|false {\n      $this->shouldStop = true;\n      return false;\n    }\n  }' }] };
    const totalIssues = commands.reduce((s, c) => s + c.issues.length, 0);
    let text = `Signalable Commands\n${'='.repeat(55)}\n\nCommands: ${commands.length}  Issues: ${totalIssues}\n`;
    for (const c of commands.sort((a, b) => b.issues.length - a.issues.length)) {
      const signals = c.subscribedSignals.length > 0 ? `signals: ${c.subscribedSignals.join(',')}` : 'no signals detected';
      const graceful = c.hasGracefulShutdown ? '  ✓ graceful' : '  ⚠ no graceful stop';
      text += `\n  ${c.class}  ${signals}${graceful}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleSignalStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const commands: SignalableCommand[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseSignalableCommand(file, appPath);
        if (c) commands.push(c);
      }
    }
    let text = `Console Signal Statistics\n${'='.repeat(40)}\n\n`;
    text += `Signalable commands: ${commands.length}\n  With handleSignal(): ${commands.filter((c) => c.hasHandleSignal).length}\n  With graceful shutdown: ${commands.filter((c) => c.hasGracefulShutdown).length}\nIssues: ${commands.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleSignalTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_console_signals', description: 'Show SignalableCommandInterface implementations: subscribed signals (SIGTERM/SIGINT), handleSignal() presence, graceful shutdown flag pattern, missing handleSignal() warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_console_signal_stats', description: 'Show console signal statistics: signalable command count, handleSignal adoption, graceful shutdown adoption, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
