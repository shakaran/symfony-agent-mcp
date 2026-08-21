/**
 * Twig Form Rendering Inspector
 *
 * Detects Twig form rendering function usage in templates and warns on
 * common accessibility and security mistakes.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigFormEntry {
  file: string;
  hasFormStart: boolean;
  hasFormEnd: boolean;
  hasFormRest: boolean;
  issues: string[];
}

// ─── Template scanning ───────────────────────────────────────────────────────

function collectTwigFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTwigFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.html.twig')) {
      results.push(full);
    }
  }
  return results;
}

function countOccurrences(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

function scanTwigFile(file: string, appPath: string): TwigFormEntry | null {
  const content = safeRead(file, appPath);
  if (content === null) return null;

  const hasAnyFormCall =
    /form_row\s*\(/u.test(content) ||
    /form_widget\s*\(/u.test(content) ||
    /form_errors\s*\(/u.test(content) ||
    /form_label\s*\(/u.test(content) ||
    /form_start\s*\(/u.test(content) ||
    /form_end\s*\(/u.test(content) ||
    /form_rest\s*\(/u.test(content) ||
    /form_help\s*\(/u.test(content);

  if (!hasAnyFormCall) return null;

  const hasFormStart = /form_start\s*\(/u.test(content);
  const hasFormEnd = /form_end\s*\(/u.test(content);
  const hasFormRest = /form_rest\s*\(/u.test(content);
  const hasFormWidget = /form_widget\s*\(/u.test(content);
  const hasFormLabel = /form_label\s*\(/u.test(content);
  const hasFormErrors = /form_errors\s*\(/u.test(content);
  const hasFormRow = /form_row\s*\(/u.test(content);

  const issues: string[] = [];

  // form_start() without csrf_protection check
  if (hasFormStart) {
    const hasCsrfCheck =
      /csrf_protection/u.test(content) || /intention/u.test(content);
    if (!hasCsrfCheck) {
      issues.push(
        'form_start() used without any csrf_protection reference — verify CSRF token protection is not disabled for this form'
      );
    }
  }

  // form rendered without form_end()
  if (hasFormStart && !hasFormEnd) {
    issues.push(
      'form_start() present but form_end() is missing — CSRF token (hidden fields) will not be rendered'
    );
  }

  // form_widget without form_label
  if (hasFormWidget && !hasFormLabel && !hasFormRow) {
    issues.push(
      'form_widget() used without form_label() or form_row() — form inputs have no accessible label (WCAG failure)'
    );
  }

  // form_rest() not called — hidden fields and CSRF not rendered
  if ((hasFormStart || hasFormRow || hasFormWidget) && !hasFormRest && !hasFormEnd) {
    issues.push(
      'Neither form_rest() nor form_end() found — hidden fields (including CSRF token) may not be rendered'
    );
  }

  // form_errors() at top without per-field errors — duplicate display
  const errorsBeforeRow =
    hasFormErrors &&
    (content.indexOf('form_errors') < content.indexOf('form_row') ||
      content.indexOf('form_errors') < content.indexOf('form_widget'));

  if (hasFormErrors && errorsBeforeRow && (hasFormRow || hasFormWidget)) {
    issues.push(
      'form_errors() appears before form_row()/form_widget() — errors may be displayed twice (once at top, once per field)'
    );
  }

  // form_row inside a loop without unique id strategy
  const inLoop =
    /\{%\s*for\s+\w{1,60}\s+in\s+\w{1,60}\s*%\}[\s\S]{0,2000}form_row\s*\(/u.test(content);
  if (inLoop) {
    const hasPrototype = /data-prototype/u.test(content);
    if (!hasPrototype) {
      issues.push(
        'form_row() appears inside a {% for %} loop without a data-prototype strategy — duplicate HTML id attributes will break accessibility and JavaScript'
      );
    }
  }

  // form_row count for stats purposes
  const rowCount = countOccurrences(content, /form_row\s*\(/gu);

  return {
    file: path.relative(appPath, file),
    hasFormStart,
    hasFormEnd,
    hasFormRest,
    issues: rowCount > 0 && issues.length === 0
      ? issues
      : issues,
  };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listTwigFormRendering(appPath: string): McpToolResult {
  try {
    const templateDirs = [
      path.join(appPath, 'templates'),
      path.join(appPath, 'src'),
    ];

    const entries: TwigFormEntry[] = [];
    for (const dir of templateDirs) {
      const files = collectTwigFiles(dir);
      for (const file of files) {
        const entry = scanTwigFile(file, appPath);
        if (entry) entries.push(entry);
      }
    }

    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Twig templates with form rendering functions found in templates/.',
        }],
      };
    }

    const withIssues = entries.filter((e) => e.issues.length > 0);

    let text = `Twig Form Rendering Inspector  (${entries.length} templates with forms)\n${'='.repeat(62)}\n`;

    if (withIssues.length === 0) {
      text += `\nAll ${entries.length} form templates look correct.\n`;
    } else {
      text += `\n${withIssues.length} template(s) with issues:\n`;
    }

    for (const e of entries) {
      const prefix = e.issues.length > 0 ? '[!]' : '   ';
      text += `\n${prefix} ${e.file}\n`;
      text += `    form_start: ${e.hasFormStart ? 'yes' : 'no'}  form_end: ${e.hasFormEnd ? 'yes' : 'no'}  form_rest: ${e.hasFormRest ? 'yes' : 'no'}\n`;
      for (const issue of e.issues) {
        text += `    [!] ${issue}\n`;
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

export function getTwigFormRenderingStats(appPath: string): McpToolResult {
  try {
    const templateDirs = [
      path.join(appPath, 'templates'),
      path.join(appPath, 'src'),
    ];

    const entries: TwigFormEntry[] = [];
    for (const dir of templateDirs) {
      const files = collectTwigFiles(dir);
      for (const file of files) {
        const entry = scanTwigFile(file, appPath);
        if (entry) entries.push(entry);
      }
    }

    const withIssues = entries.filter((e) => e.issues.length > 0);
    const missingFormEnd = entries.filter((e) => e.hasFormStart && !e.hasFormEnd);
    const missingFormRest = entries.filter((e) => !e.hasFormRest && !e.hasFormEnd);

    let text = `Twig Form Rendering Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates with form calls:    ${entries.length}\n`;
    text += `Templates with issues:        ${withIssues.length}\n`;
    text += `Missing form_end():           ${missingFormEnd.length}\n`;
    text += `Missing form_rest/form_end(): ${missingFormRest.length}\n`;
    text += `With form_start():            ${entries.filter((e) => e.hasFormStart).length}\n`;
    text += `Total issues:                 ${entries.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getTwigFormRenderingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_twig_form_rendering',
      description: 'Detect Twig form rendering patterns (form_row, form_widget, form_errors, form_label, form_rest, form_start, form_end) and warn on missing CSRF protection, missing form_end, inaccessible forms without labels, missing form_rest, duplicate error display, and form_row in loops without unique id strategy',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_twig_form_rendering_stats',
      description: 'Statistics on Twig form rendering: template count, issues detected, missing form_end/form_rest',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
