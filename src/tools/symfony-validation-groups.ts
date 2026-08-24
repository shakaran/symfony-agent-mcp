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

interface ValidationGroupUsage {
  file: string;
  class?: string;
  hasGroupSequence: boolean;
  hasGroupSequenceProvider: boolean;
  hasSequentialGroups: boolean;
  formValidationGroups: string[][];
  groupNames: string[];
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

function parseValidationGroups(filePath: string, appPath: string): ValidationGroupUsage | null {
  const content = safeRead(filePath, path.join(appPath, 'src'));
  if (content === null) return null;
  const hasGroupSequence = content.includes('GroupSequence');
  const hasGroupSequenceProvider = content.includes('GroupSequenceProviderInterface');
  const hasFormValGroups = content.includes("'validation_groups'") || content.includes('"validation_groups"');
  const hasSequentialGroups = content.includes('Sequentially') && content.includes('group');
  if (!hasGroupSequence && !hasGroupSequenceProvider && !hasFormValGroups && !hasSequentialGroups) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const groupNames: string[] = [];
  for (const m of content.matchAll(/#\[Assert\\[A-Z]\w+[^]]*groups\s*:\s*\[([^\]]+)\]/g)) {
    for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) groupNames.push(gm[1]);
  }
  const formValidationGroups: string[][] = [];
  for (const m of content.matchAll(/validation_groups['"]\s*=>\s*\[([^\]]+)\]/g)) {
    const groups: string[] = [];
    for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) groups.push(gm[1]);
    if (groups.length > 0) formValidationGroups.push(groups);
  }
  const issues: string[] = [];
  if (hasGroupSequence && content.includes('Default')) issues.push('GroupSequence containing "Default" — the Default group inside a sequence includes itself recursively; use specific group names');
  if (hasGroupSequenceProvider && !content.includes('function getGroupSequence')) issues.push('GroupSequenceProviderInterface without getGroupSequence() method');
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasGroupSequence, hasGroupSequenceProvider, hasSequentialGroups, formValidationGroups, groupNames: [...new Set(groupNames)], issues };
}

export function listValidationGroups(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: ValidationGroupUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseValidationGroups(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No validation group sequences found.\n\nExample:\n  #[Assert\\GroupSequence([\'Basic\', \'Advanced\'])]\n  class User implements GroupSequenceProviderInterface { }' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Validation Groups Analysis\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const tags = [u.hasGroupSequence ? 'GroupSequence' : '', u.hasGroupSequenceProvider ? 'GroupSequenceProvider' : ''].filter(Boolean).join(', ');
      const groups = u.groupNames.length > 0 ? `  groups: ${u.groupNames.join(',')}` : '';
      text += `\n  ${u.class ?? '(file)'}  ${tags}${groups}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getValidationGroupStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: ValidationGroupUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseValidationGroups(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Validation Group Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with group usage: ${usages.length}\nGroupSequence: ${usages.filter((u) => u.hasGroupSequence).length}\nGroupSequenceProvider: ${usages.filter((u) => u.hasGroupSequenceProvider).length}\nForm validation_groups: ${usages.filter((u) => u.formValidationGroups.length > 0).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getValidationGroupTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_validation_groups', description: 'Show validation group sequences: GroupSequence, GroupSequenceProviderInterface, form validation_groups option, Default group in sequence warning, missing getGroupSequence() warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_validation_group_stats', description: 'Show validation group statistics: file count, GroupSequence/GroupSequenceProvider/form-groups counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
