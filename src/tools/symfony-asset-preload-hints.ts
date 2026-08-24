// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Asset Preload Hints Inspector
 *
 * Scans templates/**\/*.html.twig for rel="preload", rel="prefetch",
 * rel="modulepreload" link tags.
 * Scans src/**\/*.php for WebLink component addLink/preload() usage.
 * Checks if critical CSS/JS and modern image formats (webp/avif) are preloaded.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AssetPreloadInfo {
  file: string;
  resource: string;
  type: 'preload' | 'prefetch' | 'modulepreload';
  asType: string;
  crossorigin: boolean;
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
  if (/\.(webp|avif|png|jpg|jpeg|svg|gif)(\?|$)/.test(resource)) return 'image';
  return 'fetch';
}

function parseLinkTagAttributes(tagContent: string): { rel: string; href: string; as: string; crossorigin: boolean } | null {
  const relMatch = /rel=["']([^"']{1,60})["']/.exec(tagContent);
  const hrefMatch = /href=["']([^"']{1,300})["']/.exec(tagContent);
  const asMatch = /\bas=["']([^"']{1,40})["']/.exec(tagContent);
  const crossorigin = /\bcrossorigin\b/.test(tagContent);

  if (!relMatch || !hrefMatch) return null;

  const rel = relMatch[1];
  const href = hrefMatch[1];
  const asType = asMatch ? asMatch[1] : inferAsType(href);

  if (!['preload', 'prefetch', 'modulepreload'].includes(rel)) return null;

  return { rel, href, as: asType, crossorigin };
}

function buildAssetPreloadInfos(appPath: string): AssetPreloadInfo[] {
  const infos: AssetPreloadInfo[] = [];

  // Scan Twig templates
  const templatesDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'app', 'Resources', 'views'),
  ];

  for (const tmplDir of templatesDirs) {
    const tmplDirR = path.resolve(tmplDir);
    if (!tmplDirR.startsWith(path.resolve(appPath) + path.sep)) continue;
    let tmplStat;
    try { tmplStat = fs.lstatSync(tmplDir); } catch { continue; }
    if (tmplStat.isSymbolicLink()) continue;
    if (!tmplStat.isDirectory()) continue;

    const twigFiles = collectConfigFiles(tmplDir, appPath, ['.twig']);
    for (const file of twigFiles) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const relFile = path.relative(appPath, file);

      if (!content.includes('preload') && !content.includes('prefetch') && !content.includes('modulepreload')) continue;

      // Match <link> tags
      const linkTagPattern = /<link\s[^>]{1,500}>/g;
      let m: RegExpExecArray | null;
      while ((m = linkTagPattern.exec(content)) !== null) {
        const attrs = parseLinkTagAttributes(m[0]);
        if (!attrs) continue;
        infos.push({
          file: relFile,
          resource: attrs.href,
          type: attrs.rel as 'preload' | 'prefetch' | 'modulepreload',
          asType: attrs.as,
          crossorigin: attrs.crossorigin,
        });
      }

      // Also catch {{ preload() }} Twig function calls
      const twigPreloadPattern = /\{\{\s*preload\s*\(\s*['"]([^'"]{1,300})['"](?:[^)]{0,200})?\)\s*\}\}/g;
      while ((m = twigPreloadPattern.exec(content)) !== null) {
        const resource = m[1];
        infos.push({
          file: relFile,
          resource,
          type: 'preload',
          asType: inferAsType(resource),
          crossorigin: false,
        });
      }
    }
  }

  // Scan PHP source for WebLink usage
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
        if (!content.includes('addLink') && !content.includes('preload(') && !content.includes('WebLink')) continue;

        const relFile = path.relative(appPath, file);

        // addLink() calls
        const addLinkPattern = /addLink\s*\(\s*['"]([^'"]{1,300})['"][^)]{0,200}\)/g;
        let m: RegExpExecArray | null;
        while ((m = addLinkPattern.exec(content)) !== null) {
          const resource = m[1];
          const context = m[0];
          const relType = /prefetch/.test(context) ? 'prefetch'
            : /modulepreload/.test(context) ? 'modulepreload'
            : 'preload';
          const crossorigin = /crossorigin/.test(context);
          infos.push({ file: relFile, resource, type: relType, asType: inferAsType(resource), crossorigin });
        }

        // preload() function calls (WebLink component helper)
        const preloadPattern = /\bpreload\s*\(\s*['"]([^'"]{1,300})['"][^)]{0,200}\)/g;
        while ((m = preloadPattern.exec(content)) !== null) {
          const resource = m[1];
          const crossorigin = /crossorigin/.test(m[0]);
          infos.push({ file: relFile, resource, type: 'preload', asType: inferAsType(resource), crossorigin });
        }
      }
    }
  }

  return infos;
}

export function listSymfonyAssetPreloadHints(appPath: string): McpToolResult {
  try {
    const infos = buildAssetPreloadInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No asset preload hints found in templates/ or src/.' }] };
    }

    const fontsWithoutCrossorigin = infos.filter(i => i.asType === 'font' && !i.crossorigin).length;
    const modernImages = infos.filter(i => /\.(webp|avif)/.test(i.resource)).length;

    let text = `Symfony Asset Preload Hints\n${'='.repeat(55)}\n\n`;
    text += `Preload hints found: ${infos.length}\n`;
    text += `  Fonts missing crossorigin: ${fontsWithoutCrossorigin}  (fonts need crossorigin for cross-origin preload)\n`;
    text += `  Modern image formats (webp/avif): ${modernImages}\n\n`;

    const byType = new Map<string, AssetPreloadInfo[]>();
    for (const info of infos) {
      const bucket = byType.get(info.type) ?? [];
      bucket.push(info);
      byType.set(info.type, bucket);
    }

    for (const [type, items] of byType) {
      text += `  ${type.toUpperCase()} (${items.length})\n`;
      for (const item of items.slice(0, 15)) {
        const co = item.crossorigin ? ' crossorigin' : '';
        const warn = item.asType === 'font' && !item.crossorigin ? '  [!missing crossorigin]' : '';
        text += `    as=${item.asType.padEnd(8)} ${item.resource}${co}${warn}\n`;
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

export function getSymfonyAssetPreloadHintsStats(appPath: string): McpToolResult {
  try {
    const infos = buildAssetPreloadInfos(appPath);
    const preloads = infos.filter(i => i.type === 'preload').length;
    const prefetches = infos.filter(i => i.type === 'prefetch').length;
    const modulePreloads = infos.filter(i => i.type === 'modulepreload').length;
    const withCrossorigin = infos.filter(i => i.crossorigin).length;
    const byAsType = infos.reduce<Record<string, number>>((acc, i) => {
      acc[i.asType] = (acc[i.asType] ?? 0) + 1;
      return acc;
    }, {});
    const fontsWithoutCrossorigin = infos.filter(i => i.asType === 'font' && !i.crossorigin).length;

    let text = `Symfony Asset Preload Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total hints: ${infos.length}\n`;
    text += `  Preload:       ${preloads}\n`;
    text += `  Prefetch:      ${prefetches}\n`;
    text += `  Modulepreload: ${modulePreloads}\n`;
    text += `  With crossorigin: ${withCrossorigin}\n`;
    text += `  Fonts missing crossorigin: ${fontsWithoutCrossorigin}\n\n`;
    text += `By asset type:\n`;
    for (const [asType, count] of Object.entries(byAsType)) {
      text += `  ${asType.padEnd(12)}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyAssetPreloadHintsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_asset_preload_hints',
      description: 'List Symfony asset preload hints from Twig templates and PHP controllers: preload/prefetch/modulepreload links with as-type, crossorigin flag, and warnings for fonts missing crossorigin',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_asset_preload_hints_stats',
      description: 'Get Symfony asset preload statistics: counts by hint type (preload/prefetch/modulepreload), by asset type (style/script/font/image), crossorigin coverage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
