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

interface IntersectionTypeInfo {
  file: string;
  class?: string;
  intersections: string[];
  dnfTypes: string[];
  count: number;
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

function parseIntersectionTypes(filePath: string, appPath: string): IntersectionTypeInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  // Intersection types: TypeA&TypeB (PHP 8.1+), DNF: (A&B)|null (PHP 8.2+)
  const intersectionRe = /\b([\w\\]{2,80}&[\w\\]{2,80}(?:&[\w\\]{2,80}){0,5})\b/g;
  const dnfRe = /\(([\w\\]{2,60}&[\w\\]{2,60})\)\|/g;
  const intersections: string[] = [];
  const dnfTypes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = intersectionRe.exec(content)) !== null) {
    const match = m[1];
    // Skip bitwise AND expressions (lowercase vars, numbers)
    if (/[a-z_$]/.test(match[0]) || /\d/.test(match[0])) continue;
    if (!intersections.includes(match)) intersections.push(match);
  }
  while ((m = dnfRe.exec(content)) !== null) {
    if (!dnfTypes.includes(m[1])) dnfTypes.push(m[1]);
  }
  if (intersections.length === 0 && dnfTypes.length === 0) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace PHPUnit\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const issues: string[] = [];
  if (dnfTypes.length > 0) issues.push(`DNF types (PHP 8.2+) used: ${dnfTypes.join(', ')} — ensure minimum PHP requirement is 8.2`);
  if (intersections.some(i => i.includes('Countable') && i.includes('Iterator'))) {
    issues.push('Consider using IteratorAggregate instead of Countable&Iterator intersection');
  }
  return { file: path.relative(appPath, filePath), class: classM?.[1], intersections: intersections.slice(0, 10), dnfTypes, count: intersections.length + dnfTypes.length, issues };
}

export function listPhpIntersectionTypes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: IntersectionTypeInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseIntersectionTypes(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No PHP 8.1+ intersection types found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `PHP Intersection Types (PHP 8.1+)\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.count - a.count)) {
      text += `\n  ${r.class ?? '(file)'}  intersections: ${r.count}  DNF: ${r.dnfTypes.length}  (${r.file})\n`;
      if (r.intersections.length > 0) text += `    types: ${r.intersections.join(', ')}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIntersectionTypeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: IntersectionTypeInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseIntersectionTypes(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `PHP Intersection Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with intersection types: ${results.length}\nTotal intersection types: ${results.reduce((s, r) => s + r.intersections.length, 0)}\nDNF types (PHP 8.2+): ${results.reduce((s, r) => s + r.dnfTypes.length, 0)}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpIntersectionTypeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_intersection_types', description: 'Detect PHP 8.1 intersection types (TypeA&TypeB) and PHP 8.2 DNF types ((A&B)|null): DNF PHP 8.2 requirement warning, Countable&Iterator suggestion', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_intersection_type_stats', description: 'PHP intersection type statistics: file count, intersection count, DNF count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
