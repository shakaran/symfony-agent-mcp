// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ProblemDetailsInfo {
  file: string;
  type: 'response' | 'exception' | 'listener' | 'serializer';
  fields: string[];
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

function buildProblemDetailsInfos(appPath: string): ProblemDetailsInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ProblemDetailsInfo[] = [];

  let hasCrelloLibrary = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['crell/api-problem'] || req['api-problem/api-problem'] || req['symfony/problem']) hasCrelloLibrary = true;
    } catch { /* ignore */ }
  }

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const hasProblemJson = content.includes("'application/problem+json'") || content.includes('"application/problem+json"') ||
      (content.includes("'type'") || content.includes('"type"') && content.includes("'title'") || content.includes('"title"') && content.includes("'status'") || content.includes('"status"') && content.includes("'detail'") || content.includes('"detail"'));

    if (!hasProblemJson) continue;

    const fields: string[] = [];
    const rfc7807Fields = ['type', 'title', 'status', 'detail', 'instance'];
    for (const f of rfc7807Fields) {
      if (content.includes(`'${f}'`) || content.includes(`"${f}"`)) fields.push(f);
    }

    const isResponse = content.includes('JsonResponse') || content.includes('Response(') || content.includes('$response');
    const isListener = content.includes('onException') || content.includes('ExceptionEvent') || content.includes('ExceptionListener');
    const isMapper = content.includes('ExceptionMapperInterface') || content.includes('MapperInterface');

    if (!fields.includes('type')) {
      issues.push('RFC 7807 problem detail response missing "type" field — RFC MUST requirement (use "about:blank" if no specific URI)');
    }

    if (content.includes("'application/json'") || content.includes('"application/json"') && !content.includes("'application/problem+json'")) {
      issues.push('Error response served as application/json instead of application/problem+json — use correct Content-Type for RFC 7807 compliance');
    }

    const statusInBody = /['"]status['"]\s*=>\s*\d{3}/.test(content);
    const statusInResponse = /new JsonResponse\([^,]{0,300},\s*\d{3}/.test(content) || /->setStatusCode\(\d{3}\)/.test(content);
    if (statusInBody && statusInResponse) {
      const bodyMatch = /['"]status['"]\s*=>\s*(\d{3})/.exec(content);
      const respMatch = /new JsonResponse\([^,]{0,300},\s*(\d{3})/.exec(content);
      if (bodyMatch && respMatch && bodyMatch[1] !== respMatch[1]) {
        issues.push('HTTP status code in body differs from HTTP response status code — contradictory');
      }
    }

    if (content.includes('stack_trace') || content.includes('trace') || content.includes('exception->getMessage()')) {
      issues.push('Problem details response may include stack trace or exception message — information disclosure risk in production');
    }

    const type = isMapper ? 'exception' : isListener ? 'listener' : isResponse ? 'response' : 'serializer';
    results.push({ file: relFile, type, fields, issues });
  }

  if (!hasCrelloLibrary && results.length > 0) {
    results.unshift({ file: 'composer.json', type: 'serializer', fields: [], issues: ['Manual problem detail implementation found — consider crell/api-problem or symfony/problem library for RFC 7807 compliance'] });
  }

  return results;
}

export function listApiProblemDetails(appPath: string): McpToolResult {
  try {
    const infos = buildProblemDetailsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No RFC 7807 Problem Details patterns found (no application/problem+json content type).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Problem Details (RFC 7807) Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] fields: ${info.fields.join(', ') || '(none)'}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiProblemDetailsStats(appPath: string): McpToolResult {
  try {
    const infos = buildProblemDetailsInfos(appPath);
    let text = `Problem Details Statistics\n${'='.repeat(40)}\n\n`;
    text += `Responses:   ${infos.filter((i) => i.type === 'response').length}\n`;
    text += `Exceptions:  ${infos.filter((i) => i.type === 'exception').length}\n`;
    text += `Listeners:   ${infos.filter((i) => i.type === 'listener').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiProblemDetailsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_problem_details', description: 'Detect RFC 7807 Problem Details usage; warns on missing "type" field, wrong Content-Type, contradictory status codes, stack trace in response', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_problem_details_stats', description: 'Statistics for Problem Details: response/exception/listener count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
