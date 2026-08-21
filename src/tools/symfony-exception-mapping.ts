/**
 * Symfony Exception Mapping Inspector
 *
 * Distinct from security-scanner.ts (vulnerability scan) and error-pages.ts (template config).
 * Focuses on exception-to-HTTP-status mapping:
 *
 * - Scans src/ PHP for HttpExceptionInterface implementations, HttpException subclasses,
 *   AccessDeniedException / NotFoundHttpException / UnauthorizedHttpException subclasses
 * - Reads twig.yaml / framework.yaml for error template mapping (error404.html.twig etc.)
 *
 * Warnings:
 *   - Custom exception extending RuntimeException without HttpExceptionInterface
 *   - Multiple exceptions mapping to same HTTP code without clear hierarchy
 *   - AccessDeniedException without getAttributes() override
 *   - Exception with HTTP 5xx code without logging guidance
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ExceptionMappingInfo {
  file: string;
  class: string;
  parent: string;
  statusCode?: number;
  implementsHttpException: boolean;
  hasHeaders: boolean;
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

const HTTP_EXCEPTION_PARENTS = [
  'HttpException',
  'NotFoundHttpException',
  'AccessDeniedException',
  'UnauthorizedHttpException',
  'BadRequestHttpException',
  'ConflictHttpException',
  'GoneHttpException',
  'LengthRequiredHttpException',
  'MethodNotAllowedHttpException',
  'NotAcceptableHttpException',
  'PreconditionFailedHttpException',
  'PreconditionRequiredHttpException',
  'ServiceUnavailableHttpException',
  'TooManyRequestsHttpException',
  'UnprocessableEntityHttpException',
  'UnsupportedMediaTypeHttpException',
];

const STATUS_CODE_MAP: Record<string, number> = {
  NotFoundHttpException: 404,
  AccessDeniedException: 403,
  UnauthorizedHttpException: 401,
  BadRequestHttpException: 400,
  ConflictHttpException: 409,
  GoneHttpException: 410,
  LengthRequiredHttpException: 411,
  MethodNotAllowedHttpException: 405,
  NotAcceptableHttpException: 406,
  PreconditionFailedHttpException: 412,
  PreconditionRequiredHttpException: 428,
  ServiceUnavailableHttpException: 503,
  TooManyRequestsHttpException: 429,
  UnprocessableEntityHttpException: 422,
  UnsupportedMediaTypeHttpException: 415,
};

function parseExceptionFile(filePath: string): ExceptionMappingInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('Exception') && !content.includes('Error')) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})\s+extends\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const parentName = classM[2];

  const isHttpParent = HTTP_EXCEPTION_PARENTS.some((p) => parentName === p || parentName.includes(p));
  const implementsHttpException =
    isHttpParent ||
    content.includes('HttpExceptionInterface') ||
    /implements[^{]{0,200}HttpExceptionInterface/.test(content);

  const hasGetStatusCode = content.includes('getStatusCode()') || content.includes('getStatusCode ():');
  const hasHeaders = content.includes('getHeaders()') || content.includes('getHeaders ():');

  let statusCode: number | undefined = STATUS_CODE_MAP[parentName];

  if (!statusCode) {
    const scMatch = /getStatusCode[^{]{0,50}\{[^}]{0,200}return\s+(\d{3})/.exec(content);
    if (scMatch) statusCode = parseInt(scMatch[1], 10);
  }

  if (!statusCode && hasGetStatusCode) {
    const constMatch = /(?:HTTP_\w{1,50}|self::\w{1,50}STATUS\w{0,30})\s*=\s*(\d{3})/.exec(content);
    if (constMatch) statusCode = parseInt(constMatch[1], 10);
  }

  const issues: string[] = [];

  if (!implementsHttpException) {
    const isRuntimeOrException = parentName === 'RuntimeException' ||
      parentName === 'Exception' ||
      parentName === 'LogicException' ||
      parentName === 'InvalidArgumentException' ||
      parentName.endsWith('Exception');
    if (isRuntimeOrException) {
      issues.push(`Extends ${parentName} without HttpExceptionInterface — won't be mapped to HTTP status automatically`);
    }
  }

  if (implementsHttpException && parentName === 'AccessDeniedException') {
    if (!content.includes('getAttributes()') && !content.includes('getAttributes ():')) {
      issues.push('AccessDeniedException subclass without getAttributes() override — generic 403 message');
    }
  }

  if (statusCode && statusCode >= 500) {
    const hasLogging = content.includes('logger') || content.includes('Logger') || content.includes('log(');
    if (!hasLogging) {
      issues.push(`HTTP ${statusCode} (5xx) exception without server-side logging detected`);
    }
  }

  return {
    file: path.basename(filePath),
    class: className,
    parent: parentName,
    statusCode,
    implementsHttpException,
    hasHeaders,
    issues,
  };
}

function scanExceptions(appPath: string): ExceptionMappingInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: ExceptionMappingInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseExceptionFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function loadErrorTemplates(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'twig.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];
  const templates: string[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const twigRaw = (raw['twig'] ?? raw) as Record<string, unknown>;
    const exceptionsBlock = twigRaw['exception_controller'];
    if (exceptionsBlock) templates.push(String(exceptionsBlock));
  }
  const templatesDir = path.join(appPath, 'templates', 'bundles', 'TwigBundle', 'Exception');
  try {
    for (const entry of fs.readdirSync(templatesDir)) {
      if (entry.endsWith('.html.twig')) templates.push(entry);
    }
  } catch { /* skip */ }
  return templates;
}

