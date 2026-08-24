// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Console Progress Bar Inspector
 *
 * Scans src/**\/*.php for ProgressBar usage:
 *   - new ProgressBar( instantiation
 *   - ProgressBar::setFormatDefinition (custom formats)
 *   - ->advance(), ->finish(), ->setFormat() calls
 *
 * Flags: missing ->finish() call, setMaxSteps(0) (indeterminate bar),
 *        custom format strings without %current%/%max%.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ProgressBarInfo {
  file: string;
  format: 'default' | 'custom' | 'debug' | 'minimal' | 'very_verbose';
  maxSteps: string;
  issues: string[];
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

function detectFormatType(content: string): 'default' | 'custom' | 'debug' | 'minimal' | 'very_verbose' {
  if (content.includes("'debug'") || content.includes('"debug"')) return 'debug';
  if (content.includes("'minimal'") || content.includes('"minimal"')) return 'minimal';
  if (content.includes("'very_verbose'") || content.includes('"very_verbose"')) return 'very_verbose';
  if (content.includes('setFormatDefinition') || content.includes('setFormat')) {
    // Check if a custom format string is defined
    if (/setFormat\s*\(\s*'(?!debug|minimal|very_verbose|normal|verbose)[^']{1,100}'/.test(content)) return 'custom';
  }
  return 'default';
}

function extractMaxSteps(content: string): string {
  // Try to find new ProgressBar($output, N) or setMaxSteps(N)
  const newBarM = /new\s+ProgressBar\s*\(\s*\$\w+\s*,\s*([^)]{1,30})/.exec(content);
  if (newBarM) return newBarM[1].trim();
  const setMaxM = /setMaxSteps\s*\(\s*([^)]{1,30})\s*\)/.exec(content);
  if (setMaxM) return setMaxM[1].trim();
  return 'unknown';
}

function analyzeProgressBarFile(filePath: string, appPath: string): ProgressBarInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('ProgressBar')) return null;
  if (!content.includes('new ProgressBar(') && !content.includes('ProgressBar::')) return null;
  // Skip framework internals
  if (content.includes('namespace Symfony\\Component\\Console')) return null;

  const format = detectFormatType(content);
  const maxSteps = extractMaxSteps(content);
  const issues: string[] = [];

  // Flag: missing ->finish() call
  const hasAdvance = content.includes('->advance(') || content.includes('->setProgress(');
  const hasFinish = content.includes('->finish(');
  if (hasAdvance && !hasFinish) {
    issues.push('ProgressBar->advance() called without ->finish() — progress bar will not be completed/newlined');
  }

  // Flag: setMaxSteps(0) or new ProgressBar($output, 0) = indeterminate
  if (/new\s+ProgressBar\s*\(\s*\$\w+\s*,\s*0\s*\)/.test(content) || /setMaxSteps\s*\(\s*0\s*\)/.test(content)) {
    issues.push('ProgressBar with maxSteps=0 (indeterminate) — set actual count if known for better UX');
  }

  // Flag: custom format strings without %current%/%max%
  if (format === 'custom') {
    const formatStringM = /setFormat\s*\(\s*'([^']{1,200})'/.exec(content);
    if (formatStringM) {
      const fmt = formatStringM[1];
      if (!fmt.includes('%current%') && !fmt.includes('%max%') && !fmt.includes('%percent%')) {
        issues.push(`Custom ProgressBar format "${fmt.slice(0, 60)}" missing %current%/%max%/%percent% — users cannot track progress`);
      }
    }
  }

  // Flag: ProgressBar without output buffer flushing in long commands
  if (content.includes('->advance(') && !content.includes('ob_flush') && content.includes('sleep')) {
    issues.push('ProgressBar in command with sleep() — ensure output is not buffered or use OutputInterface::VERBOSITY_* checks');
  }

  // Flag: start() never called before advance()
  const hasStart = content.includes('->start(');
  if (hasAdvance && !hasStart && !content.includes('new ProgressBar(')) {
    issues.push('ProgressBar->advance() without ->start() — call ->start() to initialize the bar');
  }

  return {
    file: path.relative(appPath, filePath),
    format,
    maxSteps,
    issues,
  };
}

function buildProgressBarInfos(appPath: string): ProgressBarInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: ProgressBarInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, srcDir)) {
    const info = analyzeProgressBarFile(file, appPath);
    if (info) results.push(info);
  }

  return results;
}

export function listSymfonyConsoleProgressBar(appPath: string): McpToolResult {
  try {
    const infos = buildProgressBarInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No ProgressBar usage found in src/ PHP files.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Console ProgressBar Analysis\n${'='.repeat(55)}\n\n`;
    text += `Files using ProgressBar: ${infos.length}  (with issues: ${withIssues.length})\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  ${info.file}\n`;
      text += `    Format:    ${info.format}\n`;
      text += `    Max steps: ${info.maxSteps}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyConsoleProgressBarStats(appPath: string): McpToolResult {
  try {
    const infos = buildProgressBarInfos(appPath);

    const byFormat: Record<string, number> = {};
    for (const info of infos) {
      byFormat[info.format] = (byFormat[info.format] ?? 0) + 1;
    }

    let text = `Symfony Console ProgressBar Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total files with ProgressBar: ${infos.length}\n\n`;
    text += `By format:\n`;
    for (const [fmt, count] of Object.entries(byFormat).sort()) {
      text += `  ${fmt.padEnd(15)}  ${count}\n`;
    }
    text += `\nTotal issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    text += `Files with issues: ${infos.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyConsoleProgressBarTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_console_progress_bar',
      description: 'List Symfony Console ProgressBar usage: format (default/custom/debug/minimal/very_verbose), max steps, flags missing finish(), indeterminate bars (maxSteps=0), custom formats without %current%/%max%',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_console_progress_bar_stats',
      description: 'Show Symfony Console ProgressBar statistics: count by format type, total issues, files with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
