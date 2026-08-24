// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Console Shell Completion Inspector
 *
 * Distinct from commands.ts (command list/structure) and symfony-console-namespaces.ts (namespace grouping).
 * Focuses on shell autocomplete support (Symfony 5.4+):
 *
 * complete() method in Command classes:
 *   protected function complete(CompletionInput $input, CompletionSuggestions $suggestions): void
 *   {
 *     if ($input->mustSuggestArgumentValuesFor('type')) {
 *       $suggestions->suggestValues(['foo', 'bar', 'baz']);
 *     }
 *     if ($input->mustSuggestOptionValuesFor('format')) {
 *       $suggestions->suggestValues(['json', 'xml', 'csv']);
 *     }
 *   }
 *
 * CompletionInput methods:
 *   - mustSuggestArgumentValuesFor(string $argumentName): bool
 *   - mustSuggestOptionValuesFor(string $optionName): bool
 *   - getArgument(), getOption()
 *
 * CompletionSuggestions methods:
 *   - suggestValues(array $values)
 *   - suggestValue(Suggestion $suggestion)
 *
 * EquatableInterface for differentiating completion inputs.
 *
 * Analysis:
 *   - Commands with addArgument() / addOption() that have NO complete() method
 *     (especially where choices are limited — enum, list, status values)
 *   - complete() method that references argument/option names not defined in configure()
 *   - Complete method with hardcoded values that could come from the DB (note only — no fix possible statically)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CommandCompletion {
  class: string;
  file: string;
  hasComplete: boolean;
  argumentCount: number;
  optionCount: number;
  completedArguments: string[];
  completedOptions: string[];
  missingCompletionItems: string[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseCommandCompletion(filePath: string, appPath: string): CommandCompletion | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isCommand = content.includes('extends Command') || content.includes('extends ContainerAwareCommand') ||
                    content.includes('AsCommand');
  if (!isCommand) return null;
  if (content.includes('namespace Symfony\\') || content.includes('abstract class')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const hasComplete = content.includes('function complete(');

  // Count addArgument / addOption in configure()
  const configureM = /function\s+configure[^{]*\{([\s\S]{0,2000})/.exec(content);
  const configureBody = configureM?.[1] ?? '';

  const argumentNames: string[] = [];
  for (const m of configureBody.matchAll(/->addArgument\s*\(\s*['"]([^'"]+)['"]/g)) {
    argumentNames.push(m[1]);
  }
  const optionNames: string[] = [];
  for (const m of configureBody.matchAll(/->addOption\s*\(\s*['"]([^'"]+)['"]/g)) {
    optionNames.push(m[1]);
  }

  // What's completed
  const completedArguments: string[] = [];
  const completedOptions: string[]   = [];
  if (hasComplete) {
    for (const m of content.matchAll(/mustSuggestArgumentValuesFor\s*\(\s*['"]([^'"]+)['"]/g)) {
      completedArguments.push(m[1]);
    }
    for (const m of content.matchAll(/mustSuggestOptionValuesFor\s*\(\s*['"]([^'"]+)['"]/g)) {
      completedOptions.push(m[1]);
    }
  }

  // Detect arguments/options defined but not completed
  const missingCompletionItems: string[] = [];
  if (!hasComplete) {
    if (argumentNames.length > 0 || optionNames.length > 0) {
      // Check if options have a restricted list (modes with choices)
      const hasChoices = content.includes('InputArgument::IS_ARRAY') || content.includes("['");
      if (hasChoices || argumentNames.length > 0) {
        missingCompletionItems.push(...argumentNames.map((a) => `argument:${a}`));
        missingCompletionItems.push(...optionNames.map((o) => `option:${o}`));
      }
    }
  }

  const issues: string[] = [];
  if (!hasComplete && (argumentNames.length + optionNames.length) > 2) {
    issues.push(`Command has ${argumentNames.length} arg(s) + ${optionNames.length} option(s) but no complete() method — no shell autocompletion`);
  }

  // Check for completed names that don't match configured names
  for (const completed of completedArguments) {
    if (!argumentNames.includes(completed)) {
      issues.push(`complete() references argument "${completed}" not defined in configure()`);
    }
  }
  for (const completed of completedOptions) {
    if (!optionNames.includes(completed)) {
      issues.push(`complete() references option "${completed}" not defined in configure()`);
    }
  }

  if (!hasComplete && argumentNames.length === 0 && optionNames.length === 0) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    hasComplete,
    argumentCount: argumentNames.length,
    optionCount: optionNames.length,
    completedArguments,
    completedOptions,
    missingCompletionItems,
    issues,
  };
}

export function listConsoleCompletion(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const commands: CommandCompletion[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseCommandCompletion(file, appPath);
      if (c) commands.push(c);
    }

    if (commands.length === 0) {
      return { content: [{ type: 'text', text: 'No commands with arguments/options found in src/.' }] };
    }

    const withComplete    = commands.filter((c) => c.hasComplete);
    const withoutComplete = commands.filter((c) => !c.hasComplete && (c.argumentCount + c.optionCount) > 0);
    const totalIssues     = commands.reduce((s, c) => s + c.issues.length, 0);

    let text = `Console Shell Completion\n${'='.repeat(55)}\n`;
    text += `\nCommands analysed:  ${commands.length}  With complete(): ${withComplete.length}  Without: ${withoutComplete.length}  Issues: ${totalIssues}\n`;

    const withIssues = commands.filter((c) => c.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nCommands with issues:\n`;
      for (const c of withIssues) {
        text += `  ${c.class}  ${c.argumentCount} args  ${c.optionCount} opts  (${c.file})\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (withComplete.length > 0) {
      text += `\nCommands with complete() (${withComplete.length}):\n`;
      for (const c of withComplete.slice(0, 8)) {
        const args = c.completedArguments.length > 0 ? `args: ${c.completedArguments.join(',')}` : '';
        const opts = c.completedOptions.length > 0 ? `opts: ${c.completedOptions.join(',')}` : '';
        text += `  ${c.class}  ${args}  ${opts}  (${c.file})\n`;
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

export function getConsoleCompletionStats(appPath: string): McpToolResult {
  try {
    const srcDir  = path.join(appPath, 'src');
    const commands: CommandCompletion[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseCommandCompletion(file, appPath);
        if (c) commands.push(c);
      }
    }

    let text = `Console Completion Statistics\n${'='.repeat(40)}\n\n`;
    text += `Commands with args/opts:  ${commands.length}\n`;
    text += `  With complete():        ${commands.filter((c) => c.hasComplete).length}\n`;
    text += `  Without complete():     ${commands.filter((c) => !c.hasComplete).length}\n`;
    text += `  Completed arguments:    ${commands.reduce((s, c) => s + c.completedArguments.length, 0)}\n`;
    text += `  Completed options:      ${commands.reduce((s, c) => s + c.completedOptions.length, 0)}\n`;
    text += `Issues:                   ${commands.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleCompletionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_console_completion',
      description: 'Show Symfony console shell completion analysis: commands with/without complete() method, CompletionInput::mustSuggestArgumentValuesFor/mustSuggestOptionValuesFor usage, completed vs configured arguments/options, missing complete() on commands with many arguments/options',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_console_completion_stats',
      description: 'Show console completion statistics: command count, with/without complete() counts, completed argument/option totals, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
