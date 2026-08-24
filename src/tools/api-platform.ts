// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Platform Inspector
 *
 * Discovers API Platform resources from PHP 8 attributes and YAML/XML config:
 *   - #[ApiResource] on entity and DTO classes
 *   - Operations: Get, GetCollection, Post, Put, Patch, Delete
 *   - Serialization groups (normalization/denormalization contexts)
 *   - Filters (#[ApiFilter])
 *   - Pagination settings
 *   - Global API Platform config from api_platform.yaml
 *
 * Pure static analysis — no PHP execution or HTTP requests.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ApiOperation {
  method: string;
  name?: string;
  path?: string;
  normalizationGroups?: string[];
  denormalizationGroups?: string[];
  security?: string;
  validationContext?: string;
}

interface ApiFilter {
  class: string;
  properties?: string[];
  strategy?: string;
}

interface ApiResource {
  class: string;
  shortName?: string;
  file: string;
  description?: string;
  operations: ApiOperation[];
  filters: ApiFilter[];
  normalizationGroups: string[];
  denormalizationGroups: string[];
  paginationEnabled?: boolean;
  paginationItemsPerPage?: number;
  security?: string;
}

interface ApiPlatformConfig {
  title?: string;
  version?: string;
  formats?: string[];
  paginationEnabled?: boolean;
  paginationItemsPerPage?: number;
  defaultOrder?: string;
}

// ─── File scanning ─────────────────────────────────────────────────────────

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

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function extractNamespace(content: string): string {
  const m = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return m ? m[1] : '';
}

// ─── Attribute parsing ─────────────────────────────────────────────────────

function parseStringGroups(raw: string): string[] {
  const groups: string[] = [];
  for (const m of raw.matchAll(/['"]([^'"]+)['"]/g)) {
    groups.push(m[1]);
  }
  return groups;
}

function parseOperations(content: string): ApiOperation[] {
  const ops: ApiOperation[] = [];

  // Match individual operation attributes:
  // #[Get], #[GetCollection], #[Post], #[Put], #[Patch], #[Delete]
  // Also handles fully qualified: #[ApiPlatform\Metadata\Get(...)]
  const opPattern = /#\[\s*(?:ApiPlatform\\Metadata\\)?(Get|GetCollection|Post|Put|Patch|Delete)\s*(?:\(([^)]{0,2000}(?:\([^)]{0,500}\)[^)]{0,2000}){0,20})\))?\s*\]/g;
  let m: RegExpExecArray | null;

  while ((m = opPattern.exec(content)) !== null) {
    const method = m[1];
    const args = m[2] ?? '';
    const op: ApiOperation = { method };

    const pathMatch = /\bpath\s*:\s*['"]([^'"]+)['"]/.exec(args);
    if (pathMatch) op.path = pathMatch[1];

    const nameMatch = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(args);
    if (nameMatch) op.name = nameMatch[1];

    const normMatch = /normalizationContext\s*:\s*\[([^\]]+)\]/.exec(args);
    if (normMatch) {
      const groupsMatch = /groups\s*:\s*\[([^\]]+)\]/.exec(normMatch[1]);
      if (groupsMatch) op.normalizationGroups = parseStringGroups(groupsMatch[1]);
    }

    const denormMatch = /denormalizationContext\s*:\s*\[([^\]]+)\]/.exec(args);
    if (denormMatch) {
      const groupsMatch = /groups\s*:\s*\[([^\]]+)\]/.exec(denormMatch[1]);
      if (groupsMatch) op.denormalizationGroups = parseStringGroups(groupsMatch[1]);
    }

    const securityMatch = /\bsecurity\s*:\s*['"]([^'"]+)['"]/.exec(args);
    if (securityMatch) op.security = securityMatch[1];

    ops.push(op);
  }

  // Also check for operations: [...] array inside #[ApiResource]
  if (ops.length === 0) {
    const opArrayMatch = /\boperations\s*:\s*\[([\s\S]*?)\]/.exec(content);
    if (opArrayMatch) {
      const methods = ['Get', 'GetCollection', 'Post', 'Put', 'Patch', 'Delete'];
      for (const method of methods) {
        if (new RegExp(`new\\s+${method}\\s*\\(`).test(opArrayMatch[1]) ||
            opArrayMatch[1].includes(`${method}::`)) {
          ops.push({ method });
        }
      }
    }
  }

  return ops;
}

