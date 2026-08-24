// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SoftDeleteInfo {
  file: string;
  class: string;
  hasDeletedAt: boolean;
  hasGedmoAnnotation: boolean;
  hasSoftDeleteableFilter: boolean;
  hasCustomFilter: boolean;
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

function parseSoftDelete(filePath: string, appPath: string): SoftDeleteInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const hasDeletedAt = /\$deleted[_]?[Aa]t\b/.test(content) || /deleted_at/.test(content) || /deletedAt/.test(content);
  const hasGedmoAnnotation = content.includes('Gedmo\\SoftDeleteable') || content.includes('SoftDeleteable(') || content.includes('@SoftDeleteable');
  const hasSoftDeleteableFilter = content.includes('SoftDeleteableFilter') || content.includes('soft_deleteable');
  const hasCustomFilter = content.includes('implements Filter') || (content.includes('softDeleted') && content.includes('filter'));
  if (!hasDeletedAt && !hasGedmoAnnotation) return null;
  if (content.includes('namespace Doctrine\\') || content.includes('namespace Gedmo\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const issues: string[] = [];
  if (hasDeletedAt && !hasGedmoAnnotation && !hasCustomFilter) issues.push('deletedAt field without SoftDeleteable annotation or custom filter — queries may return "deleted" records');
  if (hasGedmoAnnotation && !content.includes('enableFilter') && !hasSoftDeleteableFilter) issues.push('SoftDeleteable annotation found but filter enablement not detected — ensure soft_deleteable filter is enabled in EntityManager');
  return { file: path.relative(appPath, filePath), class: classM[1], hasDeletedAt, hasGedmoAnnotation, hasSoftDeleteableFilter, hasCustomFilter, issues };
}

export function listDoctrineSoftDelete(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: SoftDeleteInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseSoftDelete(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No soft-delete patterns found.\n\nExample:\n  use Gedmo\\Mapping\\Annotation as Gedmo;\n  #[Gedmo\\SoftDeleteable(fieldName: "deletedAt")]\n  class Article { private ?\\DateTimeImmutable $deletedAt = null; }' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Doctrine Soft Delete\n${'='.repeat(55)}\n\nEntities: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        r.hasGedmoAnnotation ? 'Gedmo' : '',
        r.hasDeletedAt ? 'deletedAt' : '',
        r.hasCustomFilter ? 'custom-filter' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${r.class}  ${flags}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineSoftDeleteStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SoftDeleteInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseSoftDelete(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Doctrine Soft Delete Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities with soft delete: ${results.length}\n  Gedmo SoftDeleteable: ${results.filter(r => r.hasGedmoAnnotation).length}\n  Custom deletedAt field: ${results.filter(r => r.hasDeletedAt && !r.hasGedmoAnnotation).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineSoftDeleteTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_soft_delete', description: 'Detect soft-delete patterns: Gedmo\\SoftDeleteable annotation, deletedAt field, custom soft-delete filters, missing filter enablement warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_soft_delete_stats', description: 'Doctrine soft delete statistics: entity count, Gedmo vs custom, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
