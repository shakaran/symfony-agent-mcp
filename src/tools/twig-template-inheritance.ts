// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TemplateInfo {
  file: string;
  parent?: string;
  blocks: string[];
  depth: number;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseTemplate(filePath: string, appPath: string): TemplateInfo {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
  const extendsM = /\{%-?\s*extends\s+['"]([^'"]{1,200})['"]/i.exec(content);
  const parent = extendsM?.[1];
  const blocks: string[] = [];
  const blockRe = /\{%-?\s*block\s+(\w{1,80})/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) blocks.push(m[1]);
  const issues: string[] = [];
  if (blocks.length > 20) issues.push(`${blocks.length} blocks in one template — consider splitting`);
  return { file: path.relative(appPath, filePath), parent, blocks, depth: 0, issues };
}

function buildDepths(templates: TemplateInfo[]): void {
  const byFile = new Map<string, TemplateInfo>();
  for (const t of templates) byFile.set(t.file, t);
  for (const t of templates) {
    if (!t.parent) { t.depth = 0; continue; }
    let depth = 0;
    let cur: TemplateInfo | undefined = t;
    const seen = new Set<string>();
    while (cur?.parent && !seen.has(cur.file)) {
      seen.add(cur.file);
      depth++;
      cur = byFile.get(cur.parent);
    }
    t.depth = depth;
    if (depth > 4) t.issues.push(`Inheritance depth ${depth} — deeply nested templates are hard to maintain`);
  }
}

export function listTwigInheritance(appPath: string): McpToolResult {
  try {
    const templatesDir = path.join(appPath, 'templates');
    const files = getAllTwigFiles(templatesDir);
    const templates = files.map(f => parseTemplate(f, appPath));
    buildDepths(templates);
    const withParent = templates.filter(t => t.parent);
    const withBlocks = templates.filter(t => t.blocks.length > 0);
    const totalIssues = templates.reduce((s, t) => s + t.issues.length, 0);
    let text = `Twig Template Inheritance\n${'='.repeat(55)}\n\nTotal templates: ${templates.length}  Extend parent: ${withParent.length}  With blocks: ${withBlocks.length}  Issues: ${totalIssues}\n`;
    for (const t of templates.filter(t => t.parent || t.issues.length > 0).sort((a, b) => b.depth - a.depth)) {
      text += `\n  ${t.file}  (depth: ${t.depth})\n`;
      if (t.parent) text += `    extends: ${t.parent}\n`;
      if (t.blocks.length > 0) text += `    blocks: ${t.blocks.slice(0, 10).join(', ')}${t.blocks.length > 10 ? ` +${t.blocks.length - 10} more` : ''}\n`;
      for (const i of t.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigInheritanceStats(appPath: string): McpToolResult {
  try {
    const templatesDir = path.join(appPath, 'templates');
    const files = getAllTwigFiles(templatesDir);
    const templates = files.map(f => parseTemplate(f, appPath));
    buildDepths(templates);
    const depths = templates.map(t => t.depth);
    const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
    let text = `Twig Inheritance Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total templates: ${templates.length}\nWith parent (extends): ${templates.filter(t => t.parent).length}\nBase templates (no parent): ${templates.filter(t => !t.parent).length}\nMax inheritance depth: ${maxDepth}\nIssues: ${templates.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigInheritanceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_twig_inheritance', description: 'Show Twig template inheritance chains: {% extends %} parent, {% block %} overrides, depth per template, warning when depth > 4 or block count > 20', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_twig_inheritance_stats', description: 'Twig inheritance statistics: total templates, templates with parent, base templates, max depth, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
