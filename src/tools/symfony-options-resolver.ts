// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface OptionsResolverUsage {
  file: string;
  class?: string;
  requiredCount: number;
  definedCount: number;
  allowedTypesCount: number;
  allowedValuesCount: number;
  normalizerCount: number;
  hasDefaults: boolean;
  isOutsideForms: boolean;
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

function parseOptionsResolver(filePath: string, appPath: string): OptionsResolverUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('OptionsResolver')) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const isForm = content.includes('AbstractType') || content.includes('FormTypeInterface') || content.includes('configureOptions');
  const requiredCount = [...content.matchAll(/->setRequired\s*\(/g)].length;
  const definedCount = [...content.matchAll(/->setDefined\s*\(/g)].length;
  const allowedTypesCount = [...content.matchAll(/->setAllowedTypes\s*\(/g)].length;
  const allowedValuesCount = [...content.matchAll(/->setAllowedValues\s*\(/g)].length;
  const normalizerCount = [...content.matchAll(/->setNormalizer\s*\(/g)].length;
  const hasDefaults = content.includes('->setDefault(') || content.includes('->setDefaults(');
  if (requiredCount + definedCount + allowedTypesCount === 0) return null;
  const issues: string[] = [];
  if (normalizerCount > 0 && allowedTypesCount === 0) issues.push('Normalizer without setAllowedTypes — normalizer receives untyped input; consider adding type constraint');
  if (requiredCount > 3 && !hasDefaults) issues.push(`${requiredCount} required options without any defaults — callers must provide all options`);
  return { file: path.relative(appPath, filePath), class: classM[1], requiredCount, definedCount, allowedTypesCount, allowedValuesCount, normalizerCount, hasDefaults, isOutsideForms: !isForm, issues };
}

export function listOptionsResolverUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: OptionsResolverUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseOptionsResolver(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No OptionsResolver usage found outside form types.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    const outsideForms = usages.filter((u) => u.isOutsideForms);
    let text = `OptionsResolver Usage\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Outside forms: ${outsideForms.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class}  req: ${u.requiredCount}  def: ${u.definedCount}  types: ${u.allowedTypesCount}  normalizers: ${u.normalizerCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOptionsResolverStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: OptionsResolverUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseOptionsResolver(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `OptionsResolver Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with OptionsResolver: ${usages.length}\n  Outside forms: ${usages.filter((u) => u.isOutsideForms).length}\n  With normalizers: ${usages.filter((u) => u.normalizerCount > 0).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getOptionsResolverTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_options_resolver_usage', description: 'Show OptionsResolver usage outside form types: setRequired/setDefined/setAllowedTypes/setNormalizer counts, normalizer-without-types warning, many required options without defaults warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_options_resolver_stats', description: 'Show OptionsResolver statistics: file count, outside-forms count, normalizer count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
