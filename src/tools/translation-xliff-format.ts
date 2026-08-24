// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface XliffInfo {
  file: string;
  locale: string;
  domain: string;
  version: '1.2' | '2.0' | 'unknown';
  unitCount: number;
  hasState: boolean;
  hasNotes: boolean;
  hasResname: boolean;
  issues: string[];
}

function getXliffFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && (e.name.endsWith('.xlf') || e.name.endsWith('.xliff'))) files.push(path.join(dir, e.name));
    }
  } catch { /* skip */ }
  return files;
}

function parseXliff(filePath: string, appPath: string): XliffInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const base = path.basename(filePath);
  const parts = base.split('.');
  const locale = parts.length >= 3 ? parts[parts.length - 2] : 'unknown';
  const domain = parts.length >= 3 ? parts.slice(0, parts.length - 2).join('.') : parts[0];
  let version: '1.2' | '2.0' | 'unknown' = 'unknown';
  if (content.includes('version="1.2"') || content.includes("version='1.2'")) version = '1.2';
  else if (content.includes('version="2.0"') || content.includes("version='2.0'") || content.includes('xliff version="2')) version = '2.0';
  const unitCount = (content.match(/<trans-unit|<unit/g) ?? []).length;
  const hasState = content.includes('state=') || content.includes('<target state=');
  const hasNotes = content.includes('<note') || content.includes('<notes');
  const hasResname = content.includes('resname=');
  const issues: string[] = [];
  if (version === '1.2' && unitCount > 0 && !hasState) issues.push('XLIFF 1.2 without state attributes — translation workflow status not tracked');
  if (version === '1.2' && !hasResname) issues.push('XLIFF 1.2 without resname — translation tools may not link to source correctly');
  if (version === 'unknown') issues.push('XLIFF version not declared — Symfony defaults to 1.2; add version attribute');
  if (unitCount === 0) issues.push('XLIFF file has no translation units — may be empty or malformed');
  return { file: path.relative(appPath, filePath), locale, domain, version, unitCount, hasState, hasNotes, hasResname, issues };
}

export function listXliffTranslations(appPath: string): McpToolResult {
  try {
    const translationsDir = path.join(appPath, 'translations');
    const files = getXliffFiles(translationsDir);
    if (files.length === 0) return { content: [{ type: 'text', text: 'No XLIFF translation files found.' }] };
    const results = files.map(f => parseXliff(f, appPath)).filter((r): r is XliffInfo => r !== null);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `XLIFF Translation Files\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    const v12 = results.filter(r => r.version === '1.2').length;
    const v20 = results.filter(r => r.version === '2.0').length;
    if (v12 > 0 && v20 > 0) text += `\n⚠ Mixed XLIFF versions: ${v12} × 1.2 and ${v20} × 2.0 — standardize to one version\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.file}  v${r.version}  [${r.locale}]  units: ${r.unitCount}  state: ${r.hasState ? '✓' : '✗'}  resname: ${r.hasResname ? '✓' : '✗'}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getXliffFormatStats(appPath: string): McpToolResult {
  try {
    const translationsDir = path.join(appPath, 'translations');
    const files = getXliffFiles(translationsDir);
    const results = files.map(f => parseXliff(f, appPath)).filter((r): r is XliffInfo => r !== null);
    let text = `XLIFF Format Statistics\n${'='.repeat(40)}\n\n`;
    text += `XLIFF files: ${results.length}\n  Version 1.2: ${results.filter(r => r.version === '1.2').length}\n  Version 2.0: ${results.filter(r => r.version === '2.0').length}\n  Unknown version: ${results.filter(r => r.version === 'unknown').length}\nTotal units: ${results.reduce((s, r) => s + r.unitCount, 0)}\nWith state attributes: ${results.filter(r => r.hasState).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getXliffFormatTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_xliff_translations', description: 'Analyze XLIFF translation files: version (1.2 vs 2.0), unit count, state attributes, resname presence, translator notes, mixed-version warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_xliff_format_stats', description: 'XLIFF format statistics: file count, version breakdown, total units, state attribute coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
