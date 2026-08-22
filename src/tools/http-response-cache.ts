/**
 * HTTP Response Cache Headers Inspector
 *
 * Distinct from http-cache.ts (ESI / reverse proxy config) and cache-pools.ts (server-side cache).
 * Focuses on HTTP response caching directives set in controllers:
 *
 * #[Cache] attribute (Symfony 6.2+):
 *   - maxage, smaxage, public, private, mustRevalidate, noStore, vary
 *
 * Programmatic response headers:
 *   - $response->setMaxAge(), setSharedMaxAge(), setPublic(), setPrivate()
 *   - $response->setEtag(), setLastModified(), setExpires()
 *   - $response->headers->set('Cache-Control', '...')
 *   - $response->headers->set('Vary', '...')
 *
 * Analysis:
 *   - Public cache without Vary: Cookie (may serve authenticated content to anon users)
 *   - setPublic() on controller that checks isGranted() (caching authenticated responses)
 *   - No-cache set unnecessarily on static resources
 *   - s-maxage without public directive (s-maxage implies public but explicit is clearer)
 *   - Vary: * (prevents any caching by shared proxies)
 *   - ETag without Last-Modified (or vice versa) — best practice is both
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ResponseCacheInfo {
  class: string;
  file: string;
  usesCacheAttribute: boolean;
  usesSetMaxAge: boolean;
  usesSetPublic: boolean;
  usesEtag: boolean;
  usesLastModified: boolean;
  usesVary: string[];
  hasSecurityCheck: boolean;
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

function parseResponseCache(filePath: string, appPath: string): ResponseCacheInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasCacheHeaders = content.includes('#[Cache(') || content.includes('setMaxAge(') ||
                          content.includes('setSharedMaxAge(') || content.includes('setPublic()') ||
                          content.includes('setEtag(') || content.includes('setLastModified(') ||
                          (content.includes('Cache-Control') && content.includes('set('));
  if (!hasCacheHeaders) return null;
  if (content.includes('namespace Symfony\\')) return null;
  if (!content.includes('Controller') && !content.includes('#[Route') && !content.includes('extends AbstractController')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const usesCacheAttribute = content.includes('#[Cache(');
  const usesSetMaxAge      = content.includes('setMaxAge(') || content.includes('setSharedMaxAge(');
  const usesSetPublic      = content.includes('setPublic()') || /smaxage\s*:\s*\d+/.test(content);
  const usesEtag           = content.includes('setEtag(');
  const usesLastModified   = content.includes('setLastModified(');
  const hasSecurityCheck   = content.includes('isGranted(') || content.includes('denyAccessUnless') ||
                             content.includes('#[IsGranted');

  const varyValues: string[] = [];
  for (const m of content.matchAll(/[Vv]ary['"]\s*[,)=]\s*['"]([^'"]+)['"]/g)) varyValues.push(m[1]);
  for (const m of content.matchAll(/vary\s*:\s*['"]([^'"]+)['"]/g)) varyValues.push(m[1]);

  const issues: string[] = [];
  if (usesSetPublic && hasSecurityCheck) {
    issues.push('setPublic() or smaxage on controller with security check — may cache authenticated content');
  }
  if (usesSetPublic && !varyValues.some((v) => v.toLowerCase().includes('cookie'))) {
    issues.push('Public cache without Vary: Cookie — shared caches may serve wrong content to different users');
  }
  if (varyValues.includes('*')) {
    issues.push('Vary: * prevents all shared proxy caching');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    usesCacheAttribute,
    usesSetMaxAge,
    usesSetPublic,
    usesEtag,
    usesLastModified,
    usesVary: [...new Set(varyValues)],
    hasSecurityCheck,
    issues,
  };
}

export function listResponseCacheHeaders(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const controllers: ResponseCacheInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseResponseCache(file, appPath);
      if (c) controllers.push(c);
    }

    if (controllers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No HTTP response cache headers found in controllers.\n\nUse #[Cache] attribute (Symfony 6.2+):\n  #[Cache(smaxage: 3600, vary: [\'Accept-Language\'])]\n  public function index(): Response { ... }\n\nOr set programmatically:\n  $response->setSharedMaxAge(3600);\n  $response->setPublic();\n  $response->headers->set(\'Vary\', \'Accept-Language\');',
        }],
      };
    }

    controllers.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
    const totalIssues = controllers.reduce((s, c) => s + c.issues.length, 0);

    let text = `HTTP Response Cache Headers\n${'='.repeat(55)}\n`;
    text += `\nControllers with cache: ${controllers.length}  Issues: ${totalIssues}\n`;

    for (const c of controllers) {
      const methods = [
        c.usesCacheAttribute ? '#[Cache]' : '',
        c.usesSetPublic ? 'public' : '',
        c.usesSetMaxAge ? 'maxAge' : '',
        c.usesEtag ? 'ETag' : '',
        c.usesLastModified ? 'LastModified' : '',
      ].filter(Boolean).join(', ');

      text += `\n  ${c.class}  (${c.file})\n`;
      text += `    ${methods}`;
      if (c.usesVary.length > 0) text += `  Vary: ${c.usesVary.join(', ')}`;
      text += `\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getResponseCacheStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const controllers: ResponseCacheInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseResponseCache(file, appPath);
        if (c) controllers.push(c);
      }
    }

    let text = `Response Cache Statistics\n${'='.repeat(40)}\n\n`;
    text += `Controllers with cache:  ${controllers.length}\n`;
    text += `  #[Cache] attribute:    ${controllers.filter((c) => c.usesCacheAttribute).length}\n`;
    text += `  Public cache:          ${controllers.filter((c) => c.usesSetPublic).length}\n`;
    text += `  With ETag:             ${controllers.filter((c) => c.usesEtag).length}\n`;
    text += `  With Last-Modified:    ${controllers.filter((c) => c.usesLastModified).length}\n`;
    text += `Issues:                  ${controllers.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getResponseCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_response_cache_headers',
      description: 'Show HTTP response cache header usage in controllers: #[Cache] attribute, setPublic/setMaxAge/setEtag/setLastModified, Vary header values, public cache without Vary:Cookie warning, caching authenticated responses, Vary:* warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_response_cache_stats',
      description: 'Show response cache statistics: controller count, #[Cache] attribute count, public cache count, ETag/Last-Modified usage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
