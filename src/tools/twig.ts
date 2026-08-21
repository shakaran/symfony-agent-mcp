/**
 * Twig Template Inspector
 *
 * Scans the templates/ directory to extract:
 *   - Template hierarchy (extends chains)
 *   - Block definitions and overrides
 *   - Macros
 *   - Included templates (include, embed, use)
 *   - Variables referenced in templates
 *   - Filter and function usage
 *
 * Pure static analysis — no Twig rendering required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigTemplate {
  path: string;
  relativePath: string;
  extends?: string;
  blocks: string[];
  includes: string[];
  embeds: string[];
  uses: string[];
  macros: string[];
  variables: string[];
  sizeBytes: number;
}

// ─── File scanning ─────────────────────────────────────────────────────────

function getAllTwigFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllTwigFiles(full, baseDir));
      else if (entry.name.endsWith('.twig') || entry.name.endsWith('.html.twig')) {
        files.push(full);
      }
    }
  } catch {
    // Skip
  }
  return files;
}

function parseTemplate(filePath: string, baseDir: string): TwigTemplate {
  let content = '';
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(filePath);
    sizeBytes = stat.size;
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Return empty template
  }

  const relativePath = path.relative(baseDir, filePath);

  if (sizeBytes > 500_000) {
    return { path: filePath, relativePath, blocks: [], includes: [], embeds: [], uses: [], macros: [], variables: [], sizeBytes };
  }

  // {% extends 'base.html.twig' %}
  const extendsMatch = /\{%-?\s*extends\s+['"]([^'"]+)['"]\s*-?%\}/.exec(content);

  // {% block content %} ... {% endblock %}
  const blocks: string[] = [];
  for (const m of content.matchAll(/\{%-?\s*block\s+(\w+)\s*-?%\}/g)) {
    if (!blocks.includes(m[1])) blocks.push(m[1]);
  }

  // {% include 'partial.html.twig' %}
  const includes: string[] = [];
  for (const m of content.matchAll(/\{%-?\s*include\s+['"]([^'"]+)['"]/g)) {
    if (!includes.includes(m[1])) includes.push(m[1]);
  }

  // {% embed 'layout.html.twig' %}
  const embeds: string[] = [];
  for (const m of content.matchAll(/\{%-?\s*embed\s+['"]([^'"]+)['"]/g)) {
    if (!embeds.includes(m[1])) embeds.push(m[1]);
  }

  // {% use 'blocks.html.twig' %}
  const uses: string[] = [];
  for (const m of content.matchAll(/\{%-?\s*use\s+['"]([^'"]+)['"]/g)) {
    if (!uses.includes(m[1])) uses.push(m[1]);
  }

  // {% macro name(...) %}
  const macros: string[] = [];
  for (const m of content.matchAll(/\{%-?\s*macro\s+(\w+)\s*\(/g)) {
    if (!macros.includes(m[1])) macros.push(m[1]);
  }

  // Variables: {{ variableName }} and {{ variableName.property }}
  const variables: string[] = [];
  for (const m of content.matchAll(/\{\{-?\s*([\w]+)(?:\.\w+)*\s*(?:[|}\s])/g)) {
    const varName = m[1];
    // Skip Twig built-ins
    if (!['loop', 'app', 'constant', 'attribute', 'block', 'parent', 'dump'].includes(varName)) {
      if (!variables.includes(varName)) variables.push(varName);
    }
  }

  return {
    path: filePath,
    relativePath,
    extends: extendsMatch ? extendsMatch[1] : undefined,
    blocks,
    includes,
    embeds,
    uses,
    macros,
    variables: variables.slice(0, 20), // Cap to avoid noise
    sizeBytes,
  };
}

function loadTemplates(appPath: string): { templates: TwigTemplate[]; baseDir: string } {
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src', 'Resources', 'views'),
  ];

  const templates: TwigTemplate[] = [];
  let baseDir = templateDirs[0];

  for (const dir of templateDirs) {
    if (!fs.existsSync(dir)) continue;
    if (!baseDir) baseDir = dir;
    for (const file of getAllTwigFiles(dir, dir)) {
      templates.push(parseTemplate(file, dir));
    }
  }

  return { templates, baseDir: baseDir ?? path.join(appPath, 'templates') };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listTemplates(appPath: string): McpToolResult {
  try {
    const { templates, baseDir } = loadTemplates(appPath);

    if (templates.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Twig templates found.\n\nExpected: ${path.join(appPath, 'templates/')}\n\nCreate with: php bin/console make:controller (generates template automatically)`,
        }],
      };
    }

    // Group by subdirectory
    const groups: Record<string, TwigTemplate[]> = {};
    for (const t of templates) {
      const parts = t.relativePath.split(path.sep);
      const group = parts.length > 1 ? parts[0] : '(root)';
      (groups[group] ??= []).push(t);
    }

    let text = `Twig Templates (${templates.length}) — ${baseDir}\n${'─'.repeat(60)}\n`;

    for (const [group, tmplList] of Object.entries(groups).sort()) {
      text += `\n  ${group}/\n`;
      for (const t of tmplList.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
        const info: string[] = [];
        if (t.extends) info.push(`extends: ${path.basename(t.extends)}`);
        if (t.blocks.length > 0) info.push(`blocks: ${t.blocks.length}`);
        if (t.includes.length > 0) info.push(`includes: ${t.includes.length}`);
        if (t.macros.length > 0) info.push(`macros: ${t.macros.length}`);
        const infoStr = info.length > 0 ? `  [${info.join(', ')}]` : '';
        text += `    ${path.basename(t.relativePath).padEnd(35)} ${formatBytes(t.sizeBytes).padEnd(8)}${infoStr}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing templates: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTemplateDetails(appPath: string, templatePath: string): McpToolResult {
  try {
    const { templates } = loadTemplates(appPath);
    const tmpl = templates.find(
      (t) =>
        t.relativePath === templatePath ||
        t.relativePath.replace(/\\/g, '/') === templatePath ||
        path.basename(t.relativePath) === templatePath ||
        t.relativePath.includes(templatePath)
    );

    if (!tmpl) {
      const paths = templates.map((t) => t.relativePath).slice(0, 20).join('\n  ');
      return {
        content: [{ type: 'text', text: `Template "${templatePath}" not found.\n\nAvailable templates:\n  ${paths}` }],
        isError: true,
      };
    }

    let text = `Template: ${tmpl.relativePath}\n${'='.repeat(50)}\n\n`;
    text += `Size: ${formatBytes(tmpl.sizeBytes)}\n`;
    if (tmpl.extends) text += `Extends: ${tmpl.extends}\n`;

    if (tmpl.blocks.length > 0) {
      text += `\nBlocks (${tmpl.blocks.length}):\n`;
      for (const block of tmpl.blocks) text += `  - ${block}\n`;
    }

    if (tmpl.includes.length > 0) {
      text += `\nIncludes (${tmpl.includes.length}):\n`;
      for (const inc of tmpl.includes) text += `  - ${inc}\n`;
    }

    if (tmpl.embeds.length > 0) {
      text += `\nEmbeds (${tmpl.embeds.length}):\n`;
      for (const emb of tmpl.embeds) text += `  - ${emb}\n`;
    }

    if (tmpl.uses.length > 0) {
      text += `\nUses (${tmpl.uses.length}):\n`;
      for (const u of tmpl.uses) text += `  - ${u}\n`;
    }

    if (tmpl.macros.length > 0) {
      text += `\nMacros (${tmpl.macros.length}):\n`;
      for (const macro of tmpl.macros) text += `  - ${macro}\n`;
    }

    if (tmpl.variables.length > 0) {
      text += `\nVariables referenced:\n  ${tmpl.variables.join(', ')}\n`;
    }

    // Find templates that include/extend this one
    const { templates: allTemplates } = loadTemplates(appPath);
    const usedBy = allTemplates.filter(
      (t) =>
        t.extends === tmpl.relativePath ||
        t.includes.includes(tmpl.relativePath) ||
        t.embeds.includes(tmpl.relativePath)
    );
    if (usedBy.length > 0) {
      text += `\nReferenced by:\n`;
      for (const ref of usedBy) text += `  - ${ref.relativePath}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTemplateInheritanceTree(appPath: string): McpToolResult {
  try {
    const { templates } = loadTemplates(appPath);

    // Build the inheritance tree: find roots (templates with no parent or base.html.twig)
    // Find base templates (extended by others, don't extend anything themselves)
    const roots = templates.filter((t) => !t.extends);
    const children = templates.filter((t) => t.extends);

    if (roots.length === 0 && children.length === 0) {
      return { content: [{ type: 'text', text: 'No templates found.' }] };
    }

    let text = `Twig Template Inheritance Tree\n${'='.repeat(50)}\n\n`;

    // Show base templates
    if (roots.length > 0) {
      text += `Base templates (no parent): ${roots.length}\n`;
      for (const root of roots.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
        const childCount = children.filter((c) => c.extends === root.relativePath || c.extends?.includes(path.basename(root.relativePath))).length;
        text += `  ${root.relativePath}  (${root.blocks.length} blocks, ${childCount} children)\n`;
      }
    }

    // Show inheritance chains
    if (children.length > 0) {
      text += `\nTemplates with inheritance (${children.length}):\n`;
      for (const child of children.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
        text += `  ${child.relativePath}\n`;
        text += `    extends: ${child.extends}\n`;
        if (child.blocks.length > 0) text += `    overrides: ${child.blocks.join(', ')}\n`;
      }
    }

    // Orphan includes (templates only used via include, never extended)
    const allReferenced = new Set<string>();
    for (const t of templates) {
      if (t.extends) allReferenced.add(t.extends);
      t.includes.forEach((i) => allReferenced.add(i));
      t.embeds.forEach((e) => allReferenced.add(e));
    }
    const standalone = templates.filter(
      (t) => !t.extends && !allReferenced.has(t.relativePath.replace(/\\/g, '/'))
    );
    if (standalone.length > 0 && standalone.length < templates.length) {
      text += `\nStandalone (not inherited or included): ${standalone.length}\n`;
      for (const t of standalone.slice(0, 10)) {
        text += `  ${t.relativePath}\n`;
      }
      if (standalone.length > 10) text += `  ... and ${standalone.length - 10} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchTemplates(appPath: string, query: string): McpToolResult {
  try {
    const { templates } = loadTemplates(appPath);
    const lq = query.toLowerCase();

    const matches = templates.filter(
      (t) =>
        t.relativePath.toLowerCase().includes(lq) ||
        t.blocks.some((b) => b.toLowerCase().includes(lq)) ||
        t.macros.some((m) => m.toLowerCase().includes(lq)) ||
        t.variables.some((v) => v.toLowerCase().includes(lq)) ||
        t.includes.some((i) => i.toLowerCase().includes(lq))
    );

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No templates matching "${query}".` }] };
    }

    let text = `Templates matching "${query}" (${matches.length}):\n\n`;
    for (const t of matches) {
      text += `  ${t.relativePath}\n`;
      const hits: string[] = [];
      if (t.blocks.some((b) => b.toLowerCase().includes(lq)))
        hits.push(`blocks: ${t.blocks.filter((b) => b.toLowerCase().includes(lq)).join(', ')}`);
      if (t.macros.some((m) => m.toLowerCase().includes(lq)))
        hits.push(`macros: ${t.macros.filter((m) => m.toLowerCase().includes(lq)).join(', ')}`);
      if (hits.length > 0) text += `    ${hits.join(' | ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getTwigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_templates',
      description: 'List all Twig templates in templates/ grouped by subdirectory, with size, blocks, and inheritance info',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_template_details',
      description: 'Get detailed info for a Twig template: extends, blocks, includes, embeds, macros, variables, and which templates use it',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          template_path: { type: 'string', description: 'Template path relative to templates/ (e.g. base.html.twig or security/login.html.twig)' },
        },
        required: ['app_path', 'template_path'],
      },
    },
    {
      name: 'get_template_inheritance_tree',
      description: 'Show the Twig template inheritance tree: base templates, which templates extend them, and block overrides',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'search_templates',
      description: 'Search Twig templates by path, block name, macro name, variable name, or included template',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Search query' },
        },
        required: ['app_path', 'query'],
      },
    },
  ];
}
