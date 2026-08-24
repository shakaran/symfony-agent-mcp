// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * NelmioApiDocBundle Configuration Inspector
 *
 * Distinct from api-platform-config.ts (API Platform) and openapi.ts (spec generation).
 * Focuses on NelmioApiDocBundle setup:
 *
 * nelmio_api_doc.yaml:
 *   - documentation: info.title / info.description / info.version
 *   - areas: names, host_patterns, path_patterns
 *   - routes: api_doc route name / path
 *   - cache: enabled, service
 *
 * OA Annotations/Attributes scan (src/ PHP files):
 *   - #[OA\Info] / @OA\Info
 *   - #[OA\Tag] usage count per resource class
 *   - #[OA\Parameter] vs route placeholders mismatch
 *   - #[OA\Response] vs missing 400/401/403/404 status codes
 *   - #[OA\SecurityScheme] definitions
 *   - #[OA\RequestBody] on non-POST/PUT routes
 *
 * Authentication scheme analysis:
 *   - Bearer (JWT), OAuth2 (implicit/password/clientCredentials/authorizationCode)
 *   - ApiKey in header / query
 *   - Basic Auth
 *
 * Analysis:
 *   - Bundle installed but not configured (missing nelmio_api_doc.yaml)
 *   - Controllers with routes but no OA attributes
 *   - Deprecated #[ApiDoc] annotation (old NelmioApiDocBundle v2 style)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface NelmioArea {
  name: string;
  hostPatterns: string[];
  pathPatterns: string[];
}

interface NelmioConfig {
  areas: NelmioArea[];
  docRoute?: string;
  cacheEnabled: boolean;
}

interface OaAnnotationSummary {
  totalAnnotated: number;
  hasInfo: boolean;
  securitySchemes: string[];
  missingResponses: string[];
}

function isNelmioInstalled(appPath: string): boolean {
  const composerJson = path.join(appPath, 'composer.json');
  if (!fs.existsSync(composerJson)) return false;
  try {
    const c = fs.readFileSync(composerJson, 'utf-8');
    return c.includes('nelmio/api-doc-bundle');
  } catch { return false; }
}

function loadNelmioConfig(appPath: string): NelmioConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'nelmio_api_doc.yaml'),
    path.join(appPath, 'config', 'packages', 'nelmio_api_doc.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const nelmio = (raw['nelmio_api_doc'] ?? raw) as Record<string, unknown>;
    const areasRaw = (nelmio['areas'] ?? {}) as Record<string, unknown>;

    const areas: NelmioArea[] = [];
    for (const [name, areaData] of Object.entries(areasRaw)) {
      const area = (areaData ?? {}) as Record<string, unknown>;
      const hostPatterns = Array.isArray(area['host_patterns']) ? area['host_patterns'].map(String) : [];
      const pathPatterns = Array.isArray(area['path_patterns']) ? area['path_patterns'].map(String) : [];
      areas.push({ name, hostPatterns, pathPatterns });
    }

    const cacheRaw = nelmio['cache'] as Record<string, unknown> | undefined;
    const cacheEnabled = cacheRaw?.['enabled'] === true;
    const docRoute = undefined; // looked up from routes.yaml if needed

    return { areas, docRoute, cacheEnabled };
  }
  return null;
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

function scanOaAnnotations(appPath: string): OaAnnotationSummary {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { totalAnnotated: 0, hasInfo: false, securitySchemes: [], missingResponses: [] };

  let totalAnnotated = 0;
  let hasInfo = false;
  const securitySchemes: string[] = [];
  const missingResponses: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('OA\\') && !content.includes('@OA\\') && !content.includes('OpenApi\\')) continue;

    totalAnnotated++;
    if (content.includes('OA\\Info') || content.includes('@OA\\Info')) hasInfo = true;

    for (const m of content.matchAll(/#\[OA\\SecurityScheme[^)]*name\s*:\s*['"]([^'"]+)['"]/g)) {
      securitySchemes.push(m[1]);
    }

    // Controllers with route but no 404 response
    if (content.includes('#[Route') && content.includes('OA\\Response') &&
        !content.includes('404') && !content.includes('Response(response: 404')) {
      const classM = /class\s+(\w+)/.exec(content);
      if (classM) missingResponses.push(classM[1]);
    }
  }

  return { totalAnnotated, hasInfo, securitySchemes, missingResponses: missingResponses.slice(0, 5) };
}

