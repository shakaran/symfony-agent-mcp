// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP File Locking Inspector
 *
 * Scans src/**\/*.php for file locking patterns:
 * flock(), fopen() without flock(), file_put_contents() with/without LOCK_EX,
 * touch() used as lock file, lock files in /tmp.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FileLockingFinding {
  file: string;
  line: number;
  pattern: string;
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

function analyseFile(filePath: string, base: string): FileLockingFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  const findings: FileLockingFinding[] = [];
  const lines = content.split('\n');

  // Track fopen handles and whether they had flock/fclose in the function scope
  // We use a simple window approach: within 30 lines of fopen, look for flock
  const fopenLines: number[] = [];
  const flockLines: number[] = [];
  const fcloseLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // fopen( — track position
    if (/\bfopen\s*\(/.test(line)) {
      fopenLines.push(i);
    }

    // flock( — analyse flags
    if (/\bflock\s*\(/.test(line)) {
      flockLines.push(i);

      const hasLockNb = /LOCK_NB/.test(line);
      const hasLockEx = /LOCK_EX/.test(line);
      const hasLockUn = /LOCK_UN/.test(line);

      if (hasLockUn) {
        // LOCK_UN — good, releasing lock
      } else if (hasLockEx && !hasLockNb) {
        findings.push({ file: filePath, line: lineNo, pattern: 'flock(LOCK_EX)', issue: 'Blocking exclusive lock (no LOCK_NB) — will deadlock if lock holder process crashes; consider flock($fp, LOCK_EX | LOCK_NB) with retry logic' });
      } else if (!hasLockEx && !hasLockUn) {
        // LOCK_SH or unknown
        findings.push({ file: filePath, line: lineNo, pattern: 'flock(LOCK_SH)', issue: 'Shared lock acquired — ensure LOCK_UN is called or file is closed after read to prevent lock accumulation' });
      }
    }

    // fclose(
    if (/\bfclose\s*\(/.test(line)) {
      fcloseLines.push(i);
    }

    // file_put_contents( — check LOCK_EX flag
    if (/\bfile_put_contents\s*\(/.test(line)) {
      if (/LOCK_EX/.test(line)) {
        findings.push({ file: filePath, line: lineNo, pattern: 'file_put_contents(LOCK_EX)', issue: 'Good: file_put_contents with LOCK_EX ensures atomic write' });
      } else {
        // Check if writing to a path that suggests concurrency (non-trivial path)
        findings.push({ file: filePath, line: lineNo, pattern: 'file_put_contents(no LOCK_EX)', issue: 'file_put_contents without LOCK_EX — concurrent writes can corrupt file; add FILE_APPEND | LOCK_EX flags or use a stream with flock' });
      }
    }

    // touch() used as a lock mechanism
    if (/\btouch\s*\(/.test(line)) {
      const ctx = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3)).join('\n');
      if (/lock|mutex|sem/i.test(ctx)) {
        findings.push({ file: filePath, line: lineNo, pattern: 'touch() as lock', issue: 'touch() is not an atomic lock operation — not reliable across filesystems; use flock() or a proper mutex' });
      }
    }

    // Lock file in /tmp
    const tmpLockMatch = /['"](\/tmp\/[^'"]{1,100}\.lock[^'"]*)['"]/.exec(line);
    if (tmpLockMatch) {
      findings.push({ file: filePath, line: lineNo, pattern: 'lock file in /tmp', issue: `Lock file in /tmp (${tmpLockMatch[1]}) — /tmp may be cleaned by OS tmpwatch/systemd-tmpfiles; use a dedicated lock directory under var/` });
    }
  }

  // Check fopen without nearby flock (within 20 lines forward)
  for (const fopenIdx of fopenLines) {
    const windowEnd = Math.min(lines.length, fopenIdx + 20);
    const hasNearbyFlock = flockLines.some(fl => fl > fopenIdx && fl < windowEnd);
    if (!hasNearbyFlock) {
      // Check if the fopen is for writing ('w', 'a', 'r+', 'w+', 'a+', 'c', 'c+')
      const fopenLine = lines[fopenIdx];
      if (/fopen\s*\([^,]{0,100},\s*['"][wa+rc][b+]?['"]/.test(fopenLine)) {
        findings.push({ file: filePath, line: fopenIdx + 1, pattern: 'fopen() write without flock()', issue: 'fopen() for writing without nearby flock() — concurrent writes can corrupt file; acquire flock(LOCK_EX) before writing' });
      }
    }
    // Check fopen without fclose (within 50 lines)
    const closeWindowEnd = Math.min(lines.length, fopenIdx + 50);
    const hasNearbyClose = fcloseLines.some(fc => fc > fopenIdx && fc < closeWindowEnd);
    if (!hasNearbyClose) {
      findings.push({ file: filePath, line: fopenIdx + 1, pattern: 'fopen() without fclose()', issue: 'fopen() without corresponding fclose() in visible scope — resource leak; also releases flock implicitly on close' });
    }
  }

  return findings;
}

function loadFindings(appPath: string): FileLockingFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: FileLockingFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listPhpFileLocking(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No file locking patterns found in src/.\n\nExample:\n  $fp = fopen($path, \'c+\');\n  flock($fp, LOCK_EX);\n  // write\n  flock($fp, LOCK_UN);\n  fclose($fp);' }] };
    }
    const issues = findings.filter(f => !f.issue.startsWith('Good:'));
    let text = `PHP File Locking Patterns\n${'='.repeat(55)}\n\nFindings: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      const prefix = f.issue.startsWith('Good:') ? '  ✓' : '  ⚠';
      text += `\n${prefix} ${rel}:${f.line}  [${f.pattern}]\n    ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFileLockingStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byPattern: Record<string, number> = {};
    for (const f of findings) byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    const goodPatterns = findings.filter(f => f.issue.startsWith('Good:')).length;
    const issues = findings.length - goodPatterns;
    let text = `PHP File Locking Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total findings: ${findings.length}\nIssues: ${issues}\nGood patterns: ${goodPatterns}\n\nBy pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) text += `  ${pat}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nFiles with locking code: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFileLockingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_file_locking', description: 'Scan src/**/*.php for file locking: flock(LOCK_EX/SH/NB), fopen without flock, file_put_contents without LOCK_EX, touch() as lock, lock files in /tmp — flags blocking locks, resource leaks, race conditions', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_file_locking_stats', description: 'Statistics for PHP file locking usage: total findings, issues vs good patterns, breakdown by pattern, files affected', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
