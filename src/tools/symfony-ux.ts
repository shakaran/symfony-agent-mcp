/**
 * Symfony UX Inspector
 *
 * Discovers Symfony UX component usage:
 *   - #[AsLiveComponent] — Live Components (form-like interactive components)
 *   - #[AsTwigComponent]  — Twig Components (stateless, server-rendered)
 *   - #[AsTurboStream]    — Turbo Streams (partial page updates)
 *   - UX packages installed (symfony/ux-live-component, ux-chartjs, etc.)
 *   - Component templates in templates/components/
 *   - #[PostMount], #[PreMount], #[LiveProp], #[LiveAction] usage
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

type UxComponentType = 'live' | 'twig' | 'unknown';

interface UxComponent {
  class: string;
  file: string;
  type: UxComponentType;
  name?: string;
  template?: string;
  liveProps: string[];
  liveActions: string[];
  hasPreMount: boolean;
  hasPostMount: boolean;
}

interface UxPackage {
  name: string;
  shortName: string;
  purpose: string;
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── UX package catalogue ───────────────────────────────────────────────────

const UX_PACKAGES: UxPackage[] = [
  { name: 'symfony/ux-live-component',    shortName: 'Live Components',   purpose: 'Interactive stateful components with real-time server communication' },
  { name: 'symfony/ux-twig-component',    shortName: 'Twig Components',   purpose: 'Stateless reusable server-rendered components' },
  { name: 'symfony/ux-turbo',             shortName: 'Turbo',             purpose: 'SPA-like navigation and partial page updates (Turbo Drive/Frames/Streams)' },
  { name: 'symfony/ux-stimulus-bundle',   shortName: 'Stimulus',          purpose: 'Stimulus.js integration and controller auto-loading' },
  { name: 'symfony/ux-chartjs',           shortName: 'Chart.js',          purpose: 'Chart.js charts via Twig component' },
  { name: 'symfony/ux-react',             shortName: 'React',             purpose: 'Render React components from Twig' },
  { name: 'symfony/ux-vue',              shortName: 'Vue',               purpose: 'Render Vue components from Twig' },
  { name: 'symfony/ux-svelte',            shortName: 'Svelte',            purpose: 'Render Svelte components from Twig' },
  { name: 'symfony/ux-cropperjs',         shortName: 'Cropper.js',        purpose: 'Image cropping form type' },
  { name: 'symfony/ux-dropzone',          shortName: 'Dropzone',          purpose: 'Drag-and-drop file upload form type' },
  { name: 'symfony/ux-toggle-password',   shortName: 'Toggle Password',   purpose: 'Password visibility toggle' },
  { name: 'symfony/ux-autocomplete',      shortName: 'Autocomplete',      purpose: 'Ajax-powered autocomplete form type' },
  { name: 'symfony/ux-notify',            shortName: 'Notify',            purpose: 'Browser notifications via Mercure' },
  { name: 'symfony/ux-translator',        shortName: 'Translator',        purpose: 'Use Symfony translations in JavaScript' },
  { name: 'symfony/ux-typed',             shortName: 'Typed.js',          purpose: 'Animated text typing effect' },
  { name: 'symfony/ux-swup',             shortName: 'Swup',              purpose: 'Page transition animations' },
  { name: 'symfony/ux-lazy-image',        shortName: 'Lazy Image',        purpose: 'Lazy-loading images with BlurHash placeholders' },
];

function detectInstalledUxPackages(appPath: string): UxPackage[] {
  try {
    const composerLock = JSON.parse(
      fs.readFileSync(path.join(appPath, 'composer.lock'), 'utf-8')
    ) as Record<string, unknown>;

    const packages = (composerLock['packages'] ?? []) as Array<Record<string, unknown>>;
    const installed = new Set(packages.map((p) => String(p['name'])));

    return UX_PACKAGES.filter((pkg) => installed.has(pkg.name));
  } catch {
    return [];
  }
}

// ─── Component parsing ──────────────────────────────────────────────────────

function parseUxComponent(filePath: string): UxComponent | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isLive = content.includes('#[AsLiveComponent') || content.includes('AsLiveComponent');
  const isTwig = content.includes('#[AsTwigComponent') || content.includes('AsTwigComponent');

  if (!isLive && !isTwig) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const type: UxComponentType = isLive ? 'live' : isTwig ? 'twig' : 'unknown';

  // Extract component name from attribute
  const nameM = /#\[As(?:Live|Twig)Component\s*\(\s*(?:name\s*:\s*)?['"]([^'"]+)['"]/.exec(content) ??
                /#\[As(?:Live|Twig)Component\s*\(\s*name\s*:\s*['"]([^'"]+)['"]/.exec(content);

  // Extract template from attribute
  const templateM = /template\s*:\s*['"]([^'"]+)['"]/.exec(content);

  // LiveProp properties
  const liveProps: string[] = [];
  for (const m of content.matchAll(/#\[LiveProp[^\]]*\]\s*(?:public\s+)?(?:readonly\s+)?(?:\??\w+\s+)?\$(\w+)/g)) {
    liveProps.push(m[1]);
  }

  // LiveAction methods
  const liveActions: string[] = [];
  for (const m of content.matchAll(/#\[LiveAction[^\]]*\]\s*(?:public\s+)?function\s+(\w+)/g)) {
    liveActions.push(m[1]);
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    type,
    name: nameM?.[1],
    template: templateM?.[1],
    liveProps,
    liveActions,
    hasPreMount: content.includes('#[PreMount') || content.includes('PreMount'),
    hasPostMount: content.includes('#[PostMount') || content.includes('PostMount'),
  };
}

function loadUxComponents(appPath: string): UxComponent[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Twig'),
    path.join(appPath, 'src', 'Component'),
    path.join(appPath, 'src', 'Components'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const components: UxComponent[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (!content.includes('AsLiveComponent') && !content.includes('AsTwigComponent')) continue;

      const c = parseUxComponent(file);
      if (c) components.push(c);
    }
  }

  return components.sort((a, b) => a.class.localeCompare(b.class));
}

function loadComponentTemplates(appPath: string): string[] {
  const dirs = [
    path.join(appPath, 'templates', 'components'),
    path.join(appPath, 'templates', 'component'),
  ];

  const templates: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          templates.push(path.join(dir.split('/templates/')[1] ?? '', entry.name));
        }
      }
    } catch { /* skip */ }
  }
  return templates.sort();
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listUxComponents(appPath: string): McpToolResult {
  try {
    const components = loadUxComponents(appPath);
    const packages = detectInstalledUxPackages(appPath);
    const templates = loadComponentTemplates(appPath);

    if (components.length === 0 && packages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony UX components found.\n\nInstall:\n  composer require symfony/ux-twig-component\n  composer require symfony/ux-live-component\n\nCreate a component:\n  php bin/console make:twig-component Alert\n  php bin/console make:live-component SearchBar',
        }],
      };
    }

    let text = `Symfony UX\n${'='.repeat(50)}\n`;

    if (packages.length > 0) {
      text += `\nInstalled UX packages (${packages.length}):\n`;
      for (const pkg of packages) {
        text += `  ${pkg.shortName.padEnd(20)} ${pkg.purpose}\n`;
      }
    }

    const live = components.filter((c) => c.type === 'live');
    const twig = components.filter((c) => c.type === 'twig');

    if (live.length > 0) {
      text += `\nLive Components (${live.length}):\n`;
      for (const c of live) {
        text += `\n  ${c.class}  ${c.name ? `(name: "${c.name}")` : ''}\n`;
        if (c.liveProps.length > 0) text += `    #[LiveProp]:  ${c.liveProps.join(', ')}\n`;
        if (c.liveActions.length > 0) text += `    #[LiveAction]: ${c.liveActions.join(', ')}\n`;
        if (c.hasPreMount) text += `    #[PreMount] hook\n`;
        if (c.hasPostMount) text += `    #[PostMount] hook\n`;
        if (c.template) text += `    Template: ${c.template}\n`;
      }
    }

    if (twig.length > 0) {
      text += `\nTwig Components (${twig.length}):\n`;
      for (const c of twig) {
        const name = c.name ? ` (name: "${c.name}")` : '';
        const tmpl = c.template ? `  → ${c.template}` : '';
        text += `  ${c.class}${name}${tmpl}\n`;
      }
    }

    if (templates.length > 0) {
      text += `\nComponent templates in templates/components/ (${templates.length}):\n`;
      for (const t of templates) text += `  ${t}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUxStats(appPath: string): McpToolResult {
  try {
    const components = loadUxComponents(appPath);
    const packages = detectInstalledUxPackages(appPath);

    let text = `Symfony UX Statistics\n${'='.repeat(40)}\n\n`;
    text += `UX packages installed:   ${packages.length}\n`;
    text += `Total UX components:     ${components.length}\n`;
    text += `Live components:         ${components.filter((c) => c.type === 'live').length}\n`;
    text += `Twig components:         ${components.filter((c) => c.type === 'twig').length}\n`;
    text += `With LiveProp:           ${components.filter((c) => c.liveProps.length > 0).length}\n`;
    text += `With LiveAction:         ${components.filter((c) => c.liveActions.length > 0).length}\n`;

    if (packages.length > 0) {
      text += `\nInstalled: ${packages.map((p) => p.shortName).join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getSymfonyUxTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_ux_components',
      description: 'List Symfony UX components: #[AsLiveComponent] with LiveProps/LiveActions, #[AsTwigComponent], installed UX packages, and component templates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_ux_stats',
      description: 'Show Symfony UX statistics: installed package count, live vs twig component count, LiveProp/LiveAction usage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
