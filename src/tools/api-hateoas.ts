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

interface HateoasInfo {
  file: string;
  type: 'resource' | 'link' | 'collection' | 'config' | 'serializer';
  pattern: string;
  issues: string[];
}

function buildHateoasInfos(appPath: string): HateoasInfo[] {
  const results: HateoasInfo[] = [];

  let hasHateoas = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['willdurand/hateoas-bundle'] || req['api-platform/core'] || req['willdurand/hateoas']) hasHateoas = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          const content = safeRead(full, appPath);
          if (content === null) return;

          const isApiResource = content.includes('#[ApiResource') || content.includes('@ApiResource') || content.includes('ApiResource(');
          const isApiController = content.includes('JsonResponse') || content.includes('Response::HTTP_') || (content.includes('#[Route') && content.includes('methods:'));
          if (!isApiResource && !isApiController) return;

          const relFile = path.relative(appPath, full);
          const issues: string[] = [];

          if (isApiController && !isApiResource) {
            const hasLinks = content.includes('_links') || content.includes('links') || content.includes('Hateoas') || content.includes('href');
            if (!hasLinks) {
              issues.push(`API controller "${relFile}" returns data without hypermedia links (_links) — REST Level 3 (HATEOAS) adds navigable relations; add _links with self, related, and action URLs to enable API discoverability without out-of-band documentation`);
            }

            const returnsPagination = content.includes('findBy') || content.includes('getRepository') || content.includes('paginator') || content.includes('Paginator');
            if (returnsPagination) {
              const hasPaginationLinks = content.includes('prev') || content.includes('next') || content.includes('first') || content.includes('last') || content.includes('Link:');
              if (!hasPaginationLinks) {
                issues.push(`Collection endpoint in "${relFile}" without pagination links — add next/prev/first/last _links or Link header to enable clients to paginate without hardcoding URL patterns`);
              }
            }
          }

          if (isApiResource) {
            const hasGetOperation = content.includes('Get(') || content.includes('GetCollection(');
            const hasSelfLink = content.includes('selfLink') || content.includes('iri') || content.includes('self');
            if (hasGetOperation && !hasSelfLink && !hasHateoas) {
              issues.push(`API Platform resource "${relFile}" without explicit self link — API Platform generates IRIs automatically; verify links are included in serialization groups and not excluded by normalization context`);
            }
          }

          results.push({ file: relFile, type: 'resource', pattern: isApiResource ? 'API Platform resource' : 'API controller', issues });
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listApiHateoas(appPath: string): McpToolResult {
  try {
    const infos = buildHateoasInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No API HATEOAS patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API HATEOAS Analysis\n${'='.repeat(55)}\n\nResources: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiHateoasStats(appPath: string): McpToolResult {
  try {
    const infos = buildHateoasInfos(appPath);
    let text = `API HATEOAS Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources:   ${infos.filter((i) => i.type === 'resource').length}\n`;
    text += `Collections: ${infos.filter((i) => i.type === 'collection').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiHateoasTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_hateoas', description: 'Analyze API HATEOAS hypermedia link implementation; warns on API controllers without _links, collection endpoints without pagination links, API Platform resources without self link in serialization groups', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_hateoas_stats', description: 'Statistics for API HATEOAS: resource/collection count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
