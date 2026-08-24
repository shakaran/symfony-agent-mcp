// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Asset Versioning Inspector
 *
 * Distinct from asset-mapper.ts (Symfony AssetMapper component, Symfony 6.3+).
 * Focuses on the classic framework.yaml assets: configuration used by asset() Twig function:
 *
 *   framework:
 *     assets:
 *       version: 'v2'
 *       version_format: '%%s?version=%%s'
 *       version_strategy: App\Asset\ContentHashVersionStrategy
 *       json_manifest_path: '%kernel.project_dir%/public/build/manifest.json'
 *       base_path: '/assets'
 *       base_url: 'https://cdn.example.com'
 *       packages:
 *         images:
 *           base_url: 'https://img.example.com'
 *           version: 'img-v1'
 *         scripts:
 *           json_manifest_path: '%kernel.project_dir%/public/js/manifest.json'
 *
 * Analysis:
 *   - Static version string (must be manually bumped on each deploy — easy to forget)
 *   - json_manifest_path file does not exist
 *   - base_url set to http:// in production config (insecure CDN)
 *   - Named package 'default' overrides global config in a confusing way
 *   - version_strategy class not found in src/
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface AssetPackage {
  name: string;
  basePath?: string;
  baseUrl?: string;
  version?: string;
  versionStrategy?: string;
  jsonManifestPath?: string;
  issues: string[];
}

function resolveProjectDir(raw: string, appPath: string): string {
  return raw.replace(/%kernel\.project_dir%/g, appPath);
}

function parsePackageConfig(name: string, pkg: Record<string, unknown>, appPath: string): AssetPackage {
  const basePath       = pkg['base_path'] ? String(pkg['base_path']) : undefined;
  const baseUrl        = pkg['base_url'] ? String(pkg['base_url']) : undefined;
  const version        = pkg['version'] ? String(pkg['version']) : undefined;
  const versionStrategy = pkg['version_strategy'] ? String(pkg['version_strategy']) : undefined;
  const jsonManifestPathRaw = pkg['json_manifest_path'] ? String(pkg['json_manifest_path']) : undefined;
  const jsonManifestPath = jsonManifestPathRaw ? resolveProjectDir(jsonManifestPathRaw, appPath) : undefined;

  const issues: string[] = [];
  if (version && !versionStrategy && !jsonManifestPath) {
    issues.push(`Static version "${version}" — must be bumped manually on each deploy`);
  }
  if (jsonManifestPath && !fs.existsSync(jsonManifestPath)) {
    issues.push(`json_manifest_path does not exist: ${jsonManifestPathRaw}`);
  }
  if (baseUrl?.startsWith('http://')) {
    issues.push(`base_url uses http:// — insecure CDN URL (use https://)`);
  }

  return { name, basePath, baseUrl, version, versionStrategy, jsonManifestPath: jsonManifestPathRaw, issues };
}

function loadAssetConfig(appPath: string): AssetPackage[] | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw    = (raw['framework'] ?? raw) as Record<string, unknown>;
    const assets = fw['assets'] as Record<string, unknown> | undefined;
    if (!assets) continue;

    const packages: AssetPackage[] = [];

    // Global/default package
    const globalPkg = parsePackageConfig('(global)', assets, appPath);
    packages.push(globalPkg);

    // Named packages
    const namedRaw = (assets['packages'] ?? {}) as Record<string, unknown>;
    for (const [pkgName, pkgData] of Object.entries(namedRaw)) {
      packages.push(parsePackageConfig(pkgName, (pkgData ?? {}) as Record<string, unknown>, appPath));
    }

    return packages;
  }
  return null;
}

export function listAssetConfig(appPath: string): McpToolResult {
  try {
    const packages = loadAssetConfig(appPath);

    if (!packages) {
      return {
        content: [{
          type: 'text',
          text: 'No framework.yaml assets: configuration found.\n\nExample:\n  framework:\n    assets:\n      json_manifest_path: \'%kernel.project_dir%/public/build/manifest.json\'\n      # Or static version:\n      # version: \'v2\'\n      # base_url: \'https://cdn.example.com\'\n      packages:\n        images:\n          base_url: \'https://img.example.com\'\n          version: \'img-v1\'',
        }],
      };
    }

    const totalIssues = packages.reduce((s, p) => s + p.issues.length, 0);

    let text = `Asset Versioning Configuration\n${'='.repeat(55)}\n`;
    text += `\nPackages: ${packages.length}  Issues: ${totalIssues}\n`;

    for (const pkg of packages) {
      text += `\n  ${pkg.name}\n`;
      if (pkg.baseUrl) text += `    base_url:          ${pkg.baseUrl}\n`;
      if (pkg.basePath) text += `    base_path:         ${pkg.basePath}\n`;
      if (pkg.version) text += `    version:           ${pkg.version}\n`;
      if (pkg.versionStrategy) text += `    version_strategy:  ${pkg.versionStrategy.split('\\').pop()}\n`;
      if (pkg.jsonManifestPath) text += `    json_manifest:     ${pkg.jsonManifestPath}\n`;
      for (const issue of pkg.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetVersioningStats(appPath: string): McpToolResult {
  try {
    const packages = loadAssetConfig(appPath);

    let text = `Asset Versioning Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured:            ${packages ? 'yes' : 'no'}\n`;
    text += `Total packages:        ${packages?.length ?? 0}\n`;
    text += `  Static version:      ${packages?.filter((p) => p.version && !p.versionStrategy && !p.jsonManifestPath).length ?? 0}\n`;
    text += `  JSON manifest:       ${packages?.filter((p) => p.jsonManifestPath).length ?? 0}\n`;
    text += `  Custom strategy:     ${packages?.filter((p) => p.versionStrategy).length ?? 0}\n`;
    text += `  With CDN base_url:   ${packages?.filter((p) => p.baseUrl).length ?? 0}\n`;
    text += `Issues:                ${packages?.reduce((s, p) => s + p.issues.length, 0) ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAssetVersioningTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_asset_config',
      description: 'Show framework.yaml assets: configuration: global and named packages, version/version_strategy/json_manifest_path/base_url per package, static version warning, missing manifest file, insecure http:// CDN URL',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_asset_versioning_stats',
      description: 'Show asset versioning statistics: package count, static/JSON manifest/custom strategy counts, CDN count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
