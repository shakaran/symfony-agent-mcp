/**
 * Webpack Encore Inspector
 *
 * Reads webpack.config.js:
 *   - Entries configured (addEntry / addStyleEntry / createSharedEntry)
 *   - Feature flags: enableSassLoader, enableLessLoader, enableTypeScriptLoader,
 *     enableReactPreset, enableVueLoader, enableSveltePreset
 *   - splitEntryChunks, enableSingleRuntimeChunk
 *   - configureBabel / configureLoaderRule calls
 *   - enableSourceMaps, enableVersioning
 *   - Copy plugin usage (copyFiles)
 *   - Output path
 *
 * package.json analysis:
 *   - devDependencies: @symfony/webpack-encore version, webpack version
 *   - Frontend frameworks: react, vue, svelte, stimulus (see symfony-ux.ts)
 *
 * Detection of coexistence with AssetMapper (migration pending):
 *   - importmap.php present alongside webpack.config.js
 *
 * Pure static analysis — no Node.js execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EncoreEntry {
  name: string;
  file: string;
  type: 'js' | 'css' | 'shared';
}

interface EncoreConfig {
  outputPath?: string;
  publicPath?: string;
  entries: EncoreEntry[];
  features: string[];
  splitEntryChunks: boolean;
  singleRuntime: boolean;
  sourceMap: boolean;
  versioning: boolean;
  copyFiles: boolean;
  babelConfigured: boolean;
  encoreVersion?: string;
  webpackVersion?: string;
}

function parseWebpackConfig(appPath: string): EncoreConfig | null {
  const candidates = ['webpack.config.js', 'webpack.config.ts'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const entries: EncoreEntry[] = [];
    for (const m of content.matchAll(/\.addEntry\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      entries.push({ name: m[1], file: m[2], type: 'js' });
    }
    for (const m of content.matchAll(/\.addStyleEntry\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      entries.push({ name: m[1], file: m[2], type: 'css' });
    }
    for (const m of content.matchAll(/\.createSharedEntry\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      entries.push({ name: m[1], file: m[2], type: 'shared' });
    }

    const features: string[] = [];
    const FLAG_MAP: Record<string, string> = {
      enableSassLoader:      'Sass/SCSS',
      enableLessLoader:      'Less',
      enableTypeScriptLoader: 'TypeScript',
      enableReactPreset:     'React',
      enableVueLoader:       'Vue.js',
      enableSveltePreset:    'Svelte',
      enableStimulusBridge:  'Stimulus',
      enableIntegrityHashes: 'Subresource Integrity',
    };
    for (const [flag, label] of Object.entries(FLAG_MAP)) {
      if (content.includes(`.${flag}(`)) features.push(label);
    }

    const outputM  = /setOutputPath\s*\(\s*['"]([^'"]+)['"]/.exec(content);
    const publicM  = /setPublicPath\s*\(\s*['"]([^'"]+)['"]/.exec(content);

    return {
      outputPath: outputM?.[1],
      publicPath: publicM?.[1],
      entries,
      features,
      splitEntryChunks:  content.includes('.splitEntryChunks()'),
      singleRuntime:     content.includes('.enableSingleRuntimeChunk()') || content.includes('.disableSingleRuntimeChunk()'),
      sourceMap:         content.includes('.enableSourceMaps('),
      versioning:        content.includes('.enableVersioning('),
      copyFiles:         content.includes('.copyFiles('),
      babelConfigured:   content.includes('.configureBabel(') || content.includes('.configureBabelPresetEnv('),
    };
  }
  return null;
}

function readPackageJson(appPath: string): { encoreVersion?: string; webpackVersion?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    const deps = { ...pkg['dependencies'], ...pkg['devDependencies'] };
    return {
      encoreVersion: deps['@symfony/webpack-encore'],
      webpackVersion: deps['webpack'],
    };
  } catch { return {}; }
}

function hasAssetMapper(appPath: string): boolean {
  return fs.existsSync(path.join(appPath, 'importmap.php')) ||
         fs.existsSync(path.join(appPath, 'assets', 'importmap.php'));
}

export function listWebpackConfig(appPath: string): McpToolResult {
  try {
    const config = parseWebpackConfig(appPath);
    const pkgInfo = readPackageJson(appPath);
    const assetMapper = hasAssetMapper(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'No webpack.config.js found.\n\nInstall Webpack Encore:\n  composer require symfony/webpack-encore-bundle\n  npm install @symfony/webpack-encore --save-dev\n\nOr migrate to AssetMapper (Symfony 6.3+):\n  composer require symfony/asset-mapper',
        }],
      };
    }

    const versions = { ...pkgInfo };
    Object.assign(config, versions);

    let text = `Webpack Encore Configuration\n${'='.repeat(55)}\n\n`;
    if (config.encoreVersion) text += `@symfony/webpack-encore: ${config.encoreVersion}\n`;
    if (config.webpackVersion) text += `webpack:                 ${config.webpackVersion}\n`;
    if (config.outputPath)    text += `Output path:             ${config.outputPath}\n`;
    if (config.publicPath)    text += `Public path:             ${config.publicPath}\n`;

    if (config.features.length > 0) {
      text += `\nEnabled features:\n`;
      for (const f of config.features) text += `  ${f}\n`;
    }

    text += `\nConfiguration:\n`;
    text += `  splitEntryChunks:    ${config.splitEntryChunks ? 'yes' : 'no'}\n`;
    text += `  singleRuntimeChunk:  ${config.singleRuntime ? 'yes' : 'no'}\n`;
    text += `  sourceMaps:          ${config.sourceMap ? 'yes' : 'no'}\n`;
    text += `  versioning:          ${config.versioning ? 'yes' : 'no'}\n`;
    text += `  copyFiles:           ${config.copyFiles ? 'yes' : 'no'}\n`;
    text += `  babelConfigured:     ${config.babelConfigured ? 'yes' : 'no'}\n`;

    if (config.entries.length > 0) {
      text += `\nEntries (${config.entries.length}):\n`;
      for (const e of config.entries) {
        text += `  ${e.name.padEnd(25)} [${e.type.padEnd(6)}] ${e.file}\n`;
      }
    }

    if (assetMapper) {
      text += `\n⚠ importmap.php detected alongside webpack.config.js — consider completing AssetMapper migration\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWebpackStats(appPath: string): McpToolResult {
  try {
    const config      = parseWebpackConfig(appPath);
    const assetMapper = hasAssetMapper(appPath);

    let text = `Webpack Encore Statistics\n${'='.repeat(40)}\n\n`;
    text += `webpack.config.js:   ${config ? 'found' : 'not found'}\n`;
    if (config) {
      text += `Entries:             ${config.entries.length}\n`;
      text += `  JS entries:        ${config.entries.filter((e) => e.type === 'js').length}\n`;
      text += `  CSS entries:       ${config.entries.filter((e) => e.type === 'css').length}\n`;
      text += `  Shared entries:    ${config.entries.filter((e) => e.type === 'shared').length}\n`;
      text += `Features enabled:    ${config.features.length}\n`;
      if (config.features.length > 0) text += `  (${config.features.join(', ')})\n`;
    }
    text += `AssetMapper coexists: ${assetMapper ? 'yes ⚠' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWebpackEncoreTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_webpack_config',
      description: 'Show Webpack Encore configuration: entries (JS/CSS/shared), enabled features (Sass/TypeScript/React/Vue/Svelte), splitEntryChunks, versioning, sourceMaps, Encore/webpack versions, AssetMapper coexistence warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_webpack_stats',
      description: 'Show Webpack Encore statistics: entry count by type, enabled feature count, AssetMapper coexistence flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
