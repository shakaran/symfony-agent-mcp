// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Vite Bundle Inspector (pentatrion/vite-bundle)
 *
 * Checks composer.json for:
 *   - pentatrion/vite-bundle, symfony-vite-dev-server, symfony/asset-mapper
 *
 * Reads vite.config.js or vite.config.ts:
 *   - Plugins: symfonyPlugin, react, vue, svelte
 *   - Server port
 *   - Build outDir
 *
 * Reads config/packages/pentatrion_vite.yaml or vite.yaml:
 *   - builds config, base, server settings
 *
 * Detects package.json for @symfony/vite-dev-server, vite dependencies.
 *
 * Warns about:
 *   - vite-bundle + webpack-encore both present (conflict)
 *   - vite.config.js not found when bundle installed
 *   - outDir not matching public/build
 *   - HMR not configured for dev
 *   - No entrypoints detected
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ViteConfigInfo {
  bundleInstalled: boolean;
  hasViteConfig: boolean;
  hasYamlConfig: boolean;
  plugins: string[];
  entrypoints: string[];
  outDir?: string;
  serverPort?: number;
  hasWebpackConflict: boolean;
  issues: string[];
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { return null; }
}

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function detectComposerPackages(appPath: string): {
  hasViteBundle: boolean;
  hasAssetMapper: boolean;
  hasWebpackEncore: boolean;
} {
  const composer = readJsonFile(path.join(appPath, 'composer.json'));
  if (!composer) return { hasViteBundle: false, hasAssetMapper: false, hasWebpackEncore: false };

  const require = (composer['require'] ?? {}) as Record<string, string>;
  const requireDev = (composer['require-dev'] ?? {}) as Record<string, string>;
  const all = { ...require, ...requireDev };

  return {
    hasViteBundle: 'pentatrion/vite-bundle' in all || 'symfony-vite-dev-server' in all,
    hasAssetMapper: 'symfony/asset-mapper' in all,
    hasWebpackEncore: 'symfony/webpack-encore-bundle' in all,
  };
}

function detectPackageJson(appPath: string): {
  hasViteDevServer: boolean;
  hasVite: boolean;
  viteBundleVersion?: string;
} {
  const pkg = readJsonFile(path.join(appPath, 'package.json'));
  if (!pkg) return { hasViteDevServer: false, hasVite: false };

  const deps = {
    ...(pkg['dependencies'] as Record<string, string> | undefined ?? {}),
    ...(pkg['devDependencies'] as Record<string, string> | undefined ?? {}),
  };

  return {
    hasViteDevServer: '@symfony/vite-dev-server' in deps,
    hasVite: 'vite' in deps,
    viteBundleVersion: deps['vite'],
  };
}

