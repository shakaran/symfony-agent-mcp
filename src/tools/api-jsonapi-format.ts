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

interface JsonApiFormatInfo {
  source: string;
  type: 'format' | 'content-type' | 'pagination' | 'structure' | 'error';
  pattern: string;
  issues: string[];
}

function buildApiJsonApiFormatInfos(appPath: string): JsonApiFormatInfo[] {
  const results: JsonApiFormatInfo[] = [];

  const apiPlatformConfig = path.join(appPath, 'config', 'packages', 'api_platform.yaml');
  if (fs.existsSync(apiPlatformConfig)) {
    let content = '';
    try { content = fs.readFileSync(apiPlatformConfig, 'utf-8'); } catch { /* skip */ }

    const hasFormats = content.includes('formats:');
    const hasJsonApi = content.includes('jsonapi');

    if (hasFormats && hasJsonApi) {
      results.push({
        source: 'config/packages/api_platform.yaml',
        type: 'format',
        pattern: 'jsonapi format configured',
        issues: [],
      });
    } else {
      results.push({
        source: 'config/packages/api_platform.yaml',
        type: 'format',
        pattern: 'jsonapi format not configured',
        issues: [
          "JSON:API format not configured in api_platform.yaml — add formats: { jsonapi: ['application/vnd.api+json'] } to enable JSON:API",
        ],
      });
    }

    if (content.includes('pagination') && content.includes('page')) {
      results.push({
        source: 'config/packages/api_platform.yaml',
        type: 'pagination',
        pattern: 'page-based pagination',
        issues: [],
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            const content = safeRead(full, appPath);
            if (content === null) return;

            const relFile = path.relative(appPath, full);

            if (content.includes('paginationType') || content.includes('pagination_type')) {
              results.push({
                source: relFile,
                type: 'pagination',
                pattern: 'custom pagination type configured',
                issues: [],
              });
            }

            if (
              (content.includes('JsonResponse') || content.includes('new Response')) &&
              content.includes('application/json') &&
              !content.includes('application/vnd.api+json')
            ) {
              results.push({
                source: relFile,
                type: 'content-type',
                pattern: 'JSON response without JSON:API content type',
                issues: [
                  "JSON:API response without correct Content-Type — must use 'application/vnd.api+json' not 'application/json'",
                ],
              });
            }

            if (
              content.includes('JsonResponse') &&
              (content.includes('error') || content.includes('Error')) &&
              !content.includes('"errors"') &&
              !content.includes("'errors'")
            ) {
              results.push({
                source: relFile,
                type: 'error',
                pattern: 'error response without JSON:API structure',
                issues: [
                  'Error response without JSON:API structure — JSON:API errors must have {errors: [{title, status, detail}]} structure',
                ],
              });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listApiJsonApiFormat(appPath: string): McpToolResult {
  try {
    const infos = buildApiJsonApiFormatInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No JSON:API format patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `JSON:API Format Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiJsonApiFormatStats(appPath: string): McpToolResult {
  try {
    const infos = buildApiJsonApiFormatInfos(appPath);
    let text = `JSON:API Format Statistics\n${'='.repeat(40)}\n\n`;
    text += `Format:       ${infos.filter((i) => i.type === 'format').length}\n`;
    text += `Content-type: ${infos.filter((i) => i.type === 'content-type').length}\n`;
    text += `Pagination:   ${infos.filter((i) => i.type === 'pagination').length}\n`;
    text += `Structure:    ${infos.filter((i) => i.type === 'structure').length}\n`;
    text += `Error:        ${infos.filter((i) => i.type === 'error').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiJsonApiFormatTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_jsonapi_format', description: 'Analyze JSON:API format compliance; warns on missing jsonapi format configuration, wrong content-type headers, error responses without JSON:API structure', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_jsonapi_format_stats', description: 'Statistics for JSON:API format: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
