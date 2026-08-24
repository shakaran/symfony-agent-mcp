// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX Autocomplete Inspector
 *
 * Scans src/ PHP for #[AsEntityAutocompleteField] attribute usage,
 * EntityAutocompleteType in forms, AutocompleteChoiceTypeExtension,
 * classes implementing AsEntityAutocompleteField interface.
 *
 * Checks composer.json for symfony/ux-autocomplete dependency.
 *
 * Warns: autocomplete without security attribute (open endpoint),
 * without max_results (can return all DB records),
 * without searchable_fields (searches all fields),
 * entity autocomplete without query_builder (no filtering).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface UxAutocompleteInfo {
  file: string;
  class: string;
  entityClass: string;
  hasSecurityAttr: boolean;
  hasMaxResults: boolean;
  hasSearchableFields: boolean;
  hasQueryBuilder: boolean;
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

function checkComposerForUxAutocomplete(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const require = (parsed['require'] ?? {}) as Record<string, unknown>;
    const requireDev = (parsed['require-dev'] ?? {}) as Record<string, unknown>;
    return 'symfony/ux-autocomplete' in require || 'symfony/ux-autocomplete' in requireDev;
  } catch { return false; }
}

function extractEntityClass(content: string, attrStart: number): string {
  const window = content.slice(attrStart, attrStart + 500);
  // Look for class: or entityClass: in attribute
  const classM = /(?:class|entityClass)\s*:\s*([A-Za-z0-9_\\]{1,100})::class/.exec(window)
    ?? /(?:class|entityClass)\s*:\s*'([^']{1,100})'/.exec(window)
    ?? /(?:class|entityClass)\s*:\s*"([^"]{1,100})"/.exec(window);
  return classM?.[1] ?? '(unknown entity)';
}

function parseAutocomplete(filePath: string, appPath: string): UxAutocompleteInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasAttr = content.includes('#[AsEntityAutocompleteField')
    || content.includes('AsEntityAutocompleteField')
    || content.includes('EntityAutocompleteType');

  if (!hasAttr) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  // Find attribute block
  const attrRe = /#\[AsEntityAutocompleteField/g;
  let m: RegExpExecArray | null;
  let attrStart = 0;
  while ((m = attrRe.exec(content)) !== null) {
    attrStart = m.index;
  }

  const entityClass = extractEntityClass(content, attrStart);

  const window = content.slice(attrStart, attrStart + 1000);
  const hasSecurityAttr = window.includes('security') || content.includes('#[IsGranted') || content.includes('->isGranted(');
  const hasMaxResults = window.includes('max_results') || window.includes('maxResults');
  const hasSearchableFields = window.includes('searchable_fields') || window.includes('searchableFields');
  const hasQueryBuilder = window.includes('query_builder') || window.includes('queryBuilder') || content.includes('->createQueryBuilder(');

  const issues: string[] = [];

  if (!hasSecurityAttr) {
    issues.push('No security restriction on autocomplete endpoint — any authenticated (or anonymous) user can query entity data');
  }
  if (!hasMaxResults) {
    issues.push('No max_results set — autocomplete can return all matching database records');
  }
  if (!hasSearchableFields) {
    issues.push('No searchable_fields defined — autocomplete searches across all entity fields (may expose sensitive data)');
  }
  if (!hasQueryBuilder && (content.includes('EntityAutocompleteType') || content.includes('AsEntityAutocompleteField'))) {
    issues.push('No query_builder defined — no custom filtering applied to autocomplete query results');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    entityClass,
    hasSecurityAttr,
    hasMaxResults,
    hasSearchableFields,
    hasQueryBuilder,
    issues,
  };
}

export function listUxAutocomplete(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const installed = checkComposerForUxAutocomplete(appPath);
    const results: UxAutocompleteInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseAutocomplete(file, appPath);
      if (r) results.push(r);
    }

    if (results.length === 0) {
      let text = 'No UX Autocomplete usage found in src/.\n';
      text += `symfony/ux-autocomplete in composer.json: ${installed ? 'yes' : 'no'}\n`;
      return { content: [{ type: 'text', text }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony UX Autocomplete Usage\n${'='.repeat(55)}\n`;
    text += `\nautocomplete fields: ${results.length}  Issues: ${totalIssues}\n`;
    text += `symfony/ux-autocomplete installed: ${installed ? 'yes' : 'no (check composer.json)'}\n`;

    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  (${r.file})\n`;
      text += `    Entity: ${r.entityClass}\n`;
      text += `    Security: ${r.hasSecurityAttr ? 'yes' : 'NO'}  max_results: ${r.hasMaxResults ? 'yes' : 'NO'}  searchable_fields: ${r.hasSearchableFields ? 'yes' : 'NO'}  query_builder: ${r.hasQueryBuilder ? 'yes' : 'NO'}\n`;
      for (const issue of r.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getUxAutocompleteStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: UxAutocompleteInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseAutocomplete(file, appPath);
        if (r) results.push(r);
      }
    }
    const installed = checkComposerForUxAutocomplete(appPath);

    let text = `UX Autocomplete Statistics\n${'='.repeat(40)}\n\n`;
    text += `Package installed:          ${installed ? 'yes' : 'no'}\n`;
    text += `Autocomplete fields:        ${results.length}\n`;
    text += `  With security:            ${results.filter((r) => r.hasSecurityAttr).length}\n`;
    text += `  With max_results:         ${results.filter((r) => r.hasMaxResults).length}\n`;
    text += `  With searchable_fields:   ${results.filter((r) => r.hasSearchableFields).length}\n`;
    text += `  With query_builder:       ${results.filter((r) => r.hasQueryBuilder).length}\n`;
    text += `Issues detected:            ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxAutocompleteTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_ux_autocomplete',
      description: 'Show Symfony UX Autocomplete fields: #[AsEntityAutocompleteField] detection, security attribute, max_results, searchable_fields, query_builder; warns on open endpoints, missing result limits, all-field search, no filtering',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_ux_autocomplete_stats',
      description: 'Show UX Autocomplete statistics: installed check, field count, security coverage, max_results coverage, searchable_fields coverage, query_builder coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
