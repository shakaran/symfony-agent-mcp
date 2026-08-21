import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface AssetIntegrityInfo {
  file: string;
  asset: string;
  hasSri: boolean;
  crossorigin: string;
  issues: string[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildAssetIntegrityInfos(appPath: string): AssetIntegrityInfo[] {
  const results: AssetIntegrityInfo[] = [];
  const templatesDir = path.join(appPath, 'templates');
  if (!fs.existsSync(templatesDir)) return results;

  for (const file of getAllTwigFiles(templatesDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const scriptTagRe = /<script[^>]{0,500}src\s*=\s*["'][^"']{1,300}["'][^>]{0,500}>/gi;
    const linkTagRe = /<link[^>]{0,500}href\s*=\s*["'][^"']{1,300}["'][^>]{0,500}>/gi;

    let match: RegExpExecArray | null;
    while ((match = scriptTagRe.exec(content)) !== null) {
      const tag = match[0];
      const srcMatch = /src\s*=\s*["']([^"']{1,300})["']/.exec(tag);
      if (!srcMatch) continue;
      const src = srcMatch[1];
      if (!src.startsWith('http') && !src.includes('//')) continue;

      const hasSri = tag.includes('integrity=');
      const crossoriginMatch = /crossorigin\s*=\s*["']?([^"' >]{1,40})["']?/.exec(tag);
      const crossorigin = crossoriginMatch ? crossoriginMatch[1] : '';
      const issues: string[] = [];

      if (!hasSri) {
        issues.push(`External script "${src}" lacks SRI integrity attribute — any CDN compromise delivers malicious scripts to all users`);
      } else if (hasSri && !crossorigin) {
        issues.push(`External script "${src}" has integrity but no crossorigin="anonymous" — SRI check is silently skipped without this attribute`);
      }

      results.push({ file: relFile, asset: src, hasSri, crossorigin, issues });
    }

    while ((match = linkTagRe.exec(content)) !== null) {
      const tag = match[0];
      if (!tag.includes('stylesheet')) continue;
      const hrefMatch = /href\s*=\s*["']([^"']{1,300})["']/.exec(tag);
      if (!hrefMatch) continue;
      const href = hrefMatch[1];
      if (!href.startsWith('http') && !href.includes('//')) continue;

      const hasSri = tag.includes('integrity=');
      const crossoriginMatch = /crossorigin\s*=\s*["']?([^"' >]{1,40})["']?/.exec(tag);
      const crossorigin = crossoriginMatch ? crossoriginMatch[1] : '';
      const issues: string[] = [];

      if (!hasSri) {
        issues.push(`External stylesheet "${href}" lacks SRI integrity attribute — CDN compromise can inject malicious CSS`);
      } else if (hasSri && !crossorigin) {
        issues.push(`External stylesheet "${href}" has integrity but no crossorigin="anonymous" — SRI check skipped`);
      }

      results.push({ file: relFile, asset: href, hasSri, crossorigin, issues });
    }
  }

  const importmapPath = path.join(appPath, 'importmap.php');
  if (fs.existsSync(importmapPath)) {
    let content = '';
    try { content = fs.readFileSync(importmapPath, 'utf-8'); } catch { /* skip */ }
    if (content.includes("'integrity'") || content.includes('"integrity"')) {
      results.push({ file: 'importmap.php', asset: 'importmap', hasSri: true, crossorigin: '', issues: [] });
    } else if (content.includes('https://')) {
      results.push({ file: 'importmap.php', asset: 'importmap', hasSri: false, crossorigin: '', issues: ['importmap.php contains remote URLs without integrity hashes — use importmap:require --dry-run to add SRI hashes'] });
    }
  }

  return results;
}

export function listSymfonyAssetIntegrity(appPath: string): McpToolResult {
  try {
    const infos = buildAssetIntegrityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No external asset references found in templates (no external script/link tags or importmap.php).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Asset Subresource Integrity (SRI) Analysis\n${'='.repeat(55)}\n\nAssets: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const status = info.hasSri ? `SRI: yes  crossorigin: ${info.crossorigin || '(none)'}` : 'SRI: MISSING';
      text += `\n  ${info.asset}  [${status}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyAssetIntegrityStats(appPath: string): McpToolResult {
  try {
    const infos = buildAssetIntegrityInfos(appPath);
    const withSri = infos.filter((i) => i.hasSri).length;
    const withoutSri = infos.filter((i) => !i.hasSri).length;
    let text = `Asset Integrity Statistics\n${'='.repeat(40)}\n\n`;
    text += `External assets:   ${infos.length}\n`;
    text += `With SRI:          ${withSri}\n`;
    text += `Without SRI:       ${withoutSri}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyAssetIntegrityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_asset_integrity', description: 'Detect external script/stylesheet tags without Subresource Integrity (SRI); warns on missing integrity attribute, integrity without crossorigin="anonymous", importmap.php without hashes', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_asset_integrity_stats', description: 'Statistics for asset SRI: external asset count, with/without SRI, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
