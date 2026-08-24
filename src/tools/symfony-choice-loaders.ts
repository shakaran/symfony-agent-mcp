// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ChoiceLoaderInfo {
  class: string;
  file: string;
  hasLoadChoiceList: boolean;
  hasLoadChoicesForValues: boolean;
  hasLoadValuesForChoices: boolean;
  hasCache: boolean;
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

function parseChoiceLoader(filePath: string, appPath: string): ChoiceLoaderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ChoiceLoaderInterface') && !content.includes('loadChoiceList')) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const hasLoadChoiceList = content.includes('function loadChoiceList(');
  const hasLoadChoicesForValues = content.includes('function loadChoicesForValues(');
  const hasLoadValuesForChoices = content.includes('function loadValuesForChoices(');
  const hasCache = content.includes('CachingFactoryDecorator') || content.includes('$cachedChoiceList') || content.includes('static $cache');
  const issues: string[] = [];
  if (hasLoadChoiceList && !hasCache) issues.push('ChoiceLoader without caching — loadChoiceList() called on every form render; use CachingFactoryDecorator or static cache');
  if (!hasLoadChoicesForValues) issues.push('Missing loadChoicesForValues() — form submission with pre-selected values may fail');
  if (!hasLoadValuesForChoices) issues.push('Missing loadValuesForChoices() — value extraction for display may fail');
  return { class: classM[1], file: path.relative(appPath, filePath), hasLoadChoiceList, hasLoadChoicesForValues, hasLoadValuesForChoices, hasCache, issues };
}

export function listChoiceLoaders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const loaders: ChoiceLoaderInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const l = parseChoiceLoader(file, appPath);
      if (l) loaders.push(l);
    }
    if (loaders.length === 0) return { content: [{ type: 'text', text: 'No ChoiceLoaderInterface implementations found.\n\nUse for large choice datasets:\n  class UserChoiceLoader implements ChoiceLoaderInterface {\n    public function loadChoiceList(?callable $filter = null): ChoiceListInterface { ... }\n  }' }] };
    const totalIssues = loaders.reduce((s, l) => s + l.issues.length, 0);
    let text = `Form Choice Loaders\n${'='.repeat(55)}\n\nLoaders: ${loaders.length}  Issues: ${totalIssues}\n`;
    for (const l of loaders.sort((a, b) => b.issues.length - a.issues.length)) {
      const methods = [l.hasLoadChoiceList ? 'loadChoiceList' : '', l.hasLoadChoicesForValues ? 'loadChoicesForValues' : '', l.hasLoadValuesForChoices ? 'loadValuesForChoices' : ''].filter(Boolean).join(' | ');
      const cache = l.hasCache ? '  ✓ cached' : '  ⚠ no cache';
      text += `\n  ${l.class}  ${methods}${cache}  (${l.file})\n`;
      for (const i of l.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getChoiceLoaderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const loaders: ChoiceLoaderInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const l = parseChoiceLoader(file, appPath);
        if (l) loaders.push(l);
      }
    }
    let text = `Choice Loader Statistics\n${'='.repeat(40)}\n\n`;
    text += `Loaders: ${loaders.length}\nWith cache: ${loaders.filter((l) => l.hasCache).length}\nIssues: ${loaders.reduce((s, l) => s + l.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getChoiceLoaderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_choice_loaders', description: 'Show ChoiceLoaderInterface implementations: loadChoiceList/loadChoicesForValues/loadValuesForChoices method presence, caching (CachingFactoryDecorator/static cache), no-cache performance warning, missing methods warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_choice_loader_stats', description: 'Show choice loader statistics: loader count, cached count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
