/**
 * Symfony UX Map Inspector
 *
 * Detects symfony/ux-map integration: Map, Marker, Polygon,
 * GoogleMapsRenderer, LeafletRenderer, ux_map() in Twig templates.
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UxMapInfo {
  hasPackage: boolean;
  renderer: string;
  hasApiKey: boolean;
  markerCount: number;
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

function buildUxMapInfo(appPath: string): UxMapInfo {
  const issues: string[] = [];

  // Check composer.json
  let hasPackage = false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as Record<string, unknown>;
    const req = (raw['require'] ?? {}) as Record<string, unknown>;
    const reqDev = (raw['require-dev'] ?? {}) as Record<string, unknown>;
    hasPackage = 'symfony/ux-map' in req || 'symfony/ux-map' in reqDev;
  } catch { /* skip */ }

  // Scan PHP for renderer and marker usage
  let renderer = 'none';
  let markerCount = 0;
  const srcDir = path.join(appPath, 'src');
  let allPhpContent = '';
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const c = safeRead(file, srcDir);
      if (c !== null) allPhpContent += c + '\n';
    }
  }

  if (allPhpContent.includes('GoogleMapsRenderer')) renderer = 'google-maps';
  else if (allPhpContent.includes('LeafletRenderer')) renderer = 'leaflet';

  const markerMatches = allPhpContent.match(/new\s+Marker\s*\(|->addMarker\s*\(/g) ?? [];
  markerCount = markerMatches.length;

  // Scan Twig templates
  const templatesDir = path.join(appPath, 'templates');
  let twigContent = '';
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      const c = safeRead(file, templatesDir);
      if (c !== null) twigContent += c + '\n';
    }
  }

  const hasMapInTwig = twigContent.includes('map(') || twigContent.includes('ux_map(');

  // Check for API key
  let hasApiKey = false;
  const envFiles = ['.env', '.env.dist', '.env.local.php'];
  for (const envFile of envFiles) {
    try {
      const envContent = fs.readFileSync(path.join(appPath, envFile), 'utf-8');
      if (envContent.includes('GOOGLE_MAPS_API_KEY') || envContent.includes('MAPS_API_KEY')) {
        hasApiKey = true;
        break;
      }
    } catch { /* skip */ }
  }
  if (allPhpContent.includes('GOOGLE_MAPS_API_KEY') || allPhpContent.includes('apiKey')) {
    hasApiKey = true;
  }

  // Warn
  if (!hasPackage && (hasMapInTwig || allPhpContent.includes('GoogleMapsRenderer') || allPhpContent.includes('LeafletRenderer'))) {
    issues.push('UX Map used in code but symfony/ux-map not found in composer.json');
  }
  if (renderer === 'google-maps' && !hasApiKey) {
    issues.push('GoogleMapsRenderer used but no GOOGLE_MAPS_API_KEY found in .env files — map will fail to load');
  }
  if (renderer === 'leaflet' && !allPhpContent.includes('tilesUrl') && !allPhpContent.includes('tiles_url')) {
    issues.push('LeafletRenderer used but no tiles URL configured — map will show empty tiles');
  }
  if (hasMapInTwig && !allPhpContent.includes('->setCenter(') && !allPhpContent.includes('center:')) {
    issues.push('Map component used but no center/zoom configured — map renders at 0,0 zoom level');
  }
  if (markerCount > 100 && !allPhpContent.includes('cluster') && !allPhpContent.includes('Cluster')) {
    issues.push(`${markerCount} Marker instances found without clustering — >100 markers without clustering causes severe performance degradation`);
  }
  if (allPhpContent.includes('new Marker(') && !allPhpContent.includes('title:') && !allPhpContent.includes("'title'") && !allPhpContent.includes('"title"')) {
    issues.push('Marker created without title/label — inaccessible for screen readers and keyboard users');
  }

  return { hasPackage, renderer, hasApiKey, markerCount, issues };
}

export function listSymfonyUxMap(appPath: string): McpToolResult {
  try {
    const info = buildUxMapInfo(appPath);

    if (!info.hasPackage && info.issues.length === 0) {
      return { content: [{ type: 'text', text: 'symfony/ux-map is not installed (not found in composer.json).' }] };
    }

    let text = `Symfony UX Map Analysis\n${'='.repeat(50)}\n\n`;
    text += `Package installed:  ${info.hasPackage ? 'yes (symfony/ux-map)' : 'no'}\n`;
    text += `Renderer:           ${info.renderer}\n`;
    text += `API key present:    ${info.hasApiKey ? 'yes' : 'no'}\n`;
    text += `Marker instances:   ${info.markerCount}\n`;
    text += `Issues:             ${info.issues.length}\n`;

    for (const issue of info.issues) {
      text += `\nWARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxMapStats(appPath: string): McpToolResult {
  try {
    const info = buildUxMapInfo(appPath);

    let text = `Symfony UX Map Statistics\n${'='.repeat(40)}\n\n`;
    text += `Installed:          ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `Renderer:           ${info.renderer}\n`;
    text += `API key:            ${info.hasApiKey ? 'yes' : 'no'}\n`;
    text += `Markers:            ${info.markerCount}\n`;
    text += `Total issues:       ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxMapTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_ux_map',
      description: 'Inspect Symfony UX Map integration: renderer (Google Maps/Leaflet), API key, marker count; warns on missing API key, no tiles URL, missing center/zoom, >100 markers without clustering, inaccessible markers',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_ux_map_stats',
      description: 'Statistics for Symfony UX Map: installed status, renderer type, API key presence, marker count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
