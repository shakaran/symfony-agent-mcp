// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CommandOption {
  name: string;
  shortcut?: string;
  mode: string;
  description: string;
  default?: string;
}

interface CommandArgument {
  name: string;
  mode: string;
  description: string;
  default?: string;
}

interface CommandOptionsInfo {
  file: string;
  class: string;
  commandName?: string;
  options: CommandOption[];
  arguments: CommandArgument[];
  hasDeprecatedOptions: boolean;
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

function parseCommandOptions(filePath: string, appPath: string): CommandOptionsInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('Command') || (!content.includes('addOption') && !content.includes('addArgument'))) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace PHPUnit\\')) return null;
  const classM = /class\s+(\w{1,120})\s+extends\s+\w*Command/.exec(content);
  if (!classM) return null;
  const commandNameM = /->setName\s*\(\s*['"]([^'"]{1,80})['"]\)|AsCommand\s*\([^)]{0,100}name\s*:\s*['"]([^'"]{1,80})['"]\)|AsCommand\s*\(\s*['"]([^'"]{1,80})['"]\)/.exec(content);
  const commandName = commandNameM ? (commandNameM[1] ?? commandNameM[2] ?? commandNameM[3]) : undefined;
  const options: CommandOption[] = [];
  const optRe = /->addOption\s*\(\s*['"](\w{1,60})['"]\s*(?:,\s*(?:['"]([^'"]{0,10})['"]\s*|null\s*))?(?:,\s*InputOption::VALUE_(\w{1,30}))?\s*(?:,\s*['"]([^'"]{0,200})['"]\s*)?(?:,\s*([^)]{0,80}))?\)/g;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(content)) !== null) {
    options.push({ name: m[1], shortcut: m[2] ?? undefined, mode: m[3] ?? 'NONE', description: m[4] ?? '', default: m[5]?.trim() });
  }
  const args: CommandArgument[] = [];
  const argRe = /->addArgument\s*\(\s*['"](\w{1,60})['"]\s*(?:,\s*InputArgument::(\w{1,30}))?\s*(?:,\s*['"]([^'"]{0,200})['"]\s*)?(?:,\s*([^)]{0,80}))?\)/g;
  while ((m = argRe.exec(content)) !== null) {
    args.push({ name: m[1], mode: m[2] ?? 'OPTIONAL', description: m[3] ?? '', default: m[4]?.trim() });
  }
  if (options.length === 0 && args.length === 0) return null;
  const hasDeprecatedOptions = content.includes('->getDeprecation') || content.includes('->addDeprecation');
  const issues: string[] = [];
  if (options.filter(o => !o.description).length > 0) issues.push(`${options.filter(o => !o.description).length} option(s) without description — help output will be empty for these`);
  if (args.filter(a => !a.description).length > 0) issues.push(`${args.filter(a => !a.description).length} argument(s) without description`);
  const requiredAfterOptional = ((): boolean => {
    let hasOptional = false;
    for (const a of args) {
      if (a.mode === 'OPTIONAL') hasOptional = true;
      if (hasOptional && a.mode === 'REQUIRED') return true;
    }
    return false;
  })();
  if (requiredAfterOptional) issues.push('Required argument after optional argument — Symfony throws LogicException for this configuration');
  return { file: path.relative(appPath, filePath), class: classM[1], commandName, options, arguments: args, hasDeprecatedOptions, issues };
}

export function listConsoleCommandOptions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: CommandOptionsInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseCommandOptions(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No commands with options/arguments found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Console Command Options\n${'='.repeat(55)}\n\nCommands: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}${r.commandName ? ` (${r.commandName})` : ''}  options: ${r.options.length}  args: ${r.arguments.length}  (${r.file})\n`;
      for (const o of r.options.slice(0, 5)) {
        const shortcut = o.shortcut ? `-${o.shortcut}` : '';
        text += `    --${o.name}${shortcut}  mode: ${o.mode}  default: ${o.default ?? '(none)'}\n`;
      }
      if (r.options.length > 5) text += `    ... +${r.options.length - 5} more options\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleCommandOptionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: CommandOptionsInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseCommandOptions(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Console Command Option Statistics\n${'='.repeat(40)}\n\n`;
    text += `Commands with options/args: ${results.length}\nTotal options: ${results.reduce((s, r) => s + r.options.length, 0)}\nTotal arguments: ${results.reduce((s, r) => s + r.arguments.length, 0)}\nWith deprecated options: ${results.filter(r => r.hasDeprecatedOptions).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getConsoleCommandOptionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_console_command_options', description: 'Analyze console command addOption()/addArgument() definitions: name, shortcut, VALUE_REQUIRED/OPTIONAL mode, default values, missing descriptions, required-after-optional argument error', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_console_command_option_stats', description: 'Console command option statistics: command count, total options/arguments, deprecated options, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
