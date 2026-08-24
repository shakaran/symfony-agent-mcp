// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PwaManifestInfo {
  field: string;
  value: string;
  source: string;
  issues: string[];
}

function buildPwaManifestInfos(appPath: string): PwaManifestInfo[] {
  const manifestCandidates = [
    path.join(appPath, 'public', 'manifest.json'),
    path.join(appPath, 'public', 'site.webmanifest'),
    path.join(appPath, 'assets', 'manifest.json'),
  ];

  const manifestFile = manifestCandidates.find((c) => fs.existsSync(c)) ?? null;
  const results: PwaManifestInfo[] = [];

  let manifest: Record<string, unknown> | null = null;
  if (manifestFile) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Record<string, unknown>;
    } catch { /* ignore */ }
  }

  const swCandidates = [
    path.join(appPath, 'public', 'sw.js'),
    path.join(appPath, 'assets', 'service-worker.js'),
    path.join(appPath, 'assets', 'sw.js'),
  ];
  const hasServiceWorker = swCandidates.some((c) => fs.existsSync(c));

  const offlinePage = path.join(appPath, 'public', 'offline.html');
  const hasOfflinePage = fs.existsSync(offlinePage);

  if (!manifest) {
    results.push({ field: 'manifest', value: 'not found', source: 'public/', issues: ['No Web App Manifest found (manifest.json or site.webmanifest) — PWA installation not possible'] });
    if (!hasServiceWorker) {
      results.push({ field: 'service-worker', value: 'not found', source: 'public/', issues: ['No service worker found (sw.js) — no offline support'] });
    }
    return results;
  }

  const relManifest = path.relative(appPath, manifestFile!);
  const issues: string[] = [];

  const name = String(manifest['name'] ?? '');
  const shortName = String(manifest['short_name'] ?? '');
  const display = String(manifest['display'] ?? '');
  const icons = manifest['icons'];
  const startUrl = String(manifest['start_url'] ?? '');
  const themeColor = String(manifest['theme_color'] ?? '');

  if (!name) issues.push('Manifest missing "name" field — required for PWA installation dialog');
  if (!shortName) issues.push('Manifest missing "short_name" field — used on home screen where space is limited');
  if (shortName.length > 12) issues.push(`short_name "${shortName}" is ${shortName.length} chars (>12) — will be truncated on home screen`);
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(display)) {
    issues.push(`display: "${display || '(not set)'}" — use "standalone", "fullscreen", or "minimal-ui" for app-like experience`);
  }

  if (!Array.isArray(icons) || icons.length === 0) {
    issues.push('Manifest missing icons array — required for PWA installability');
  } else {
    const iconSizes = (icons as Array<Record<string, string>>).map((i) => i['sizes'] ?? '');
    if (!iconSizes.includes('512x512')) {
      issues.push('Manifest icons missing 512x512 size — required for installability on Chrome/Android');
    }
  }

  if (!hasServiceWorker) {
    issues.push('Manifest found but no service worker (sw.js) — manifest without service worker provides no offline support or push notifications');
  }
  if (!hasOfflinePage && hasServiceWorker) {
    issues.push('Service worker found but no offline.html — users see browser error when offline instead of custom page');
  }

  if (startUrl && !startUrl.startsWith('/')) {
    issues.push(`start_url "${startUrl}" is not root-relative — should start with "/" for proper scope matching`);
  }

  results.push({ field: 'manifest', value: name, source: relManifest, issues });

  if (themeColor) {
    results.push({ field: 'theme_color', value: themeColor, source: relManifest, issues: [] });
  }

  return results;
}

export function listPwaManifestConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPwaManifestInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PWA Manifest Analysis\n${'='.repeat(50)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.field}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPwaManifestStats(appPath: string): McpToolResult {
  try {
    const infos = buildPwaManifestInfos(appPath);
    let text = `PWA Manifest Statistics\n${'='.repeat(40)}\n\n`;
    text += `Manifest found:  ${infos.some((i) => i.field === 'manifest' && !i.issues.some((iss) => iss.includes('not found'))) ? 'yes' : 'no'}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPwaManifestTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_pwa_manifest_config', description: 'Analyze PWA manifest.json/site.webmanifest; warns on missing icons, short_name >12 chars, invalid display value, missing service worker, no offline.html, non-relative start_url', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_pwa_manifest_stats', description: 'Statistics for PWA manifest: found status, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
