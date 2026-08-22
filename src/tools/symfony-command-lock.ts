import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CommandLockInfo {
  file: string;
  class: string;
  hasLockableTrait: boolean;
  hasReleaseInFinally: boolean;
  checksLockReturn: boolean;
  lockTtl?: number;
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

function parseCommandFile(filePath: string, appPath: string): CommandLockInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Only look at Command subclasses with LockableTrait
  if (!content.includes('LockableTrait')) return null;
  if (!content.includes('extends')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasLockableTrait = content.includes('use LockableTrait');

  // Check for finally block containing release()
  const finallyM = /finally\s*\{[^}]{0,300}\$this->release\s*\(/s.exec(content);
  const hasReleaseInFinally = finallyM !== null;

  // Check if lock() return value is checked
  // Pattern: if (!$this->lock(...) or if (false === $this->lock(
  const checksLockReturn = /if\s*\(\s*(?:!|false\s*===\s*)\s*\$this->lock\s*\(/.test(content) ||
    /\$this->isAlreadyRunning\s*\(/.test(content);

  // Extract lock TTL if provided
  let lockTtl: number | undefined;
  const ttlM = /\$this->lock\s*\([^,)]{0,200},\s*(\d+)/.exec(content);
  if (ttlM) lockTtl = parseInt(ttlM[1], 10);

  const issues: string[] = [];

  if (hasLockableTrait && !hasReleaseInFinally) {
    issues.push('LockableTrait without finally { $this->release() } — lock is never released if command throws an exception');
  }

  if (hasLockableTrait && !checksLockReturn) {
    issues.push('lock() return value not checked — command continues executing even if already running');
  }

  if (lockTtl !== undefined && lockTtl < 60) {
    issues.push(`Lock TTL of ${lockTtl}s is very short — lock may expire during a long-running command, allowing concurrent execution`);
  }

  // Heuristic: detect if lock store might default to in-memory (no framework.lock config)
  // We can check if the command relies only on a default lock store
  // We check if it imports/uses lock store explicitly
  const hasExplicitStore = content.includes('LockFactory') || content.includes('StoreInterface') ||
    content.includes('lock.store') || content.includes('lock_factory');
  if (hasLockableTrait && !hasExplicitStore) {
    issues.push('LockableTrait without explicit lock store configuration — may default to in-memory (not shared across processes)');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    hasLockableTrait,
    hasReleaseInFinally,
    checksLockReturn,
    lockTtl,
    issues,
  };
}

function loadCommandLocks(appPath: string): CommandLockInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: CommandLockInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseCommandFile(file, appPath);
    if (info) results.push(info);
  }
  return results;
}

export function listCommandLock(appPath: string): McpToolResult {
  try {
    const commands = loadCommandLocks(appPath);
    if (commands.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No commands using LockableTrait found.\n\nExample:\n  class MyCommand extends Command {\n    use LockableTrait;\n    protected function execute(...): int {\n      if (!$this->lock()) { return Command::SUCCESS; }\n      try { /* work */ } finally { $this->release(); }\n      return Command::SUCCESS;\n    }\n  }',
        }],
      };
    }

    const totalIssues = commands.reduce((s, c) => s + c.issues.length, 0);
    let text = `Command Lock (LockableTrait)\n${'='.repeat(55)}\n\nCommands: ${commands.length}  Issues: ${totalIssues}\n`;

    for (const cmd of commands.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${cmd.class}  (${cmd.file})\n`;
      text += `    LockableTrait:         yes\n`;
      text += `    release() in finally:  ${cmd.hasReleaseInFinally ? 'yes' : 'no'}\n`;
      text += `    checks lock() result:  ${cmd.checksLockReturn ? 'yes' : 'no'}\n`;
      if (cmd.lockTtl !== undefined) text += `    lock TTL: ${cmd.lockTtl}s\n`;
      for (const issue of cmd.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCommandLockStats(appPath: string): McpToolResult {
  try {
    const commands = loadCommandLocks(appPath);

    let text = `Command Lock Statistics\n${'='.repeat(40)}\n\n`;
    text += `Commands with LockableTrait:      ${commands.length}\n`;
    text += `  release() in finally:           ${commands.filter((c) => c.hasReleaseInFinally).length}\n`;
    text += `  Checks lock() return:           ${commands.filter((c) => c.checksLockReturn).length}\n`;
    text += `  With explicit TTL:              ${commands.filter((c) => c.lockTtl !== undefined).length}\n`;
    text += `  Short TTL (<60s):               ${commands.filter((c) => c.lockTtl !== undefined && c.lockTtl < 60).length}\n`;
    text += `Issues:                           ${commands.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCommandLockTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_command_lock',
      description: 'Show LockableTrait usage in Console commands: release() in finally, lock() return check, TTL; warns on missing finally release (lock leak on exception), unchecked lock() return (concurrent execution), short TTL, in-memory lock store (not shared)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_command_lock_stats',
      description: 'Show command lock statistics: total commands with LockableTrait, finally/return-check coverage, TTL count, short-TTL count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
