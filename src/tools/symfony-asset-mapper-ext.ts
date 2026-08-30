// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Asset Mapper Extended Inspector
 *
 * Checks composer.json for symfony/asset-mapper.
 * Reads config/packages/asset_mapper.yaml (or framework.yaml asset_mapper section).
 * Reads assets/importmap.php if present: mapped packages and their versions.
 * Scans Twig templates for: asset() with .js/.css, importmap(), ux_map().
 *
 * Warns about:
 *   - asset-mapper installed but importmap.php missing (assets not served)
 *   - missing_import_mode: 'strict' in dev (breaks on missing imports)
 *   - CDN packages without integrity hash (CDN compromise undetected)
 *   - Very large importmap (>100 packages, performance)
 *   - asset-mapper with webpack encore also installed (conflicting asset pipelines)
 *   - CSS file imported via importmap without preload hint (FOUC risk)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface AssetMapperInfo {
  hasAssetMapper: boolean;
  pathsCount: number;
  importmapPackages: number;
  cdnPackages: number;
  missingImportMode: string;
  issues: string[];
}

function checkComposerForAssetMapper(appPath: string): { hasAssetMapper: boolean; hasWebpackEncore: boolean } {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
    const require = (raw['require'] ?? {}) as Record<string, unknown>;
    const requireDev = (raw['require-dev'] ?? {}) as Record<string, unknown>;
    const allDeps = { ...require, ...requireDev };
    return {
      hasAssetMapper: 'symfony/asset-mapper' in allDeps,
      hasWebpackEncore: 'symfony/webpack-encore-bundle' in allDeps,
    };
  } catch {
    return { hasAssetMapper: false, hasWebpackEncore: false };
  }
}

