import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ResourceMetadataInfo {
  class: string;
  file: string;
  shortName?: string;
  description?: string;
  iri?: string;
  types: string[];
  uriTemplate?: string;
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

function parseResourceMetadata(filePath: string, appPath: string): ResourceMetadataInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  if (!content.includes('ApiResource')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const apiResBlock = /#\[ApiResource\s*\([^)]{0,800}\)/.exec(content);
  if (!apiResBlock) return null;
  const block = apiResBlock[0];
  const shortNameM = /shortName\s*:\s*['"]([^'"]{0,100})['"]/i.exec(block);
  const descriptionM = /description\s*:\s*['"]([^'"]{0,200})['"]/i.exec(block);
  const iriM = /iri\s*:\s*['"]([^'"]{0,200})['"]/i.exec(block);
  const typePattern = /types\s*:\s*\[([^\]]{0,400})\]/i.exec(block);
  const types: string[] = typePattern ? typePattern[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  const uriM = /uriTemplate\s*:\s*['"]([^'"]{0,200})['"]/i.exec(block);
  const issues: string[] = [];
  if (!descriptionM) issues.push('No description — API documentation will be empty; add description for better DX');
  if (!shortNameM && classM[1].endsWith('Resource')) issues.push('Class name ends with "Resource" — define shortName to control the JSON-LD @type and API path');
  if (types.some((t) => !t.startsWith('https://') && !t.startsWith('http://') && !t.startsWith('schema:') && !t.startsWith('owl:'))) {
    issues.push('types include non-prefixed IRI — use full URL or prefix (schema:, owl:) for JSON-LD compliance');
  }
  return { class: classM[1], file: path.relative(appPath, filePath), shortName: shortNameM?.[1], description: descriptionM?.[1], iri: iriM?.[1], types, uriTemplate: uriM?.[1], issues };
}

export function listApiPlatformResourceMetadata(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const resources: ResourceMetadataInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseResourceMetadata(file, appPath);
      if (r) resources.push(r);
    }
    if (resources.length === 0) return { content: [{ type: 'text', text: 'No #[ApiResource] found.' }] };
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform Resource Metadata\n${'='.repeat(55)}\n\nResources: ${resources.length}  Issues: ${totalIssues}\n`;
    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length)) {
      const sn = r.shortName ? `  shortName: ${r.shortName}` : '  no shortName';
      const desc = r.description ? `  ✓ description` : '  ⚠ no description';
      const typeStr = r.types.length > 0 ? `  types: ${r.types.join(',')}` : '';
      text += `\n  ${r.class}${sn}${desc}${typeStr}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformResourceMetadataStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: ResourceMetadataInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourceMetadata(file, appPath);
        if (r) resources.push(r);
      }
    }
    let text = `API Platform Resource Metadata Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources: ${resources.length}\n  With shortName: ${resources.filter((r) => !!r.shortName).length}\n  With description: ${resources.filter((r) => !!r.description).length}\n  With JSON-LD types: ${resources.filter((r) => r.types.length > 0).length}\nIssues: ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiPlatformResourceMetadataTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_resource_metadata', description: 'Show API Platform resource metadata: shortName, description, iri, JSON-LD types, uriTemplate, missing description warning, non-prefixed type IRI warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_resource_metadata_stats', description: 'Show API Platform resource metadata statistics: resource count, shortName/description/types adoption, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
