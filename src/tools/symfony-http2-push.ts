// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTTP/2 Server Push Inspector
 *
 * Scans src/**\/*.php for WebLink component usage (addLink, preload, prefetch,
 * dnsPrefetch) and config/ for web_link configuration.
 * Detects rel=preload Link headers in controllers.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface Http2PushInfo {
  file: string;
  type: 'preload' | 'prefetch' | 'preconnect';
  resource: string;
  asType: string;
}

function collectPhpFiles(dir: string, base: string): string[] {
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
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
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

function inferAsType(resource: string): string {
  if (/\.(css)(\?|$)/.test(resource)) return 'style';
  if (/\.(js|mjs)(\?|$)/.test(resource)) return 'script';
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(resource)) return 'font';
  if (/\.(png|jpg|jpeg|webp|avif|svg|gif)(\?|$)/.test(resource)) return 'image';
  return 'fetch';
}

function buildHttp2PushInfos(appPath: string): Http2PushInfo[] {
  const infos: Http2PushInfo[] = [];

  // Scan PHP source files
  const srcDir = path.join(appPath, 'src');
  const srcDirR = path.resolve(srcDir);
  if (srcDirR.startsWith(path.resolve(appPath) + path.sep)) {
    let srcStat;
    try { srcStat = fs.lstatSync(srcDir); } catch { srcStat = null; }
    if (srcStat && srcStat.isSymbolicLink()) srcStat = null;
    if (srcStat && srcStat.isDirectory()) {
      for (const file of collectPhpFiles(srcDir, appPath)) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        const relFile = path.relative(appPath, file);

        // Check if WebLink is used
        if (!content.includes('WebLink') && !content.includes('addLink') &&
            !content.includes('preload(') && !content.includes('prefetch(') &&
            !content.includes('dnsPrefetch(') && !content.includes('rel=preload')) {
          continue;
        }

        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();

          // preload() calls
          if (/\bpreload\s*\(/.test(trimmed)) {
            const resMatch = /preload\s*\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed);
            const resource = resMatch ? resMatch[1] : 'dynamic';
            infos.push({ file: relFile, type: 'preload', resource, asType: inferAsType(resource) });
          }

          // prefetch() calls
          if (/\bprefetch\s*\(/.test(trimmed)) {
            const resMatch = /prefetch\s*\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed);
            const resource = resMatch ? resMatch[1] : 'dynamic';
            infos.push({ file: relFile, type: 'prefetch', resource, asType: inferAsType(resource) });
          }

          // dnsPrefetch() calls
          if (/\bdnsPrefetch\s*\(/.test(trimmed)) {
            const resMatch = /dnsPrefetch\s*\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed);
            const resource = resMatch ? resMatch[1] : 'dynamic';
            infos.push({ file: relFile, type: 'preconnect', resource, asType: 'dns' });
          }

          // addLink with rel=preload
          if (/\baddLink\s*\(/.test(trimmed) && /rel\s*=\s*['"]?preload/.test(trimmed)) {
            const resMatch = /addLink\s*\(\s*['"]([^'"]{1,200})['"]/.exec(trimmed);
            const resource = resMatch ? resMatch[1] : 'dynamic';
            infos.push({ file: relFile, type: 'preload', resource, asType: inferAsType(resource) });
          }

          // Link header with rel=preload
          if (/Link.*rel=preload/.test(trimmed) || /rel=preload.*Link/.test(trimmed)) {
            const resMatch = /<([^>]{1,200})>/.exec(trimmed);
            const resource = resMatch ? resMatch[1] : 'dynamic';
            infos.push({ file: relFile, type: 'preload', resource, asType: inferAsType(resource) });
          }
        }
      }
    }
  }

  // Scan config for web_link configuration
  const configDir = path.join(appPath, 'config');
  const configDirR = path.resolve(configDir);
  if (configDirR.startsWith(path.resolve(appPath) + path.sep)) {
    let cfgStat;
    try { cfgStat = fs.lstatSync(configDir); } catch { cfgStat = null; }
    if (cfgStat && cfgStat.isSymbolicLink()) cfgStat = null;
    if (cfgStat && cfgStat.isDirectory()) {
      const configFiles = collectConfigFiles(configDir, appPath, ['.yaml', '.yml']);
      for (const file of configFiles) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        if (/\bweb_link\s*:/.test(content)) {
          const relFile = path.relative(appPath, file);
          infos.push({ file: relFile, type: 'preload', resource: 'web_link config', asType: 'config' });
        }
      }
    }
  }

  return infos;
}

export function listSymfonyHttp2Push(appPath: string): McpToolResult {
  try {
    const infos = buildHttp2PushInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HTTP/2 push hints (preload/prefetch/preconnect) found in src/ or config/.' }] };
    }

    let text = `Symfony HTTP/2 Server Push / Resource Hints\n${'='.repeat(55)}\n\n`;
    text += `Push hints found: ${infos.length}\n\n`;

    const byType = new Map<string, Http2PushInfo[]>();
    for (const info of infos) {
      const bucket = byType.get(info.type) ?? [];
      bucket.push(info);
      byType.set(info.type, bucket);
    }

    for (const [type, items] of byType) {
      text += `  ${type.toUpperCase()} (${items.length})\n`;
      for (const item of items.slice(0, 15)) {
        text += `    as=${item.asType.padEnd(8)} ${item.resource}\n`;
        text += `             ${item.file}\n`;
      }
      if (items.length > 15) text += `    ... and ${items.length - 15} more\n`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttp2PushStats(appPath: string): McpToolResult {
  try {
    const infos = buildHttp2PushInfos(appPath);
    const preloads = infos.filter(i => i.type === 'preload').length;
    const prefetches = infos.filter(i => i.type === 'prefetch').length;
    const preconnects = infos.filter(i => i.type === 'preconnect').length;
    const configs = infos.filter(i => i.asType === 'config').length;
    const byAsType = infos.reduce<Record<string, number>>((acc, i) => {
      acc[i.asType] = (acc[i.asType] ?? 0) + 1;
      return acc;
    }, {});

    let text = `Symfony HTTP/2 Push Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total push hints: ${infos.length}\n`;
    text += `  Preload:        ${preloads}\n`;
    text += `  Prefetch:       ${prefetches}\n`;
    text += `  Preconnect:     ${preconnects}\n`;
    text += `  Config blocks:  ${configs}\n\n`;
    text += `By as= type:\n`;
    for (const [asType, count] of Object.entries(byAsType)) {
      text += `  ${asType.padEnd(12)}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttp2PushTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_http2_push',
      description: 'List Symfony HTTP/2 server push and resource hints: preload/prefetch/preconnect calls via WebLink component in controllers, with resource and as-type details',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_http2_push_stats',
      description: 'Get Symfony HTTP/2 push statistics: counts by hint type (preload/prefetch/preconnect) and by asset type (script/style/font/image)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
