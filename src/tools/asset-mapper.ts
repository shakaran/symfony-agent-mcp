/**
 * Symfony Asset Mapper / Webpack Encore Inspector
 *
 * Supports two asset pipelines:
 *   - Asset Mapper (Symfony 6.3+ / 7 default): reads importmap.php,
 *     assets/controllers.json, assets/controllers/ directory
 *   - Webpack Encore (legacy): reads webpack.config.js, package.json
 *
 * Reports:
 *   - Entry points and output paths
 *   - Imported packages (npm / importmap)
 *   - Stimulus controllers (assets/controllers/)
 *   - Asset versioning strategy
 *
 * Pure static analysis — no Node.js or PHP execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ImportMapEntry {
  name: string;
  version?: string;
  url?: string;
  path?: string;
  isLocal: boolean;
}

interface StimulusController {
  name: string;
  file: string;
  isLazy: boolean;
  isEnabled: boolean;
  fromPackage?: string;
}

interface AssetPipeline {
  type: 'asset_mapper' | 'encore' | 'none';
  entryPoints: string[];
  outputPath?: string;
  publicPath?: string;
  packages: ImportMapEntry[];
  stimulusControllers: StimulusController[];
  versionStrategy?: string;
}

// ─── Asset Mapper ──────────────────────────────────────────────────────────

function parseImportMap(appPath: string): ImportMapEntry[] {
  const candidates = [
    path.join(appPath, 'importmap.php'),
    path.join(appPath, 'assets', 'importmap.php'),
  ];

  for (const file of candidates) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const entries: ImportMapEntry[] = [];

    // Match: 'package-name' => ['version' => '1.2.3', 'url' => '...']
    // or:    'package-name' => ['path' => 'assets/app.js']
    const pattern = /['"]([^'"]+)['"]\s*=>\s*\[([\s\S]*?)\]/g;
    let m: RegExpExecArray | null;

    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      const block = m[2];

      const version = /['"]version['"]\s*=>\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      const url = /['"]url['"]\s*=>\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      const localPath = /['"]path['"]\s*=>\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      const isLocal = !!localPath || name.startsWith('.');

      entries.push({ name, version, url, path: localPath, isLocal });
    }

    return entries;
  }

  return [];
}

function parseStimulusControllersJson(appPath: string): StimulusController[] {
  const controllersJson = path.join(appPath, 'assets', 'controllers.json');
  let raw: Record<string, unknown>;

  try {
    raw = JSON.parse(fs.readFileSync(controllersJson, 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const controllers: StimulusController[] = [];
  const controllerMap = (raw['controllers'] ?? {}) as Record<string, Record<string, unknown>>;

  for (const [pkg, pkgControllers] of Object.entries(controllerMap)) {
    for (const [name, config] of Object.entries(pkgControllers)) {
      const c = config as Record<string, unknown>;
      controllers.push({
        name: `${pkg}/${name}`,
        file: `controllers.json`,
        isLazy: Boolean(c['fetch'] === 'lazy'),
        isEnabled: c['enabled'] !== false,
        fromPackage: pkg,
      });
    }
  }

  return controllers;
}

function parseLocalStimulusControllers(appPath: string): StimulusController[] {
  const controllersDir = path.join(appPath, 'assets', 'controllers');
  if (!fs.existsSync(controllersDir)) return [];

  const controllers: StimulusController[] = [];

  try {
    for (const entry of fs.readdirSync(controllersDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('_controller.js') &&
          !entry.name.endsWith('_controller.ts') &&
          !entry.name.endsWith('-controller.js') &&
          !entry.name.endsWith('-controller.ts')) continue;

      const name = entry.name
        .replace(/_controller\.[jt]s$/, '')
        .replace(/-controller\.[jt]s$/, '')
        .replace(/_/g, '-');

      controllers.push({
        name,
        file: path.join('assets', 'controllers', entry.name),
        isLazy: false,
        isEnabled: true,
      });
    }
  } catch { /* skip */ }

  return controllers;
}

// ─── Webpack Encore ─────────────────────────────────────────────────────────

