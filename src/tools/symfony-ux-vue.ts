// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX Vue.js Bridge Inspector
 *
 * Checks composer.json for symfony/ux-vue.
 * Scans templates/ Twig files for: vue_component(), <twig:Vue:Component.
 * Scans assets/ JS/TS for: registerVueControllerComponents(), import from '@symfony/ux-vue'.
 *
 * Warns on:
 *   - vue_component() with non-serializable props
 *   - vue_component() component not in assets/vue/controllers/
 *   - registerVueControllerComponents called without components
 *   - Vue component without defineProps (implicit any props)
 *   - UX Vue without Vue in package.json
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface UxVueInfo {
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

function getJsVueFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getJsVueFiles(full));
      else if (/\.(js|ts|vue)$/.test(e.name)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function checkComposerForUxVue(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-vue');
  } catch { return false; }
}

function checkPackageJsonForVue(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'package.json'), 'utf-8');
    return content.includes('"vue"') || content.includes("'vue'");
  } catch { return false; }
}

function collectTwigVueUsages(appPath: string): { count: number; withObjectProps: number } {
  const templateDirs = [path.join(appPath, 'templates'), path.join(appPath, 'src')];

  let count = 0;
  let withObjectProps = 0;

  for (const dir of templateDirs) {
    for (const file of getTwigFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('vue_component(') && !content.includes('<twig:Vue:')) continue;
      count++;

      // Detect non-serializable props: new ClassName or PHP class instances
      const propsM = /vue_component\s*\([^,]{0,200},\s*(\{[^}]{0,400}\})/.exec(content);
      if (propsM && /\bnew\s+\w{1,80}/.test(propsM[1])) {
        withObjectProps++;
      }
    }
  }

  return { count, withObjectProps };
}

function checkVueControllersDir(appPath: string): boolean {
  const controllersDir = path.join(appPath, 'assets', 'vue', 'controllers');
  return fs.existsSync(controllersDir);
}

function checkRegisterVueCall(appPath: string): { hasImport: boolean; hasComponents: boolean } {
  const assetsDir = path.join(appPath, 'assets');
  if (!fs.existsSync(assetsDir)) return { hasImport: false, hasComponents: false };

  for (const file of getJsVueFiles(assetsDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (content.includes('@symfony/ux-vue') || content.includes('registerVueControllerComponents')) {
      const hasImport = content.includes('@symfony/ux-vue');
      const hasComponents = content.includes('registerVueControllerComponents(') &&
        /registerVueControllerComponents\s*\(\s*(?:import\.meta|require)\b/.test(content);
      return { hasImport, hasComponents };
    }
  }

  return { hasImport: false, hasComponents: false };
}

function checkVueComponentsHaveDefineProps(appPath: string): number {
  const vueDir = path.join(appPath, 'assets', 'vue', 'controllers');
  if (!fs.existsSync(vueDir)) return 0;

  let missingCount = 0;
  for (const file of getJsVueFiles(vueDir)) {
    if (!file.endsWith('.vue')) continue;
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('defineProps') && !content.includes(':Props') && !content.includes('PropType')) {
      missingCount++;
    }
  }
  return missingCount;
}

function analyzeUxVue(appPath: string): UxVueInfo {
  const hasPackage = checkComposerForUxVue(appPath);
  const hasVueInPackageJson = checkPackageJsonForVue(appPath);
  const twigUsages = collectTwigVueUsages(appPath);
  const hasControllersDir = checkVueControllersDir(appPath);
  const registerInfo = checkRegisterVueCall(appPath);
  const missingDefineProps = checkVueComponentsHaveDefineProps(appPath);

  const issues: string[] = [];

  if (hasPackage && !hasVueInPackageJson) {
    issues.push('symfony/ux-vue installed but "vue" not found in package.json — Vue library missing');
  }

  if (twigUsages.withObjectProps > 0) {
    issues.push(`${twigUsages.withObjectProps} vue_component() call(s) pass PHP objects as props — must be JSON-serializable`);
  }

  if (twigUsages.count > 0 && !hasControllersDir) {
    issues.push('vue_component() used but assets/vue/controllers/ directory not found — Vue components will not mount');
  }

  if (registerInfo.hasImport && !registerInfo.hasComponents) {
    issues.push('registerVueControllerComponents() called without glob/components argument — no components will be registered');
  }

  if (missingDefineProps > 0) {
    issues.push(`${missingDefineProps} Vue component(s) in assets/vue/controllers/ without defineProps — implicit any props, no type safety`);
  }

  if (hasPackage && !registerInfo.hasImport && twigUsages.count === 0) {
    issues.push('symfony/ux-vue installed but no registerVueControllerComponents() or vue_component() usage found');
  }

  return { hasPackage, componentCount: twigUsages.count, issues };
}

export function listSymfonyUxVue(appPath: string): McpToolResult {
  try {
    const info = analyzeUxVue(appPath);

    if (!info.hasPackage && info.componentCount === 0) {
      return {
        content: [{
          type: 'text',
          text: 'symfony/ux-vue not installed and no vue_component() usage found.',
        }],
      };
    }

    let text = `Symfony UX Vue.js Bridge Analysis\n${'='.repeat(55)}\n\n`;
    text += `symfony/ux-vue installed:   ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `vue_component() usages:     ${info.componentCount}\n`;
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

export function getSymfonyUxVueStats(appPath: string): McpToolResult {
  try {
    const info = analyzeUxVue(appPath);

    let text = `Symfony UX Vue Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-vue installed:    ${info.hasPackage ? 'yes' : 'no'}\n`;
    text += `vue_component() usages:      ${info.componentCount}\n`;
    text += `Total issues:                ${info.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyUxVueTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_ux_vue',
      description: 'Inspect Symfony UX Vue bridge: composer package, vue_component() Twig calls, registerVueControllerComponents() in assets, non-serializable props, missing vue/controllers dir, Vue components without defineProps, Vue missing from package.json',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_ux_vue_stats',
      description: 'Statistics for Symfony UX Vue bridge: package presence, component count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
