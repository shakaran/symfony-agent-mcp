// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ExceptionNode {
  class: string;
  parent: string;
  file: string;
  isInterface: boolean;
  httpCode?: number;
  children: string[];
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

function parseExceptionClass(filePath: string, appPath: string): ExceptionNode | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isException = content.includes('Exception') || content.includes('Error') || content.includes('Throwable');
  if (!isException) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace PHPUnit\\') || content.includes('namespace Doctrine\\')) return null;
  const classM = /(?:class|interface)\s+(\w{1,120})\s+extends\s+([\w\\]{1,120}(?:Exception|Error))\b/.exec(content);
  if (!classM) return null;
  const isInterface = content.trimStart().startsWith('interface') || /^interface\s+\w/.test(content);
  const className = classM[1];
  const parent = classM[2];
  const httpCodeM = /(?:HTTP_CODE|STATUS_CODE|statusCode|httpStatusCode)\s*=\s*(\d{3})/.exec(content);
  let httpCode: number | undefined;
  if (httpCodeM) httpCode = parseInt(httpCodeM[1], 10);
  const issues: string[] = [];
  if (!className.endsWith('Exception') && !className.endsWith('Error') && !isInterface) {
    issues.push(`Class "${className}" extends Exception but name doesn't end in Exception/Error — naming convention violation`);
  }
  if (httpCode && (httpCode < 400 || httpCode > 599)) issues.push(`HTTP status code ${httpCode} is not in the 4xx/5xx range`);
  return { class: className, parent, file: path.relative(appPath, filePath), isInterface, httpCode, children: [], issues };
}

export function listCustomExceptionHierarchy(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const nodes: ExceptionNode[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const n = parseExceptionClass(f, appPath);
      if (n) nodes.push(n);
    }
    if (nodes.length === 0) return { content: [{ type: 'text', text: 'No custom exception classes found.' }] };
    const byClass = new Map<string, ExceptionNode>();
    for (const n of nodes) byClass.set(n.class, n);
    for (const n of nodes) {
      const parentNode = byClass.get(n.parent.split('\\').pop() ?? n.parent);
      if (parentNode) parentNode.children.push(n.class);
    }
    const roots = nodes.filter(n => !byClass.has(n.parent.split('\\').pop() ?? n.parent));
    const totalIssues = nodes.reduce((s, n) => s + n.issues.length, 0);
    let text = `Custom Exception Hierarchy\n${'='.repeat(55)}\n\nException classes: ${nodes.length}  Root exceptions: ${roots.length}  Issues: ${totalIssues}\n`;
    for (const root of roots.sort((a, b) => b.children.length - a.children.length)) {
      text += `\n  ${root.class} extends ${root.parent}${root.httpCode ? `  [HTTP ${root.httpCode}]` : ''}\n    children: ${root.children.length > 0 ? root.children.join(', ') : 'none'}\n`;
      for (const i of root.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCustomExceptionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const nodes: ExceptionNode[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const n = parseExceptionClass(f, appPath);
        if (n) nodes.push(n);
      }
    }
    let text = `Custom Exception Statistics\n${'='.repeat(40)}\n\n`;
    text += `Exception classes: ${nodes.length}\n  With HTTP status code: ${nodes.filter(n => n.httpCode).length}\n  Interfaces: ${nodes.filter(n => n.isInterface).length}\nIssues: ${nodes.reduce((s, n) => s + n.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCustomExceptionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_custom_exception_hierarchy', description: 'Map custom Exception/Error class hierarchy: parent classes, children, HTTP status codes, naming convention check, invalid HTTP code warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_custom_exception_stats', description: 'Custom exception statistics: class count, HTTP-status-coded count, interface count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
