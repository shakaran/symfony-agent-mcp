import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FormAjaxInfo {
  file: string;
  type: 'turbo' | 'live' | 'xhr' | 'fetch';
  pattern: string;
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildFormAjaxInfos(appPath: string): FormAjaxInfo[] {
  const results: FormAjaxInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const templatesDir = path.join(appPath, 'templates');

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('TurboStreamResponse') || content.includes("'application/vnd.turbo-stream.html'")) {
        const hasCsrf = content.includes('csrf') || content.includes('_token') || content.includes('getToken(');
        if (!hasCsrf) {
          issues.push('TurboStreamResponse returned without CSRF token validation — Turbo Stream forms bypass CSRF if not validated server-side');
        }
        results.push({ file: relFile, type: 'turbo', pattern: 'TurboStreamResponse', issues });
      }

      const isLiveComponent = content.includes('#[AsLiveComponent]') && content.includes('form');
      if (isLiveComponent) {
        const hasLiveAction = content.includes('#[LiveAction]') || content.includes('LiveAction');
        if (!hasLiveAction) {
          issues.push('LiveComponent with form but no #[LiveAction] on submit handler — form submission not wired to server action');
        }
        results.push({ file: relFile, type: 'live', pattern: '#[AsLiveComponent] form', issues });
      }

      const hasXhrCheck = content.includes('isXmlHttpRequest()') || content.includes('X-Requested-With');
      if (hasXhrCheck) {
        const hasMethodCheck = content.includes("isMethod('POST')") || content.includes('isMethod("POST")') ||
          content.includes('getMethod()') || content.includes('->isMethod(');
        if (!hasMethodCheck) {
          issues.push('XHR detection without HTTP method check — GET requests with X-Requested-With header will also match');
        }
        results.push({ file: relFile, type: 'xhr', pattern: 'isXmlHttpRequest()', issues });
      }
    }
  }

  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('<turbo-stream') || content.includes('stream-target') || content.includes("turbo-stream")) {
        const hasCsrfInput = content.includes('csrf_token') || content.includes('_token') || content.includes('csrf_field()');
        if (!hasCsrfInput && content.includes('<form')) {
          issues.push(`Turbo Stream template "${relFile}" contains form without csrf_token field`);
        }
        results.push({ file: relFile, type: 'turbo', pattern: '<turbo-stream>', issues });
      }

      if (content.includes('data-controller') && content.includes('fetch(')) {
        results.push({ file: relFile, type: 'fetch', pattern: 'Stimulus fetch() form', issues: [] });
      }
    }
  }

  return results;
}

export function listSymfonyFormAjax(appPath: string): McpToolResult {
  try {
    const infos = buildFormAjaxInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Ajax form patterns found (no TurboStreamResponse, LiveComponent, XHR detection).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Ajax Form Analysis\n${'='.repeat(50)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormAjaxStats(appPath: string): McpToolResult {
  try {
    const infos = buildFormAjaxInfos(appPath);
    let text = `Ajax Form Statistics\n${'='.repeat(40)}\n\n`;
    text += `Turbo:   ${infos.filter((i) => i.type === 'turbo').length}\n`;
    text += `Live:    ${infos.filter((i) => i.type === 'live').length}\n`;
    text += `XHR:     ${infos.filter((i) => i.type === 'xhr').length}\n`;
    text += `Fetch:   ${infos.filter((i) => i.type === 'fetch').length}\n`;
    text += `Issues:  ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormAjaxTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_form_ajax', description: 'Detect Ajax form patterns (Turbo Stream, LiveComponent, XHR, Fetch); warns on TurboStream without CSRF, LiveComponent without #[LiveAction], XHR without method check', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_form_ajax_stats', description: 'Statistics for Ajax forms: turbo/live/xhr/fetch count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
