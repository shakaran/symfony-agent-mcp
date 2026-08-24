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

interface NamespaceIssue {
  file: string;
  declaredNamespace: string;
  expectedNamespace: string;
}

function loadPsr4Mappings(appPath: string): Array<{ prefix: string; dir: string }> {
  const composerPath = path.join(appPath, 'composer.json');
  const mappings: Array<{ prefix: string; dir: string }> = [];
  try {
    const cj = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
    const autoload = (cj['autoload'] ?? {}) as Record<string, unknown>;
    const psr4 = (autoload['psr-4'] ?? {}) as Record<string, string>;
    for (const [prefix, dir] of Object.entries(psr4)) {
      const normalizedDir = path.resolve(appPath, dir.replace(/\/$/, ''));
      mappings.push({ prefix: prefix.replace(/\\$/, ''), dir: normalizedDir });
    }
  } catch { /* skip */ }
  return mappings;
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

function checkFile(filePath: string, mappings: Array<{ prefix: string; dir: string }>, appPath: string): NamespaceIssue | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const nsM = /namespace\s+([\w\\]+)\s*;/.exec(content);
  if (!nsM) return null;
  const declaredNamespace = nsM[1];
  for (const { prefix, dir } of mappings) {
    if (!filePath.startsWith(dir)) continue;
    const relativePath = filePath.slice(dir.length + 1);
    const expectedRelative = relativePath.replace(/\.php$/, '').split(path.sep).join('\\');
    const expectedNamespace = `${prefix}\\${expectedRelative}`.replace(/\\[^\\]+$/, '');
    if (declaredNamespace !== expectedNamespace) {
      return { file: path.relative(appPath, filePath), declaredNamespace, expectedNamespace };
    }
    break;
  }
  return null;
}

export function listPhpNamespaceConsistency(appPath: string): McpToolResult {
  try {
    const mappings = loadPsr4Mappings(appPath);
    if (mappings.length === 0) return { content: [{ type: 'text', text: 'No PSR-4 autoload mappings found in composer.json.' }] };
    const issues: NamespaceIssue[] = [];
    for (const { dir } of mappings) {
      if (!fs.existsSync(dir)) continue;
      for (const file of getAllPhpFiles(dir)) {
        const issue = checkFile(file, mappings, appPath);
        if (issue) issues.push(issue);
      }
    }
    if (issues.length === 0) return { content: [{ type: 'text', text: `All namespaces are PSR-4 consistent.\n\nMappings checked:\n${mappings.map((m) => `  ${m.prefix}\\ → ${path.relative(appPath, m.dir)}/`).join('\n')}` }] };
    let text = `PHP Namespace Consistency\n${'='.repeat(55)}\n\nMismatches: ${issues.length}\n`;
    for (const i of issues.slice(0, 50)) {
      text += `\n  ${i.file}\n    declared:  ${i.declaredNamespace}\n    expected:  ${i.expectedNamespace}\n`;
    }
    if (issues.length > 50) text += `\n  ... and ${issues.length - 50} more\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNamespaceConsistencyStats(appPath: string): McpToolResult {
  try {
    const mappings = loadPsr4Mappings(appPath);
    let filesChecked = 0;
    const issues: NamespaceIssue[] = [];
    for (const { dir } of mappings) {
      if (!fs.existsSync(dir)) continue;
      const files = getAllPhpFiles(dir);
      filesChecked += files.length;
      for (const file of files) {
        const issue = checkFile(file, mappings, appPath);
        if (issue) issues.push(issue);
      }
    }
    let text = `PHP Namespace Consistency Statistics\n${'='.repeat(40)}\n\n`;
    text += `PSR-4 mappings: ${mappings.length}\nFiles checked: ${filesChecked}\nMismatches: ${issues.length}\nConsistency: ${filesChecked > 0 ? `${(((filesChecked - issues.length) / filesChecked) * 100).toFixed(1)}%` : 'N/A'}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpNamespaceConsistencyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_namespace_consistency', description: 'Show PSR-4 namespace/directory mismatches: declared namespace vs expected from composer.json psr-4 mapping and file path', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_namespace_consistency_stats', description: 'Show namespace consistency statistics: files checked, mismatch count, consistency percentage', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
