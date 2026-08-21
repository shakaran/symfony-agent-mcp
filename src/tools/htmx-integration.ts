import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface HtmxIntegrationInfo {
  file: string;
  type: 'template' | 'controller' | 'csrf' | 'csp' | 'config';
  pattern: string;
  issues: string[];
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

function buildHtmxIntegrationInfos(appPath: string): HtmxIntegrationInfo[] {
  const results: HtmxIntegrationInfo[] = [];

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (!content.includes('hx-') && !content.includes('htmx.js') && !content.includes('htmx.min.js')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const hasHxPost = content.includes('hx-post=') || content.includes('hx-delete=') || content.includes('hx-put=') || content.includes('hx-patch=');
      const hasCsrf = content.includes('csrf') || content.includes('_token') || content.includes("hx-headers='");
      if (hasHxPost && !hasCsrf) {
        issues.push(`hx-post/delete/put/patch in "${relFile}" without CSRF token — HTMX mutating requests bypass Symfony CSRF form token; use hx-headers='{"X-CSRF-Token": "{{ csrf_token(\\'htmx\\') }}"}' or a meta tag approach`);
      }

      const hasHxGetWithSensitive = content.includes('hx-get=') && (content.includes('password') || content.includes('secret') || content.includes('token'));
      if (hasHxGetWithSensitive) {
        issues.push(`hx-get in "${relFile}" with potentially sensitive parameter — GET requests append parameters to URL where they appear in server logs and browser history; use hx-post for sensitive data`);
      }

      const hasInnerHtmlWithUserData = content.includes('hx-swap="innerHTML"') && (content.includes('|raw') || content.includes('raw }'));
      if (hasInnerHtmlWithUserData) {
        issues.push(`hx-swap="innerHTML" with |raw filter in "${relFile}" — if HTMX response contains unescaped user content this creates XSS; escape server-side or use hx-swap="outerHTML" with safe Twig templates`);
      }

      const hasBoost = content.includes('hx-boost="true"') || content.includes("hx-boost='true'");
      const hasNoHistoryReplace = !content.includes('hx-push-url=');
      if (hasBoost && hasNoHistoryReplace) {
        issues.push(`hx-boost in "${relFile}" without hx-push-url strategy — boosted links replace the URL automatically but history.pushState events may conflict with Turbo/Symfony UX; configure explicitly or disable if both are used`);
      }

      results.push({ file: relFile, type: 'template', pattern: 'HTMX attributes', issues });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('HX-Request') && !content.includes('hx-request') && !content.includes('htmx')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasHxCheck = content.includes('HX-Request') || content.includes('isXmlHttpRequest');
            const hasPartialResponse = content.includes('render(') || content.includes('renderView(');
            if (hasHxCheck && hasPartialResponse) {
              const hasFragment = content.includes('fragment') || content.includes('partial') || content.includes('_fragment');
              if (!hasFragment) {
                issues.push(`HTMX controller "${relFile}" returns full rendered template instead of fragment — for hx-get/post HTMX partial renders, return only the relevant fragment using render($template + '.htmx.twig') to avoid sending full page HTML`);
              }
            }

            results.push({ file: relFile, type: 'controller', pattern: 'HTMX controller', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listHtmxIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildHtmxIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HTMX integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `HTMX Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHtmxIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildHtmxIntegrationInfos(appPath);
    let text = `HTMX Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates:   ${infos.filter((i) => i.type === 'template').length}\n`;
    text += `Controllers: ${infos.filter((i) => i.type === 'controller').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHtmxIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_htmx_integration', description: 'Analyze HTMX integration in Symfony templates; warns on hx-post/put/delete without CSRF token, sensitive data in hx-get URL, innerHTML swap with raw filter (XSS risk), full-page response instead of fragment, hx-boost without URL strategy', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_htmx_integration_stats', description: 'Statistics for HTMX integration: template/controller count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
