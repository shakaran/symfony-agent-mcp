// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface IriConverterInfo {
  file: string;
  class: string;
  isCustomConverter: boolean;
  hasGetIriFromResource: boolean;
  hasGetResourceFromIri: boolean;
  usesUriTemplate: boolean;
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

function parseIriConverter(filePath: string, appPath: string): IriConverterInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isConverter = content.includes('IriConverterInterface') || content.includes('UrlGeneratorInterface') && content.includes('IriConverter');
  if (!isConverter) return null;
  if (content.includes('namespace ApiPlatform\\') || content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const isCustomConverter = content.includes('implements') && content.includes('IriConverterInterface');
  const hasGetIriFromResource = content.includes('getIriFromResource');
  const hasGetResourceFromIri = content.includes('getResourceFromIri');
  const usesUriTemplate = content.includes('uriTemplate') || content.includes('UriTemplate');
  const issues: string[] = [];
  if (isCustomConverter && !hasGetIriFromResource) issues.push('IriConverterInterface without getIriFromResource() — IRI generation will fail');
  if (isCustomConverter && !hasGetResourceFromIri) issues.push('IriConverterInterface without getResourceFromIri() — IRI resolution will fail');
  return { file: path.relative(appPath, filePath), class: classM[1], isCustomConverter, hasGetIriFromResource, hasGetResourceFromIri, usesUriTemplate, issues };
}

export function listApiIriConverter(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const converters: IriConverterInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const c = parseIriConverter(f, appPath);
      if (c) converters.push(c);
    }
    if (converters.length === 0) return { content: [{ type: 'text', text: 'No custom IRI converter found (using API Platform default IriConverter).' }] };
    const totalIssues = converters.reduce((s, c) => s + c.issues.length, 0);
    let text = `API Platform IRI Converter\n${'='.repeat(55)}\n\nConverters: ${converters.length}  Issues: ${totalIssues}\n`;
    for (const c of converters.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.class}  custom: ${c.isCustomConverter ? 'yes' : 'no'}  uriTemplate: ${c.usesUriTemplate ? 'yes' : 'no'}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiIriConverterStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const converters: IriConverterInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const c = parseIriConverter(f, appPath);
        if (c) converters.push(c);
      }
    }
    let text = `IRI Converter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom IRI converters: ${converters.filter(c => c.isCustomConverter).length}\nIRI converter usage (injection): ${converters.filter(c => !c.isCustomConverter).length}\nWith uriTemplate: ${converters.filter(c => c.usesUriTemplate).length}\nIssues: ${converters.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiIriConverterTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_iri_converter', description: 'Detect API Platform IriConverterInterface implementations: getIriFromResource/getResourceFromIri presence, uriTemplate usage, missing method warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_iri_converter_stats', description: 'API Platform IRI converter statistics: custom converter count, uriTemplate count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
