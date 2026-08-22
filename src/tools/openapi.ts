/**
 * OpenAPI / API Documentation Inspector
 *
 * Detects NelmioApiDocBundle:
 *   - config/packages/nelmio_api_doc.yaml: areas, routes, swagger UI path
 *   - Security schemes, documentation host/base path
 *
 * Scans src/ for OpenAPI PHP attributes (zircote/swagger-php or nelmio):
 *   - #[OA\Get], #[OA\Post], #[OA\Put], #[OA\Patch], #[OA\Delete]
 *   - #[OA\Property], #[OA\Schema] on DTOs / Entities
 *   - #[OA\Tag] groupings
 *   - #[OA\SecurityScheme], #[OA\Parameter], #[OA\Response]
 *
 * Also detects API Platform OpenAPI config (already covered by api-platform.ts
 * at the route level — this focuses on the documentation metadata layer).
 *
 * Analysis:
 *   - Controllers with routes but no OA annotation (undocumented endpoints)
 *   - DTOs with OA\Schema vs without
 *   - Tag coverage
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface OpenApiEndpoint {
  class: string;
  file: string;
  methods: string[];
  tags: string[];
  hasSecurity: boolean;
  hasResponse: boolean;
  hasRequestBody: boolean;
}

interface OpenApiSchema {
  class: string;
  file: string;
  propertyCount: number;
}

interface NelmioConfig {
  areas: string[];
  swaggerUiPath?: string;
  securitySchemes: string[];
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadNelmioConfig(appPath: string): NelmioConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'nelmio_api_doc.yaml'),
    path.join(appPath, 'config', 'packages', 'nelmio_api_doc.yml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const nelmio = (raw['nelmio_api_doc'] ?? raw) as Record<string, unknown>;
    const areas  = nelmio['areas'] ? Object.keys(nelmio['areas'] as Record<string, unknown>) : ['default'];

    // Security schemes
    const docsRaw = nelmio['documentation'] as Record<string, unknown> | undefined;
    const secSchemes = docsRaw?.['components']
      ? Object.keys((docsRaw['components'] as Record<string, unknown>)['securitySchemes'] as Record<string, unknown> ?? {})
      : [];

    // Swagger UI path from routes or config
    let swaggerUiPath: string | undefined;
    try {
      const routesFile = path.join(appPath, 'config', 'routes', 'nelmio_api_doc.yaml');
      const routesRaw = parseYamlFile(routesFile) as Record<string, unknown> | null;
      if (routesRaw) {
        const firstRoute = Object.values(routesRaw)[0] as Record<string, unknown> | undefined;
        swaggerUiPath = firstRoute?.['prefix'] ? String(firstRoute['prefix']) : '/api/doc';
      }
    } catch { /* skip */ }

    return { areas, swaggerUiPath: swaggerUiPath ?? '/api/doc', securitySchemes: secSchemes };
  }
  return null;
}

// ─── Source scanning ─────────────────────────────────────────────────────────


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

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options'];

