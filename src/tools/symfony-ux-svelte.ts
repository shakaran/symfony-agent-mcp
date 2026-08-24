// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX Svelte Bridge Inspector
 *
 * Checks composer.json for symfony/ux-svelte.
 * Scans templates/ Twig files for: svelte_component(), <twig:Svelte:Component.
 * Scans assets/ JS/TS for: registerSvelteControllerComponents(), import from '@symfony/ux-svelte'.
 *
 * Warns on:
 *   - svelte_component() component not in assets/svelte/controllers/
 *   - registerSvelteControllerComponents without components
 *   - Svelte component without typed props declaration
 *   - UX Svelte without svelte in package.json
 *   - svelte_component() with PHP class as prop (not serializable)
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

interface UxSvelteInfo {
  hasPackage: boolean;
  componentCount: number;
  issues: string[];
}

function getTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getJsSvelteFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getJsSvelteFiles(full));
      else if (/\.(js|ts|svelte)$/.test(e.name)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function checkComposerForUxSvelte(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-svelte');
  } catch { return false; }
}

function checkPackageJsonForSvelte(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8');
    return content.includes('"svelte"') || content.includes("'svelte'");
  } catch { return false; }
}

function collectTwigSvelteUsages(appPath: string): { count: number; withObjectProps: number } {
  const templateDirs = [path.join(appPath, 'templates'), path.join(appPath, 'src')];

  let count = 0;
  let withObjectProps = 0;

  for (const dir of templateDirs) {
    for (const file of getTwigFiles(dir)) {
      const content = safeRead(file, dir);
      if (content === null) continue;

      if (!content.includes('svelte_component(') && !content.includes('<twig:Svelte:')) continue;
      count++;

      // Detect non-serializable props: passing PHP class instances
      const propsM = /svelte_component\s*\([^,]{0,200},\s*(\{[^}]{0,400}\})/.exec(content);
      if (propsM && /\bnew\s+\w{1,80}/.test(propsM[1])) {
        withObjectProps++;
      }
    }
  }

  return { count, withObjectProps };
}

function checkSvelteControllersDir(appPath: string): boolean {
  const controllersDir = path.join(appPath, 'assets', 'svelte', 'controllers');
  return fs.existsSync(controllersDir);
}

function checkRegisterSvelteCall(appPath: string): { hasImport: boolean; hasComponents: boolean } {
  const assetsDir = path.join(appPath, 'assets');
  if (!fs.existsSync(assetsDir)) return { hasImport: false, hasComponents: false };

  for (const file of getJsSvelteFiles(assetsDir)) {
    const content = safeRead(file, assetsDir);
    if (content === null) continue;

    if (content.includes('@symfony/ux-svelte') || content.includes('registerSvelteControllerComponents')) {
      const hasImport = content.includes('@symfony/ux-svelte');
      const hasComponents = content.includes('registerSvelteControllerComponents(') &&
        /registerSvelteControllerComponents\s*\(\s*(?:import\.meta|require)\b/.test(content);
      return { hasImport, hasComponents };
    }
  }

  return { hasImport: false, hasComponents: false };
}

function countSvelteComponentsWithoutTypedProps(appPath: string): number {
  const svelteDir = path.join(appPath, 'assets', 'svelte', 'controllers');
  if (!fs.existsSync(svelteDir)) return 0;

  let missingCount = 0;
  for (const file of getJsSvelteFiles(svelteDir)) {
    if (!file.endsWith('.svelte')) continue;
    const content = safeRead(file, svelteDir);
    if (content === null) continue;

    // Svelte components with props should have `export let prop` or `<script lang="ts">` with types
    const hasScriptTag = content.includes('<script');
    const hasExportLet = content.includes('export let ');
    const hasTypedScript = content.includes('lang="ts"') || content.includes("lang='ts'");

    if (hasScriptTag && hasExportLet && !hasTypedScript) {
      missingCount++;
    }
  }
  return missingCount;
}

function analyzeUxSvelte(appPath: string): UxSvelteInfo {
  const hasPackage = checkComposerForUxSvelte(appPath);
  const hasSvelteInPackageJson = checkPackageJsonForSvelte(appPath);
  const twigUsages = collectTwigSvelteUsages(appPath);
  const hasControllersDir = checkSvelteControllersDir(appPath);
  const registerInfo = checkRegisterSvelteCall(appPath);
  const untypedComponents = countSvelteComponentsWithoutTypedProps(appPath);

  const issues: string[] = [];

  if (hasPackage && !hasSvelteInPackageJson) {
    issues.push('symfony/ux-svelte installed but "svelte" not found in package.json — Svelte library missing');
  }

  if (twigUsages.withObjectProps > 0) {
    issues.push(`${twigUsages.withObjectProps} svelte_component() call(s) pass PHP class instances as props — must be JSON-serializable`);
  }

  if (twigUsages.count > 0 && !hasControllersDir) {
    issues.push('svelte_component() used but assets/svelte/controllers/ directory not found — Svelte components will not mount');
  }

  if (registerInfo.hasImport && !registerInfo.hasComponents) {
    issues.push('registerSvelteControllerComponents() called without glob/components argument — no components will be registered');
  }

  if (untypedComponents > 0) {
    issues.push(`${untypedComponents} Svelte component(s) use JavaScript (not TypeScript) with exported props — no type safety on props`);
  }

  if (hasPackage && !registerInfo.hasImport && twigUsages.count === 0) {
    issues.push('symfony/ux-svelte installed but no registerSvelteControllerComponents() or svelte_component() usage found');
  }

  return { hasPackage, componentCount: twigUsages.count, issues };
}

export function listSymfonyUxSvelte(appPath: string): McpToolResult {
  try {
    const info = analyzeUxSvelte(appPath);

    if (!info.hasPackage && info.componentCount === 0) {
      return {
        content: [{
          type: 'text',
          text: 'symfony/ux-svelte not installed and no svelte_component() usage found.',
        }],
      };
    }

    let text = `Symfony UX Svelte Bridge Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/ux-svelte installed:   ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `svelte_component() usages:     ${info.componentCount}\n`;
    text += `Issues:                        ${info.issues.length}\n`;

    for (const issue of info.issues) text += `\n  WARNING: ${issue}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyUxSvelteStats(appPath: string): McpToolResult {
  try {
    const info = analyzeUxSvelte(appPath);

    let text = `Symfony UX Svelte Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-svelte installed:    ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `svelte_component() usages:      ${info.componentCount}\n`;
    text += `Total issues:                   ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyUxSvelteTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_ux_svelte',
      description: 'Inspect Symfony UX Svelte bridge: composer package, svelte_component() Twig calls, registerSvelteControllerComponents() in assets, PHP class props, missing svelte/controllers dir, Svelte components without TypeScript props, svelte missing from package.json',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_ux_svelte_stats',
      description: 'Statistics for Symfony UX Svelte bridge: package presence, component count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