function parseFilters(content: string): ApiFilter[] {
  const filters: ApiFilter[] = [];

  // #[ApiFilter(SearchFilter::class, properties: ['name' => 'partial'])]
  const filterPattern = /#\[ApiFilter\(([^)]+)\)\]/g;
  let m: RegExpExecArray | null;

  while ((m = filterPattern.exec(content)) !== null) {
    const args = m[1];
    const classMatch = /([\w\\]+Filter)::class/.exec(args);
    if (!classMatch) continue;

    const filter: ApiFilter = { class: classMatch[1].split('\\').pop() ?? classMatch[1] };

    const propsMatch = /properties\s*:\s*\[([^\]]+)\]/.exec(args);
    if (propsMatch) {
      filter.properties = [];
      for (const pm of propsMatch[1].matchAll(/['"](\w+)['"]/g)) {
        filter.properties.push(pm[1]);
      }
    }

    const strategyMatch = /strategy\s*:\s*['"]([^'"]+)['"]/.exec(args);
    if (strategyMatch) filter.strategy = strategyMatch[1];

    filters.push(filter);
  }

  return filters;
}

function parseApiResourceFile(filePath: string): ApiResource | null {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch { return null; }

  if (!content.includes('ApiResource') && !content.includes('api_resource')) return null;

  // Must have #[ApiResource] attribute
  if (!/#\[.*ApiResource/.test(content)) return null;

  const className = extractClassName(content);
  if (!className) return null;
  const namespace = extractNamespace(content);

  // Parse #[ApiResource(...)] — grab full attribute block
  const resourceMatch = /#\[(?:ApiPlatform\\Metadata\\)?ApiResource\s*(?:\(([^)]{0,2000}(?:\([^)]{0,500}\)[^)]{0,2000}){0,20})\))?\s*\]/.exec(content);
  const resourceArgs = resourceMatch?.[1] ?? '';

  // shortName
  const shortNameMatch = /\bshortName\s*:\s*['"]([^'"]+)['"]/.exec(resourceArgs);

  // description
  const descMatch = /\bdescription\s*:\s*['"]([^'"]+)['"]/.exec(resourceArgs);

  // Global normalization/denormalization groups
  const normMatch = /normalizationContext\s*:\s*\[([^\]]+)\]/.exec(resourceArgs);
  let normGroups: string[] = [];
  if (normMatch) {
    const gm = /groups\s*:\s*\[([^\]]+)\]/.exec(normMatch[1]);
    if (gm) normGroups = parseStringGroups(gm[1]);
  }

  const denormMatch = /denormalizationContext\s*:\s*\[([^\]]+)\]/.exec(resourceArgs);
  let denormGroups: string[] = [];
  if (denormMatch) {
    const gm = /groups\s*:\s*\[([^\]]+)\]/.exec(denormMatch[1]);
    if (gm) denormGroups = parseStringGroups(gm[1]);
  }

  // Security
  const secMatch = /\bsecurity\s*:\s*['"]([^'"]+)['"]/.exec(resourceArgs);

  // Pagination
  const pagMatch = /paginationEnabled\s*:\s*(true|false)/.exec(resourceArgs);
  const pagItemsMatch = /paginationItemsPerPage\s*:\s*(\d+)/.exec(resourceArgs);

  const operations = parseOperations(content);
  const filters = parseFilters(content);

  return {
    class: namespace ? `${namespace}\\${className}` : className,
    shortName: shortNameMatch?.[1],
    file: path.basename(filePath),
    description: descMatch?.[1],
    operations,
    filters,
    normalizationGroups: normGroups,
    denormalizationGroups: denormGroups,
    paginationEnabled: pagMatch ? pagMatch[1] === 'true' : undefined,
    paginationItemsPerPage: pagItemsMatch ? parseInt(pagItemsMatch[1], 10) : undefined,
    security: secMatch?.[1],
  };
}

