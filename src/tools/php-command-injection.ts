// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CommandInjectionInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
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

const CMD_FUNCTIONS = ['exec', 'system', 'passthru', 'shell_exec', 'popen', 'proc_open'];
const SUPERGLOBALS = /\$_(GET|POST|REQUEST|SERVER|COOKIE)/;
const ESCAPE_FNS = /escapeshellarg\s*\(|escapeshellcmd\s*\(/;

function classifyCommandLine(line: string, lineNum: number, relFile: string): CommandInjectionInfo | null {
  const trimmed = line.trim();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return null;

  // Check for backtick operator with variable interpolation
  const backtickRe = /`[^`]{0,200}\$[^`]{0,100}`/;
  if (backtickRe.test(trimmed)) {
    let severity: 'high' | 'medium' | 'low';
    let issue: string;
    if (SUPERGLOBALS.test(trimmed)) {
      severity = 'high';
      issue = 'Backtick operator with user-supplied input — direct OS command injection risk';
    } else if (ESCAPE_FNS.test(trimmed)) {
      severity = 'low';
      issue = 'Backtick operator with variable but escapeshellarg/escapeshellcmd applied';
    } else {
      severity = 'medium';
      issue = 'Backtick operator with variable interpolation — verify input is sanitised';
    }
    return { file: relFile, line: lineNum, fn: 'backtick', issue, severity };
  }

  // Check for OS command functions with a variable argument
  for (const fn of CMD_FUNCTIONS) {
    // Match function call with at least one `$` in the argument area
    const fnRe = new RegExp(`\\b${fn}\\s*\\([^)]{0,300}\\$[^)]{0,200}\\)`);
    if (!fnRe.test(trimmed)) continue;

    let severity: 'high' | 'medium' | 'low';
    let issue: string;

    if (SUPERGLOBALS.test(trimmed)) {
      severity = 'high';
      issue = `${fn}() with user-supplied input — direct OS command injection via superglobal`;
    } else if (ESCAPE_FNS.test(trimmed)) {
      severity = 'low';
      issue = `${fn}() with variable but escapeshellarg/escapeshellcmd present`;
    } else {
      severity = 'medium';
      issue = `${fn}() with variable argument — confirm input is not user-controlled or is properly escaped`;
    }

    return { file: relFile, line: lineNum, fn, issue, severity };
  }

  return null;
}

function buildCommandInjectionInfos(appPath: string): CommandInjectionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, appPath);
  const results: CommandInjectionInfo[] = [];

  for (const filePath of files) {
    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    // Quick pre-filter: must contain at least one relevant token
    const hasCmd = CMD_FUNCTIONS.some((fn) => content.includes(`${fn}(`));
    const hasBacktick = content.includes('`');
    if (!hasCmd && !hasBacktick) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const info = classifyCommandLine(lines[i], i + 1, relFile);
      if (info !== null) results.push(info);
    }
  }

  return results;
}

export function listPhpCommandInjection(appPath: string): McpToolResult {
  try {
    const infos = buildCommandInjectionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OS command injection risks found in src/.' }] };
    }

    const high = infos.filter((i) => i.severity === 'high');
    const medium = infos.filter((i) => i.severity === 'medium');
    const low = infos.filter((i) => i.severity === 'low');

    let text = `PHP OS Command Injection Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total findings: ${infos.length}\n`;
    text += `  High   (user input in cmd): ${high.length}\n`;
    text += `  Medium (variable, may be internal): ${medium.length}\n`;
    text += `  Low    (escapeshellarg/cmd present): ${low.length}\n`;

    if (high.length > 0) {
      text += `\nHIGH SEVERITY — User Input in Command:\n`;
      for (const i of high) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (medium.length > 0) {
      text += `\nMEDIUM SEVERITY — Variable in Command:\n`;
      for (const i of medium) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }
    if (low.length > 0) {
      text += `\nLOW SEVERITY — Escaped Variable:\n`;
      for (const i of low) {
        text += `  [${i.fn}] ${i.file}:${i.line}\n`;
        text += `    ${i.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCommandInjectionStats(appPath: string): McpToolResult {
  try {
    const infos = buildCommandInjectionInfos(appPath);

    const high = infos.filter((i) => i.severity === 'high').length;
    const medium = infos.filter((i) => i.severity === 'medium').length;
    const low = infos.filter((i) => i.severity === 'low').length;
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    const byFn: Record<string, number> = {};
    for (const info of infos) {
      byFn[info.fn] = (byFn[info.fn] ?? 0) + 1;
    }

    let text = `PHP OS Command Injection Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total findings:       ${infos.length}\n`;
    text += `Files affected:       ${filesAffected}\n`;
    text += `  High severity:      ${high}\n`;
    text += `  Medium severity:    ${medium}\n`;
    text += `  Low severity:       ${low}\n\n`;
    text += `By function:\n`;
    for (const fn of [...CMD_FUNCTIONS, 'backtick']) {
      text += `  ${fn.padEnd(12)}: ${byFn[fn] ?? 0}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCommandInjectionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_command_injection',
      description: 'Scan PHP source for OS command injection risks: exec/system/passthru/shell_exec/popen/proc_open with variable args and backtick operator — classified by severity (high/medium/low)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_command_injection_stats',
      description: 'Statistics for PHP OS command injection findings: counts by severity (high/medium/low), affected files, and breakdown by function name',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
