import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CspInfo {
  file: string;
  class?: string;
  hasNonce: boolean;
  hasUnsafeInline: boolean;
  hasUnsafeEval: boolean;
  hasStrictDynamic: boolean;
  hasReportUri: boolean;
  hasReportOnly: boolean;
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

function parseCspFile(filePath: string, appPath: string): CspInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const hasCsp = content.includes('Content-Security-Policy') || content.includes('content-security-policy') || content.includes('csp_nonce') || content.includes('csp-nonce') || content.includes('nonce(');
  if (!hasCsp) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  const hasNonce = content.includes('nonce') || content.includes('csp_nonce');
  const hasUnsafeInline = content.includes("'unsafe-inline'");
  const hasUnsafeEval = content.includes("'unsafe-eval'");
  const hasStrictDynamic = content.includes("'strict-dynamic'");
  const hasReportUri = content.includes('report-uri') || content.includes('report-to');
  const hasReportOnly = content.includes('Content-Security-Policy-Report-Only');
  const issues: string[] = [];
  if (hasUnsafeInline && !hasNonce) issues.push("'unsafe-inline' without nonce — inline scripts/styles allowed for all origins; add nonce-based CSP");
  if (hasUnsafeEval) issues.push("'unsafe-eval' allows eval(), new Function() — high XSS risk; remove or replace with a safer pattern");
  if (!hasReportUri && !hasReportOnly) issues.push('No report-uri/report-to directive — CSP violations are silently ignored; add a violation report endpoint');
  if (!hasNonce && !hasStrictDynamic) issues.push('CSP without nonce or strict-dynamic — consider nonce-based policy for stronger protection');
  return { file: path.relative(appPath, filePath), class: classM?.[1], hasNonce, hasUnsafeInline, hasUnsafeEval, hasStrictDynamic, hasReportUri, hasReportOnly, issues };
}

export function listCspConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: CspInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseCspFile(f, appPath);
        if (r) results.push(r);
      }
    }
    if (results.length === 0) return { content: [{ type: 'text', text: "No Content Security Policy implementation found.\n\nExample:\n  $response->headers->set('Content-Security-Policy', \"default-src 'self'; script-src 'nonce-{$nonce}'\");" }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Content Security Policy\n${'='.repeat(55)}\n\nFiles: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        r.hasNonce ? '✓nonce' : '✗nonce',
        r.hasUnsafeInline ? '⚠unsafe-inline' : '',
        r.hasUnsafeEval ? '⚠unsafe-eval' : '',
        r.hasStrictDynamic ? '✓strict-dynamic' : '',
        r.hasReportUri ? '✓report' : '',
        r.hasReportOnly ? 'report-only' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${r.class ?? '(file)'}  ${flags}  (${r.file})\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCspStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: CspInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseCspFile(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `CSP Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with CSP: ${results.length}\n  With nonce: ${results.filter(r => r.hasNonce).length}\n  unsafe-inline: ${results.filter(r => r.hasUnsafeInline).length}\n  unsafe-eval: ${results.filter(r => r.hasUnsafeEval).length}\n  With report-uri: ${results.filter(r => r.hasReportUri).length}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCspTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_csp_config', description: "Detect Content Security Policy implementation: nonce usage, 'unsafe-inline'/'unsafe-eval' risks, strict-dynamic, report-uri/report-to directive, Report-Only mode", inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_csp_stats', description: 'CSP statistics: files count, nonce/unsafe-inline/unsafe-eval/report-uri coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
