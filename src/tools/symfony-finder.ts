import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FinderUsage {
  file: string;
  class?: string;
  hasInCall: boolean;
  hasNameFilter: boolean;
  hasDepthFilter: boolean;
  hasSizeFilter: boolean;
  hasDateFilter: boolean;
  hasContentFilter: boolean;
  hasSort: boolean;
  iteratesAll: boolean;
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

function parseFinderUsage(filePath: string, appPath: string): FinderUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('Finder') || (!content.includes('new Finder') && !content.includes('Finder::create'))) return null;
  if (content.includes('namespace Symfony\\Component\\Finder')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasInCall = content.includes('->in(');
  const hasNameFilter = content.includes('->name(') || content.includes('->notName(');
  const hasDepthFilter = content.includes('->depth(');
  const hasSizeFilter = content.includes('->size(');
  const hasDateFilter = content.includes('->date(');
  const hasContentFilter = content.includes('->contains(') || content.includes('->notContains(');
  const hasSort = content.includes('->sortBy') || content.includes('->sort(');
  const iteratesAll = content.includes('->files()') || content.includes('->directories()') || content.includes('foreach');
  const issues: string[] = [];
  if (!hasInCall) issues.push('Finder without ->in() — no directory constraint; will throw LogicException');
  if (!hasDepthFilter && iteratesAll) issues.push('Finder without ->depth() — recursively scans all subdirectories; may be slow on large trees');
  if (hasContentFilter) issues.push('->contains() reads file contents for matching — can be slow on large codebases');
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasInCall, hasNameFilter, hasDepthFilter, hasSizeFilter, hasDateFilter, hasContentFilter, hasSort, iteratesAll, issues };
}

export function listFinderUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: FinderUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseFinderUsage(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No Symfony Finder usage found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony Finder Usage\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        r.hasInCall ? '✓in' : '✗in',
        r.hasNameFilter ? 'name' : '',
        r.hasDepthFilter ? 'depth' : '',
        r.hasSizeFilter ? 'size' : '',
        r.hasContentFilter ? 'contains' : '',
        r.hasSort ? 'sort' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${r.class ?? '(file)'}  ${flags}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFinderStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: FinderUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseFinderUsage(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Symfony Finder Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using Finder: ${results.length}\n  With in(): ${results.filter(r => r.hasInCall).length}\n  With depth(): ${results.filter(r => r.hasDepthFilter).length}\n  With name(): ${results.filter(r => r.hasNameFilter).length}\n  With content filter: ${results.filter(r => r.hasContentFilter).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFinderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_finder', description: 'Detect Symfony Finder usage: ->in() directory constraint, ->name()/depth()/size()/date()/contains() filters, ->sortBy(), missing in() LogicException warning, unbounded depth warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_finder_stats', description: 'Symfony Finder statistics: file count, in/depth/name/content-filter coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
