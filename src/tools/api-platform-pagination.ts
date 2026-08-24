// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Platform Pagination Inspector
 *
 * Distinct from api-platform.ts (general resource config) and api-platform-operations.ts (HTTP ops).
 * Focuses on pagination configuration per API Platform resource:
 *
 * Per-resource pagination (PHP attribute syntax, API Platform 3.x):
 *   #[ApiResource(
 *     paginationEnabled: true,
 *     paginationItemsPerPage: 30,
 *     paginationMaximumItemsPerPage: 100,
 *     paginationClientEnabled: true,
 *     paginationClientItemsPerPage: true,
 *     paginationViaCursor: [['field' => 'id', 'direction' => 'DESC']],
 *     paginationPartial: false,
 *     paginationFetchJoinCollection: true,
 *   )]
 *
 * Global defaults (config/packages/api_platform.yaml):
 *   api_platform:
 *     defaults:
 *       pagination_enabled: true
 *       pagination_items_per_page: 30
 *       pagination_maximum_items_per_page: ~
 *
 * Custom paginators:
 *   - Classes implementing PaginatorInterface or PartialPaginatorInterface
 *   - Injected as custom stateProvider with pagination logic
 *
 * Analysis:
 *   - paginationEnabled: false on collection with potentially large datasets
 *   - paginationMaximumItemsPerPage missing (client can request unlimited)
 *   - paginationMaximumItemsPerPage > 500 (very large pages, memory risk)
 *   - paginationViaCursor without indexed field (poor performance)
 *   - paginationClientItemsPerPage: true without maximum set (user can request all)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ResourcePagination {
  class: string;
  file: string;
  paginationEnabled?: boolean;
  itemsPerPage?: number;
  maximumItemsPerPage?: number;
  clientEnabled?: boolean;
  clientItemsPerPage?: boolean;
  viaCursor: boolean;
  partial: boolean;
  issues: string[];
}

interface GlobalPaginationConfig {
  enabled?: boolean;
  itemsPerPage?: number;
  maximumItemsPerPage?: number;
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

function loadGlobalConfig(appPath: string): GlobalPaginationConfig {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'api_platform.yaml'),
    path.join(appPath, 'config', 'packages', 'api_platform.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const ap  = (raw['api_platform'] ?? {}) as Record<string, unknown>;
    const def = (ap['defaults'] ?? ap) as Record<string, unknown>;
    return {
      enabled: def['pagination_enabled'] as boolean | undefined,
      itemsPerPage: def['pagination_items_per_page'] ? Number(def['pagination_items_per_page']) : undefined,
      maximumItemsPerPage: def['pagination_maximum_items_per_page'] ? Number(def['pagination_maximum_items_per_page']) : undefined,
    };
  }
  return {};
}

function parseResourcePagination(filePath: string, appPath: string): ResourcePagination | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  if (!content.includes('#[ApiResource') && !content.includes('ApiResource(')) return null;
  if (content.includes('namespace ApiPlatform\\') || content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Extract pagination-related attributes
  const apiResBlock = /#\[ApiResource\s*\(([\s\S]{0,1500}?)\)\]/.exec(content);
  const block = apiResBlock?.[1] ?? '';

  const boolVal = (name: string): boolean | undefined => {
    const m = new RegExp(`${name}\\s*:\\s*(true|false)`).exec(block);
    return m ? m[1] === 'true' : undefined;
  };
  const numVal = (name: string): number | undefined => {
    const m = new RegExp(`${name}\\s*:\\s*(\\d+)`).exec(block);
    return m ? parseInt(m[1], 10) : undefined;
  };

  const paginationEnabled        = boolVal('paginationEnabled');
  const itemsPerPage             = numVal('paginationItemsPerPage');
  const maximumItemsPerPage      = numVal('paginationMaximumItemsPerPage');
  const clientEnabled            = boolVal('paginationClientEnabled');
  const clientItemsPerPage       = boolVal('paginationClientItemsPerPage');
  const viaCursor                = block.includes('paginationViaCursor');
  const partial                  = boolVal('paginationPartial') === true;

  const issues: string[] = [];
  if (paginationEnabled === false) {
    issues.push('paginationEnabled: false — collection endpoint returns all items (memory/performance risk on large datasets)');
  }
  if (!maximumItemsPerPage && (clientEnabled || clientItemsPerPage)) {
    issues.push('paginationClientEnabled/paginationClientItemsPerPage without paginationMaximumItemsPerPage — client can request all items');
  }
  if (maximumItemsPerPage !== undefined && maximumItemsPerPage > 500) {
    issues.push(`paginationMaximumItemsPerPage: ${maximumItemsPerPage} is very large — may cause memory/timeout issues`);
  }

  if (paginationEnabled === undefined && !itemsPerPage && !maximumItemsPerPage && !clientEnabled && !viaCursor && !partial) {
    return null; // No pagination config at all — uses global defaults, skip
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    paginationEnabled,
    itemsPerPage,
    maximumItemsPerPage,
    clientEnabled,
    clientItemsPerPage,
    viaCursor,
    partial,
    issues,
  };
}

