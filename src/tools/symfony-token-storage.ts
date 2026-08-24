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

interface TokenStorageUsage {
  file: string;
  class?: string;
  usages: number;
  hasNullCheck: boolean;
  isInRepository: boolean;
  isInService: boolean;
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

function parseTokenStorageUsage(filePath: string, appPath: string): TokenStorageUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  if (!content.includes('TokenStorageInterface') && !content.includes('tokenStorage') && !content.includes('token_storage')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace App\\Security')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const usages = [...content.matchAll(/->getToken\s*\(\s*\)/g)].length;
  if (usages === 0 && !content.includes('TokenStorageInterface')) return null;
  const hasNullCheck = content.includes('getToken()') && (content.includes('getToken() !== null') || content.includes('getToken() instanceof') || content.includes('null !== $') || content.includes('if ($token)'));
  const isInRepository = filePath.includes('Repository');
  const isInService = filePath.includes('Service') || filePath.includes('Manager') || filePath.includes('Handler');
  const issues: string[] = [];
  if (isInRepository) issues.push('TokenStorageInterface injected in Repository — antipattern; pass user via method argument instead');
  if (usages > 0 && !hasNullCheck) issues.push('getToken() called without null check — throws if no token (unauthenticated request)');
  return { file: path.relative(appPath, filePath), class: classM?.[1], usages, hasNullCheck, isInRepository, isInService, issues };
}

export function listTokenStorageUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: TokenStorageUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseTokenStorageUsage(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No TokenStorageInterface usage found outside Security layer.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Token Storage Usage Analysis\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class ?? '(file)'}  getToken() calls: ${u.usages}  nullCheck: ${u.hasNullCheck}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTokenStorageStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: TokenStorageUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseTokenStorageUsage(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Token Storage Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using token storage: ${usages.length}\n`;
    text += `  In repositories: ${usages.filter((u) => u.isInRepository).length}\n`;
    text += `  In services: ${usages.filter((u) => u.isInService).length}\n`;
    text += `  Without null check: ${usages.filter((u) => !u.hasNullCheck && u.usages > 0).length}\n`;
    text += `Issues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTokenStorageTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_token_storage_usage', description: 'Show TokenStorageInterface usage outside Security layer: repository injection antipattern, getToken() without null check, usage in services/managers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_token_storage_stats', description: 'Show token storage statistics: file count, repository injection count, no-null-check count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