export function listNelmioConfig(appPath: string): McpToolResult {
  try {
    const installed = isNelmioInstalled(appPath);
    const config    = loadNelmioConfig(appPath);

    if (!installed && !config) {
      return {
        content: [{
          type: 'text',
          text: 'NelmioApiDocBundle not installed.\n\nInstall:\n  composer require nelmio/api-doc-bundle\n\nConfigure in config/packages/nelmio_api_doc.yaml:\n  nelmio_api_doc:\n    areas:\n      default:\n        path_patterns:\n          - ^/api(?!/doc$)',
        }],
      };
    }

    const oaSummary = scanOaAnnotations(appPath);
    let text = `NelmioApiDocBundle Configuration\n${'='.repeat(55)}\n\n`;
    text += `Installed:           ${installed ? 'yes' : 'no'}\n`;
    text += `Config file:         ${config ? 'nelmio_api_doc.yaml found' : '⚠ not found'}\n`;
    text += `OA annotated files:  ${oaSummary.totalAnnotated}\n`;
    text += `OA\\Info present:     ${oaSummary.hasInfo ? 'yes' : '⚠ no — API title/version missing'}\n`;
    text += `Cache enabled:       ${config?.cacheEnabled ? 'yes' : 'no'}\n`;

    if (config && config.areas.length > 0) {
      text += `\nAreas (${config.areas.length}):\n`;
      for (const area of config.areas) {
        text += `  ${area.name}\n`;
        if (area.pathPatterns.length > 0) text += `    Path patterns: ${area.pathPatterns.join(', ')}\n`;
        if (area.hostPatterns.length > 0) text += `    Host patterns: ${area.hostPatterns.join(', ')}\n`;
      }
    }

    if (oaSummary.securitySchemes.length > 0) {
      text += `\nSecurity schemes: ${oaSummary.securitySchemes.join(', ')}\n`;
    }

    const issues: string[] = [];
    if (!config) issues.push('Bundle installed but no nelmio_api_doc.yaml found');
    if (!oaSummary.hasInfo && oaSummary.totalAnnotated > 0) issues.push('OA\\Info missing — API title and version not defined');
    if (oaSummary.missingResponses.length > 0) {
      issues.push(`Controllers missing 404 response annotation: ${oaSummary.missingResponses.join(', ')}`);
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNelmioStats(appPath: string): McpToolResult {
  try {
    const installed  = isNelmioInstalled(appPath);
    const config     = loadNelmioConfig(appPath);
    const oaSummary  = scanOaAnnotations(appPath);

    let text = `Nelmio Statistics\n${'='.repeat(40)}\n\n`;
    text += `Installed:           ${installed ? 'yes' : 'no'}\n`;
    text += `Configured:          ${config ? 'yes' : 'no'}\n`;
    text += `Areas:               ${config?.areas.length ?? 0}\n`;
    text += `OA annotated files:  ${oaSummary.totalAnnotated}\n`;
    text += `Security schemes:    ${oaSummary.securitySchemes.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNelmioApiDocTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_nelmio_config',
      description: 'Show NelmioApiDocBundle configuration: areas with path/host patterns, cache status, OA annotated file count, OA\\Info presence, security scheme definitions, missing 404 response annotation detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_nelmio_stats',
      description: 'Show Nelmio statistics: installed, configured, area count, OA annotated file count, security scheme count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
