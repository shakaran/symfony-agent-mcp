/**
 * Symfony Process Component Usage Inspector
 *
 * Analyzes Symfony Process component usage for security and correctness.
 *
 * Detects in src/:
 *   - use Symfony\Component\Process\Process; imports
 *   - new Process([...]) or Process::fromShellCommandline(...) calls
 *   - mustRun() vs run() usage
 *   - setTimeout(0) or no timeout (infinite wait)
 *   - enableShellEmulation() calls
 *   - fromShellCommandline() with non-literal strings (injection risk)
 *   - exec()/shell_exec()/system()/passthru() usage (not Process)
 *
 * Security warnings:
 *   - fromShellCommandline with variable/concatenation (shell injection)
 *   - setTimeout(0) — process runs indefinitely (DoS risk)
 *   - run() without return code check and without mustRun() (silent failure)
 *   - exec()/shell_exec() used instead of Process
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ProcessCall {
  type: 'array' | 'shell' | 'unknown';
  hasShellInjectionRisk: boolean;
  usesShellEmulation: boolean;
}

interface ProcessUsage {
  class: string;
  file: string;
  usesProcessImport: boolean;
  processCalls: ProcessCall[];
  usesMustRun: boolean;
  usesRunOnly: boolean;
  hasInfiniteTimeout: boolean;
  hasNoTimeout: boolean;
  usesNativeFunctions: string[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

/**
 * Returns true if the fromShellCommandline call argument is NOT a pure string literal.
 * A pure literal is: fromShellCommandline('...' ) or fromShellCommandline("...")
 * Anything else (concatenation, variable, heredoc) is risky.
 */
function hasShellInjectionRisk(callStr: string): boolean {
  // Match the argument portion after fromShellCommandline(
  const argRe = /fromShellCommandline\s*\(([^)]{0,400})\)/;
  const m = argRe.exec(callStr);
  if (!m?.[1]) return true; // can't determine — be conservative

  const arg = m[1].trim();
  // Pure single-quoted string: 'text only'
  if (/^'[^']*'$/.test(arg)) return false;
  // Pure double-quoted string without variable interpolation-style patterns
  if (/^"[^"$]*"$/.test(arg)) return false;
  // Everything else: variable, concatenation, heredoc, etc.
  return true;
}

function extractProcessCalls(content: string): ProcessCall[] {
  const calls: ProcessCall[] = [];

  // new Process([...]) — array form (safe)
  const arrayRe = /new\s+Process\s*\(\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = arrayRe.exec(content)) !== null) {
    calls.push({ type: 'array', hasShellInjectionRisk: false, usesShellEmulation: false });
  }

  // Process::fromShellCommandline(...)
  const shellRe = /Process::fromShellCommandline\s*\([^)]{0,400}\)/g;
  while ((m = shellRe.exec(content)) !== null) {
    const callStr = m[0];
    const injectionRisk = hasShellInjectionRisk(callStr);
    const usesShellEmulation = content.includes('->enableShellEmulation(');
    calls.push({ type: 'shell', hasShellInjectionRisk: injectionRisk, usesShellEmulation });
  }

  return calls;
}

