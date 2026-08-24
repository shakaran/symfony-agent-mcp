// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ValidationContextInfo {
  class: string;
  file: string;
  operations: Array<{ name: string; validationGroups: string[] }>;
  hasConstraints: boolean;
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

function parseValidationContext(filePath: string, appPath: string): ValidationContextInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ApiResource') && !content.includes('validationContext')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const operations: Array<{ name: string; validationGroups: string[] }> = [];
  const opPattern = /(?:new\s+(?:Get|GetCollection|Post|Put|Patch|Delete)\s*\(|#\[(?:Get|GetCollection|Post|Put|Patch|Delete))[^)]{0,600}/g;
  let m: RegExpExecArray | null;
  while ((m = opPattern.exec(content)) !== null) {
    const block = m[0];
    const nameM = /(?:Get|GetCollection|Post|Put|Patch|Delete)/.exec(block);
    const vgM = /validationContext\s*:\s*\[\s*groups\s*:\s*\[([^\]]{0,200})\]\s*\]/i.exec(block);
    const groups = vgM ? vgM[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    operations.push({ name: nameM?.[0] ?? 'operation', validationGroups: groups });
  }
  const hasConstraints = content.includes('Assert\\') || content.includes('@Assert') || content.includes('#[Assert');
  const issues: string[] = [];
  const writableOps = operations.filter((o) => ['Post', 'Put', 'Patch'].includes(o.name));
  if (writableOps.some((o) => o.validationGroups.length === 0) && hasConstraints) {
    issues.push('Write operations (Post/Put/Patch) without validationContext groups — all constraint groups will be validated; may validate unintended rules');
  }
  return { class: classM[1], file: path.relative(appPath, filePath), operations, hasConstraints, issues };
}

export function listApiPlatformValidationContexts(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const resources: ValidationContextInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseValidationContext(file, appPath);
      if (r) resources.push(r);
    }
    if (resources.length === 0) return { content: [{ type: 'text', text: 'No API Platform ApiResource with validationContext found.\n\nExample:\n  #[Post(validationContext: [\'groups\' => [\'create\']])]' }] };
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform Validation Context\n${'='.repeat(55)}\n\nResources: ${resources.length}  Issues: ${totalIssues}\n`;
    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  operations: ${r.operations.length}  constraints: ${r.hasConstraints ? 'yes' : 'no'}  (${r.file})\n`;
      for (const op of r.operations.filter((o) => o.validationGroups.length > 0)) {
        text += `    ${op.name}: groups=${op.validationGroups.join(',')}\n`;
      }
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformValidationContextStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: ValidationContextInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseValidationContext(file, appPath);
        if (r) resources.push(r);
      }
    }
    let text = `API Platform Validation Context Statistics\n${'='.repeat(40)}\n\n`;
    const allOps = resources.flatMap((r) => r.operations);
    text += `Resources: ${resources.length}\n  Operations: ${allOps.length}\n  With validation groups: ${allOps.filter((o) => o.validationGroups.length > 0).length}\nIssues: ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformValidationContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_validation_contexts', description: 'Show API Platform per-operation validationContext groups: Post/Put/Patch operations, validation group per operation, missing groups on write operations warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_validation_context_stats', description: 'Show API Platform validation context statistics: resource count, operation count, with-groups count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
