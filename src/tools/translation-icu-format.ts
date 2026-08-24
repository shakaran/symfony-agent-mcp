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

interface IcuTranslation {
  file: string;
  locale: string;
  domain: string;
  icuKeys: string[];
  hasPlural: boolean;
  hasSelect: boolean;
  hasMissingDefault: boolean;
  issues: string[];
}

function getTranslationFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.(yaml|yml|xlf|xliff)$/.test(e.name)) files.push(path.join(dir, e.name));
    }
  } catch { /* skip */ }
  return files;
}

function parseIcuFile(filePath: string, appPath: string): IcuTranslation | null {
  const translationsDir = path.join(appPath, 'translations');
  const content = safeRead(filePath, translationsDir);
  if (content === null) return null;
  if (!content.includes(', plural,') && !content.includes(', select,') && !content.includes(', selectordinal,')) return null;
  const base = path.basename(filePath);
  const parts = base.split('.');
  const locale = parts.length >= 3 ? parts[parts.length - 2] : 'unknown';
  const domain = parts.length >= 3 ? parts.slice(0, parts.length - 2).join('.') : parts[0];
  const icuKeys: string[] = [];
  const keyRe = /^(\s{0,8}[\w.]+[\w.-]{0,80}):/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(content)) !== null) {
    const key = m[1].trim();
    const keyStart = content.indexOf(m[0]) + m[0].length;
    const valueEnd = Math.min(keyStart + 500, content.length);
    const value = content.substring(keyStart, valueEnd);
    if (value.includes(', plural,') || value.includes(', select,')) icuKeys.push(key);
  }
  const hasPlural = content.includes(', plural,');
  const hasSelect = content.includes(', select,');
  const hasMissingDefault = hasPlural && !content.includes('other {') && !content.includes('=1 {');
  const issues: string[] = [];
  if (hasMissingDefault) issues.push('ICU plural without "other {}" fallback — CLDR requires an "other" category');
  if (content.includes(', plural,') && !content.includes('=0')) issues.push('ICU plural without "=0 {}" — zero case may render as "1 item" or similar');
  return { file: path.relative(appPath, filePath), locale, domain, icuKeys, hasPlural, hasSelect, hasMissingDefault, issues };
}

export function listIcuTranslations(appPath: string): McpToolResult {
  try {
    const translationsDir = path.join(appPath, 'translations');
    const files = getTranslationFiles(translationsDir);
    const results: IcuTranslation[] = [];
    for (const f of files) {
      const r = parseIcuFile(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No ICU plural/select format translations found.\n\nExample:\n  item_count: "{count, plural, =0 {No items} =1 {One item} other {# items}}"' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    const totalKeys = results.reduce((s, r) => s + r.icuKeys.length, 0);
    let text = `ICU Message Format Translations\n${'='.repeat(55)}\n\nFiles: ${results.length}  ICU keys: ${totalKeys}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const types = [r.hasPlural ? 'plural' : '', r.hasSelect ? 'select' : ''].filter(Boolean).join('+');
      text += `\n  ${r.file}  [${r.locale}] domain: ${r.domain}  types: ${types}  keys: ${r.icuKeys.length}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getIcuTranslationStats(appPath: string): McpToolResult {
  try {
    const translationsDir = path.join(appPath, 'translations');
    const files = getTranslationFiles(translationsDir);
    const results: IcuTranslation[] = [];
    for (const f of files) {
      const r = parseIcuFile(f, appPath);
      if (r) results.push(r);
    }
    let text = `ICU Translation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with ICU format: ${results.length}\nTotal ICU keys: ${results.reduce((s, r) => s + r.icuKeys.length, 0)}\nWith plural: ${results.filter(r => r.hasPlural).length}\nWith select: ${results.filter(r => r.hasSelect).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getIcuTranslationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_icu_translations', description: 'Detect ICU message format in translation files: {count, plural, ...}, {gender, select, ...}, missing "other {}" fallback warning, missing "=0" case warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_icu_translation_stats', description: 'ICU translation statistics: file count, ICU key count, plural/select counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