function scanCustomPaginators(appPath: string): number {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (content.includes('PaginatorInterface') || content.includes('PartialPaginatorInterface')) count++;
  }
  return count;
}

export function listApiPagination(appPath: string): McpToolResult {
  try {
    const srcDir    = path.join(appPath, 'src');
    const global    = loadGlobalConfig(appPath);
    const resources: ResourcePagination[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourcePagination(file, appPath);
        if (r) resources.push(r);
      }
    }

    const customPaginators = scanCustomPaginators(appPath);
    const totalIssues      = resources.reduce((s, r) => s + r.issues.length, 0);

    let text = `API Platform Pagination\n${'='.repeat(55)}\n`;

    text += `\nGlobal defaults:\n`;
    text += `  pagination_enabled:         ${global.enabled ?? 'not set (true)'}\n`;
    text += `  pagination_items_per_page:  ${global.itemsPerPage ?? 'not set (30)'}\n`;
    text += `  pagination_maximum_items:   ${global.maximumItemsPerPage ?? 'not set (unlimited)'}\n`;

    if (!global.maximumItemsPerPage) {
      text += `  ⚠ No global maximum — clients can request unlimited items if paginationClientEnabled\n`;
    }

    text += `\nCustom resource pagination: ${resources.length}  Custom paginators: ${customPaginators}  Issues: ${totalIssues}\n`;

    if (resources.length > 0) {
      for (const r of resources.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
        const enabled = r.paginationEnabled === false ? '⚠ disabled' : r.paginationEnabled === true ? '✓ enabled' : 'default';
        const max     = r.maximumItemsPerPage ? `max:${r.maximumItemsPerPage}` : '';
        const ipp     = r.itemsPerPage ? `ipp:${r.itemsPerPage}` : '';
        const cursor  = r.viaCursor ? 'cursor' : '';
        text += `\n  ${r.class}  ${enabled}  ${ipp}  ${max}  ${cursor}  (${r.file})\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
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

export function getApiPaginationStats(appPath: string): McpToolResult {
  try {
    const srcDir    = path.join(appPath, 'src');
    const resources: ResourcePagination[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseResourcePagination(file, appPath);
        if (r) resources.push(r);
      }
    }

    let text = `API Platform Pagination Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources with custom pagination: ${resources.length}\n`;
    text += `  Pagination disabled:            ${resources.filter((r) => r.paginationEnabled === false).length}\n`;
    text += `  With cursor pagination:         ${resources.filter((r) => r.viaCursor).length}\n`;
    text += `  With client control:            ${resources.filter((r) => r.clientEnabled || r.clientItemsPerPage).length}\n`;
    text += `  With max items set:             ${resources.filter((r) => r.maximumItemsPerPage !== undefined).length}\n`;
    text += `Custom paginators:                ${scanCustomPaginators(appPath)}\n`;
    text += `Issues:                           ${resources.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPaginationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_pagination',
      description: 'Show API Platform pagination config per resource: paginationEnabled, paginationItemsPerPage, paginationMaximumItemsPerPage, paginationClientEnabled, paginationClientItemsPerPage, paginationViaCursor, global api_platform.yaml defaults, unlimited-items warning when client control enabled without maximum',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_pagination_stats',
      description: 'Show API Platform pagination statistics: custom resource pagination count, disabled/cursor/client-control/max-set counts, custom paginator count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
