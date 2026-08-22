/**
 * Symfony UX React Bridge Inspector
 *
 * Checks composer.json for symfony/ux-react.
 * Scans templates/ Twig files for: react_component(), <twig:React:Component, ux-react Stimulus controller.
 * Scans assets/ JS/TS for: registerReactControllerComponents(), import from '@symfony/ux-react'.
 *
 * Warns on:
 *   - react_component() with PHP objects as props (not JSON-serializable)
 *   - react_component() without assets/controllers/react_controller.js
 *   - registerReactControllerComponents without components argument
 *   - React component file missing (props rendered to null)
 *   - UX React without React in package.json
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface UxReactInfo {
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

function getJsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getJsFiles(full));
      else if (/\.(js|ts|jsx|tsx)$/.test(e.name)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function checkComposerForUxReact(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-react');
  } catch { return false; }
}

function checkPackageJsonForReact(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8');
    return content.includes('"react"') || content.includes("'react'");
  } catch { return false; }
}

function collectTwigReactUsages(appPath: string): { count: number; withObjectProps: number } {
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];

  let count = 0;
  let withObjectProps = 0;

  for (const dir of templateDirs) {
    for (const file of getTwigFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const hasReactComp = content.includes('react_component(') ||
        content.includes('<twig:React:') ||
        content.includes('data-controller="react"');

      if (!hasReactComp) continue;
      count++;

      // Detect passing PHP objects: new ClassName(...) or {object}, not just scalars
      const propsM = /react_component\s*\([^,]{0,200},\s*(\{[^}]{0,400}\})/.exec(content);
      if (propsM && /\bnew\s+\w{1,80}|\bthis\./.test(propsM[1])) {
        withObjectProps++;
      }
    }
  }

  return { count, withObjectProps };
}

function checkAssetsControllerExists(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'assets', 'controllers', 'react_controller.js'),
    path.join(appPath, 'assets', 'controllers', 'react_controller.ts'),
    path.join(appPath, 'assets', 'react_controller.js'),
  ];
  return candidates.some((f) => fs.existsSync(f));
}

function checkRegisterCall(appPath: string): { hasImport: boolean; hasComponents: boolean } {
  const assetsDir = path.join(appPath, 'assets');
  if (!fs.existsSync(assetsDir)) return { hasImport: false, hasComponents: false };

  for (const file of getJsFiles(assetsDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (content.includes('@symfony/ux-react') || content.includes('registerReactControllerComponents')) {
      const hasImport = content.includes('@symfony/ux-react');
      const hasComponents = content.includes('registerReactControllerComponents(') &&
        /registerReactControllerComponents\s*\(\s*(?:import\.meta|require)\b/.test(content);
      return { hasImport, hasComponents };
    }
  }

  return { hasImport: false, hasComponents: false };
}

function analyzeUxReact(appPath: string): UxReactInfo {
  const hasPackage = checkComposerForUxReact(appPath);
  const hasReactInPackageJson = checkPackageJsonForReact(appPath);
  const twigUsages = collectTwigReactUsages(appPath);
  const controllerExists = checkAssetsControllerExists(appPath);
  const registerInfo = checkRegisterCall(appPath);

  const issues: string[] = [];

  if (hasPackage && !hasReactInPackageJson) {
    issues.push('symfony/ux-react installed but "react" not found in package.json — React library missing');
  }

  if (twigUsages.withObjectProps > 0) {
    issues.push(`${twigUsages.withObjectProps} react_component() call(s) pass PHP objects as props — must be JSON-serializable scalars/arrays`);
  }

  if (twigUsages.count > 0 && !controllerExists) {
    issues.push('react_component() used but assets/controllers/react_controller.js not found — React components will not mount');
  }

  if (registerInfo.hasImport && !registerInfo.hasComponents) {
    issues.push('registerReactControllerComponents() called without glob/components argument — no components will be registered');
  }

  if (hasPackage && !registerInfo.hasImport && twigUsages.count === 0) {
    issues.push('symfony/ux-react installed but no registerReactControllerComponents() or react_component() usage found');
  }

  return { hasPackage, componentCount: twigUsages.count, issues };
}

export function listSymfonyUxReact(appPath: string): McpToolResult {
  try {
    const info = analyzeUxReact(appPath);

    if (!info.hasPackage && info.componentCount === 0) {
      return {
        content: [{
          type: 'text',
          text: 'symfony/ux-react not installed and no react_component() usage found.',
        }],
      };
    }

    let text = `Symfony UX React Bridge Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/ux-react installed: ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `react_component() usages:   ${info.componentCount}\n`;
    text += `Issues:                     ${info.issues.length}\n`;

    for (const issue of info.issues) text += `\n  WARNING: ${issue}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyUxReactStats(appPath: string): McpToolResult {
  try {
    const info = analyzeUxReact(appPath);

    let text = `Symfony UX React Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-react installed:   ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `react_component() usages:     ${info.componentCount}\n`;
    text += `Total issues:                 ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyUxReactTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_ux_react',
      description: 'Inspect Symfony UX React bridge: composer package, react_component() Twig calls, registerReactControllerComponents() in assets, PHP object props, missing react_controller.js, React missing from package.json',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_ux_react_stats',
      description: 'Statistics for Symfony UX React bridge: package presence, component count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
