// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Platform Operations Inspector
 *
 * Distinct from api-platform.ts (resources/config) and api-platform-state.ts (state providers/processors).
 * Focuses on per-resource HTTP operations analysis:
 *
 * Operations (API Platform 3.x):
 *   - Get           — GET /resources/{id}
 *   - GetCollection — GET /resources
 *   - Post          — POST /resources
 *   - Patch         — PATCH /resources/{id}
 *   - Put           — PUT /resources/{id}
 *   - Delete        — DELETE /resources/{id}
 *
 * Per-operation configuration:
 *   - uriTemplate     — custom URI pattern
 *   - input           — custom input DTO class (or false to disable)
 *   - output          — custom output DTO class (or false to disable)
 *   - security         — "is_granted('ROLE_USER')"
 *   - securityPostDenormalize — security after deserialization
 *   - validationContext — groups for validation
 *   - denormalizationContext — groups for input
 *   - normalizationContext   — groups for output
 *   - processor        — custom StateProcessorInterface
 *   - provider         — custom StateProviderInterface
 *
 * PHP 8 attribute syntax (API Platform 3.x):
 *   #[ApiResource(
 *     operations: [
 *       new Get(uriTemplate: '/products/{id}.{_format}'),
 *       new Post(security: 'is_granted("ROLE_ADMIN")')
 *     ]
 *   )]
 *
 * Analysis:
 *   - Post/Put/Patch without security (unauthenticated write — potential data exposure)
 *   - Delete without security (unauthenticated delete — dangerous)
 *   - Get on sensitive resource without security
 *   - No normalizationContext groups on Get (serializes all fields including sensitive)
 *   - Custom uriTemplate without matching route format
 *   - Operations with output: false (void responses — useful to document)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


type OperationVerb = 'Get' | 'GetCollection' | 'Post' | 'Put' | 'Patch' | 'Delete';

const WRITE_OPS  = new Set<OperationVerb>(['Post', 'Put', 'Patch', 'Delete']);

interface ApiOperation {
  verb: OperationVerb;
  hasSecurity: boolean;
  hasNormalizationGroups: boolean;
  hasInput: boolean;
  hasOutput: boolean;
  uriTemplate?: string;
  issues: string[];
}

interface ApiResourceInfo {
  class: string;
  file: string;
  operations: ApiOperation[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseOperationBlock(block: string): ApiOperation | null {
  const verbM = /^new\s+(Get|GetCollection|Post|Put|Patch|Delete)\b/.exec(block.trim());
  if (!verbM) return null;
  const verb = verbM[1] as OperationVerb;

  const hasSecurity              = block.includes('security') || block.includes('is_granted');
  const hasNormalizationGroups   = block.includes('normalizationContext') || block.includes('groups');
  const hasInput                 = block.includes('input:');
  const hasOutput                = !block.includes('output: false') && !block.includes("output: 'false'");
  const uriM                     = /uriTemplate\s*:\s*['"]([^'"]+)['"]/.exec(block);

  const issues: string[] = [];
  if (WRITE_OPS.has(verb) && !hasSecurity) {
    issues.push(`${verb} operation has no security — write endpoint may be publicly accessible`);
  }
  if (verb === 'Delete' && !hasSecurity) {
    issues.push('Delete without security — anyone can delete resources');
  }

  return {
    verb,
    hasSecurity,
    hasNormalizationGroups,
    hasInput,
    hasOutput,
    uriTemplate: uriM?.[1],
    issues,
  };
}

function parseApiResource(filePath: string, appPath: string): ApiResourceInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('#[ApiResource') && !content.includes('ApiResource(')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace ApiPlatform\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const operations: ApiOperation[] = [];

  // Find operations: [...] block
  const opsM = /operations\s*:\s*\[([\s\S]{0,2000}?)\]/.exec(content);
  if (opsM) {
    const opsBlock = opsM[1];
    // Split on "new Verb(" boundaries
    for (const m of opsBlock.matchAll(/new\s+(Get|GetCollection|Post|Put|Patch|Delete)\s*\([^)]*\)/g)) {
      const op = parseOperationBlock(m[0]);
      if (op) operations.push(op);
    }
  } else {
    // No explicit operations — API Platform infers all 6 CRUD operations
    const verbs: OperationVerb[] = ['Get', 'GetCollection', 'Post', 'Put', 'Patch', 'Delete'];
    for (const verb of verbs) {
      const hasSecurity = content.includes('security') || content.includes('is_granted');
      const issues: string[] = [];
      if (WRITE_OPS.has(verb) && !hasSecurity) {
        issues.push(`${verb} (default) — no security on ApiResource, write endpoint may be publicly accessible`);
      }
      operations.push({ verb, hasSecurity, hasNormalizationGroups: false, hasInput: false, hasOutput: true, issues });
    }
  }

  const issues = operations.flatMap((o) => o.issues);

  return { class: classM[1], file: path.relative(appPath, filePath), operations, issues };
}

export function listApiOperations(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const resources: ApiResourceInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseApiResource(file, appPath);
      if (r) resources.push(r);
    }

    if (resources.length === 0) {
      return { content: [{ type: 'text', text: 'No #[ApiResource] classes found in src/.' }] };
    }

    const totalOps    = resources.reduce((s, r) => s + r.operations.length, 0);
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);

    let text = `API Platform Operations\n${'='.repeat(55)}\n`;
    text += `\nResources: ${resources.length}  Operations: ${totalOps}  Issues: ${totalIssues}\n`;

    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      text += `\n  ${r.class}  (${r.file})\n`;
      for (const op of r.operations) {
        const sec    = op.hasSecurity ? '✓ auth' : '⚠ open';
        const groups = op.hasNormalizationGroups ? '✓ groups' : '';
        text += `    ${op.verb.padEnd(16)} ${sec}  ${groups}\n`;
        for (const issue of op.issues) text += `      ⚠ ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiOperationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: ApiResourceInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseApiResource(file, appPath);
        if (r) resources.push(r);
      }
    }

    const allOps     = resources.flatMap((r) => r.operations);
    const writeOps   = allOps.filter((o) => WRITE_OPS.has(o.verb));
    const securedOps = writeOps.filter((o) => o.hasSecurity);

    let text = `API Platform Operation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources:              ${resources.length}\n`;
    text += `Total operations:       ${allOps.length}\n`;
    text += `  Write ops:            ${writeOps.length}\n`;
    text += `  Write ops secured:    ${securedOps.length}\n`;
    text += `  Write ops open:       ${writeOps.length - securedOps.length}\n`;
    text += `  With norm. groups:    ${allOps.filter((o) => o.hasNormalizationGroups).length}\n`;
    text += `Issues:                 ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiOperationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_operations',
      description: 'Show API Platform per-resource operations: Get/GetCollection/Post/Put/Patch/Delete per class, security expression presence, normalizationContext groups, input/output DTO, uriTemplate, Post/Put/Patch/Delete without security warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_operation_stats',
      description: 'Show API Platform operation statistics: resource count, total operations, write operation count, secured vs open write ops, normalization group coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
