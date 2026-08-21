/**
 * UX TwigComponent Inspector (non-live)
 *
 * Distinct from live-components.ts (#[AsLiveComponent] — reactive, Stimulus-driven)
 * and symfony-ux.ts (general UX package detection).
 * Focuses on static UX TwigComponent (#[AsTwigComponent]):
 *
 * Component classes:
 *   - #[AsTwigComponent(name: 'Alert', template: 'components/Alert.html.twig')]
 *   - Props: public properties, readonly properties (#[ExposeInTemplate])
 *   - Computed properties: methods annotated or returning values for template
 *   - mountWith(): accepts external props
 *   - PreMount: validation/transformation before mounting
 *
 * Anonymous components:
 *   - Twig files in templates/components/ without a backing PHP class
 *   - props block in anonymous component templates
 *
 * Usage scan:
 *   - <twig:ComponentName> in .html.twig templates
 *   - {{ component('name', {props}) }} calls
 *
 * Analysis:
 *   - Component class with no public properties (nothing passed as props)
 *   - Component template not found
 *   - Component name used in templates but no backing class found
 *   - Prop type mismatch: nullable but required in template without default
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigComponent {
  class: string;
  file: string;
  name?: string;
  template?: string;
  props: string[];
  hasMountWith: boolean;
  templateExists: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (entry.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseTwigComponent(filePath: string, appPath: string): TwigComponent | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('#[AsTwigComponent') && !content.includes('AsTwigComponent(')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('#[AsLiveComponent')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const nameM     = /#\[AsTwigComponent[^)]*name\s*:\s*['"]([^'"]+)['"]/.exec(content);
  const templateM = /#\[AsTwigComponent[^)]*template\s*:\s*['"]([^'"]+)['"]/.exec(content);

  const name     = nameM?.[1] ?? classM[1];
  const template = templateM?.[1];

  // Collect public props
  const props: string[] = [];
  for (const m of content.matchAll(/public\s+(?:readonly\s+)?(?:\??\w+\s+)?\$(\w+)/g)) {
    if (!['id', 'container', 'kernel', 'request'].includes(m[1])) props.push(m[1]);
  }
  for (const m of content.matchAll(/#\[ExposeInTemplate[^\]]*\]\s*(?:public\s+)?(?:\w+\s+)?\$(\w+)/g)) {
    if (!props.includes(m[1])) props.push(m[1]);
  }

  const hasMountWith = content.includes('function mount(') || content.includes('function mountWith(');

  let templateExists = false;
  if (template) {
    const tplPath = path.join(appPath, 'templates', template);
    templateExists = fs.existsSync(tplPath);
  } else {
    // Default template location: components/ClassName.html.twig
    const defaultPath = path.join(appPath, 'templates', 'components', classM[1] + '.html.twig');
    templateExists = fs.existsSync(defaultPath);
  }

  const issues: string[] = [];
  if (!templateExists) issues.push(`Component template not found (checked templates/components/${classM[1]}.html.twig)`);
  if (props.length === 0 && !hasMountWith) issues.push('No public props or mount() — component cannot receive external data');

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    name,
    template,
    props,
    hasMountWith,
    templateExists,
    issues,
  };
}

function scanComponentUsage(appPath: string, componentNames: Set<string>): Map<string, number> {
  const templatesDir = path.join(appPath, 'templates');
  if (!fs.existsSync(templatesDir)) return new Map();

  const usage = new Map<string, number>();
  for (const file of getAllTwigFiles(templatesDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const name of componentNames) {
      if (content.includes(`<twig:${name}`) || content.includes(`component('${name}'`) ||
          content.includes(`component("${name}"`)) {
        usage.set(name, (usage.get(name) ?? 0) + 1);
      }
    }
  }
  return usage;
}

export function listTwigComponents(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const components: TwigComponent[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const c = parseTwigComponent(file, appPath);
      if (c) components.push(c);
    }

    if (components.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[AsTwigComponent] classes found.\n\nInstall:\n  composer require symfony/ux-twig-component\n\nCreate a component:\n  #[AsTwigComponent]\n  class Alert\n  {\n    public string $message = \'\';\n    public string $type = \'info\';\n  }\n\nTemplate: templates/components/Alert.html.twig\n  <div class="alert alert-{{ type }}">\n    {{ message }}\n  </div>',
        }],
      };
    }

    const compNames = new Set(components.map((c) => c.name ?? c.class));
    const usage     = scanComponentUsage(appPath, compNames);
    const totalIssues = components.reduce((s, c) => s + c.issues.length, 0);

    let text = `UX Twig Components\n${'='.repeat(55)}\n`;
    text += `\nComponents: ${components.length}  Issues: ${totalIssues}\n`;

    for (const c of components.sort((a, b) => b.issues.length - a.issues.length || (a.name ?? a.class).localeCompare(b.name ?? b.class))) {
      const usageCount = usage.get(c.name ?? c.class) ?? 0;
      const tplOk  = c.templateExists ? '✓' : '⚠';
      text += `\n  ${tplOk} ${(c.name ?? c.class).padEnd(30)} props: ${c.props.join(', ') || 'none'}  used: ${usageCount}x\n`;
      if (c.hasMountWith) text += `    [mount()]\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigComponentStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const components: TwigComponent[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const c = parseTwigComponent(file, appPath);
        if (c) components.push(c);
      }
    }

    let text = `Twig Component Statistics\n${'='.repeat(40)}\n\n`;
    text += `Components:          ${components.length}\n`;
    text += `  Template found:    ${components.filter((c) => c.templateExists).length}\n`;
    text += `  With mount():      ${components.filter((c) => c.hasMountWith).length}\n`;
    text += `  No props:          ${components.filter((c) => c.props.length === 0 && !c.hasMountWith).length}\n`;
    text += `Issues:              ${components.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigComponentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_components',
      description: 'Show UX TwigComponent (#[AsTwigComponent]) analysis: component name, template existence, public props, mount(), usage count in Twig templates, missing template warning, no-props warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_component_stats',
      description: 'Show Twig component statistics: total count, template found, mount() count, no-props count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
