import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SubresourceInfo {
  file: string;
  class: string;
  subresources: Array<{ uriTemplate: string; property?: string; resource?: string }>;
  hasStateProvider: boolean;
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

function parseSubresources(filePath: string, appPath: string): SubresourceInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('ApiResource') && !content.includes('ApiSubresource')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const subresources: Array<{ uriTemplate: string; property?: string; resource?: string }> = [];
  // Detect uriTemplate with path variables indicating subresource pattern
  const uriRe = /uriTemplate\s*:\s*['"]([^'"]{1,200})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = uriRe.exec(content)) !== null) {
    const tmpl = m[1];
    if ((tmpl.match(/\{/g) ?? []).length >= 2) {
      subresources.push({ uriTemplate: tmpl });
    }
  }
  // Detect deprecated @ApiSubresource
  const legacyRe = /@ApiSubresource/g;
  while ((legacyRe.exec(content)) !== null) {
    subresources.push({ uriTemplate: '(legacy @ApiSubresource)' });
  }
  if (subresources.length === 0) return null;
  const hasStateProvider = content.includes('provider:') || content.includes('StateProvider') || content.includes('ProviderInterface');
  const issues: string[] = [];
  for (const s of subresources) {
    if (s.uriTemplate.includes('@ApiSubresource')) issues.push('@ApiSubresource is deprecated — migrate to uriTemplate with embedded path variables');
    if (!hasStateProvider) issues.push(`Subresource "${s.uriTemplate}" without custom state provider — ensure default provider handles nested resource resolution`);
  }
  return { file: path.relative(appPath, filePath), class: classM[1], subresources, hasStateProvider, issues };
}

export function listApiSubresources(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const resources: SubresourceInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseSubresources(f, appPath);
      if (r) resources.push(r);
    }
    if (resources.length === 0) return { content: [{ type: 'text', text: 'No API Platform subresources found.\n\nExample:\n  #[ApiResource(\n    operations: [\n      new GetCollection(uriTemplate: \'/users/{userId}/posts.{_format}\')\n    ]\n  )]' }] };
    const totalIssues = resources.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform Subresources\n${'='.repeat(55)}\n\nResources with subresources: ${resources.length}  Issues: ${totalIssues}\n`;
    for (const r of resources.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  provider: ${r.hasStateProvider ? 'yes' : 'no'}  (${r.file})\n`;
      for (const s of r.subresources) text += `    uriTemplate: ${s.uriTemplate}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiSubresourceStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const resources: SubresourceInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseSubresources(f, appPath);
        if (r) resources.push(r);
      }
    }
    let text = `API Platform Subresource Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources with subresources: ${resources.length}\nTotal subresource endpoints: ${resources.reduce((s, r) => s + r.subresources.length, 0)}\nWith state provider: ${resources.filter(r => r.hasStateProvider).length}\nIssues: ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiSubresourceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_subresources', description: 'Detect API Platform subresources via multi-variable uriTemplate patterns and deprecated @ApiSubresource, state provider coverage, legacy annotation migration warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_subresource_stats', description: 'API Platform subresource statistics: resource count, endpoint count, provider coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
