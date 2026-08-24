// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigMacroInfo {
  file: string;
  macros: string[];
  importCount: number;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseTwigMacros(filePath: string, appPath: string): TwigMacroInfo | null {
  const templatesDir = path.join(appPath, 'templates');
  const content = safeRead(filePath, templatesDir);
  if (content === null) return null;
  const macros: string[] = [];
  const macroRe = /\{%-?\s*macro\s+(\w{1,80})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = macroRe.exec(content)) !== null) macros.push(m[1]);
  const importRe = /\{%-?\s*(?:import|from)\s+['"][^'"]{1,200}['"]/g;
  let importCount = 0;
  while ((importRe.exec(content)) !== null) importCount++;
  if (macros.length === 0 && importCount === 0) return null;
  const issues: string[] = [];
  if (macros.length > 10) issues.push(`${macros.length} macros in one file — consider a dedicated macro-only template`);
  return { file: path.relative(appPath, filePath), macros, importCount, issues };
}

export function listTwigMacros(appPath: string): McpToolResult {
  try {
    const templatesDir = path.join(appPath, 'templates');
    const files = getAllTwigFiles(templatesDir);
    const results: TwigMacroInfo[] = [];
    for (const f of files) {
      const r = parseTwigMacros(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No Twig macros or macro imports found.' }] };
    const totalMacros = results.reduce((s, r) => s + r.macros.length, 0);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Twig Macros\n${'='.repeat(55)}\n\nFiles: ${results.length}  Total macros: ${totalMacros}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.macros.length - a.macros.length)) {
      text += `\n  ${r.file}\n`;
      if (r.macros.length > 0) text += `    Macros: ${r.macros.join(', ')}\n`;
      if (r.importCount > 0) text += `    Imports: ${r.importCount}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigMacroStats(appPath: string): McpToolResult {
  try {
    const templatesDir = path.join(appPath, 'templates');
    const files = getAllTwigFiles(templatesDir);
    const results: TwigMacroInfo[] = [];
    for (const f of files) {
      const r = parseTwigMacros(f, appPath);
      if (r) results.push(r);
    }
    let text = `Twig Macro Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with macros/imports: ${results.length}\nTotal macro definitions: ${results.reduce((s, r) => s + r.macros.length, 0)}\nFiles with imports: ${results.filter(r => r.importCount > 0).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigMacroTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_twig_macros', description: 'Detect Twig macro definitions ({% macro %}), cross-template imports ({% import %}/{% from ... import %}), warning when a file defines more than 10 macros', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_twig_macro_stats', description: 'Twig macro statistics: file count, total macro definitions, import file count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
