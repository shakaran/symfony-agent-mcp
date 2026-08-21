/**
 * API Platform Error Handling Inspector
 *
 * Reads config/packages/api_platform.yaml for:
 *   - error_formats, exception_to_status map, formats
 *
 * Scans src/ PHP for:
 *   - ApiException/ApiPlatformException throws
 *   - Classes implementing NormalizerInterface for Exception types
 *   - ProblemDetailsFactory custom implementations
 *   - ErrorNormalizerInterface implementations
 *
 * Warns about:
 *   - exception_to_status mapping 500 (exposes internal errors as-is)
 *   - error_formats including html in production (exposes stack traces)
 *   - ApiException without status code (defaults to 500)
 *   - Custom normalizer for exceptions without checking instanceof
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

interface ExceptionMapping {
  exception: string;
  status: number;
}

interface ApiErrorHandlingInfo {
  errorFormats: string[];
  exceptionMappings: ExceptionMapping[];
  hasCustomNormalizer: boolean;
  hasProblemDetails: boolean;
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

function readApiPlatformConfig(appPath: string): Record<string, unknown> | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'api_platform.yaml'),
    path.join(appPath, 'config', 'packages', 'api_platform.yml'),
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf-8');
      return { _raw: content, _path: candidate };
    } catch { /* skip */ }
  }
  return null;
}

function extractErrorFormats(rawContent: string): string[] {
  const formats: string[] = [];
  // Match error_formats block
  const errorFormatsM = /error_formats\s*:([\s\S]{0,500}?)(?:\n\s{0,4}\w|$)/.exec(rawContent);
  if (!errorFormatsM) return formats;
  const block = errorFormatsM[1];
  const fmtRe = /^\s{0,10}(\w{1,30})\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = fmtRe.exec(block)) !== null) {
    if (!formats.includes(m[1])) formats.push(m[1]);
  }
  return formats;
}

