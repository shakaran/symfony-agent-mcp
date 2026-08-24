// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FiberUsage {
  file: string;
  class?: string;
  createCount: number;
  suspendCount: number;
  resumeCount: number;
  isAsyncIntegration: boolean;
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

function parseFiberUsage(filePath: string, appPath: string): FiberUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('Fiber') && !content.includes('fiber')) return null;
  const createCount = (content.match(/new\s+Fiber\s*\(/g) ?? []).length;
  const suspendCount = (content.match(/Fiber::suspend\s*\(/g) ?? []).length;
  const resumeCount = (content.match(/->resume\s*\(/g) ?? []).length;
  if (createCount === 0 && suspendCount === 0) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace React\\') || content.includes('namespace Amp\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const isAsyncIntegration = content.includes('ReactPHP') || content.includes('Amp\\') || content.includes('Swoole') || content.includes('RoadRunner') || content.includes('FrankenPHP');
  const issues: string[] = [];
  if (createCount > 0 && resumeCount === 0) issues.push('Fiber created but never resumed — fiber will be garbage-collected in suspended state');
  if (suspendCount > 0 && createCount === 0) issues.push('Fiber::suspend() called outside a Fiber — will throw FiberError if not in a fiber context');
  if (createCount > 10) issues.push(`${createCount} Fiber instances created — consider a pooling strategy`);
  return { file: path.relative(appPath, filePath), class: classM?.[1], createCount, suspendCount, resumeCount, isAsyncIntegration, issues };
}

export function listPhpFibers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: FiberUsage[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseFiberUsage(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No PHP Fiber usage found (PHP 8.1+).' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHP Fiber Usage\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class ?? '(file)'}  create: ${r.createCount}  suspend: ${r.suspendCount}  resume: ${r.resumeCount}${r.isAsyncIntegration ? '  async-runtime' : ''}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFiberStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: FiberUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseFiberUsage(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `PHP Fiber Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using Fibers: ${results.length}\nTotal Fiber creations: ${results.reduce((s, r) => s + r.createCount, 0)}\nTotal suspend calls: ${results.reduce((s, r) => s + r.suspendCount, 0)}\nAsync runtime integration: ${results.filter(r => r.isAsyncIntegration).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFiberTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_fibers', description: 'Detect PHP 8.1 Fiber usage: new Fiber(), Fiber::suspend(), resume(), async runtime integration (ReactPHP/Amp/Swoole), unresumed fiber warning, out-of-context suspend warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_fiber_stats', description: 'PHP Fiber statistics: file count, create/suspend counts, async runtime count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