function parseViteConfig(appPath: string): {
  found: boolean;
  plugins: string[];
  outDir?: string;
  serverPort?: number;
  entrypoints: string[];
  hasHmr: boolean;
} {
  const candidates = [
    path.join(appPath, 'vite.config.ts'),
    path.join(appPath, 'vite.config.js'),
    path.join(appPath, 'vite.config.mjs'),
  ];

  for (const filePath of candidates) {
    const content = readFile(filePath);
    if (!content) continue;

    const plugins: string[] = [];
    const PLUGIN_PATTERNS: Array<[RegExp, string]> = [
      [/symfonyPlugin\s*\(/, 'symfonyPlugin'],
      [/\breact\s*\(/, 'react'],
      [/\bvue\s*\(/, 'vue'],
      [/\bsvelte\s*\(/, 'svelte'],
      [/\bsolidPlugin\s*\(/, 'solid'],
      [/\bpreact\s*\(/, 'preact'],
    ];
    for (const [pattern, name] of PLUGIN_PATTERNS) {
      if (pattern.test(content)) plugins.push(name);
    }

    const outDirMatch = /\boutDir\s*:\s*['"`]([^'"`]{1,100})['"`]/.exec(content);
    const portMatch = /\bport\s*:\s*(\d{2,5})/.exec(content);

    // Detect input entrypoints: input: { main: './assets/main.ts', ... }
    const entrypoints: string[] = [];
    const inputMatch = /\binput\s*:\s*\{([^}]{0,500})\}/.exec(content);
    if (inputMatch) {
      const inputContent = inputMatch[1];
      const entryPattern = /(\w{1,80})\s*:/g;
      let em: RegExpExecArray | null;
      while ((em = entryPattern.exec(inputContent)) !== null) {
        entrypoints.push(em[1]);
      }
    }
    // Also: input: ['./assets/app.ts']
    const inputArrayMatch = /\binput\s*:\s*\[([^\][]{0,500}(?:\[[^\][]{0,300}\][^\][]{0,500}){0,40})\]/.exec(content);
    if (inputArrayMatch) {
      const arrContent = inputArrayMatch[1];
      const filePattern = /['"`]([^'"`]{1,100})['"`]/g;
      let fm: RegExpExecArray | null;
      while ((fm = filePattern.exec(arrContent)) !== null) {
        entrypoints.push(fm[1]);
      }
    }

    const hasHmr = content.includes('hmr') || content.includes('HMR');

    return {
      found: true,
      plugins,
      outDir: outDirMatch?.[1],
      serverPort: portMatch ? parseInt(portMatch[1], 10) : undefined,
      entrypoints,
      hasHmr,
    };
  }
  return { found: false, plugins: [], entrypoints: [], hasHmr: false };
}

function parseYamlViteConfig(appPath: string): {
  found: boolean;
  hasBuildsKey: boolean;
} {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'pentatrion_vite.yaml'),
    path.join(appPath, 'config', 'packages', 'pentatrion_vite.yml'),
    path.join(appPath, 'config', 'packages', 'vite.yaml'),
    path.join(appPath, 'config', 'packages', 'vite.yml'),
    path.join(appPath, 'config', 'packages', 'dev', 'pentatrion_vite.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'pentatrion_vite.yml'),
  ];

  for (const filePath of candidates) {
    const content = readFile(filePath);
    if (!content) continue;
    const hasBuildsKey = /\bbuilds\s*:/.test(content);
    return { found: true, hasBuildsKey };
  }
  return { found: false, hasBuildsKey: false };
}

function buildViteInfo(appPath: string): ViteConfigInfo {
  const composer = detectComposerPackages(appPath);
  const npm = detectPackageJson(appPath);
  const viteConfig = parseViteConfig(appPath);
  const yamlConfig = parseYamlViteConfig(appPath);

  const bundleInstalled = composer.hasViteBundle || npm.hasViteDevServer;
  const hasWebpackConflict = bundleInstalled && composer.hasWebpackEncore;

  const issues: string[] = [];

  if (hasWebpackConflict) {
    issues.push('Both pentatrion/vite-bundle and symfony/webpack-encore-bundle are present — remove one to avoid asset conflicts');
  }
  if (bundleInstalled && !viteConfig.found) {
    issues.push('vite-bundle installed but vite.config.js/ts not found — frontend build will not work');
  }
  if (viteConfig.found && viteConfig.outDir && !viteConfig.outDir.includes('public/build') && !viteConfig.outDir.includes('public\\build')) {
    issues.push(`vite outDir is '${viteConfig.outDir}' — Symfony typically expects public/build`);
  }
  if (bundleInstalled && viteConfig.found && !viteConfig.hasHmr && viteConfig.serverPort === undefined) {
    issues.push('HMR and dev server port not detected in vite.config — hot module replacement may not work in development');
  }
  if (bundleInstalled && viteConfig.found && viteConfig.entrypoints.length === 0) {
    issues.push('No entrypoints detected in vite.config input — no assets will be compiled');
  }

  return {
    bundleInstalled,
    hasViteConfig: viteConfig.found,
    hasYamlConfig: yamlConfig.found,
    plugins: viteConfig.plugins,
    entrypoints: viteConfig.entrypoints,
    outDir: viteConfig.outDir,
    serverPort: viteConfig.serverPort,
    hasWebpackConflict,
    issues,
  };
}

export function listViteConfig(appPath: string): McpToolResult {
  try {
    const info = buildViteInfo(appPath);

    if (!info.bundleInstalled && !info.hasViteConfig) {
      return {
        content: [{
          type: 'text',
          text: 'Vite bundle not detected.\n\nInstall pentatrion/vite-bundle:\n  composer require pentatrion/vite-bundle\n  npm install vite @symfony/vite-dev-server --save-dev',
        }],
      };
    }

    let text = `Vite Bundle Configuration\n${'='.repeat(55)}\n\n`;
    text += `Bundle installed:      ${info.bundleInstalled ? 'yes' : 'no'}\n`;
    text += `vite.config file:      ${info.hasViteConfig ? 'found' : 'NOT FOUND'}\n`;
    text += `YAML config:           ${info.hasYamlConfig ? 'found' : 'not found'}\n`;

    if (info.outDir !== undefined) text += `outDir:                ${info.outDir}\n`;
    if (info.serverPort !== undefined) text += `Dev server port:       ${info.serverPort}\n`;

    if (info.plugins.length > 0) {
      text += `\nPlugins: ${info.plugins.join(', ')}\n`;
    }

    if (info.entrypoints.length > 0) {
      text += `\nEntrypoints (${info.entrypoints.length}):\n`;
      for (const ep of info.entrypoints) {
        text += `  ${ep}\n`;
      }
    }

    if (info.hasWebpackConflict) {
      text += `\nCONFLICT: webpack-encore also installed\n`;
    }

    if (info.issues.length > 0) {
      text += `\nWarnings:\n`;
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
      }
    } else {
      text += '\nNo issues detected.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getViteStats(appPath: string): McpToolResult {
  try {
    const info = buildViteInfo(appPath);

    let text = `Vite Bundle Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bundle installed:      ${info.bundleInstalled ? 'yes' : 'no'}\n`;
    text += `vite.config found:     ${info.hasViteConfig ? 'yes' : 'no'}\n`;
    text += `YAML config found:     ${info.hasYamlConfig ? 'yes' : 'no'}\n`;
    text += `Plugins:               ${info.plugins.length} (${info.plugins.join(', ') || 'none'})\n`;
    text += `Entrypoints:           ${info.entrypoints.length}\n`;
    text += `Webpack conflict:      ${info.hasWebpackConflict ? 'YES' : 'no'}\n`;
    text += `Warnings:              ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getViteTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_vite_config',
      description: 'Analyze pentatrion/vite-bundle configuration: detect bundle installation, vite.config.js/ts plugins (symfonyPlugin/react/vue/svelte), entrypoints, outDir, dev server port, YAML config, webpack-encore conflict detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_vite_stats',
      description: 'Statistics for Vite bundle: installation status, config file presence, plugin count, entrypoint count, webpack conflict flag, warning count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
