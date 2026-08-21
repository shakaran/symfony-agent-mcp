import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ShmopIpcInfo {
  file: string;
  line: number;
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function buildShmopIpcInfos(appPath: string): ShmopIpcInfo[] {
  const findings: ShmopIpcInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);
    const lines = content.split('\n');

    // Pattern 1: shmop_open( without shmop_close( in same file — MEDIUM risk (resource leak)
    if (content.includes('shmop_open(') && !content.includes('shmop_close(')) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('shmop_open(')) {
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'shmop-no-close',
            severity: 'medium',
            issue: 'shmop_open() called without shmop_close() in the same file — shared memory resource leak risk.',
          });
          break;
        }
      }
    }

    // Pattern 2: sem_get( or sem_acquire( without sem_release( in same file — HIGH risk (deadlock risk)
    const hasSemAcquire = content.includes('sem_get(') || content.includes('sem_acquire(');
    if (hasSemAcquire && !content.includes('sem_release(')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('sem_get(') || line.includes('sem_acquire(')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
          const fn = line.includes('sem_get(') ? 'sem_get()' : 'sem_acquire()';
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'sem-no-release',
            severity: 'high',
            issue: `${fn} called without sem_release() in the same file — semaphore deadlock risk.`,
          });
          break;
        }
      }
    }

    // Pattern 3: msg_get_queue(/msg_send(/msg_receive( without msg_remove_queue( — MEDIUM risk (message queue memory leak)
    const hasMsgQueue = content.includes('msg_get_queue(') || content.includes('msg_send(') || content.includes('msg_receive(');
    if (hasMsgQueue && !content.includes('msg_remove_queue(')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('msg_get_queue(') || line.includes('msg_send(') || line.includes('msg_receive(')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
          let fn = 'msg_get_queue()';
          if (line.includes('msg_send(')) fn = 'msg_send()';
          else if (line.includes('msg_receive(')) fn = 'msg_receive()';
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'msg-queue-no-remove',
            severity: 'medium',
            issue: `${fn} used without msg_remove_queue() in the same file — message queue memory leak risk.`,
          });
          break;
        }
      }
    }

    // Pattern 4: shmop_open( with 0777 permission mode — HIGH risk (world-writable shared memory)
    if (content.includes('shmop_open(')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('shmop_open(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        // Check this line and a few following lines for the 0777 argument
        const surroundEnd = Math.min(lines.length - 1, i + 3);
        const callText = lines.slice(i, surroundEnd + 1).join(' ');
        if (callText.includes('0777')) {
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'shmop-world-writable',
            severity: 'high',
            issue: 'shmop_open() called with permission mode 0777 — world-writable shared memory is a privilege escalation risk.',
          });
        }
      }
    }

    // Pattern 5: shm_put_var( or shm_get_var( with user input nearby (within 5 lines) — HIGH risk
    const hasShmVar = content.includes('shm_put_var(') || content.includes('shm_get_var(');
    if (hasShmVar) {
      const userInputPatterns = ['$_GET', '$_POST', '$_REQUEST'];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('shm_put_var(') && !line.includes('shm_get_var(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        const surroundStart = Math.max(0, i - 5);
        const surroundEnd = Math.min(lines.length - 1, i + 5);
        const surroundText = lines.slice(surroundStart, surroundEnd + 1).join('\n');
        const hasUserInput = userInputPatterns.some(p => surroundText.includes(p));
        if (hasUserInput) {
          const fn = line.includes('shm_put_var(') ? 'shm_put_var()' : 'shm_get_var()';
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'shm-user-input',
            severity: 'high',
            issue: `${fn} used with apparent user-supplied data ($_GET/$_POST/$_REQUEST nearby) — serialization of untrusted data into shared memory is a security risk.`,
          });
        }
      }
    }
  }

  return findings;
}

export function listPhpShmopIpc(appPath: string): McpToolResult {
  try {
    const infos = buildShmopIpcInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP shared memory or IPC issues found.' }] };
    }
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    infos.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
    let text = `PHP Shared Memory & IPC Issues\n${'='.repeat(50)}\n\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpShmopIpcStats(appPath: string): McpToolResult {
  try {
    const infos = buildShmopIpcInfos(appPath);
    const stats = {
      total: infos.length,
      filesAffected: new Set(infos.map(i => i.file)).size,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>,
      byPattern: {} as Record<string, number>,
    };
    for (const i of infos) {
      stats.bySeverity[i.severity] = (stats.bySeverity[i.severity] ?? 0) + 1;
      stats.byPattern[i.pattern] = (stats.byPattern[i.pattern] ?? 0) + 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpShmopIpcTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_shmop_ipc',
      description: 'Scan PHP source files for shared memory and IPC misuse patterns: missing shmop_close(), semaphore deadlocks (sem_get/sem_acquire without sem_release), message queue leaks, world-writable shmop_open() with 0777, and shm_put_var/shm_get_var with user-supplied data.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_shmop_ipc_stats',
      description: 'Get statistics for PHP shared memory and IPC issues: total findings grouped by severity (critical/high/medium/low) and by pattern name, plus number of files affected.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
