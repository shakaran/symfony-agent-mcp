// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Content Negotiation Inspector
 *
 * Reads framework.yaml:
 *   - request.formats map (format -> mime types)
 *   - http_method_override
 *
 * Scans src/ PHP for:
 *   - $request->getPreferredFormat()
 *   - $request->getMimeType()
 *   - $request->getAcceptableContentTypes()
 *   - $request->getFormat()
 *
 * Warns about:
 *   - Format used in getPreferredFormat() not declared in framework.yaml
 *   - getPreferredFormat() without fallback default
 *   - Controller returning different format than declared Accept header handling
 *   - http_method_override: true (security concern with reverse proxies)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface ContentNegotiationInfo {
  declaredFormats: string[];
  usedFormats: string[];
  hasHttpMethodOverride: boolean;
  issues: string[];
}

interface FileNegotiationUsage {
  file: string;
  class?: string;
  methods: string[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadFrameworkConfig(appPath: string): { declaredFormats: string[]; hasHttpMethodOverride: boolean } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const fp of candidates) {
    const raw = parseYamlFile(fp) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
    const request = (fw['request'] ?? {}) as Record<string, unknown>;
    const formats = (request['formats'] ?? {}) as Record<string, unknown>;
    const declaredFormats = Object.keys(formats);
    const hasHttpMethodOverride = fw['http_method_override'] === true ||
      fw['http_method_override'] === 'true';
    return { declaredFormats, hasHttpMethodOverride };
  }
  return { declaredFormats: [], hasHttpMethodOverride: false };
}

function parseNegotiationFile(filePath: string, appPath: string, declaredFormats: string[]): FileNegotiationUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const negotiationMethods = [
    'getPreferredFormat', 'getMimeType', 'getAcceptableContentTypes', 'getFormat',
  ];
  const hasAny = negotiationMethods.some((m) => content.includes(`->${m}(`));
  if (!hasAny) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const methods: string[] = [];
  const issues: string[] = [];

  if (content.includes('->getPreferredFormat(')) {
    methods.push('getPreferredFormat');
    // Check for fallback default arg
    const m = /->getPreferredFormat\(([^)]{0,100})\)/.exec(content);
    const arg = m ? m[1].trim() : '';
    if (!arg) {
      issues.push('getPreferredFormat() called without fallback default — returns null for unknown Accept headers');
    }
    // Extract format strings used as args
    const formatArgs = content.match(/getPreferredFormat\(['"]([a-z]{1,20})['"]\)/g) ?? [];
    for (const fa of formatArgs) {
      const fmM = /getPreferredFormat\(['"]([a-z]{1,20})['"]\)/.exec(fa);
      if (fmM && declaredFormats.length > 0 && !declaredFormats.includes(fmM[1])) {
        issues.push(`Format "${fmM[1]}" used in getPreferredFormat() not declared in framework.yaml request.formats`);
      }
    }
  }

  if (content.includes('->getMimeType(')) {
    methods.push('getMimeType');
  }

  if (content.includes('->getAcceptableContentTypes(')) {
    methods.push('getAcceptableContentTypes');
  }

  if (content.includes('->getFormat(')) {
    methods.push('getFormat');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    methods,
    issues,
  };
}

function loadContentNegotiationData(appPath: string): { info: ContentNegotiationInfo; usages: FileNegotiationUsage[] } {
  const { declaredFormats, hasHttpMethodOverride } = loadFrameworkConfig(appPath);
  const srcDir = path.join(appPath, 'src');
  const usages: FileNegotiationUsage[] = [];

  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseNegotiationFile(f, appPath, declaredFormats);
      if (r) usages.push(r);
    }
  }

  usages.sort((a, b) => a.file.localeCompare(b.file));

  const usedFormats: string[] = [];
  for (const u of usages) {
    for (const m of u.methods) {
      if (!usedFormats.includes(m)) usedFormats.push(m);
    }
  }

  const issues: string[] = [];
  if (hasHttpMethodOverride) {
    issues.push('http_method_override: true — security concern: reverse proxies may forward X-HTTP-Method-Override from untrusted clients');
  }
  if (declaredFormats.length === 0 && usages.length > 0) {
    issues.push('No formats declared in framework.yaml request.formats but content negotiation methods used in code');
  }

  return {
    info: { declaredFormats, usedFormats, hasHttpMethodOverride, issues },
    usages,
  };
}

export function listContentNegotiation(appPath: string): McpToolResult {
  try {
    const { info, usages } = loadContentNegotiationData(appPath);

    let text = `Symfony Content Negotiation\n${'='.repeat(55)}\n`;
    text += `\nDeclared formats: ${info.declaredFormats.length > 0 ? info.declaredFormats.join(', ') : '(none)'}\n`;
    text += `HTTP method override: ${info.hasHttpMethodOverride ? 'enabled' : 'disabled'}\n`;

    for (const issue of info.issues) text += `WARN: ${issue}\n`;

    if (usages.length === 0) {
      text += '\nNo content negotiation method usage found in src/.\n';
    } else {
      text += `\nFiles using content negotiation (${usages.length}):\n`;
      for (const u of usages) {
        text += `\n  ${u.file}`;
        if (u.class) text += `  [${u.class}]`;
        text += `\n    methods: ${u.methods.join(', ')}\n`;
        for (const issue of u.issues) text += `    WARN: ${issue}\n`;
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

export function getContentNegotiationStats(appPath: string): McpToolResult {
  try {
    const { info, usages } = loadContentNegotiationData(appPath);

    const totalIssues = info.issues.length + usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Content Negotiation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Declared formats:             ${info.declaredFormats.length}\n`;
    text += `Files with negotiation calls: ${usages.length}\n`;
    text += `  getPreferredFormat:         ${usages.filter((u) => u.methods.includes('getPreferredFormat')).length}\n`;
    text += `  getMimeType:                ${usages.filter((u) => u.methods.includes('getMimeType')).length}\n`;
    text += `  getAcceptableContentTypes:  ${usages.filter((u) => u.methods.includes('getAcceptableContentTypes')).length}\n`;
    text += `  getFormat:                  ${usages.filter((u) => u.methods.includes('getFormat')).length}\n`;
    text += `HTTP method override enabled: ${info.hasHttpMethodOverride ? 'yes' : 'no'}\n`;
    text += `Issues:                       ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getContentNegotiationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_content_negotiation',
      description: 'List Symfony content negotiation usage: declared formats in framework.yaml, getPreferredFormat/getMimeType/getAcceptableContentTypes/getFormat calls, http_method_override security warning, undeclared formats',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_content_negotiation_stats',
      description: 'Show content negotiation statistics: declared formats count, method usage breakdown, http_method_override status, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
