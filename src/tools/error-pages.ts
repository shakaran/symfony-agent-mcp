/**
 * Custom Error Pages & Exception Handling Inspector
 *
 * Scans templates/bundles/TwigBundle/Exception/ for custom error templates:
 *   - error{CODE}.html.twig  (e.g. error404.html.twig, error500.html.twig)
 *   - error.html.twig        (catch-all fallback)
 *
 * Reads framework.error_controller override.
 *
 * Scans src/ for:
 *   - kernel.exception event listeners/subscribers
 *   - Custom ErrorController implementations
 *   - #[AsEventListener(event: 'kernel.exception')] attributes
 *
 * Reports:
 *   - Which HTTP status codes have custom templates
 *   - Which codes are missing (404, 403, 500 are most critical)
 *   - Whether a global catch-all error.html.twig exists
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface ErrorTemplate {
  code: number | 'catch-all';
  file: string;
  path: string;
}

interface ExceptionListener {
  class: string;
  file: string;
  via: 'attribute' | 'yaml' | 'interface';
}

// ─── Template scanning ───────────────────────────────────────────────────────

function scanErrorTemplates(appPath: string): ErrorTemplate[] {
  const dirs = [
    path.join(appPath, 'templates', 'bundles', 'TwigBundle', 'Exception'),
    path.join(appPath, 'templates', 'errors'),
    path.join(appPath, 'templates', 'error'),
  ];

  const templates: ErrorTemplate[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = entry.name;

        if (name === 'error.html.twig') {
          templates.push({ code: 'catch-all', file: name, path: path.join(dir, name) });
          continue;
        }

        const m = /^error(\d{3})\.html\.twig$/.exec(name);
        if (m) {
          templates.push({ code: parseInt(m[1], 10), file: name, path: path.join(dir, name) });
        }
      }
    } catch { /* skip */ }
  }

  return templates.sort((a, b) => {
    if (a.code === 'catch-all') return 1;
    if (b.code === 'catch-all') return -1;
    return (a.code as number) - (b.code as number);
  });
}

// ─── Exception listener scanning ────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanExceptionListeners(appPath: string): ExceptionListener[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const listeners: ExceptionListener[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isListener =
      content.includes('kernel.exception') ||
      content.includes('KernelEvents::EXCEPTION') ||
      (content.includes('ExceptionEvent') && content.includes('function'));

    if (!isListener) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Detect via
    let via: ExceptionListener['via'] = 'interface';
    if (content.includes('#[AsEventListener') && content.includes('kernel.exception')) {
      via = 'attribute';
    } else if (content.includes('getSubscribedEvents') || content.includes('EventSubscriberInterface')) {
      via = 'interface';
    }

    listeners.push({
      class: classM[1],
      file: path.basename(file),
      via,
    });
  }

  return listeners.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Error controller check ──────────────────────────────────────────────────

function readErrorControllerOverride(appPath: string): string | null {
  const frameworkFile = path.join(appPath, 'config', 'packages', 'framework.yaml');
  const raw = parseYamlFile(frameworkFile) as Record<string, unknown> | null;
  if (!raw) return null;

  const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
  const ec = framework['error_controller'];
  return ec ? String(ec) : null;
}

// ─── Tool functions ────────────────────────────────────────────────────────

const IMPORTANT_CODES = [400, 401, 403, 404, 405, 422, 429, 500, 502, 503];
const CODE_LABELS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function listErrorPages(appPath: string): McpToolResult {
  try {
    const templates = scanErrorTemplates(appPath);
    const listeners = scanExceptionListeners(appPath);
    const errorController = readErrorControllerOverride(appPath);

    const coveredCodes = new Set(
      templates
        .filter((t) => t.code !== 'catch-all')
        .map((t) => t.code as number)
    );
    const hasCatchAll = templates.some((t) => t.code === 'catch-all');
    const missingImportant = IMPORTANT_CODES.filter(
      (code) => !coveredCodes.has(code) && !hasCatchAll
    );

    let text = `Custom Error Pages\n${'='.repeat(55)}\n`;

    if (errorController) {
      text += `\nError controller override: ${errorController}\n`;
    }

    if (templates.length === 0) {
      text += `\nNo custom error templates found.\n`;
      text += `Create: templates/bundles/TwigBundle/Exception/error404.html.twig\n`;
      text += `         templates/bundles/TwigBundle/Exception/error500.html.twig\n`;
    } else {
      text += `\nCustom error templates (${templates.length}):\n`;
      for (const t of templates) {
        const label = t.code === 'catch-all'
          ? 'catch-all (all unmatched codes)'
          : `HTTP ${t.code}  ${CODE_LABELS[t.code as number] ?? ''}`;
        text += `  ${String(t.code).padEnd(12)} ${t.file.padEnd(30)} ${label}\n`;
      }
    }

    if (missingImportant.length > 0) {
      text += `\n⚠ Missing critical error templates (no catch-all either):\n`;
      for (const code of missingImportant) {
        text += `   error${code}.html.twig  (${CODE_LABELS[code]})\n`;
      }
    } else if (hasCatchAll) {
      text += `\nerror.html.twig catch-all covers all unmatched HTTP codes.\n`;
    } else {
      text += `\nAll critical error codes covered.\n`;
    }

    if (listeners.length > 0) {
      text += `\nkernel.exception listeners (${listeners.length}):\n`;
      for (const l of listeners) {
        text += `  ${l.class.padEnd(40)} (${l.file})  [${l.via}]\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getErrorPageStats(appPath: string): McpToolResult {
  try {
    const templates = scanErrorTemplates(appPath);
    const listeners = scanExceptionListeners(appPath);

    const coveredCodes = new Set(
      templates
        .filter((t) => t.code !== 'catch-all')
        .map((t) => t.code as number)
    );
    const hasCatchAll  = templates.some((t) => t.code === 'catch-all');
    const missingCount = IMPORTANT_CODES.filter(
      (c) => !coveredCodes.has(c) && !hasCatchAll
    ).length;

    let text = `Error Page Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom templates:      ${templates.length}\n`;
    text += `Catch-all template:    ${hasCatchAll ? 'yes' : 'no'}\n`;
    text += `Missing critical:      ${missingCount}\n`;
    text += `Exception listeners:   ${listeners.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getErrorPageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_error_pages',
      description: 'List custom Twig error templates (error404.html.twig etc.), missing critical codes, kernel.exception listeners, error_controller override',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_error_page_stats',
      description: 'Show error page statistics: custom template count, catch-all presence, missing critical codes, exception listener count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
