// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FosRestInfo {
  source: string;
  type: 'config' | 'php';
  key: string;
  value: string;
  issue: string | null;
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

function extractYamlValue(content: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*:\\s*([^\\n]{1,200})`);
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function buildFosRestInfos(appPath: string): FosRestInfo[] {
  const results: FosRestInfo[] = [];

  const fosYaml = path.join(appPath, 'config', 'packages', 'fos_rest.yaml');
  if (fs.existsSync(fosYaml)) {
    let content = '';
    try { content = fs.readFileSync(fosYaml, 'utf-8'); } catch { /* skip */ }

    const viewFormats = extractYamlValue(content, 'formats');
    if (viewFormats !== null) {
      const hasJson = viewFormats.includes('json') || content.includes('json:');
      results.push({
        source: 'config/packages/fos_rest.yaml',
        type: 'config',
        key: 'view.formats',
        value: viewFormats.substring(0, 100),
        issue: hasJson ? null : 'view.formats does not include json — API JSON responses will fail; add "json: true" under fos_rest.view.formats',
      });
    }

    const templatingFormats = extractYamlValue(content, 'templating_formats');
    if (templatingFormats !== null) {
      results.push({
        source: 'config/packages/fos_rest.yaml',
        type: 'config',
        key: 'view.templating_formats',
        value: templatingFormats.substring(0, 100),
        issue: null,
      });
    }

    const bodyListenerEnabled = content.includes('body_listener:') && !content.includes('body_listener: false');
    results.push({
      source: 'config/packages/fos_rest.yaml',
      type: 'config',
      key: 'body_listener.enabled',
      value: bodyListenerEnabled ? 'true' : 'false',
      issue: bodyListenerEnabled ? null : 'body_listener.enabled: false — request body will not be deserialized automatically; set body_listener: true to enable JSON/XML body parsing',
    });

    const paramFetcherVal = extractYamlValue(content, 'param_fetcher_listener');
    results.push({
      source: 'config/packages/fos_rest.yaml',
      type: 'config',
      key: 'param_fetcher_listener',
      value: paramFetcherVal ?? 'not set',
      issue: null,
    });

    const exceptionEnabled = content.includes('exception:') && !content.includes('exception: false');
    const exceptionVal = extractYamlValue(content, 'exception');
    results.push({
      source: 'config/packages/fos_rest.yaml',
      type: 'config',
      key: 'exception.enabled',
      value: exceptionVal ?? (exceptionEnabled ? 'true' : 'false'),
      issue: exceptionEnabled ? null : 'exception.enabled: false — FOSRestBundle will not handle exceptions and return proper HTTP error responses; enable for API error handling',
    });

    if (content.includes('include_format: true') || content.includes('include_format:true')) {
      results.push({
        source: 'config/packages/fos_rest.yaml',
        type: 'config',
        key: 'routing_loader.include_format',
        value: 'true',
        issue: 'routing_loader.include_format: true is deprecated — URL format suffixes (.json, .xml) are legacy; use Accept header negotiation and set include_format: false',
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('FOS\\RestBundle') && !content.includes('Rest\\')) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('use FOS\\RestBundle\\')) {
      const importRe = /use FOS\\RestBundle\\[^;]{1,150};/g;
      let im: RegExpExecArray | null;
      while ((im = importRe.exec(content)) !== null) {
        results.push({
          source: relFile,
          type: 'php',
          key: 'import',
          value: im[0].trim(),
          issue: null,
        });
      }
    }

    const attributeRe = /#\[Rest\\(Get|Post|Put|Patch|Delete|View|RequestParam|QueryParam)[^\]]{0,300}\]/g;
    let am: RegExpExecArray | null;
    while ((am = attributeRe.exec(content)) !== null) {
      const attrText = am[0];
      const attrType = am[1];
      let issue: string | null = null;

      if (attrType === 'QueryParam') {
        const requirementsMatch = /requirements\s*=\s*["']([^"']{1,200})["']/.exec(attrText);
        if (requirementsMatch) {
          const req = requirementsMatch[1];
          const hasDangerousQuantifier = /\.\+|\.\*|\([^)]{0,100}\)\+|\([^)]{0,100}\)\*/.test(req);
          if (hasDangerousQuantifier) {
            issue = `@QueryParam requirements="${req}" contains .+ or .* quantifier — potential ReDoS; use bounded patterns like [^\\n]{1,100}`;
          }
        }
      }

      results.push({
        source: relFile,
        type: 'php',
        key: `#[Rest\\${attrType}]`,
        value: attrText.substring(0, 100),
        issue,
      });
    }

    if (content.includes('View::create(') || content.includes('FOSView') || content.includes('$this->view(')) {
      results.push({
        source: relFile,
        type: 'php',
        key: 'View::create',
        value: 'FOSView / View::create() usage detected',
        issue: null,
      });
    }
  }

  return results;
}

export function listFosRestBundle(appPath: string): McpToolResult {
  try {
    const infos = buildFosRestInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No FOSRestBundle configuration or usage found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `FOSRestBundle Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.key}: ${info.value}  (${info.source})\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFosRestBundleStats(appPath: string): McpToolResult {
  try {
    const infos = buildFosRestInfos(appPath);
    let text = `FOSRestBundle Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config entries:  ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `PHP usages:      ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Issues:          ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFosRestBundleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_fos_rest_bundle',
      description: 'Scan FOSRestBundle config (view.formats, body_listener, param_fetcher_listener, exception, include_format) and PHP usage (#[Rest\\Get/Post/View/RequestParam/QueryParam] attributes, View::create); warns on missing json format, body_listener disabled, deprecated include_format, ReDoS in QueryParam requirements',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_fos_rest_bundle_stats',
      description: 'Statistics for FOSRestBundle: config entry count, PHP usage count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
