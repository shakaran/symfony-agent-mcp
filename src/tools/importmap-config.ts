// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ImportmapPackage {
  name: string;
  version?: string;
  url?: string;
  isPolyfill: boolean;
  isLocal: boolean;
  issues: string[];
}

function loadImportmap(appPath: string): ImportmapPackage[] {
  const importmapPath = path.join(appPath, 'importmap.php');
  let content = '';
  try { content = fs.readFileSync(importmapPath, 'utf-8'); } catch { return []; }
  const packages: ImportmapPackage[] = [];
  // Parse PHP array entries: 'package-name' => ['version' => 'x.y.z', 'url' => '...', ...]
  const entryRe = /'([^']{1,200})'\s*=>\s*\[([^\][]{0,500}(?:\[[^\][]{0,300}\][^\][]{0,500}){0,40})\]/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const versionM = /'version'\s*=>\s*'([^']{1,50})'/.exec(body);
    const urlM = /'url'\s*=>\s*'([^']{1,500})'/.exec(body);
    const isPolyfill = name.toLowerCase().includes('polyfill') || body.includes("'polyfill'");
    const isLocal = name.startsWith('@') && name.includes('/') && !urlM;
    const issues: string[] = [];
    if (!versionM && !urlM && !isLocal) issues.push(`"${name}" has no pinned version or url — use "importmap:require ${name}" to pin`);
    if (isPolyfill && urlM) issues.push(`Polyfill "${name}" loaded from external URL — prefer importmap:require with pinned CDN hash`);
    packages.push({ name, version: versionM?.[1], url: urlM?.[1], isPolyfill, isLocal, issues });
  }
  return packages;
}

export function listImportmapConfig(appPath: string): McpToolResult {
  try {
    const packages = loadImportmap(appPath);
    if (packages.length === 0) {
      const hasImportmap = fs.existsSync(path.join(appPath, 'importmap.php'));
      if (!hasImportmap) return { content: [{ type: 'text', text: 'No importmap.php found.\n\nInstall: composer require symfony/asset-mapper\nThen: php bin/console importmap:require @hotwired/stimulus' }] };
      return { content: [{ type: 'text', text: 'importmap.php found but no packages parsed.' }] };
    }
    const totalIssues = packages.reduce((s, p) => s + p.issues.length, 0);
    let text = `Importmap Configuration\n${'='.repeat(55)}\n\nPackages: ${packages.length}  Polyfills: ${packages.filter(p => p.isPolyfill).length}  Issues: ${totalIssues}\n`;
    for (const p of packages.sort((a, b) => b.issues.length - a.issues.length)) {
      const version = p.version ? `v${p.version}` : (p.url ? 'url' : 'unpinned');
      const type = p.isPolyfill ? ' [polyfill]' : (p.isLocal ? ' [local]' : '');
      text += `\n  ${p.name}  ${version}${type}\n`;
      for (const i of p.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImportmapStats(appPath: string): McpToolResult {
  try {
    const packages = loadImportmap(appPath);
    let text = `Importmap Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total packages: ${packages.length}\n  Pinned (version/url): ${packages.filter(p => p.version ?? p.url).length}\n  Unpinned: ${packages.filter(p => !p.version && !p.url && !p.isLocal).length}\n  Polyfills: ${packages.filter(p => p.isPolyfill).length}\n  Local: ${packages.filter(p => p.isLocal).length}\nIssues: ${packages.reduce((s, p) => s + p.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImportmapTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_importmap_config', description: 'Analyze importmap.php packages: pinned versions, external URLs, polyfills, local packages, unpinned package warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_importmap_stats', description: 'Importmap statistics: total packages, pinned vs unpinned, polyfill count, local count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
