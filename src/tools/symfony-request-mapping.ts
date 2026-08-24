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

interface RequestMappingUsage {
  file: string;
  class?: string;
  mapRequestPayload: number;
  mapQueryParameter: number;
  mapQueryString: number;
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

function parseRequestMapping(filePath: string, appPath: string): RequestMappingUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const mapReqPayload = [...content.matchAll(/#\[MapRequestPayload/g)].length;
  const mapQueryParam = [...content.matchAll(/#\[MapQueryParameter/g)].length;
  const mapQueryString = [...content.matchAll(/#\[MapQueryString/g)].length;
  if (mapReqPayload + mapQueryParam + mapQueryString === 0) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const issues: string[] = [];
  if (mapReqPayload > 0 && !content.includes('validationFailedStatusCode') && !content.includes('constraints:') && !content.includes('groups:')) {
    issues.push('#[MapRequestPayload] without validationFailedStatusCode or validation groups — validation errors return 422 by default');
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('#[MapQueryParameter')) continue;
    const block = lines.slice(i, Math.min(i + 3, lines.length)).join('\n');
    if (!block.includes('filter:') && !block.includes('type:') && !/:\s*(?:int|float|string|bool)/.test(block)) {
      issues.push('#[MapQueryParameter] without type hint — parameter arrives as raw string; add PHP type or filter:');
    }
    break;
  }
  return { file: path.relative(appPath, filePath), class: classM?.[1], mapRequestPayload: mapReqPayload, mapQueryParameter: mapQueryParam, mapQueryString, issues };
}

export function listRequestMappingAttrs(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: RequestMappingUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseRequestMapping(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No #[MapRequestPayload]/#[MapQueryParameter]/#[MapQueryString] found.\n\nRequires Symfony 6.3+.\n\nExample:\n  #[Route(\'/api/users\', methods: [\'POST\'])]\n  public function create(#[MapRequestPayload] CreateUserDto $dto): Response { }' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Request Mapping Attributes (Symfony 6.3+)\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  #[MapRequestPayload]: ${usages.reduce((s, u) => s + u.mapRequestPayload, 0)}\n`;
    text += `  #[MapQueryParameter]:  ${usages.reduce((s, u) => s + u.mapQueryParameter, 0)}\n`;
    text += `  #[MapQueryString]:     ${usages.reduce((s, u) => s + u.mapQueryString, 0)}\n`;
    for (const u of usages.filter((x) => x.issues.length > 0)) {
      text += `\n  ${u.class ?? '(file)'}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRequestMappingStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: RequestMappingUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseRequestMapping(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Request Mapping Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\n  #[MapRequestPayload]: ${usages.reduce((s, u) => s + u.mapRequestPayload, 0)}\n  #[MapQueryParameter]: ${usages.reduce((s, u) => s + u.mapQueryParameter, 0)}\n  #[MapQueryString]: ${usages.reduce((s, u) => s + u.mapQueryString, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRequestMappingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_request_mapping_attrs', description: 'Show Symfony 6.3+ #[MapRequestPayload]/#[MapQueryParameter]/#[MapQueryString] attributes: usage counts per controller, missing validationFailedStatusCode warning, MapQueryParameter without type hint warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_request_mapping_stats', description: 'Show request mapping attribute statistics: file count, per-attribute type counts, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
