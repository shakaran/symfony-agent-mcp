// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ErrorRendererInfo {
  class: string;
  file: string;
  format: string;
  hasProblemJson: boolean;
  isRegistered: boolean;
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

function parseErrorRenderer(filePath: string, appPath: string): ErrorRendererInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ErrorRendererInterface') && !content.includes('ErrorRenderer')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Twig\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  if (!content.includes('implements') && !content.includes('ErrorRendererInterface')) return null;
  const formatM = /getFormat\s*\(\s*\)\s*:\s*string[^{]*\{[^}]*return\s*['"]([^'"]+)['"]/s.exec(content);
  const format = formatM?.[1] ?? 'unknown';
  const hasProblemJson = content.includes('application/problem+json') || content.includes('problem+json');
  const isRegistered = content.includes('#[AsTaggedItem') || content.includes('error_renderer');
  const issues: string[] = [];
  if (!isRegistered) issues.push('ErrorRenderer not tagged — register with tag: error_renderer.renderer');
  if (format === 'unknown') issues.push('Could not detect getFormat() return value — format may not match Accept header');
  return { class: classM[1], file: path.relative(appPath, filePath), format, hasProblemJson, isRegistered, issues };
}

export function listErrorRenderers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const renderers: ErrorRendererInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseErrorRenderer(file, appPath);
      if (r) renderers.push(r);
    }
    if (renderers.length === 0) return { content: [{ type: 'text', text: 'No custom ErrorRendererInterface implementations found.\n\nExample:\n  class JsonErrorRenderer implements ErrorRendererInterface {\n    public static function getFormat(): string { return \'json\'; }\n    public function render(\\Throwable $exception): FlattenException { ... }\n  }' }] };
    const totalIssues = renderers.reduce((s, r) => s + r.issues.length, 0);
    let text = `Custom Error Renderers\n${'='.repeat(55)}\n\nRenderers: ${renderers.length}  Issues: ${totalIssues}\n`;
    for (const r of renderers.sort((a, b) => b.issues.length - a.issues.length)) {
      const pj = r.hasProblemJson ? '  problem+json' : '';
      const reg = r.isRegistered ? '  ✓ registered' : '  ⚠ not tagged';
      text += `\n  ${r.class}  format: ${r.format}${pj}${reg}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getErrorRendererStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const renderers: ErrorRendererInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseErrorRenderer(file, appPath);
        if (r) renderers.push(r);
      }
    }
    let text = `Error Renderer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom renderers: ${renderers.length}\n  With problem+json: ${renderers.filter((r) => r.hasProblemJson).length}\n  Properly tagged: ${renderers.filter((r) => r.isRegistered).length}\nIssues: ${renderers.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getErrorRendererTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_error_renderers', description: 'Show custom ErrorRendererInterface implementations: format detection, problem+json support, service registration tag, missing tag warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_error_renderer_stats', description: 'Show error renderer statistics: renderer count, problem+json count, properly tagged count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