function detectDuplicateStatusCodes(exceptions: ExceptionMappingInfo[]): Map<number, string[]> {
  const codeMap = new Map<number, string[]>();
  for (const ex of exceptions) {
    if (ex.statusCode !== undefined) {
      const existing = codeMap.get(ex.statusCode) ?? [];
      existing.push(ex.class);
      codeMap.set(ex.statusCode, existing);
    }
  }
  return codeMap;
}

export function listExceptionMapping(appPath: string): McpToolResult {
  try {
    const exceptions = scanExceptions(appPath);
    const errorTemplates = loadErrorTemplates(appPath);

    if (exceptions.length === 0) {
      return { content: [{ type: 'text', text: 'No exception classes found in src/.' }] };
    }

    const duplicates = detectDuplicateStatusCodes(exceptions);
    const totalIssues = exceptions.reduce((s, e) => s + e.issues.length, 0);

    let text = `Exception Mapping\n${'='.repeat(55)}\n`;
    text += `\nExceptions: ${exceptions.length}  Issues: ${totalIssues}\n`;

    const httpExceptions = exceptions.filter((e) => e.implementsHttpException);
    const nonHttpExceptions = exceptions.filter((e) => !e.implementsHttpException);

    if (httpExceptions.length > 0) {
      text += `\nHTTP-mapped exceptions (${httpExceptions.length}):\n`;
      for (const ex of httpExceptions) {
        const code = ex.statusCode ? ` [HTTP ${ex.statusCode}]` : '';
        const headers = ex.hasHeaders ? ' +headers' : '';
        text += `  ${ex.class.padEnd(45)} extends ${ex.parent}${code}${headers}  (${ex.file})\n`;
        for (const issue of ex.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (nonHttpExceptions.length > 0) {
      text += `\nNon-HTTP exceptions (${nonHttpExceptions.length}):\n`;
      for (const ex of nonHttpExceptions) {
        text += `  ${ex.class.padEnd(45)} extends ${ex.parent}  (${ex.file})\n`;
        for (const issue of ex.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    const dupCodes = [...duplicates.entries()].filter(([, cls]) => cls.length > 1);
    if (dupCodes.length > 0) {
      text += `\nDuplicate HTTP status codes:\n`;
      for (const [code, classes] of dupCodes) {
        text += `  HTTP ${code}: ${classes.join(', ')}\n`;
      }
    }

    if (errorTemplates.length > 0) {
      text += `\nError templates: ${errorTemplates.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getExceptionMappingStats(appPath: string): McpToolResult {
  try {
    const exceptions = scanExceptions(appPath);
    const errorTemplates = loadErrorTemplates(appPath);

    let text = `Exception Mapping Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total exception classes: ${exceptions.length}\n`;
    text += `  HTTP-mapped:           ${exceptions.filter((e) => e.implementsHttpException).length}\n`;
    text += `  Non-HTTP:              ${exceptions.filter((e) => !e.implementsHttpException).length}\n`;
    text += `  With status code:      ${exceptions.filter((e) => e.statusCode !== undefined).length}\n`;
    text += `  With custom headers:   ${exceptions.filter((e) => e.hasHeaders).length}\n`;
    text += `  5xx exceptions:        ${exceptions.filter((e) => e.statusCode && e.statusCode >= 500).length}\n`;
    text += `Error templates:         ${errorTemplates.length}\n`;
    text += `Issues:                  ${exceptions.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getExceptionMappingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_exception_mapping',
      description: 'Show Symfony exception-to-HTTP mapping: HttpExceptionInterface implementations, HttpException subclasses with status codes, AccessDeniedException/NotFoundHttpException hierarchy, error templates; warns on RuntimeException without HTTP mapping, duplicate status codes, missing getAttributes() on AccessDeniedException, 5xx without logging',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_exception_mapping_stats',
      description: 'Show exception mapping statistics: total count, HTTP-mapped vs non-HTTP, status code coverage, custom headers count, 5xx count, error template count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
