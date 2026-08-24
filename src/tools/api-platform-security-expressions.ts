// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SecurityExpressionInfo {
  file: string;
  class: string;
  expressions: Array<{ type: string; expr: string; operation?: string }>;
  usesIsGranted: boolean;
  usesUser: boolean;
  usesObject: boolean;
  usesPreviousObject: boolean;
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

function parseSecurityExpressions(filePath: string, appPath: string): SecurityExpressionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('security:') && !content.includes('securityPostDenormalize') && !content.includes('ApiResource')) return null;
  if (content.includes('namespace ApiPlatform\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const expressions: Array<{ type: string; expr: string; operation?: string }> = [];
  const secRe = /security\s*:\s*['"]([^'"]{1,300})['"]/g;
  const postDenormRe = /securityPostDenormalize\s*:\s*['"]([^'"]{1,300})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(content)) !== null) expressions.push({ type: 'security', expr: m[1] });
  while ((m = postDenormRe.exec(content)) !== null) expressions.push({ type: 'securityPostDenormalize', expr: m[1] });
  if (expressions.length === 0) return null;
  const exprsText = expressions.map(e => e.expr).join(' ');
  const usesIsGranted = exprsText.includes('is_granted(');
  const usesUser = exprsText.includes('user') || exprsText.includes('is_authenticated()');
  const usesObject = exprsText.includes('object');
  const usesPreviousObject = exprsText.includes('previous_object');
  const issues: string[] = [];
  if (expressions.some(e => e.type === 'securityPostDenormalize' && !e.expr.includes('previous_object'))) {
    issues.push('securityPostDenormalize without previous_object — cannot compare original object state; consider using previous_object for ownership checks');
  }
  if (exprsText.includes("is_granted('PUBLIC_ACCESS')")) {
    issues.push("is_granted('PUBLIC_ACCESS') in security expression — this allows any request; use null security or remove expression");
  }
  const writeOps = content.includes('Post') || content.includes('Put') || content.includes('Patch') || content.includes('Delete');
  if (writeOps && !usesUser && !usesIsGranted) {
    issues.push('Write operation without user or is_granted() check in security expression — may be insecure');
  }
  return { file: path.relative(appPath, filePath), class: classM[1], expressions, usesIsGranted, usesUser, usesObject, usesPreviousObject, issues };
}

export function listApiSecurityExpressions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: SecurityExpressionInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseSecurityExpressions(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No API Platform security expressions found.' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `API Platform Security Expressions\n${'='.repeat(55)}\n\nResources: ${results.length}  Expressions: ${results.reduce((s, r) => s + r.expressions.length, 0)}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  is_granted: ${r.usesIsGranted ? '✓' : '✗'}  user: ${r.usesUser ? '✓' : '✗'}  object: ${r.usesObject ? '✓' : '✗'}  previous_object: ${r.usesPreviousObject ? '✓' : '✗'}  (${r.file})\n`;
      for (const e of r.expressions) text += `    [${e.type}]: ${e.expr.substring(0, 80)}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiSecurityExpressionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SecurityExpressionInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseSecurityExpressions(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `API Platform Security Expression Statistics\n${'='.repeat(40)}\n\n`;
    text += `Resources with security expressions: ${results.length}\nTotal expressions: ${results.reduce((s, r) => s + r.expressions.length, 0)}\n  security: ${results.reduce((s, r) => s + r.expressions.filter(e => e.type === 'security').length, 0)}\n  securityPostDenormalize: ${results.reduce((s, r) => s + r.expressions.filter(e => e.type === 'securityPostDenormalize').length, 0)}\nWith is_granted(): ${results.filter(r => r.usesIsGranted).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiSecurityExpressionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_platform_security_expressions', description: 'Analyze per-operation security:/securityPostDenormalize: expressions in #[ApiResource]: is_granted/user/object/previous_object usage, PUBLIC_ACCESS warning, write-without-user-check warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_platform_security_expression_stats', description: 'API Platform security expression statistics: resource count, expression count, security/securityPostDenormalize breakdown, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