function loadApiPlatformConfig(appPath: string): ApiPlatformConfig {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'api_platform.yaml'),
    path.join(appPath, 'config', 'packages', 'api_platform.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const ap = (raw['api_platform'] ?? raw) as Record<string, unknown>;
    return {
      title: ap['title'] as string | undefined,
      version: ap['version'] as string | undefined,
      formats: Object.keys((ap['formats'] ?? {}) as object),
      paginationEnabled: ap['defaults']
        ? Boolean((ap['defaults'] as Record<string, unknown>)['pagination_enabled'])
        : undefined,
      paginationItemsPerPage: ap['defaults']
        ? Number((ap['defaults'] as Record<string, unknown>)['pagination_items_per_page'] ?? 0) || undefined
        : undefined,
    };
  }

  return {};
}

function loadApiResources(appPath: string): ApiResource[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Entity'),
    path.join(appPath, 'src', 'ApiResource'),
    path.join(appPath, 'src', 'Dto'),
    path.join(appPath, 'src', 'DTO'),
    path.join(appPath, 'src', 'Model'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const resources: ApiResource[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const r = parseApiResourceFile(file);
      if (r) resources.push(r);
    }
  }

  return resources.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listApiResources(appPath: string): McpToolResult {
  try {
    const resources = loadApiResources(appPath);
    const config = loadApiPlatformConfig(appPath);

    if (resources.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API Platform resources found.\n\nInstall: composer require api-platform/core\nAdd #[ApiResource] to your entities.',
        }],
      };
    }

    let text = `API Platform Resources (${resources.length})\n${'='.repeat(50)}\n`;

    if (config.title) text += `\nAPI: ${config.title}${config.version ? ` v${config.version}` : ''}\n`;
    if (config.formats?.length) text += `Formats: ${config.formats.join(', ')}\n`;

    text += '\n';

    for (const r of resources) {
      const shortClass = r.shortName ?? r.class.split('\\').pop() ?? r.class;
      text += `  ${shortClass}  (${r.file})\n`;

      if (r.operations.length > 0) {
        const methods = r.operations.map((o) => o.method).join(', ');
        text += `    Operations: ${methods}\n`;
      } else {
        text += `    Operations: (all defaults)\n`;
      }

      if (r.normalizationGroups.length > 0) {
        text += `    Read groups:  ${r.normalizationGroups.join(', ')}\n`;
      }
      if (r.denormalizationGroups.length > 0) {
        text += `    Write groups: ${r.denormalizationGroups.join(', ')}\n`;
      }
      if (r.filters.length > 0) {
        text += `    Filters: ${r.filters.map((f) => f.class).join(', ')}\n`;
      }
      if (r.security) {
        text += `    Security: ${r.security}\n`;
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

export function getApiResourceDetails(appPath: string, resourceName: string): McpToolResult {
  try {
    const resources = loadApiResources(appPath);
    const r = resources.find(
      (res) =>
        res.class.toLowerCase().includes(resourceName.toLowerCase()) ||
        (res.shortName ?? '').toLowerCase().includes(resourceName.toLowerCase()) ||
        res.file.toLowerCase().includes(resourceName.toLowerCase())
    );

    if (!r) {
      const names = resources.map((res) => res.shortName ?? res.class.split('\\').pop()).join(', ');
      return {
        content: [{ type: 'text', text: `Resource "${resourceName}" not found.\n\nAvailable: ${names || 'none'}` }],
        isError: true,
      };
    }

    let text = `API Resource: ${r.shortName ?? r.class.split('\\').pop()}\n${'='.repeat(50)}\n\n`;
    text += `Class: ${r.class}\n`;
    text += `File:  ${r.file}\n`;
    if (r.description) text += `Description: ${r.description}\n`;
    if (r.security) text += `Security: ${r.security}\n`;

    if (r.normalizationGroups.length > 0 || r.denormalizationGroups.length > 0) {
      text += `\nGlobal serialization:\n`;
      if (r.normalizationGroups.length > 0) text += `  Read (normalization):  ${r.normalizationGroups.join(', ')}\n`;
      if (r.denormalizationGroups.length > 0) text += `  Write (denormalization): ${r.denormalizationGroups.join(', ')}\n`;
    }

    if (r.operations.length > 0) {
      text += `\nOperations (${r.operations.length}):\n`;
      for (const op of r.operations) {
        text += `  ${op.method.padEnd(15)}`;
        if (op.path) text += ` path: ${op.path}`;
        if (op.security) text += `  security: ${op.security}`;
        text += '\n';
        if (op.normalizationGroups?.length) text += `    Read groups:  ${op.normalizationGroups.join(', ')}\n`;
        if (op.denormalizationGroups?.length) text += `    Write groups: ${op.denormalizationGroups.join(', ')}\n`;
      }
    } else {
      text += `\nOperations: all defaults (Get, GetCollection, Post, Put, Patch, Delete)\n`;
    }

    if (r.filters.length > 0) {
      text += `\nFilters (${r.filters.length}):\n`;
      for (const f of r.filters) {
        text += `  ${f.class}`;
        if (f.strategy) text += `  strategy: ${f.strategy}`;
        if (f.properties?.length) text += `\n    Properties: ${f.properties.join(', ')}`;
        text += '\n';
      }
    }

    if (r.paginationEnabled !== undefined) {
      text += `\nPagination: ${r.paginationEnabled ? 'enabled' : 'disabled'}`;
      if (r.paginationItemsPerPage) text += ` (${r.paginationItemsPerPage} per page)`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPlatformStats(appPath: string): McpToolResult {
  try {
    const resources = loadApiResources(appPath);
    const config = loadApiPlatformConfig(appPath);

    if (resources.length === 0) {
      return { content: [{ type: 'text', text: 'No API Platform resources found.' }] };
    }

    const opCounts: Record<string, number> = {};
    let totalFilters = 0;
    let securedResources = 0;

    for (const r of resources) {
      for (const op of r.operations) {
        opCounts[op.method] = (opCounts[op.method] ?? 0) + 1;
      }
      totalFilters += r.filters.length;
      if (r.security) securedResources++;
    }

    let text = `API Platform Statistics\n${'='.repeat(40)}\n\n`;
    if (config.title) text += `API title: ${config.title}\n`;
    text += `Resources:          ${resources.length}\n`;
    text += `Secured resources:  ${securedResources}\n`;
    text += `Total filters:      ${totalFilters}\n`;

    if (Object.keys(opCounts).length > 0) {
      text += `\nOperations by type:\n`;
      for (const [method, count] of Object.entries(opCounts).sort()) {
        text += `  ${method.padEnd(15)} ${count}\n`;
      }
    }

    const allGroups = new Set<string>();
    for (const r of resources) {
      r.normalizationGroups.forEach((g) => allGroups.add(g));
      r.denormalizationGroups.forEach((g) => allGroups.add(g));
      for (const op of r.operations) {
        op.normalizationGroups?.forEach((g) => allGroups.add(g));
        op.denormalizationGroups?.forEach((g) => allGroups.add(g));
      }
    }

    if (allGroups.size > 0) {
      text += `\nSerialization groups used (${allGroups.size}):\n`;
      for (const g of Array.from(allGroups).sort()) {
        text += `  ${g}\n`;
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getApiPlatformTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_api_resources',
      description: 'List all API Platform resources (#[ApiResource]) with their operations, serialization groups, filters, and security rules',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_api_resource_details',
      description: 'Get full details for an API Platform resource: all operations with paths, per-operation serialization groups, filters, and pagination config',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          resource_name: { type: 'string', description: 'Resource class name, short name, or file name (partial match)' },
        },
        required: ['app_path', 'resource_name'],
      },
    },
    {
      name: 'get_api_platform_stats',
      description: 'Show API Platform statistics: resource count, operation breakdown, filter count, and all serialization groups in use',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
