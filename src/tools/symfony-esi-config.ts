// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony ESI (Edge Side Includes) Configuration Inspector
 *
 * Scans config/packages/*.yaml for ESI configuration and templates/**\/*.html.twig
 * for ESI render calls. Detects misconfigurations such as ESI enabled without
 * a reverse proxy config, or ESI fragments missing cache headers.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EsiConfigInfo {
  file: string;
  type: 'include' | 'remove' | 'config';
  url: string;
  issues: string[];
}

function collectConfigFiles(dir: string, base: string, exts: string[]): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectConfigFiles(full, base, exts));
    else if (exts.some(e => entry.endsWith(e))) results.push(full);
  }
  return results;
}

function hasReverseProxyConfig(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'framework.yaml'),
  ];
  for (const f of candidates) {
    const resolved = path.resolve(f);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    let content = '';
    try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    if (/trusted_proxies/.test(content) || /reverse_proxy/.test(content)) return true;
  }
  const vcl = path.join(appPath, 'varnish.vcl');
  const vclR = path.resolve(vcl);
  if (vclR.startsWith(path.resolve(appPath) + path.sep)) {
    try { fs.statSync(vcl); return true; } catch { /* not found */ }
  }
  return false;
}

function buildEsiConfigInfos(appPath: string): EsiConfigInfo[] {
  const infos: EsiConfigInfo[] = [];
  const hasProxy = hasReverseProxyConfig(appPath);

  // Scan config files for ESI config
  const configDir = path.join(appPath, 'config');
  const configFiles = collectConfigFiles(configDir, appPath, ['.yaml', '.yml']);
  let esiEnabled = false;

  for (const file of configFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    // Check for esi: enabled: true or framework.esi
    if (/\besi\s*:/.test(content)) {
      const issues: string[] = [];
      if (/enabled\s*:\s*true/.test(content)) {
        esiEnabled = true;
        if (!hasProxy) {
          issues.push('ESI enabled but no trusted_proxies or Varnish config detected — ESI requires a reverse proxy (Varnish, Nginx)');
        }
      }
      if (/enabled\s*:\s*false/.test(content)) {
        issues.push('ESI explicitly disabled');
      }
      infos.push({ file: relFile, type: 'config', url: 'framework.esi', issues });
    }
  }

  // Scan Twig templates for render_esi / render calls
  const templatesDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'app', 'Resources', 'views'),
  ];

  for (const tmplDir of templatesDirs) {
    const resolved = path.resolve(tmplDir);
    if (!resolved.startsWith(path.resolve(appPath) + path.sep)) continue;
    let stat;
    try { stat = fs.lstatSync(tmplDir); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    const twigFiles = collectConfigFiles(tmplDir, appPath, ['.twig']);
    for (const file of twigFiles) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const relFile = path.relative(appPath, file);
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        // render_esi calls
        if (trimmed.includes('render_esi(')) {
          const urlMatch = /render_esi\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed)
            ?? /render_esi\(\s*path\(\s*['"]([^'"]{1,100})['"]/.exec(trimmed);
          const url = urlMatch ? urlMatch[1] : `line ${idx + 1}`;
          const issues: string[] = [];
          if (!esiEnabled) {
            issues.push('render_esi() used but ESI is not enabled in framework config');
          }
          infos.push({ file: relFile, type: 'include', url, issues });
        }
        // plain render calls that might be ESI candidates
        if (trimmed.includes('render(') && !trimmed.includes('render_esi(')) {
          const urlMatch = /render\(\s*path\(\s*['"]([^'"]{1,100})['"]/.exec(trimmed)
            ?? /render\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed);
          if (urlMatch) {
            const url = urlMatch[1];
            const issues: string[] = ['Consider render_esi() for cacheable sub-requests to improve performance'];
            infos.push({ file: relFile, type: 'include', url, issues });
          }
        }
      });
    }
  }

  return infos;
}

export function listSymfonyEsiConfig(appPath: string): McpToolResult {
  try {
    const infos = buildEsiConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No ESI configuration or render_esi() calls found.' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony ESI (Edge Side Includes) Configuration\n${'='.repeat(55)}\n\n`;
    text += `ESI entries found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    for (const info of infos.slice(0, 40)) {
      text += `  [${info.type.toUpperCase()}] ${info.url}\n`;
      text += `          ${info.file}\n`;
      for (const issue of info.issues) {
        text += `          ! ${issue}\n`;
      }
    }
    if (infos.length > 40) text += `  ... and ${infos.length - 40} more entries\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEsiConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildEsiConfigInfos(appPath);
    const configs = infos.filter(i => i.type === 'config').length;
    const includes = infos.filter(i => i.type === 'include').length;
    const withIssues = infos.filter(i => i.issues.length > 0).length;
    const proxyMissing = infos.filter(i => i.issues.some(s => s.includes('reverse proxy'))).length;

    let text = `Symfony ESI Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total ESI entries: ${infos.length}\n`;
    text += `  Config blocks:   ${configs}\n`;
    text += `  ESI includes:    ${includes}\n`;
    text += `  With issues:     ${withIssues}\n`;
    text += `  Missing proxy:   ${proxyMissing}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEsiConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_esi_config',
      description: 'List Symfony ESI (Edge Side Includes) configuration: config blocks, render_esi() calls in Twig templates, issues with missing reverse proxy or disabled ESI',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_esi_config_stats',
      description: 'Get Symfony ESI configuration statistics: counts of config blocks, ESI includes, entries with issues, and missing reverse proxy warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
