/**
 * Symfony Response Types Inspector
 *
 * Scans src/ PHP for response type usage:
 *   - new JsonResponse(, new BinaryFileResponse(, new StreamedResponse(
 *   - new RedirectResponse(, new Response(, new EventStreamResponse(
 *
 * Detects per-file:
 *   - Which response types are used
 *   - JSON without explicit status code in catch blocks
 *   - BinaryFileResponse without setContentDisposition
 *   - StreamedResponse without flush()
 *
 * Warns about:
 *   - JsonResponse without Content-Type json (manual override)
 *   - BinaryFileResponse without Content-Disposition header
 *   - StreamedResponse callback without ob_flush()/flush()
 *   - Multiple redirect response types in same controller (inconsistency)
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

interface ResponseUsage {
  type: string;
  hasStatusCode: boolean;
  issues: string[];
}

interface ResponseTypeInfo {
  file: string;
  class?: string;
  usages: ResponseUsage[];
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

function parseResponseTypeFile(filePath: string, appPath: string): ResponseTypeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const responseTypes = [
    'JsonResponse', 'BinaryFileResponse', 'StreamedResponse',
    'RedirectResponse', 'EventStreamResponse', 'Response',
  ];
  const hasAny = responseTypes.some((t) => content.includes(`new ${t}(`));
  if (!hasAny) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const usages: ResponseUsage[] = [];
  const fileIssues: string[] = [];

  // JsonResponse
  if (content.includes('new JsonResponse(')) {
    const issues: string[] = [];
    // Check for status code — second arg to JsonResponse
    const jM = /new JsonResponse\(([^)]{0,300})\)/.exec(content);
    const args = jM ? jM[1] : '';
    const hasStatusCode = args.includes(',');
    // Check if used in catch block without status code
    if (/catch\s*\([^)]{0,100}\)[^{]{0,20}\{[^}]{0,500}new JsonResponse\(/.test(content)) {
      if (!hasStatusCode) {
        issues.push('JsonResponse in catch block without explicit status code (defaults 200 — should be 4xx/5xx)');
      }
    }
    // Check if Content-Type header is manually overridden (suspicious)
    if (content.includes('JsonResponse') && /->headers->set\([^)]{0,100}Content-Type[^)]{0,100}(?!application\/json)/.test(content)) {
      issues.push('JsonResponse with manual Content-Type override — ensure it remains application/json');
    }
    usages.push({ type: 'JsonResponse', hasStatusCode, issues });
  }

  // BinaryFileResponse
  if (content.includes('new BinaryFileResponse(')) {
    const issues: string[] = [];
    const hasContentDisposition = content.includes('setContentDisposition(') || content.includes('Content-Disposition');
    if (!hasContentDisposition) {
      issues.push('BinaryFileResponse without setContentDisposition() — browser may display instead of download');
    }
    usages.push({ type: 'BinaryFileResponse', hasStatusCode: true, issues });
  }

  // StreamedResponse
  if (content.includes('new StreamedResponse(')) {
    const issues: string[] = [];
    const hasFlush = content.includes('ob_flush()') || content.includes('flush()');
    if (!hasFlush) {
      issues.push('StreamedResponse callback without ob_flush()/flush() — output may not stream to client');
    }
    const bM = /new StreamedResponse\s*\(\s*function[^{]{0,50}\{([^}]{0,500})\}/.exec(content);
    const cbBody = bM ? bM[1] : '';
    if (cbBody && !cbBody.includes('flush')) {
      issues.push('StreamedResponse callback body does not call flush — data may be buffered');
    }
    usages.push({ type: 'StreamedResponse', hasStatusCode: false, issues });
  }

  // RedirectResponse
  const redirectCount = (content.match(/new RedirectResponse\(/g) ?? []).length;
  if (redirectCount > 0) {
    const issues: string[] = [];
    usages.push({ type: 'RedirectResponse', hasStatusCode: false, issues });
  }

  // Check multiple redirect types in same controller
  const hasRedirectResponse = content.includes('new RedirectResponse(');
  const hasRedirectToRoute = content.includes('$this->redirectToRoute(') || content.includes('$this->redirect(');
  if (hasRedirectResponse && hasRedirectToRoute) {
    fileIssues.push('Mixed redirect approaches: new RedirectResponse() and redirectToRoute()/redirect() helper — use one consistently');
  }

  // EventStreamResponse
  if (content.includes('new EventStreamResponse(')) {
    usages.push({ type: 'EventStreamResponse', hasStatusCode: false, issues: [] });
  }

  // Plain Response
  if (content.includes('new Response(') && !content.includes('new JsonResponse(') &&
    !content.includes('new BinaryFileResponse(') && !content.includes('new StreamedResponse(')) {
    const issues: string[] = [];
    usages.push({ type: 'Response', hasStatusCode: /new Response\([^)]{0,300},[^)]{0,100}[1-9]\d\d/.test(content), issues });
  }

  if (usages.length === 0 && fileIssues.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    usages,
    issues: fileIssues,
  };
}

function loadResponseTypeInfos(appPath: string): ResponseTypeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: ResponseTypeInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseResponseTypeFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listResponseTypes(appPath: string): McpToolResult {
  try {
    const infos = loadResponseTypeInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No response type usage found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length + i.usages.reduce((u, v) => u + v.issues.length, 0), 0);
    let text = `Symfony Response Types (${infos.length} files)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      text += '\n';
      for (const u of info.usages) {
        const scTag = u.hasStatusCode ? '' : ' [no status code]';
        text += `    ${u.type}${scTag}\n`;
        for (const issue of u.issues) text += `      WARN: ${issue}\n`;
      }
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getResponseTypeStats(appPath: string): McpToolResult {
  try {
    const infos = loadResponseTypeInfos(appPath);

    const allUsages = infos.flatMap((i) => i.usages);
    let text = `Response Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using response types:    ${infos.length}\n`;
    text += `  JsonResponse:                ${allUsages.filter((u) => u.type === 'JsonResponse').length}\n`;
    text += `  BinaryFileResponse:          ${allUsages.filter((u) => u.type === 'BinaryFileResponse').length}\n`;
    text += `  StreamedResponse:            ${allUsages.filter((u) => u.type === 'StreamedResponse').length}\n`;
    text += `  RedirectResponse:            ${allUsages.filter((u) => u.type === 'RedirectResponse').length}\n`;
    text += `  EventStreamResponse:         ${allUsages.filter((u) => u.type === 'EventStreamResponse').length}\n`;
    text += `  Response (plain):            ${allUsages.filter((u) => u.type === 'Response').length}\n`;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length + i.usages.reduce((u, v) => u + v.issues.length, 0), 0);
    text += `Issues:                        ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getResponseTypeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_response_types',
      description: 'List Symfony response type usage per file: JsonResponse, BinaryFileResponse, StreamedResponse, RedirectResponse, EventStreamResponse, Response; warns about missing status codes, Content-Disposition, flush() calls, mixed redirect styles',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_response_type_stats',
      description: 'Show response type statistics: counts per response type, total issues detected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