function extractExceptionMappings(rawContent: string): ExceptionMapping[] {
  const mappings: ExceptionMapping[] = [];
  // Match exception_to_status block
  const blockM = /exception_to_status\s*:([\s\S]{0,2000}?)(?:\n\s{0,4}\w|$)/.exec(rawContent);
  if (!blockM) return mappings;
  const block = blockM[1];
  const lineRe = /(['"]?)([A-Za-z\\]{1,200})\1\s*:\s*(\d{3})/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(block)) !== null) {
    mappings.push({ exception: m[2], status: parseInt(m[3], 10) });
  }
  return mappings;
}

function scanApiErrorPhpFiles(appPath: string): { hasCustomNormalizer: boolean; hasProblemDetails: boolean; phpIssues: string[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { hasCustomNormalizer: false, hasProblemDetails: false, phpIssues: [] };

  let hasCustomNormalizer = false;
  let hasProblemDetails = false;
  const phpIssues: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    // Check for Exception normalizer
    if (content.includes('NormalizerInterface') && content.includes('implements') &&
      /implements[^{]{0,200}NormalizerInterface/.test(content)) {
      const supportsM = /function\s+supportsNormalization[^{]{0,100}\{([^}]{0,500})\}/s.exec(content);
      if (supportsM && (supportsM[1].includes('Exception') || supportsM[1].includes('Throwable'))) {
        hasCustomNormalizer = true;
        // Check instanceof usage
        if (!supportsM[1].includes('instanceof')) {
          phpIssues.push(`${path.basename(file)}: Custom exception normalizer supportsNormalization() without instanceof check — may normalize unintended objects`);
        }
      }
    }

    // Check ProblemDetailsFactory
    if (content.includes('ProblemDetailsFactory') && content.includes('implements')) {
      hasProblemDetails = true;
    }

    // Check ErrorNormalizerInterface
    if (content.includes('ErrorNormalizerInterface') && content.includes('implements')) {
      hasCustomNormalizer = true;
    }

    // Check ApiException throw without status
    if ((content.includes('ApiException') || content.includes('ApiPlatformException')) && content.includes('throw new')) {
      const throwRe = /throw\s+new\s+(?:ApiException|ApiPlatformException)\s*\([^)]{0,300}\)/g;
      let tm: RegExpExecArray | null;
      while ((tm = throwRe.exec(content)) !== null) {
        const throwStr = tm[0];
        // Check if status code (3xx or 4xx or 5xx) is in the args
        if (!/[345]\d{2}/.test(throwStr)) {
          phpIssues.push(`${path.basename(file)}: ApiException thrown without explicit status code — defaults to 500`);
          break;
        }
      }
    }
  }

  return { hasCustomNormalizer, hasProblemDetails, phpIssues };
}

function buildApiErrorInfo(appPath: string): ApiErrorHandlingInfo {
  const configData = readApiPlatformConfig(appPath);
  const issues: string[] = [];

  let errorFormats: string[] = [];
  let exceptionMappings: ExceptionMapping[] = [];

  if (configData) {
    const rawContent = configData['_raw'] as string;
    errorFormats = extractErrorFormats(rawContent);
    exceptionMappings = extractExceptionMappings(rawContent);

    // Warn on 500 mappings
    for (const mapping of exceptionMappings) {
      if (mapping.status >= 500) {
        issues.push(`exception_to_status maps ${mapping.exception} to ${mapping.status} — exposes internal errors; prefer 4xx for client-facing exceptions`);
      }
    }

    // Warn on html in error_formats
    if (errorFormats.includes('html') || rawContent.includes("'html'") || rawContent.includes('"html"')) {
      issues.push('error_formats includes html — exposes stack traces in production; restrict to json/jsonld/jsonproblem');
    }

    if (errorFormats.length === 0 && !rawContent.includes('error_formats')) {
      issues.push('No error_formats configured — defaults may expose stack traces in HTML; set error_formats explicitly');
    }
  } else {
    issues.push('No api_platform.yaml found — cannot verify error_formats and exception_to_status configuration');
  }

  const { hasCustomNormalizer, hasProblemDetails, phpIssues } = scanApiErrorPhpFiles(appPath);
  issues.push(...phpIssues);

  return {
    errorFormats,
    exceptionMappings,
    hasCustomNormalizer,
    hasProblemDetails,
    issues,
  };
}

export function listApiPlatformErrorHandling(appPath: string): McpToolResult {
  try {
    const info = buildApiErrorInfo(appPath);

    let text = `API Platform Error Handling\n${'='.repeat(55)}\n`;

    if (info.errorFormats.length > 0) {
      text += `\nError formats: ${info.errorFormats.join(', ')}\n`;
    } else {
      text += `\nError formats: (not configured or using defaults)\n`;
    }

    if (info.exceptionMappings.length > 0) {
      text += `\nException to status mappings (${info.exceptionMappings.length}):\n`;
      for (const m of info.exceptionMappings) {
        const warn = m.status >= 500 ? '  [WARN: 5xx]' : '';
        text += `  ${m.exception.padEnd(60)} → ${m.status}${warn}\n`;
      }
    } else {
      text += `\nException to status mappings: (none configured)\n`;
    }

    text += `\nCustom exception normalizer: ${info.hasCustomNormalizer ? 'yes' : 'no'}\n`;
    text += `Custom ProblemDetailsFactory: ${info.hasProblemDetails ? 'yes' : 'no'}\n`;

    if (info.issues.length > 0) {
      text += `\nIssues (${info.issues.length}):\n`;
      for (const issue of info.issues) {
        text += `  WARN: ${issue}\n`;
      }
    } else {
      text += `\nNo issues detected.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPlatformErrorHandlingStats(appPath: string): McpToolResult {
  try {
    const info = buildApiErrorInfo(appPath);

    let text = `API Platform Error Handling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Error formats configured:    ${info.errorFormats.length}\n`;
    text += `Exception mappings:          ${info.exceptionMappings.length}\n`;
    text += `  5xx mappings:              ${info.exceptionMappings.filter((m) => m.status >= 500).length}\n`;
    text += `Custom exception normalizer: ${info.hasCustomNormalizer ? 'yes' : 'no'}\n`;
    text += `Custom ProblemDetails:       ${info.hasProblemDetails ? 'yes' : 'no'}\n`;
    text += `Issues:                      ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getApiPlatformErrorHandlingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_api_platform_error_handling',
      description: 'Audit API Platform error handling: error_formats and exception_to_status from api_platform.yaml, custom exception normalizers, ProblemDetailsFactory, HTML format warning, 5xx mapping detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_api_platform_error_handling_stats',
      description: 'Show API Platform error handling statistics: error format count, exception mapping count, 5xx mappings, custom normalizer presence, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
