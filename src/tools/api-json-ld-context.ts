// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface JsonLdContextInfo {
  file: string;
  type: 'context' | 'type' | 'property' | 'vocab';
  term: string;
  uri: string;
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

function buildJsonLdInfos(appPath: string): JsonLdContextInfo[] {
  const results: JsonLdContextInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const hasJsonLd = content.includes("'@context'") || content.includes('"@context"') ||
        content.includes('JsonLdContextBuilder') || content.includes('ContextBuilderInterface');

      const hasApiResource = content.includes('#[ApiResource') || content.includes('@ApiResource');
      const hasApiProp = content.includes('#[ApiProperty') || content.includes('@ApiProperty');

      if (!hasJsonLd && !hasApiResource && !hasApiProp) continue;

      if (hasApiResource) {
        const typesMatch = /types\s*:\s*\[([^\]]{1,200})\]/.exec(content);
        const iriMatch = /iri\s*:\s*['"]([^'"]{1,200})['"]/.exec(content);
        const uri = typesMatch ? typesMatch[1].replace(/['",\s]/g, '') : iriMatch ? iriMatch[1] : '';

        if (!uri) {
          issues.push(`ApiResource without explicit IRI types — defaults to class name as type, not portable across refactors`);
        } else if (uri.startsWith('http://schema.org')) {
          issues.push(`ApiResource uses HTTP schema.org IRI (${uri}) — schema.org deprecated HTTP in favor of HTTPS`);
        }
        results.push({ file: relFile, type: 'type', term: 'ApiResource', uri, issues });
      }

      if (hasApiProp) {
        const iriMatch = /iri\s*:\s*['"]([^'"]{1,200})['"]/.exec(content);
        const uri = iriMatch ? iriMatch[1] : '';
        if (uri && uri.startsWith('http://schema.org')) {
          issues.push(`ApiProperty uses HTTP schema.org IRI — use HTTPS (https://schema.org/...)`);
          results.push({ file: relFile, type: 'property', term: 'ApiProperty', uri, issues });
        }
      }

      if (hasJsonLd) {
        const hasVocab = content.includes("'@vocab'") || content.includes('"@vocab"');
        if (!hasVocab) {
          issues.push('JSON-LD @context missing @vocab declaration — terms without explicit prefix are unresolvable');
        }
        results.push({ file: relFile, type: 'context', term: '@context', uri: '', issues });
      }
    }
  }

  const contextsDir = path.join(appPath, 'public', 'contexts');
  if (fs.existsSync(contextsDir)) {
    try {
      for (const entry of fs.readdirSync(contextsDir)) {
        if (!entry.endsWith('.jsonld') && !entry.endsWith('.json')) continue;
        const filePath = path.join(contextsDir, entry);
        let content = '';
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

        const issues: string[] = [];
        if (!content.includes('"@context"') && !content.includes("'@context'")) {
          issues.push(`Context file "${entry}" does not contain @context — not a valid JSON-LD context`);
        }
        results.push({ file: path.relative(appPath, filePath), type: 'vocab', term: entry, uri: '', issues });
      }
    } catch { /* ignore */ }
  }

  return results;
}

export function listApiJsonLdContext(appPath: string): McpToolResult {
  try {
    const infos = buildJsonLdInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No JSON-LD @context patterns found (no ApiResource with IRI types, @context declarations, or .jsonld files).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `JSON-LD Context Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.term}${info.uri ? `  uri: ${info.uri}` : ''}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiJsonLdContextStats(appPath: string): McpToolResult {
  try {
    const infos = buildJsonLdInfos(appPath);
    let text = `JSON-LD Statistics\n${'='.repeat(40)}\n\n`;
    text += `Contexts:   ${infos.filter((i) => i.type === 'context').length}\n`;
    text += `Types:      ${infos.filter((i) => i.type === 'type').length}\n`;
    text += `Properties: ${infos.filter((i) => i.type === 'property').length}\n`;
    text += `Vocab:      ${infos.filter((i) => i.type === 'vocab').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiJsonLdContextTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_json_ld_context', description: 'Detect JSON-LD @context patterns; warns on ApiResource without IRI types, HTTP schema.org IRIs (use HTTPS), missing @vocab, invalid .jsonld context files', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_json_ld_context_stats', description: 'Statistics for JSON-LD: context/type/property/vocab count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
