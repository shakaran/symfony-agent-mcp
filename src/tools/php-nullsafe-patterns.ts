import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface NullsafeInfo {
  file: string;
  class?: string;
  count: number;
  maxChainLength: number;
  examplesWithLongChain: string[];
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

function parseNullsafe(filePath: string, appPath: string): NullsafeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('?->')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace PHPUnit\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const count = (content.match(/\?->/g) ?? []).length;
  let maxChainLength = 0;
  const longChains: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const chainCount = (line.match(/\?->/g) ?? []).length;
    if (chainCount > maxChainLength) maxChainLength = chainCount;
    if (chainCount >= 3 && longChains.length < 3) longChains.push(line.trim().substring(0, 100));
  }
  const issues: string[] = [];
  if (maxChainLength >= 4) issues.push(`Chain of ${maxChainLength} nullsafe operators in one expression — may indicate missing null object pattern or incomplete initialization`);
  if (count > 30) issues.push(`${count} nullsafe operators — high number may indicate optional-heavy design; consider null object pattern for frequently nullable objects`);
  return { file: path.relative(appPath, filePath), class: classM?.[1], count, maxChainLength, examplesWithLongChain: longChains, issues };
}

export function listPhpNullsafePatterns(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: NullsafeInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseNullsafe(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No PHP 8.0+ nullsafe operator (?->) usage found.' }] };
    const totalCount = results.reduce((s, r) => s + r.count, 0);
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHP Nullsafe Operator Patterns\n${'='.repeat(55)}\n\nFiles: ${results.length}  Total ?-> usages: ${totalCount}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.maxChainLength - a.maxChainLength).slice(0, 30)) {
      text += `\n  ${r.class ?? '(file)'}  count: ${r.count}  max chain: ${r.maxChainLength}  (${r.file})\n`;
      for (const e of r.examplesWithLongChain) text += `    ${e}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNullsafeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: NullsafeInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseNullsafe(f, appPath);
        if (r) results.push(r);
      }
    }
    const maxChain = results.length > 0 ? Math.max(...results.map(r => r.maxChainLength)) : 0;
    let text = `PHP Nullsafe Operator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using ?->: ${results.length}\nTotal ?-> usages: ${results.reduce((s, r) => s + r.count, 0)}\nMax chain length: ${maxChain}\nFiles with long chains (≥3): ${results.filter(r => r.maxChainLength >= 3).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNullsafeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_nullsafe_patterns', description: 'Detect PHP 8.0+ nullsafe operator (?->) usage: chain length, files with long chains (≥3 in one expression), null object pattern suggestion for frequently-nullable objects', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_nullsafe_stats', description: 'PHP nullsafe statistics: file count, total usages, max chain length, long-chain file count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
