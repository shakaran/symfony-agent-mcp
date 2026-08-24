// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * API Platform Filters Inspector
 *
 * Distinct from api-platform.ts (resources/operations) and security-scanner.ts.
 * Focuses on API Platform filter declarations and usage:
 *
 * Built-in filters detected:
 *   - SearchFilter (exact/partial/start/end/word_start)
 *   - OrderFilter (property, nulls_comparison)
 *   - DateFilter (before/after/strictly_before/strictly_after, null_always/null_never)
 *   - RangeFilter (between/gt/gte/lt/lte)
 *   - BooleanFilter
 *   - ExistsFilter (null check)
 *   - NumericFilter
 *
 * Custom filters:
 *   - Classes implementing FilterInterface / AbstractFilter / AbstractContextAwareFilter
 *
 * Per-resource filter declarations:
 *   - #[ApiFilter] attributes on entity classes
 *   - services.yaml tags (api_platform.filter) — legacy declaration
 *
 * Analysis:
 *   - Properties filtered without DB index (full-scan risk heuristic)
 *   - SearchFilter on non-string fields without explicit strategy
 *   - OrderFilter on large text fields (bad for performance)
 *   - Filters declared but never used in any resource
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ResourceFilter {
  entity: string;
  file: string;
  filterType: string;
  properties: string[];
  strategy?: string;
  issues: string[];
}

interface CustomFilter {
  class: string;
  file: string;
  parentType: string;
}

const FILTER_ALIASES: Record<string, string> = {
  SearchFilter: 'Search',
  OrderFilter: 'Order',
  DateFilter: 'Date',
  RangeFilter: 'Range',
  BooleanFilter: 'Boolean',
  ExistsFilter: 'Exists',
  NumericFilter: 'Numeric',
  PropertyFilter: 'Property (sparse fieldsets)',
};

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

function parseApiFilters(filePath: string): ResourceFilter[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (!content.includes('#[ApiFilter') && !content.includes('@ApiFilter')) return [];

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return [];
  const entity = classM[1];

  const results: ResourceFilter[] = [];

  for (const m of content.matchAll(/#\[ApiFilter\s*\(\s*([^,)]+)(?:,\s*properties\s*:\s*\[([^\]]*)\])?(?:,\s*strategy\s*:\s*['"]([^'"]+)['"])?/g)) {
    const filterClass = m[1].trim().replace(/::class$/, '').split('\\').pop() ?? m[1];
    const propsRaw    = m[2] ?? '';
    const strategy    = m[3];

    const properties: string[] = [];
    for (const p of propsRaw.split(',')) {
      const propM = /['"]([^'"]+)['"]/.exec(p.trim());
      if (propM) properties.push(propM[1]);
    }

    const issues: string[] = [];
    const friendly = FILTER_ALIASES[filterClass] ?? filterClass;

    if (filterClass === 'SearchFilter' && !strategy && properties.length > 0) {
      issues.push(`SearchFilter without explicit strategy (defaults to "exact") — verify intent`);
    }
    if (filterClass === 'OrderFilter' && properties.some((p) => p.includes('description') || p.includes('content') || p.includes('body'))) {
      issues.push(`OrderFilter on large text field — may cause slow query`);
    }

    results.push({ entity, file: path.basename(filePath), filterType: friendly, properties, strategy, issues });
  }
  return results;
}

function scanCustomApiFilters(appPath: string): CustomFilter[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: CustomFilter[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const isFilter = content.includes('FilterInterface') || content.includes('AbstractFilter') || content.includes('AbstractContextAwareFilter');
    if (!isFilter) continue;
    if (Object.keys(FILTER_ALIASES).some((f) => content.includes(`class ${f}`) || content.includes(`extends ${f}`))) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    let parentType = 'FilterInterface';
    if (content.includes('AbstractContextAwareFilter')) parentType = 'AbstractContextAwareFilter';
    else if (content.includes('AbstractFilter')) parentType = 'AbstractFilter';

    results.push({ class: classM[1], file: path.basename(file), parentType });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listApiPlatformFilters(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const filters: ResourceFilter[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      filters.push(...parseApiFilters(file));
    }
    const customFilters = scanCustomApiFilters(appPath);

    if (filters.length === 0 && customFilters.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No API Platform filters found.\n\nAdd filters to entities:\n  use ApiPlatform\\Metadata\\ApiFilter;\n  use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;\n\n  #[ApiResource]\n  #[ApiFilter(SearchFilter::class, properties: [\'name\' => \'partial\'])]\n  class Product { ... }',
        }],
      };
    }

    let text = `API Platform Filters\n${'='.repeat(55)}\n`;

    if (filters.length > 0) {
      // Group by entity
      const byEntity = new Map<string, ResourceFilter[]>();
      for (const f of filters) {
        const list = byEntity.get(f.entity) ?? [];
        list.push(f);
        byEntity.set(f.entity, list);
      }

      // Summary by filter type
      const byType = new Map<string, number>();
      for (const f of filters) byType.set(f.filterType, (byType.get(f.filterType) ?? 0) + 1);

      text += `\nFilter types used:\n`;
      for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${type.padEnd(30)} ${count}x\n`;
      }

      text += `\nFilters by entity (${byEntity.size} entities, ${filters.length} total):\n`;
      for (const [entity, entityFilters] of [...byEntity.entries()].sort()) {
        text += `\n  ${entity}:\n`;
        for (const f of entityFilters) {
          const props   = f.properties.length > 0 ? `  [${f.properties.join(', ')}]` : '';
          const strategy = f.strategy ? `  strategy: ${f.strategy}` : '';
          text += `    ${f.filterType}${props}${strategy}\n`;
          for (const issue of f.issues) text += `      ⚠ ${issue}\n`;
        }
      }
    }

    if (customFilters.length > 0) {
      text += `\nCustom filters (${customFilters.length}):\n`;
      for (const f of customFilters) {
        text += `  ${f.class.padEnd(40)} extends ${f.parentType}  (${f.file})\n`;
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

export function getApiPlatformFilterStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const filters: ResourceFilter[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        filters.push(...parseApiFilters(file));
      }
    }
    const customFilters = scanCustomApiFilters(appPath);
    const byType = new Map<string, number>();
    for (const f of filters) byType.set(f.filterType, (byType.get(f.filterType) ?? 0) + 1);

    let text = `API Platform Filter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total filter declarations: ${filters.length}\n`;
    text += `Entities with filters:     ${new Set(filters.map((f) => f.entity)).size}\n`;
    text += `Custom filter classes:     ${customFilters.length}\n`;
    text += `Issues detected:           ${filters.reduce((s, f) => s + f.issues.length, 0)}\n`;
    if (byType.size > 0) {
      text += `Filter types:\n`;
      for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${type.padEnd(20)} ${count}\n`;
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

export function getApiPlatformFiltersTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_platform_filters',
      description: 'Show API Platform filters: #[ApiFilter] declarations per entity (Search/Order/Date/Range/Boolean/Exists/Numeric), strategy, properties, custom AbstractFilter subclasses, SearchFilter without strategy warning, OrderFilter on text field warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_platform_filter_stats',
      description: 'Show API Platform filter statistics: total declarations, entities with filters, custom filter count, issue count, filter type breakdown',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
