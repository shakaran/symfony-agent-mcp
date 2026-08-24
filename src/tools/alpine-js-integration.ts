// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface AlpineJsInfo {
  file: string;
  type: 'template' | 'security' | 'csp' | 'config';
  pattern: string;
  issues: string[];
}

function getAllHtmlTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllHtmlTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildAlpineJsInfos(appPath: string): AlpineJsInfo[] {
  const results: AlpineJsInfo[] = [];

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllHtmlTwigFiles(templatesDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;
      if (!content.includes('x-data') && !content.includes('x-show') && !content.includes('x-model') && !content.includes('alpine')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const hasXDataWithTwigOutput = /x-data=["'][^"']*{{/.test(content) || /x-data=['"][^'"]*\|raw/.test(content);
      if (hasXDataWithTwigOutput) {
        issues.push(`x-data attribute in "${relFile}" contains Twig expression — if the Twig variable contains user input this creates a JavaScript injection vector; JSON encode Twig values: x-data='{{ someArray|json_encode }}'`);
      }

      const hasXHtml = content.includes('x-html=') || content.includes(':innerHTML=');
      if (hasXHtml) {
        issues.push(`x-html directive in "${relFile}" renders HTML without sanitization — equivalent to innerHTML; if content comes from user input this is an XSS vulnerability; use x-text for plain text or sanitize HTML before binding`);
      }

      const hasEval = /x-on:[^=]+=["'][^"']*\$eval\(/.test(content) || content.includes('Alpine.evaluate');
      if (hasEval) {
        issues.push(`Alpine.js $eval() or Alpine.evaluate() in "${relFile}" — dynamic code evaluation with user-controlled strings is an XSS risk; avoid evaluating user-supplied code`);
      }

      const hasUnsafeFetch = content.includes('@click') && content.includes('fetch(') && content.includes('innerHTML');
      if (hasUnsafeFetch) {
        issues.push(`Alpine.js fetch() result assigned to innerHTML in "${relFile}" — fetched HTML inserted directly into DOM without sanitization; use x-html only with trusted server-rendered fragments or sanitize first`);
      }

      const hasXModelWithPassword = content.includes('x-model') && content.includes('type="password"');
      if (hasXModelWithPassword) {
        issues.push(`x-model bound to password input in "${relFile}" — password value stored in Alpine reactive data is visible in Vue/Alpine devtools; consider not binding passwords to reactive state`);
      }

      results.push({ file: relFile, type: 'template', pattern: 'Alpine.js directives', issues });
    }
  }

  const nelmioYaml = path.join(appPath, 'config', 'packages', 'nelmio_security.yaml');
  if (fs.existsSync(nelmioYaml)) {
    let content = '';
    try { content = fs.readFileSync(nelmioYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('Content-Security-Policy') || content.includes('csp')) {
      const hasUnsafeEval = content.includes("'unsafe-eval'");
      if (!hasUnsafeEval) {
        const templatesHaveEval = results.some((r) => r.issues.some((i) => i.includes('$eval')));
        if (!templatesHaveEval) {
          results.push({ file: 'nelmio_security.yaml', type: 'csp', pattern: 'CSP without unsafe-eval', issues: [] });
        }
      } else {
        results.push({ file: 'nelmio_security.yaml', type: 'csp', pattern: 'CSP with unsafe-eval', issues: ["CSP includes 'unsafe-eval' — Alpine.js v3 does not require unsafe-eval; check if another library needs it and remove if possible to strengthen CSP"] });
      }
    }
  }

  return results;
}

export function listAlpineJsIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildAlpineJsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Alpine.js integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Alpine.js Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAlpineJsIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildAlpineJsInfos(appPath);
    let text = `Alpine.js Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates:  ${infos.filter((i) => i.type === 'template').length}\n`;
    text += `CSP:        ${infos.filter((i) => i.type === 'csp').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAlpineJsIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_alpine_js_integration', description: 'Analyze Alpine.js integration in Symfony templates; warns on x-data with Twig expression (JS injection), x-html XSS risk, $eval with user data, fetch result to innerHTML, password in x-model, CSP with unsafe-eval', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_alpine_js_integration_stats', description: 'Statistics for Alpine.js integration: template/CSP count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
