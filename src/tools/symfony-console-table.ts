// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Console Table Usage Inspector
 *
 * Scans src/ PHP for Table usage: new Table($output), ->setHeaders(),
 * ->setRows(), ->addRow(), ->render(), TableSeparator, TableStyle,
 * ->setStyle(), ->setColumnWidth(), horizontal tables (->setVertical()),
 * TableCell with colspan/rowspan.
 *
 * Warns: >20 columns (unreadable), addRows in loop without limit,
 * no ->render() after setRows (built but not output).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ConsoleTableUsage {
  method: string;
  columnCount: number;
  hasTableSeparator: boolean;
  hasCustomStyle: boolean;
  issues: string[];
}

interface ConsoleTableInfo {
  file: string;
  class?: string;
  usages: ConsoleTableUsage[];
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

function countColumns(content: string): number {
  // Count columns from setHeaders array literal
  const headersM = /->setHeaders\s*\(\s*\[([^\]]{0,500})\]/.exec(content);
  if (headersM) {
    const items = headersM[1].split(',').filter((s) => s.trim().length > 0);
    return items.length;
  }
  return 0;
}

function parseConsoleTable(filePath: string, appPath: string): ConsoleTableInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('new Table(') && !content.includes('Table $') && !content.includes('\\Console\\Helper\\Table')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  const fileRel = path.relative(appPath, filePath);

  const hasTableSeparator = content.includes('TableSeparator');
  const hasCustomStyle = content.includes('->setStyle(') || content.includes('TableStyle');
  const hasSetRows = content.includes('->setRows(');
  const hasRender = content.includes('->render(');
  const hasAddRow = content.includes('->addRow(') || content.includes('->addRows(');
  const hasVertical = content.includes('->setVertical(');
  const hasTableCell = content.includes('TableCell') && (content.includes('colspan') || content.includes('rowspan'));
  const columnCount = countColumns(content);

  const usageIssues: string[] = [];

  if (columnCount > 20) {
    usageIssues.push(`Table has ~${columnCount} columns — may be unreadable on narrow terminals`);
  }
  if (hasSetRows && !hasRender) {
    usageIssues.push('->setRows() called but ->render() not found — table built but never output');
  }
  if (hasAddRow && !hasRender) {
    usageIssues.push('->addRow() called but ->render() not found — table built but never output');
  }
  // Detect addRows() inside a loop without obvious limit
  const loopAddRowsRe = /(?:foreach|for|while)\s*\([^)]{0,200}\)[^{]{0,20}\{[^}]{0,500}->addRows?\s*\(/;
  if (loopAddRowsRe.test(content)) {
    usageIssues.push('->addRow(s)() inside loop — no row limit detected (possible memory issue with >1000 rows)');
  }

  const fileIssues: string[] = [];
  if (hasTableCell) fileIssues.push('Uses TableCell with colspan/rowspan — ensure terminal width supports it');
  if (hasVertical) fileIssues.push('Uses ->setVertical() (horizontal table layout) — verify rendering in all output contexts');

  const methods: string[] = [];
  if (hasSetRows) methods.push('setRows');
  if (hasAddRow) methods.push('addRow/addRows');
  if (hasRender) methods.push('render');
  if (hasTableSeparator) methods.push('TableSeparator');
  if (hasCustomStyle) methods.push('setStyle');
  if (hasVertical) methods.push('setVertical');
  if (content.includes('->setColumnWidth(')) methods.push('setColumnWidth');
  if (content.includes('->setHeaders(')) methods.push('setHeaders');

  const usage: ConsoleTableUsage = {
    method: methods.join(', '),
    columnCount,
    hasTableSeparator,
    hasCustomStyle,
    issues: usageIssues,
  };

  const allIssues = [...usageIssues, ...fileIssues];
  if (!hasSetRows && !hasAddRow) return null;

  return {
    file: fileRel,
    class: classM?.[1],
    usages: [usage],
    issues: allIssues,
  };
}

export function listConsoleTableUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }
    const tables: ConsoleTableInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const t = parseConsoleTable(file, appPath);
      if (t) tables.push(t);
    }
    if (tables.length === 0) {
      return { content: [{ type: 'text', text: 'No Console Table usage found in src/.' }] };
    }
    const totalIssues = tables.reduce((s, t) => s + t.issues.length, 0);
    let text = `Symfony Console Table Usage\n${'='.repeat(55)}\n`;
    text += `\nFiles using Console Table: ${tables.length}  Issues: ${totalIssues}\n`;
    for (const t of tables.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${t.class ?? '(no class)'}  (${t.file})\n`;
      for (const u of t.usages) {
        text += `    Methods: ${u.method || 'n/a'}\n`;
        if (u.columnCount > 0) text += `    Columns detected: ${u.columnCount}\n`;
        text += `    TableSeparator: ${u.hasTableSeparator ? 'yes' : 'no'}  Custom style: ${u.hasCustomStyle ? 'yes' : 'no'}\n`;
      }
      for (const issue of t.issues) {
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

export function getConsoleTableStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const tables: ConsoleTableInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const t = parseConsoleTable(file, appPath);
        if (t) tables.push(t);
      }
    }
    let text = `Console Table Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with Table usage:     ${tables.length}\n`;
    text += `  With TableSeparator:      ${tables.filter((t) => t.usages.some((u) => u.hasTableSeparator)).length}\n`;
    text += `  With custom style:        ${tables.filter((t) => t.usages.some((u) => u.hasCustomStyle)).length}\n`;
    text += `  Wide tables (>20 cols):   ${tables.filter((t) => t.usages.some((u) => u.columnCount > 20)).length}\n`;
    text += `Issues detected:            ${tables.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConsoleTableTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_console_table_usage',
      description: 'Show Symfony Console Table usage: setHeaders/setRows/addRow/render detection, TableSeparator, TableStyle, setColumnWidth, setVertical (horizontal tables), TableCell colspan/rowspan, warns on >20 columns, addRows in loop without limit, setRows without render',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_console_table_stats',
      description: 'Show Console Table statistics: file count, TableSeparator usage, custom style count, wide table count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