function detectNativeFunctions(content: string): string[] {
  const natives: string[] = [];
  const fns = [
    { pattern: /\bexec\s*\(/, name: 'exec()' },
    { pattern: /\bshell_exec\s*\(/, name: 'shell_exec()' },
    { pattern: /\bsystem\s*\(/, name: 'system()' },
    { pattern: /\bpassthru\s*\(/, name: 'passthru()' },
  ];
  for (const { pattern, name } of fns) {
    if (pattern.test(content)) natives.push(name);
  }
  return natives;
}

function hasRunWithoutCheck(content: string): boolean {
  // ->run() present but neither $returnCode check nor mustRun() used
  if (!content.includes('->run(') && !content.includes('->run()')) return false;
  // If mustRun is also used, it's covered
  if (content.includes('->mustRun(')) return false;
  // Check if the return value of run() is used (e.g., $code = $process->run())
  if (/\$\w+\s*=\s*\$\w+->run\s*\(/.test(content)) return false;
  return true;
}

function parseProcessUsage(filePath: string, appPath: string): ProcessUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const usesProcessImport = content.includes('Symfony\\Component\\Process\\Process');
  const nativeFunctions = detectNativeFunctions(content);

  if (!usesProcessImport && nativeFunctions.length === 0) return null;
  // Skip Symfony core
  if (content.includes('namespace Symfony\\Component\\Process\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const processCalls = usesProcessImport ? extractProcessCalls(content) : [];
  const usesMustRun = content.includes('->mustRun(');
  const usesRunOnly = (content.includes('->run(') || content.includes('->run()')) && !usesMustRun;

  // Timeout detection
  const hasInfiniteTimeout = content.includes('->setTimeout(0)') || content.includes('->setTimeout(0.0)');
  // No setTimeout call at all (relying on default, which may be fine but worth noting for long-running)
  const hasNoTimeout = !content.includes('->setTimeout(') && processCalls.length > 0;

  const issues: string[] = [];

  for (const call of processCalls) {
    if (call.type === 'shell' && call.hasShellInjectionRisk) {
      issues.push('fromShellCommandline() called with non-literal argument — shell injection risk');
    }
    if (call.usesShellEmulation) {
      issues.push('enableShellEmulation() used — shell mode increases injection risk');
    }
  }

  if (hasInfiniteTimeout) {
    issues.push('setTimeout(0) — process runs indefinitely; DoS risk in web requests');
  }

  if (usesRunOnly && hasRunWithoutCheck(content)) {
    issues.push('run() used without checking return code and without mustRun() — failures are silently ignored');
  }

  for (const fn of nativeFunctions) {
    issues.push(`${fn} used instead of Process — no timeout, no signal handling, harder to test`);
  }

  if (processCalls.length === 0 && nativeFunctions.length === 0) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    usesProcessImport,
    processCalls,
    usesMustRun,
    usesRunOnly,
    hasInfiniteTimeout,
    hasNoTimeout,
    usesNativeFunctions: nativeFunctions,
    issues,
  };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listProcessUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: ProcessUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseProcessUsage(file, appPath);
      if (u) usages.push(u);
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Process usage found in src/.\n\nExample (safe — array form):\n  $process = new Process([\'ls\', \'-la\', $dir]);\n  $process->mustRun();\n\nAvoid:\n  Process::fromShellCommandline(\'cmd \' . $userInput);  // injection risk',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Symfony Process Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles using Process/exec: ${usages.length}  Issues: ${totalIssues}\n`;

    for (const u of usages.sort((a, b) => a.class.localeCompare(b.class))) {
      text += `\n  ${u.class}  (${u.file})\n`;

      const arrayCalls = u.processCalls.filter((c) => c.type === 'array').length;
      const shellCalls = u.processCalls.filter((c) => c.type === 'shell').length;
      if (arrayCalls > 0) text += `    new Process([]):         ${arrayCalls} call(s)  [safe]\n`;
      if (shellCalls > 0) {
        const risky = u.processCalls.filter((c) => c.type === 'shell' && c.hasShellInjectionRisk).length;
        text += `    fromShellCommandline():  ${shellCalls} call(s)${risky > 0 ? `  [${risky} RISKY]` : ''}\n`;
      }

      const runStyle = u.usesMustRun
        ? 'mustRun() (throws on failure)'
        : u.usesRunOnly
          ? 'run() only (check return code)'
          : 'none';
      text += `    Error handling:          ${runStyle}\n`;

      if (u.hasInfiniteTimeout) text += `    Timeout:                 setTimeout(0) — INFINITE\n`;
      else if (u.hasNoTimeout) text += `    Timeout:                 not set (default 60s)\n`;

      if (u.usesNativeFunctions.length > 0) {
        text += `    Native functions:        ${u.usesNativeFunctions.join(', ')}\n`;
      }

      for (const issue of u.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getProcessStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files = fs.existsSync(srcDir) ? getAllPhpFiles(srcDir) : [];
    const usages: ProcessUsage[] = [];

    for (const file of files) {
      const u = parseProcessUsage(file, appPath);
      if (u) usages.push(u);
    }

    const totalArrayCalls = usages.reduce((s, u) => s + u.processCalls.filter((c) => c.type === 'array').length, 0);
    const totalShellCalls = usages.reduce((s, u) => s + u.processCalls.filter((c) => c.type === 'shell').length, 0);
    const riskyShellCalls = usages.reduce(
      (s, u) => s + u.processCalls.filter((c) => c.type === 'shell' && c.hasShellInjectionRisk).length,
      0
    );

    let text = `Process Component Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with Process/exec:    ${usages.length}\n`;
    text += `  new Process([]) calls:    ${totalArrayCalls}\n`;
    text += `  fromShellCommandline():   ${totalShellCalls}\n`;
    text += `    Risky (non-literal):    ${riskyShellCalls}\n`;
    text += `  Using mustRun():          ${usages.filter((u) => u.usesMustRun).length}\n`;
    text += `  Using run() only:         ${usages.filter((u) => u.usesRunOnly).length}\n`;
    text += `  setTimeout(0):            ${usages.filter((u) => u.hasInfiniteTimeout).length}\n`;
    text += `  Native exec functions:    ${usages.filter((u) => u.usesNativeFunctions.length > 0).length}\n`;
    text += `Issues detected:            ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    // List native function usages
    const allNative = usages.flatMap((u) => u.usesNativeFunctions);
    if (allNative.length > 0) {
      const counts: Record<string, number> = {};
      for (const fn of allNative) counts[fn] = (counts[fn] ?? 0) + 1;
      text += `\nNative function usage:\n`;
      for (const [fn, cnt] of Object.entries(counts)) {
        text += `  ${fn.padEnd(20)} ${cnt}\n`;
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

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getProcessTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_process_usage',
      description: 'Show Symfony Process component usage: new Process([]) vs fromShellCommandline(), mustRun vs run(), setTimeout(0) infinite-wait warning, shell injection risk from non-literal fromShellCommandline arguments, enableShellEmulation detection, exec/shell_exec/system/passthru native function usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_process_stats',
      description: 'Show Process component statistics: file count, array vs shell call counts, risky shell calls, mustRun vs run counts, infinite timeout count, native exec function usage breakdown',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
