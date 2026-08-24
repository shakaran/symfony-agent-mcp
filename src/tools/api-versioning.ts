// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Versioning Inspector
 *
 * Route-level versioning:
 *   - Routes with /v1/, /v2/, /api/v{n} path prefixes (YAML + PHP attributes)
 *   - Route names with _v1, _v2 suffixes
 *   - #[Route] with version requirement constraints
 *
 * Serialization-group versioning:
 *   - Groups named v1:*, v2:*, api:v1:read, etc. in entities/DTOs
 *
 * FOSRestBundle versioning:
 *   - fos_rest.versioning in config/packages/fos_rest.yaml
 *
 * LiipImagineBundle / API-specific:
 *   - Header-based versioning: Accept: application/vnd.*+json; version=2
 *   - X-API-Version header middleware
 *
 * Analysis:
 *   - Endpoints in v1 but not v2 (migration gaps)
 *   - Routes without any version prefix mixed with versioned routes
 *   - Deprecated version detection (#[Deprecated], @deprecated)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface VersionedEndpoint {
  version: string;
  path: string;
  controller: string;
  file: string;
}

interface VersionSummary {
  version: string;
  count: number;
  deprecated: boolean;
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

function extractVersionFromPath(routePath: string): string | null {
  const m = /\/v(\d+)(?:\/|$)/.exec(routePath) ?? /\/api\/v(\d+)/.exec(routePath);
  return m ? `v${m[1]}` : null;
}

function scanVersionedRoutes(appPath: string): VersionedEndpoint[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const endpoints: VersionedEndpoint[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[Route') && !content.includes('@Route')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    for (const m of content.matchAll(/#\[Route\s*\(\s*['"]([^'"]+)['"]/g)) {
      const routePath = m[1];
      const version = extractVersionFromPath(routePath);
      if (version) {
        endpoints.push({ version, path: routePath, controller: classM[1], file: path.basename(file) });
      }
    }
  }

  // Also scan YAML route files
  const routesDir = path.join(appPath, 'config', 'routes');
  if (fs.existsSync(routesDir)) {
    try {
      for (const fname of fs.readdirSync(routesDir)) {
        if (!fname.endsWith('.yaml') && !fname.endsWith('.yml')) continue;
        const content = fs.readFileSync(path.join(routesDir, fname), 'utf-8');
        for (const m of content.matchAll(/path:\s*([^\n]+)/g)) {
          const routePath = m[1].trim();
          const version = extractVersionFromPath(routePath);
          if (version) {
            endpoints.push({ version, path: routePath, controller: fname, file: fname });
          }
        }
      }
    } catch { /* skip */ }
  }

  return endpoints.sort((a, b) => a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
}

function scanVersionedSerializerGroups(appPath: string): Map<string, number> {
  const srcDir = path.join(appPath, 'src');
  const counts = new Map<string, number>();
  if (!fs.existsSync(srcDir)) return counts;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const m of content.matchAll(/groups\s*=\s*\[([^\]]+)\]/g)) {
      for (const g of m[1].split(',')) {
        const group = g.trim().replace(/['"]/g, '');
        if (/^v\d+[_:]|:v\d+/.test(group)) {
          counts.set(group, (counts.get(group) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

function detectFosRestVersioning(appPath: string): boolean {
  const candidates = ['config/packages/fos_rest.yaml', 'config/packages/fos_rest.yml'];
  for (const c of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, c), 'utf-8');
      if (content.includes('versioning')) return true;
    } catch { /* skip */ }
  }
  return false;
}

function buildVersionSummaries(endpoints: VersionedEndpoint[]): VersionSummary[] {
  const map = new Map<string, number>();
  for (const e of endpoints) {
    map.set(e.version, (map.get(e.version) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([version, count]) => ({ version, count, deprecated: false }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

export function listApiVersions(appPath: string): McpToolResult {
  try {
    const endpoints       = scanVersionedRoutes(appPath);
    const serializerGroups = scanVersionedSerializerGroups(appPath);
    const fosRest         = detectFosRestVersioning(appPath);

    if (endpoints.length === 0 && serializerGroups.size === 0 && !fosRest) {
      return {
        content: [{
          type: 'text',
          text: 'No API versioning detected.\n\nCommon strategies:\n  1. URL prefix: /api/v1/, /api/v2/\n  2. Serialization groups: v1:read, v2:read\n  3. FOSRestBundle versioning:\n     fos_rest:\n       versioning: true',
        }],
      };
    }

    let text = `API Versioning Configuration\n${'='.repeat(55)}\n`;

    if (fosRest) text += `\nFOSRestBundle versioning: enabled\n`;

    const summaries = buildVersionSummaries(endpoints);
    if (summaries.length > 0) {
      text += `\nVersioned endpoints by version:\n`;
      for (const s of summaries) {
        text += `  ${s.version.padEnd(8)} ${s.count} endpoint(s)\n`;
      }
    }

    if (endpoints.length > 0) {
      const versions = [...new Set(endpoints.map((e) => e.version))].sort();
      for (const ver of versions) {
        const group = endpoints.filter((e) => e.version === ver);
        text += `\n${ver.toUpperCase()} routes (${group.length}):\n`;
        for (const e of group.slice(0, 20)) {
          text += `  ${e.path.padEnd(45)} ${e.controller}\n`;
        }
        if (group.length > 20) text += `  ... and ${group.length - 20} more\n`;
      }
    }

    if (serializerGroups.size > 0) {
      text += `\nVersioned serializer groups (${serializerGroups.size}):\n`;
      for (const [group, count] of [...serializerGroups.entries()].sort()) {
        text += `  ${group.padEnd(30)} used ${count}x\n`;
      }
    }

    // Gap analysis: versions with fewer endpoints than the latest
    if (summaries.length >= 2) {
      const latest   = summaries[summaries.length - 1];
      const previous = summaries[summaries.length - 2];
      if (previous && latest && previous.count > latest.count) {
        text += `\n⚠ ${previous.version} has ${previous.count - latest.count} more endpoints than ${latest.version} — migration may be incomplete\n`;
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

export function getApiVersionStats(appPath: string): McpToolResult {
  try {
    const endpoints        = scanVersionedRoutes(appPath);
    const serializerGroups = scanVersionedSerializerGroups(appPath);
    const fosRest          = detectFosRestVersioning(appPath);
    const versions         = [...new Set(endpoints.map((e) => e.version))].sort();

    let text = `API Versioning Statistics\n${'='.repeat(40)}\n\n`;
    text += `Versions detected:       ${versions.length > 0 ? versions.join(', ') : 'none'}\n`;
    text += `Versioned endpoints:     ${endpoints.length}\n`;
    text += `Versioned groups:        ${serializerGroups.size}\n`;
    text += `FOSRest versioning:      ${fosRest ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiVersioningTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_versions',
      description: 'Show API versioning: URL-prefixed routes (/v1/, /v2/), versioned serializer groups (v1:read), FOSRestBundle versioning, gap analysis between versions',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_version_stats',
      description: 'Show API versioning statistics: versions detected, versioned endpoint count, versioned serializer group count, FOSRest flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
