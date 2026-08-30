// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Asset Packages Inspector
 *
 * Reads framework.yaml assets section: base_path, base_urls, version,
 * version_format, version_strategy, json_manifest_path, packages map
 * (named packages with their own config).
 *
 * Detects: json_manifest_version_strategy, static version string,
 * custom VersionStrategyInterface.
 *
 * Warns: base_urls without version strategy (hard browser caching),
 * named package without version strategy, json_manifest_path pointing
 * to non-existent file, multiple packages with same base_path (redundant),
 * version as static string without update mechanism.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface AssetPackageInfo {
  name: 'default' | string;
  basePath?: string;
  baseUrls: string[];
  hasVersionStrategy: boolean;
  versionStrategyType: string;
  jsonManifestPath?: string;
  issues: string[];
}

function detectVersionStrategyType(raw: Record<string, unknown>): string {
  if (raw['json_manifest_path']) return 'json_manifest';
  if (raw['version_strategy']) {
    const vs = String(raw['version_strategy']);
    if (vs.includes('json_manifest') || vs.includes('JsonManifest')) return 'json_manifest';
    if (vs.includes('StaticVersion') || vs.includes('static_version')) return 'static';
    return `custom: ${vs}`;
  }
  if (raw['version']) {
    const v = String(raw['version']);
    if (v.includes('%env(') || v.includes('APP_VERSION')) return 'env_var';
    return 'static_string';
  }
  return 'none';
}

function parsePackageEntry(
  name: string,
  raw: Record<string, unknown>,
  appPath: string,
): AssetPackageInfo {
  const basePath = raw['base_path'] ? String(raw['base_path']) : undefined;
  const baseUrlsRaw = raw['base_urls'];
  const baseUrls: string[] = Array.isArray(baseUrlsRaw)
    ? baseUrlsRaw.map((u) => String(u))
    : baseUrlsRaw
    ? [String(baseUrlsRaw)]
    : [];

  const versionStrategyType = detectVersionStrategyType(raw);
  const hasVersionStrategy = versionStrategyType !== 'none';

  const jsonManifestPath = raw['json_manifest_path']
    ? String(raw['json_manifest_path'])
    : undefined;

  const issues: string[] = [];

  if (baseUrls.length > 0 && !hasVersionStrategy) {
    issues.push('base_urls set without version strategy — browsers will hard-cache assets across deployments');
  }
  if (!hasVersionStrategy) {
    issues.push('No version strategy configured — use json_manifest_path or version for cache busting');
  }
  if (versionStrategyType === 'static_string') {
    issues.push('Version is a static string — must be manually updated on each deployment to bust browser cache');
  }
  if (jsonManifestPath) {
    // Resolve relative to appPath (public/ or project root)
    const candidates = [
      path.join(appPath, jsonManifestPath),
      path.join(appPath, 'public', path.basename(jsonManifestPath)),
    ];
    const exists = candidates.some((c) => {
      try { fs.accessSync(c); return true; } catch { return false; }
    });
    if (!exists) {
      issues.push(`json_manifest_path "${jsonManifestPath}" does not exist — asset versioning will fail at runtime`);
    }
  }

  return {
    name: name as 'default' | string,
    basePath,
    baseUrls,
    hasVersionStrategy,
    versionStrategyType,
    jsonManifestPath,
    issues,
  };
}

function parseAssetPackages(appPath: string): AssetPackageInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
    path.join(appPath, 'config', 'packages', 'assets.yaml'),
    path.join(appPath, 'config', 'packages', 'assets.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const assetsSection = framework['assets'] as Record<string, unknown> | undefined;
    if (!assetsSection) continue;

    const packages: AssetPackageInfo[] = [];

    // Parse default package
    const defaultPkg = parsePackageEntry('default', assetsSection, appPath);
    packages.push(defaultPkg);

    // Parse named packages
    const namedPkgs = assetsSection['packages'] as Record<string, unknown> | undefined;
    if (namedPkgs) {
      for (const [pkgName, def] of Object.entries(namedPkgs)) {
        if (!def || typeof def !== 'object') continue;
        const pkg = parsePackageEntry(pkgName, def as Record<string, unknown>, appPath);
        packages.push(pkg);
      }
    }

    // Warn on duplicate base_path
    const basePathCounts: Record<string, number> = {};
    for (const p of packages) {
      if (p.basePath) {
        basePathCounts[p.basePath] = (basePathCounts[p.basePath] ?? 0) + 1;
      }
    }
    for (const p of packages) {
      if (p.basePath && (basePathCounts[p.basePath] ?? 0) > 1) {
        p.issues.push(`base_path "${p.basePath}" is shared with another package — redundant configuration`);
      }
    }

    return packages;
  }

  return [];
}

export function listAssetPackages(appPath: string): McpToolResult {
  try {
    const packages = parseAssetPackages(appPath);

    if (packages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No framework.assets configuration found.\n\nExample config/packages/framework.yaml:\n  framework:\n    assets:\n      json_manifest_path: "%kernel.project_dir%/public/build/manifest.json"\n      packages:\n        cdn:\n          base_urls: ["https://cdn.example.com"]\n          json_manifest_path: "%kernel.project_dir%/public/build/manifest.json"',
        }],
      };
    }

    const totalIssues = packages.reduce((s, p) => s + p.issues.length, 0);
    let text = `Symfony Asset Packages\n${'='.repeat(55)}\n`;
    text += `\nPackages: ${packages.length}  Issues: ${totalIssues}\n`;

    for (const p of packages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  Package: ${p.name}\n`;
      if (p.basePath) text += `    base_path: ${p.basePath}\n`;
      if (p.baseUrls.length > 0) text += `    base_urls: ${p.baseUrls.join(', ')}\n`;
      text += `    Version strategy: ${p.versionStrategyType}\n`;
      if (p.jsonManifestPath) text += `    json_manifest_path: ${p.jsonManifestPath}\n`;
      for (const issue of p.issues) {
        text += `    WARNING: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetPackageStats(appPath: string): McpToolResult {
  try {
    const packages = parseAssetPackages(appPath);

    let text = `Asset Package Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total packages:             ${packages.length}\n`;
    text += `  With version strategy:    ${packages.filter((p) => p.hasVersionStrategy).length}\n`;
    text += `  json_manifest:            ${packages.filter((p) => p.versionStrategyType === 'json_manifest').length}\n`;
    text += `  Static string version:    ${packages.filter((p) => p.versionStrategyType === 'static_string').length}\n`;
    text += `  No version strategy:      ${packages.filter((p) => !p.hasVersionStrategy).length}\n`;
    text += `  With base_urls (CDN):     ${packages.filter((p) => p.baseUrls.length > 0).length}\n`;
    text += `Issues detected:            ${packages.reduce((s, p) => s + p.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetPackageTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_asset_packages',
      description: 'Show Symfony asset package configuration: default and named packages, base_path, base_urls, version strategy type (json_manifest/static/env_var/custom), json_manifest_path existence check; warns on base_urls without versioning, static version strings, missing manifest file, duplicate base_path',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_asset_package_stats',
      description: 'Show asset package statistics: total package count, with/without version strategy, json_manifest count, static version count, CDN (base_urls) count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