function parseWebpackConfig(appPath: string): { entryPoints: string[]; outputPath?: string; publicPath?: string } {
  const webpackFile = path.join(appPath, 'webpack.config.js');
  let content = '';
  try { content = fs.readFileSync(webpackFile, 'utf-8'); } catch {
    return { entryPoints: [] };
  }

  const entryPoints: string[] = [];

  for (const m of content.matchAll(/\.addEntry\s*\(\s*['"]([^'"]+)['"]/g)) {
    entryPoints.push(m[1]);
  }
  for (const m of content.matchAll(/\.addStyleEntry\s*\(\s*['"]([^'"]+)['"]/g)) {
    entryPoints.push(`${m[1]} (CSS)`);
  }

  const outputPath = /setOutputPath\s*\(\s*['"]([^'"]+)['"]/.exec(content)?.[1];
  const publicPath = /setPublicPath\s*\(\s*['"]([^'"]+)['"]/.exec(content)?.[1];

  return { entryPoints, outputPath, publicPath };
}

function parsePackageJson(appPath: string): ImportMapEntry[] {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8')
    ) as Record<string, unknown>;

    const deps = {
      ...(pkg['dependencies'] as Record<string, string> ?? {}),
      ...(pkg['devDependencies'] as Record<string, string> ?? {}),
    };

    return Object.entries(deps).map(([name, version]) => ({
      name,
      version: String(version).replace(/^[\^~>=<]/, ''),
      isLocal: false,
    }));
  } catch {
    return [];
  }
}

// ─── Pipeline detection ─────────────────────────────────────────────────────

function detectPipeline(appPath: string): AssetPipeline {
  const hasImportMap = fs.existsSync(path.join(appPath, 'importmap.php')) ||
                       fs.existsSync(path.join(appPath, 'assets', 'importmap.php'));
  const hasWebpack = fs.existsSync(path.join(appPath, 'webpack.config.js'));

  if (hasImportMap) {
    const packages = parseImportMap(appPath);
    const pkgControllers = parseStimulusControllersJson(appPath);
    const localControllers = parseLocalStimulusControllers(appPath);

    return {
      type: 'asset_mapper',
      entryPoints: ['assets/app.js'],
      packages,
      stimulusControllers: [...pkgControllers, ...localControllers],
    };
  }

  if (hasWebpack) {
    const { entryPoints, outputPath, publicPath } = parseWebpackConfig(appPath);
    const packages = parsePackageJson(appPath);
    const localControllers = parseLocalStimulusControllers(appPath);

    return {
      type: 'encore',
      entryPoints,
      outputPath,
      publicPath,
      packages,
      stimulusControllers: localControllers,
    };
  }

  return { type: 'none', entryPoints: [], packages: [], stimulusControllers: [] };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listAssetPipeline(appPath: string): McpToolResult {
  try {
    const pipeline = detectPipeline(appPath);

    if (pipeline.type === 'none') {
      return {
        content: [{
          type: 'text',
          text: 'No asset pipeline detected.\n\nAsset Mapper (Symfony 7 default):\n  composer require symfony/asset-mapper\n  php bin/console importmap:install\n\nWebpack Encore (legacy):\n  composer require symfony/webpack-encore-bundle',
        }],
      };
    }

    const label = pipeline.type === 'asset_mapper' ? 'Asset Mapper (Symfony 7)' : 'Webpack Encore';
    let text = `Asset Pipeline: ${label}\n${'='.repeat(50)}\n`;

    if (pipeline.entryPoints.length > 0) {
      text += `\nEntry Points:\n`;
      for (const ep of pipeline.entryPoints) text += `  ${ep}\n`;
    }

    if (pipeline.outputPath) text += `\nOutput path:  ${pipeline.outputPath}\n`;
    if (pipeline.publicPath) text += `Public path:  ${pipeline.publicPath}\n`;

    const external = pipeline.packages.filter((p) => !p.isLocal);
    const local = pipeline.packages.filter((p) => p.isLocal);

    if (external.length > 0) {
      text += `\nExternal packages (${external.length}):\n`;
      for (const p of external.slice(0, 20)) {
        text += `  ${p.name.padEnd(40)} ${p.version ?? ''}\n`;
      }
      if (external.length > 20) text += `  … and ${external.length - 20} more\n`;
    }

    if (local.length > 0) {
      text += `\nLocal assets (${local.length}):\n`;
      for (const p of local) text += `  ${p.path ?? p.name}\n`;
    }

    if (pipeline.stimulusControllers.length > 0) {
      text += `\nStimulus Controllers (${pipeline.stimulusControllers.length}):\n`;
      for (const c of pipeline.stimulusControllers) {
        const flags: string[] = [];
        if (!c.isEnabled) flags.push('disabled');
        if (c.isLazy) flags.push('lazy');
        if (c.fromPackage) flags.push(`pkg: ${c.fromPackage}`);
        text += `  ${c.name.padEnd(35)} ${flags.join(' ')}\n`;
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

export function listStimulusControllers(appPath: string): McpToolResult {
  try {
    const pipeline = detectPipeline(appPath);
    const all = pipeline.stimulusControllers;

    if (all.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Stimulus controllers found.\n\nCreate: assets/controllers/hello_controller.js\nInstall UX: composer require symfony/ux-stimulus-bundle',
        }],
      };
    }

    let text = `Stimulus Controllers (${all.length})\n${'='.repeat(50)}\n\n`;

    const local = all.filter((c) => !c.fromPackage);
    const fromPkg = all.filter((c) => c.fromPackage);

    if (local.length > 0) {
      text += `  Local controllers (${local.length}):\n`;
      for (const c of local) text += `    ${c.name}  (${c.file})\n`;
    }

    if (fromPkg.length > 0) {
      text += `\n  Package controllers (${fromPkg.length}):\n`;
      for (const c of fromPkg) {
        const status = c.isEnabled ? (c.isLazy ? 'lazy' : 'eager') : 'disabled';
        text += `    ${c.name.padEnd(45)} [${status}]\n`;
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

export function getAssetStats(appPath: string): McpToolResult {
  try {
    const pipeline = detectPipeline(appPath);

    let text = `Asset Pipeline Statistics\n${'='.repeat(40)}\n\n`;
    text += `Pipeline:            ${pipeline.type === 'none' ? 'not configured' : pipeline.type === 'asset_mapper' ? 'Asset Mapper' : 'Webpack Encore'}\n`;
    text += `Entry points:        ${pipeline.entryPoints.length}\n`;
    text += `External packages:   ${pipeline.packages.filter((p) => !p.isLocal).length}\n`;
    text += `Local assets:        ${pipeline.packages.filter((p) => p.isLocal).length}\n`;
    text += `Stimulus controllers:${pipeline.stimulusControllers.length}\n`;
    text += `Lazy controllers:    ${pipeline.stimulusControllers.filter((c) => c.isLazy).length}\n`;
    text += `Disabled controllers:${pipeline.stimulusControllers.filter((c) => !c.isEnabled).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getAssetMapperTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_asset_pipeline',
      description: 'Show asset pipeline type (Asset Mapper or Webpack Encore), entry points, imported packages/importmap entries, and Stimulus controllers',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_stimulus_controllers',
      description: 'List all Stimulus controllers: local ones in assets/controllers/ and package-provided ones from controllers.json with lazy/enabled status',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_asset_stats',
      description: 'Show asset pipeline statistics: pipeline type, entry point count, package count, Stimulus controller breakdown',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
