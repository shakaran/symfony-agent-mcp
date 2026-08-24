// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PosixFunctionInfo {
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

function isInWebPublicDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/public/') || normalized.includes('/web/');
}

function buildPosixFunctionInfos(appPath: string): PosixFunctionInfo[] {
  const findings: PosixFunctionInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);

  const userInputPatterns = ['$_GET', '$_POST', '$_REQUEST'];

  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);
    const lines = content.split('\n');

    // Pattern 1: posix_kill( with user input on same or nearby lines — CRITICAL
    if (content.includes('posix_kill(')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('posix_kill(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        const surroundStart = Math.max(0, i - 3);
        const surroundEnd = Math.min(lines.length - 1, i + 3);
        const surroundText = lines.slice(surroundStart, surroundEnd + 1).join('\n');
        const hasUserInput = userInputPatterns.some(p => surroundText.includes(p));
        if (hasUserInput) {
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'posix-kill-user-input',
            severity: 'critical',
            issue: 'posix_kill() called with apparent user-supplied $pid or $signal ($_GET/$_POST/$_REQUEST nearby) — attacker can send arbitrary signals to any process.',
          });
        }
      }
    }

    // Pattern 2: posix_setuid( or posix_setgid( without nearby root check — HIGH
    const hasSetIdCall = content.includes('posix_setuid(') || content.includes('posix_setgid(');
    if (hasSetIdCall) {
      const rootCheckPatterns = ['posix_geteuid() === 0', 'posix_getuid() === 0', 'posix_geteuid()==0', 'posix_getuid()==0'];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('posix_setuid(') && !line.includes('posix_setgid(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        const surroundStart = Math.max(0, i - 10);
        const surroundEnd = Math.min(lines.length - 1, i + 5);
        const surroundText = lines.slice(surroundStart, surroundEnd + 1).join('\n');
        const hasRootCheck = rootCheckPatterns.some(p => surroundText.includes(p));
        if (!hasRootCheck) {
          const fn = line.includes('posix_setuid(') ? 'posix_setuid()' : 'posix_setgid()';
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'posix-setid-no-root-check',
            severity: 'high',
            issue: `${fn} called without a nearby posix_geteuid() === 0 or posix_getuid() === 0 root privilege check — unsafe privilege change.`,
          });
        }
      }
    }

    // Pattern 3: posix_getpwnam( with user-supplied username — MEDIUM (info disclosure, user enumeration)
    if (content.includes('posix_getpwnam(')) {
      const getpwnamUserInputPatterns = ['$_GET', '$_POST', '$_REQUEST', '$request->get('];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('posix_getpwnam(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        const surroundStart = Math.max(0, i - 5);
        const surroundEnd = Math.min(lines.length - 1, i + 5);
        const surroundText = lines.slice(surroundStart, surroundEnd + 1).join('\n');
        const hasUserInput = getpwnamUserInputPatterns.some(p => surroundText.includes(p));
        if (hasUserInput) {
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'posix-getpwnam-user-input',
            severity: 'medium',
            issue: 'posix_getpwnam() called with apparent user-supplied $username — enables user enumeration and information disclosure about system accounts.',
          });
        }
      }
    }

    // Pattern 4: posix_mkfifo( in or under public/ or web/ directory — HIGH (named pipe in web-accessible location)
    if (content.includes('posix_mkfifo(') && isInWebPublicDir(file)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('posix_mkfifo(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        findings.push({
          file: relFile,
          line: i + 1,
          pattern: 'posix-mkfifo-web-dir',
          severity: 'high',
          issue: 'posix_mkfifo() found in a file under a web-accessible directory (public/ or web/) — creating named pipes in web roots can expose server internals.',
        });
      }
    }

    // Pattern 5: proc_open( with user input nearby — CRITICAL (command injection)
    if (content.includes('proc_open(')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('proc_open(')) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
        const surroundStart = Math.max(0, i - 5);
        const surroundEnd = Math.min(lines.length - 1, i + 5);
        const surroundText = lines.slice(surroundStart, surroundEnd + 1).join('\n');
        const hasUserInput = userInputPatterns.some(p => surroundText.includes(p));
        if (hasUserInput) {
          findings.push({
            file: relFile,
            line: i + 1,
            pattern: 'proc-open-user-input',
            severity: 'critical',
            issue: 'proc_open() called with apparent user-supplied data ($_GET/$_POST/$_REQUEST nearby) — high risk of OS command injection.',
          });
        }
      }
    }
  }

  return findings;
}

export function listPhpPosixFunctions(appPath: string): McpToolResult {
  try {
    const infos = buildPosixFunctionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No dangerous POSIX function usage found.' }] };
    }
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    infos.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));
    let text = `PHP Dangerous POSIX Function Usage\n${'='.repeat(50)}\n\nTotal: ${infos.length}\n\n`;
    for (const info of infos) {
      text += `  [${info.severity.toUpperCase()}] [${info.pattern}] ${info.file}:${info.line}\n`;
      text += `    ${info.issue}\n\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpPosixFunctionsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPosixFunctionInfos(appPath);
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

export function getPhpPosixFunctionsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Absolute path to the Symfony application root' } };
  return [
    {
      name: 'list_php_posix_functions',
      description: 'Scan PHP source files for dangerous POSIX function usage: posix_kill() with user input (CRITICAL), posix_setuid/setgid without root checks (HIGH), posix_getpwnam() with user-supplied usernames (MEDIUM), posix_mkfifo() in web-accessible directories (HIGH), and proc_open() with user-controlled arguments (CRITICAL).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_posix_functions_stats',
      description: 'Get statistics for dangerous PHP POSIX function usage: total findings grouped by severity (critical/high/medium/low) and by pattern name, plus number of files affected.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