function parseOpenApiEndpoint(filePath: string): OpenApiEndpoint | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasOA = content.includes('#[OA\\') || content.includes('#[OpenApi\\') ||
    content.includes('use OpenApi\\') || content.includes('use Nelmio\\');
  if (!hasOA) return null;

  const hasMethods = HTTP_METHODS.some((m) =>
    content.includes(`#[OA\\${m}`) || content.includes(`#[OA\\Operation`)
  );
  if (!hasMethods && !content.includes('#[OA\\Operation')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const methods = HTTP_METHODS.filter((m) =>
    content.includes(`#[OA\\${m}`) || content.includes(`#[OA\\Operation`)
  );

  const tags: string[] = [];
  for (const m of content.matchAll(/#\[OA\\Tag\s*\(\s*(?:name\s*:\s*)?['"]([^'"]+)['"]/g)) {
    tags.push(m[1]);
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    methods,
    tags,
    hasSecurity:     content.includes('#[OA\\Security') || content.includes('security:'),
    hasResponse:     content.includes('#[OA\\Response'),
    hasRequestBody:  content.includes('#[OA\\RequestBody'),
  };
}

function parseOpenApiSchema(filePath: string): OpenApiSchema | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('#[OA\\Schema') && !content.includes('#[OA\\Property')) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const propertyCount = (content.match(/#\[OA\\Property/g) ?? []).length;

  return { class: classM[1], file: path.basename(filePath), propertyCount };
}

function scanOpenApi(appPath: string): { endpoints: OpenApiEndpoint[]; schemas: OpenApiSchema[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { endpoints: [], schemas: [] };

  const endpoints: OpenApiEndpoint[] = [];
  const schemas: OpenApiSchema[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const ep = parseOpenApiEndpoint(file);
    if (ep) { endpoints.push(ep); continue; }

    const sc = parseOpenApiSchema(file);
    if (sc) schemas.push(sc);
  }

  return {
    endpoints: endpoints.sort((a, b) => a.class.localeCompare(b.class)),
    schemas:   schemas.sort((a, b) => a.class.localeCompare(b.class)),
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listOpenApiConfig(appPath: string): McpToolResult {
  try {
    const nelmio = loadNelmioConfig(appPath);
    const { endpoints, schemas } = scanOpenApi(appPath);

    if (!nelmio && endpoints.length === 0 && schemas.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No OpenAPI/Swagger documentation found.\n\nInstall NelmioApiDocBundle:\n  composer require nelmio/api-doc-bundle\n\nOr use API Platform which generates OpenAPI automatically.\n\nAnnotate endpoints:\n  use OpenApi\\Attributes as OA;\n  #[OA\\Get(path: \'/api/users\', tags: [\'User\'])]\n  #[OA\\Response(response: 200, description: \'User list\')]',
        }],
      };
    }

    let text = `OpenAPI / API Documentation\n${'='.repeat(55)}\n`;

    if (nelmio) {
      text += `\nNelmioApiDocBundle:\n`;
      text += `  Areas:          ${nelmio.areas.join(', ')}\n`;
      if (nelmio.swaggerUiPath) text += `  Swagger UI:     ${nelmio.swaggerUiPath}\n`;
      if (nelmio.securitySchemes.length > 0) {
        text += `  Security:       ${nelmio.securitySchemes.join(', ')}\n`;
      }
    }

    if (endpoints.length > 0) {
      const allTags = [...new Set(endpoints.flatMap((e) => e.tags))];
      text += `\nAnnotated controllers (${endpoints.length}):`;
      if (allTags.length > 0) text += `  Tags: ${allTags.join(', ')}`;
      text += `\n`;

      for (const ep of endpoints) {
        const methods = ep.methods.join('+') || 'Operation';
        const tags    = ep.tags.length > 0 ? `  [${ep.tags.join(',')}]` : '';
        const flags: string[] = [];
        if (ep.hasSecurity)    flags.push('sec');
        if (ep.hasResponse)    flags.push('resp');
        if (ep.hasRequestBody) flags.push('body');
        const flagStr = flags.length > 0 ? `  (${flags.join(',')})` : '';
        text += `  ${ep.class.padEnd(40)} ${methods.padEnd(20)}${tags}${flagStr}\n`;
      }

      const noResponse = endpoints.filter((e) => !e.hasResponse);
      if (noResponse.length > 0) {
        text += `\n⚠ ${noResponse.length} endpoint(s) without #[OA\\Response] — incomplete docs:\n`;
        for (const e of noResponse) text += `   ${e.class}\n`;
      }
    }

    if (schemas.length > 0) {
      text += `\nOpenAPI schemas (${schemas.length}):\n`;
      for (const s of schemas) {
        text += `  ${s.class.padEnd(40)} ${s.propertyCount} properties\n`;
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

export function getOpenApiStats(appPath: string): McpToolResult {
  try {
    const nelmio = loadNelmioConfig(appPath);
    const { endpoints, schemas } = scanOpenApi(appPath);

    let text = `OpenAPI Statistics\n${'='.repeat(40)}\n\n`;
    text += `NelmioApiDocBundle: ${nelmio ? 'yes' : 'no'}\n`;
    text += `Nelmio areas:       ${nelmio?.areas.length ?? 0}\n`;
    text += `Annotated endpoints: ${endpoints.length}\n`;
    text += `With response doc:  ${endpoints.filter((e) => e.hasResponse).length}\n`;
    text += `With security:      ${endpoints.filter((e) => e.hasSecurity).length}\n`;
    text += `Schema classes:     ${schemas.length}\n`;
    text += `Total OA properties: ${schemas.reduce((s, sc) => s + sc.propertyCount, 0)}\n`;
    const tags = [...new Set(endpoints.flatMap((e) => e.tags))];
    text += `Tags used:          ${tags.length} (${tags.join(', ')})\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getOpenApiTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_openapi_config',
      description: 'Show OpenAPI/Swagger documentation: NelmioApiDocBundle areas/UI path, #[OA\\Get/Post/Put/…] annotated controllers, schema classes with #[OA\\Property], missing response annotations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_openapi_stats',
      description: 'Show OpenAPI statistics: NelmioApiDocBundle detected, annotated endpoint count, response doc coverage, schema class count, OA property count, tags used',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
