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

interface QueryExtensionInfo {
  file: string;
  class: string;
  type: 'collection' | 'item' | 'both';
  hasApplyToCollection: boolean;
  hasApplyToItem: boolean;
  hasResourceClassCheck: boolean;
  hasOperationNameCheck: boolean;
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

function parseExtension(filePath: string, appPath: string): QueryExtensionInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const isCollection = content.includes('QueryCollectionExtensionInterface');
  const isItem = content.includes('QueryItemExtensionInterface');
  if (!isCollection && !isItem) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const hasApplyToCollection = content.includes('applyToCollection');
  const hasApplyToItem = content.includes('applyToItem');
  const hasResourceClassCheck = /resourceClass\s*===|resourceClass\s*!==|is_a\s*\(\s*\$resourceClass/.test(content);
  const hasOperationNameCheck = content.includes('operationName') || content.includes('$context[');
  const type: 'collection' | 'item' | 'both' = isCollection && isItem ? 'both' : (isCollection ? 'collection' : 'item');
  const issues: string[] = [];
  if (!hasResourceClassCheck) issues.push('No resourceClass check — extension applies to ALL resources (may be intentional for global filters)');
  if (isCollection && !hasApplyToCollection) issues.push('QueryCollectionExtensionInterface without applyToCollection() implementation');
  if (isItem && !hasApplyToItem) issues.push('QueryItemExtensionInterface without applyToItem() implementation');
  return { file: path.relative(appPath, filePath), class: classM[1], type, hasApplyToCollection, hasApplyToItem, hasResourceClassCheck, hasOperationNameCheck, issues };
}

export function listApiQueryExtensions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const extensions: QueryExtensionInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const e = parseExtension(f, appPath);
      if (e) extensions.push(e);
    }
    if (extensions.length === 0) return { content: [{ type: 'text', text: 'No API Platform query extensions found.\n\nExample:\n  class CurrentUserExtension implements QueryCollectionExtensionInterface, QueryItemExtensionInterface {\n    public function applyToCollection(QueryBuilder $qb, ...) { ... }\n  }' }] };
    const totalIssues = extensions.reduce((s, e) => s + e.issues.length, 0);
    let text = `API Platform Query Extensions\n${'='.repeat(55)}\n\nExtensions: ${extensions.length}  Issues: ${totalIssues}\n`;
    for (const e of extensions.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${e.class}  type: ${e.type}  resourceCheck: ${e.hasResourceClassCheck ? 'yes' : 'no'}  (${e.file})\n`;
      for (const i of e.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiQueryExtensionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const extensions: QueryExtensionInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const e = parseExtension(f, appPath);
        if (e) extensions.push(e);
      }
    }
    let text = `API Platform Query Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total extensions: ${extensions.length}\n  Collection: ${extensions.filter(e => e.type === 'collection' || e.type === 'both').length}\n  Item: ${extensions.filter(e => e.type === 'item' || e.type === 'both').length}\n  Both: ${extensions.filter(e => e.type === 'both').length}\n  With resourceClass check: ${extensions.filter(e => e.hasResourceClassCheck).length}\nIssues: ${extensions.reduce((s, e) => s + e.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiQueryExtensionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_query_extensions', description: 'Detect API Platform QueryCollectionExtensionInterface and QueryItemExtensionInterface: applyToCollection/applyToItem presence, resourceClass check, global extension warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_query_extension_stats', description: 'API Platform query extension statistics: collection/item/both counts, resourceClass check coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