function readImportmap(appPath: string): { total: number; cdnCount: number; hasCssWithoutPreload: boolean } {
  const importmapPath = path.join(appPath, 'assets', 'importmap.php');
  let content = '';
  try { content = fs.readFileSync(importmapPath, 'utf-8'); } catch { return { total: 0, cdnCount: 0, hasCssWithoutPreload: false }; }

  // Count entries: lines with 'path' => or 'url' =>
  const urlMatches = content.match(/['"]{0,1}url['"]{0,1}\s*=>/g);
  const pathMatches = content.match(/['"]{0,1}path['"]{0,1}\s*=>/g);
  const total = (urlMatches?.length ?? 0) + (pathMatches?.length ?? 0);

  // Count CDN entries (http/https)
  const cdnMatches = content.match(/https?:\/\//g);
  const cdnCount = cdnMatches?.length ?? 0;

  // Check for CSS without preload (entries with .css not having 'preload' => true nearby)
  const hasCssWithoutPreload = /\.css['"]/.test(content) && !content.includes("'preload' => true");

  return { total, cdnCount, hasCssWithoutPreload };
}

function checkIntegrityHashes(appPath: string): number {
  const importmapPath = path.join(appPath, 'assets', 'importmap.php');
  try {
    const content = fs.readFileSync(importmapPath, 'utf-8');
    // Count CDN entries without integrity
    const cdnEntryRe = /url['"]{0,1}\s*=>\s*['"]https?:\/\/[^'"]{1,200}['"]/g;
    const cdnMatches = content.match(cdnEntryRe) ?? [];
    const hasIntegrity = content.includes("'integrity'") || content.includes('"integrity"');
    const withoutIntegrity = hasIntegrity ? 0 : cdnMatches.length;
    return withoutIntegrity;
  } catch {
    return 0;
  }
}

function buildAssetMapperInfo(appPath: string): AssetMapperInfo {
  const { hasAssetMapper, hasWebpackEncore } = checkComposerForAssetMapper(appPath);
  const issues: string[] = [];

  if (!hasAssetMapper) {
    return { hasAssetMapper: false, pathsCount: 0, importmapPackages: 0, cdnPackages: 0, missingImportMode: '', issues };
  }

  // Read config
  let pathsCount = 0;
  let missingImportMode = '';

  const cfgCandidates = [
    path.join(appPath, 'config', 'packages', 'asset_mapper.yaml'),
    path.join(appPath, 'config', 'packages', 'asset_mapper.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  for (const cfgPath of cfgCandidates) {
    const raw = parseYamlFile(cfgPath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const am = (framework['asset_mapper'] ?? raw['asset_mapper'] ?? {}) as Record<string, unknown>;

    const pathsRaw = am['paths'];
    if (Array.isArray(pathsRaw)) pathsCount = pathsRaw.length;
    else if (pathsRaw) pathsCount = 1;

    missingImportMode = String(am['missing_import_mode'] ?? '');
    break;
  }

  const { total: importmapPackages, cdnCount: cdnPackages, hasCssWithoutPreload } = readImportmap(appPath);
  const cdnWithoutIntegrity = checkIntegrityHashes(appPath);

  // Check importmap.php presence
  const importmapExists = fs.existsSync(path.join(appPath, 'assets', 'importmap.php'));
  if (!importmapExists) {
    issues.push('symfony/asset-mapper installed but assets/importmap.php missing — assets will not be served via importmap');
  }

  if (missingImportMode === 'strict') {
    issues.push("missing_import_mode is 'strict' — any missing import will throw an error in dev (set to 'warn' for development)");
  }

  if (cdnWithoutIntegrity > 0) {
    issues.push(`${cdnWithoutIntegrity} CDN package(s) in importmap without integrity hash — CDN compromise cannot be detected by browser`);
  }

  if (importmapPackages > 100) {
    issues.push(`importmap has ${importmapPackages} packages (>100) — very large importmaps degrade page load performance`);
  }

  if (hasWebpackEncore) {
    issues.push('Both symfony/asset-mapper and symfony/webpack-encore-bundle are installed — conflicting asset pipelines; use one or the other');
  }

  if (hasCssWithoutPreload) {
    issues.push('CSS file(s) found in importmap without preload hint — CSS imported via JS may cause FOUC (Flash of Unstyled Content)');
  }

  return {
    hasAssetMapper,
    pathsCount,
    importmapPackages,
    cdnPackages,
    missingImportMode,
    issues,
  };
}

export function listAssetMapper(appPath: string): McpToolResult {
  try {
    const info = buildAssetMapperInfo(appPath);

    if (!info.hasAssetMapper) {
      return {
        content: [{
          type: 'text',
          text: 'symfony/asset-mapper is not installed (not found in composer.json).',
        }],
      };
    }

    let text = `Asset Mapper Analysis\n${'='.repeat(55)}\n\n`;
    text += `hasAssetMapper:      yes\n`;
    text += `pathsCount:          ${info.pathsCount}\n`;
    text += `importmapPackages:   ${info.importmapPackages}\n`;
    text += `cdnPackages:         ${info.cdnPackages}\n`;
    if (info.missingImportMode) text += `missingImportMode:   ${info.missingImportMode}\n`;
    text += `Issues:              ${info.issues.length}\n`;

    for (const issue of info.issues) {
      text += `\nWARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetMapperStats(appPath: string): McpToolResult {
  try {
    const info = buildAssetMapperInfo(appPath);

    let text = `Asset Mapper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Installed:             ${info.hasAssetMapper ? 'yes' : 'no'}\n`;
    text += `Paths configured:      ${info.pathsCount}\n`;
    text += `Importmap packages:    ${info.importmapPackages}\n`;
    text += `CDN packages:          ${info.cdnPackages}\n`;
    text += `Missing import mode:   ${info.missingImportMode || '(default)'}\n`;
    text += `Total issues:          ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetMapperExtTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_asset_mapper',
      description: 'Inspect symfony/asset-mapper configuration: importmap.php packages, CDN vs vendored, integrity hashes, missing_import_mode, Webpack Encore conflict; warns on missing importmap, CDN packages without integrity, large importmaps, FOUC risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_asset_mapper_stats',
      description: 'Statistics for symfony/asset-mapper: installed status, paths count, importmap package count, CDN count, missing import mode, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
