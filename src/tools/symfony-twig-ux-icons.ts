/**
 * Symfony UX Icons Inspector
 *
 * Detects ux_icon() usage in Twig templates and checks configuration
 * in composer.json and ux_icons.yaml.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UxIconEntry {
  file: string;
  icons: string[];
  hasAriaAttr: boolean;
  issues: string[];
}

// ─── File collection ─────────────────────────────────────────────────────────

function collectTwigFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectTwigFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.twig')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Icon name extraction ────────────────────────────────────────────────────

function extractIconNames(content: string): string[] {
  const icons: string[] = [];
  // ux_icon('name') or ux_icon("name")
  const re = /ux_icon\s*\(\s*['"]([^'"]{1,120})['"]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    icons.push(m[1]);
  }
  // <twig:UX:Icon name="..." />
  const re2 = /<twig:UX:Icon[^>]{0,300}name\s*=\s*['"]([^'"]{1,120})['"]/gu;
  while ((m = re2.exec(content)) !== null) {
    if (!icons.includes(m[1])) icons.push(m[1]);
  }
  // {% component 'ux:icon' with {name: 'foo'} %}
  const re3 = /component\s+['"]ux:icon['"]\s+with\s*\{[^}]{0,200}name\s*:\s*['"]([^'"]{1,120})['"]/gu;
  while ((m = re3.exec(content)) !== null) {
    if (!icons.includes(m[1])) icons.push(m[1]);
  }
  return icons;
}

function hasAriaAttribute(content: string): boolean {
  return /aria-label\s*=/u.test(content) || /aria-hidden\s*=/u.test(content);
}

function isInsideLoop(content: string, iconCallIndex: number): boolean {
  const before = content.slice(0, iconCallIndex);
  const forCount = (before.match(/\{%\s*for\s+/gu) ?? []).length;
  const endforCount = (before.match(/\{%\s*endfor\s*%\}/gu) ?? []).length;
  return forCount > endforCount;
}

// ─── Config loading ──────────────────────────────────────────────────────────

interface UxIconConfig {
  installed: boolean;
  hasIconSets: boolean;
  hasFallbackIcon: boolean;
  hasSprite: boolean;
  iconSets: string[];
}

function loadUxIconConfig(appPath: string): UxIconConfig {
  // Check composer.json
  let installed = false;
  try {
    const composerRaw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf8');
    const composer = JSON.parse(composerRaw) as Record<string, unknown>;
    const require = (composer['require'] ?? {}) as Record<string, unknown>;
    const requireDev = (composer['require-dev'] ?? {}) as Record<string, unknown>;
    installed = 'symfony/ux-icons' in require || 'symfony/ux-icons' in requireDev;
  } catch {
    // no composer.json
  }

  // Check ux_icons.yaml
  const candidates = [
    path.join(appPath, 'config', 'packages', 'ux_icons.yaml'),
    path.join(appPath, 'config', 'ux_icons.yaml'),
  ];

  for (const candidate of candidates) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!raw) continue;

    const uxIcons = (raw['ux_icons'] ?? raw) as Record<string, unknown>;
    const iconSets = uxIcons['icon_sets'] as Record<string, unknown> | undefined;
    const iconSetsNames = iconSets ? Object.keys(iconSets) : [];
    const hasFallback = 'fallback_icon' in uxIcons;
    const hasSprite = 'sprite' in uxIcons || /sprite/u.test(JSON.stringify(uxIcons));

    return {
      installed,
      hasIconSets: iconSetsNames.length > 0,
      hasFallbackIcon: hasFallback,
      hasSprite,
      iconSets: iconSetsNames,
    };
  }

  return { installed, hasIconSets: false, hasFallbackIcon: false, hasSprite: false, iconSets: [] };
}

// ─── Template scanning ───────────────────────────────────────────────────────

function scanTwigFiles(appPath: string, config: UxIconConfig): UxIconEntry[] {
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];

  const results: UxIconEntry[] = [];

  for (const dir of templateDirs) {
    const files = collectTwigFiles(dir);
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const hasUxIcon =
        /ux_icon\s*\(/u.test(content) ||
        /<twig:UX:Icon/u.test(content) ||
        /component\s+['"]ux:icon/u.test(content);

      if (!hasUxIcon) continue;

      const icons = extractIconNames(content);
      const hasAriaAttr = hasAriaAttribute(content);
      const issues: string[] = [];

      if (!hasAriaAttr) {
        issues.push(
          'ux_icon() used without aria-label or aria-hidden — icons are not accessible to screen readers (WCAG 2.1 failure)'
        );
      }

      if (!config.hasIconSets && config.installed) {
        issues.push(
          'symfony/ux-icons is installed but no icon set is configured in ux_icons.yaml — ux_icon() calls will fail at render time'
        );
      }

      if (!config.hasSprite) {
        issues.push(
          'No icon sprite configured — each ux_icon() call reads an individual SVG file; configure sprite for better performance'
        );
      }

      // Check if used inside a loop
      const uxIconIdx = content.indexOf('ux_icon(');
      if (uxIconIdx !== -1 && isInsideLoop(content, uxIconIdx)) {
        issues.push(
          'ux_icon() called inside a {% for %} loop without sprite caching — repeated SVG parsing on each iteration'
        );
      }

      results.push({
        file: path.relative(appPath, file),
        icons,
        hasAriaAttr,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonyTwigUxIcons(appPath: string): McpToolResult {
  try {
    const config = loadUxIconConfig(appPath);
    const entries = scanTwigFiles(appPath, config);

    if (entries.length === 0 && !config.installed) {
      return {
        content: [{
          type: 'text',
          text: 'symfony/ux-icons is not installed and no ux_icon() calls found in templates.',
        }],
      };
    }

    let text = `Symfony UX Icons Inspector  (${entries.length} templates)\n${'='.repeat(58)}\n`;
    text += `\nPackage installed:    ${config.installed ? 'yes' : 'no'}\n`;
    text += `Icon sets configured: ${config.hasIconSets ? config.iconSets.join(', ') : 'none'}\n`;
    text += `Sprite configured:    ${config.hasSprite ? 'yes' : 'no'}\n`;
    text += `Fallback icon:        ${config.hasFallbackIcon ? 'yes' : 'no'}\n`;

    if (!config.hasIconSets && config.installed) {
      text += `[!] No icon sets configured in ux_icons.yaml\n`;
    }

    for (const e of entries) {
      const prefix = e.issues.length > 0 ? '\n[!]' : '\n   ';
      text += `${prefix} ${e.file}\n`;
      text += `    Icons: ${e.icons.slice(0, 10).join(', ')}${e.icons.length > 10 ? ` ... +${e.icons.length - 10}` : ''}\n`;
      text += `    Aria attributes: ${e.hasAriaAttr ? 'yes' : 'NO [!]'}\n`;
      for (const issue of e.issues) {
        text += `    [!] ${issue}\n`;
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

export function getSymfonyTwigUxIconStats(appPath: string): McpToolResult {
  try {
    const config = loadUxIconConfig(appPath);
    const entries = scanTwigFiles(appPath, config);

    const allIcons = new Set<string>();
    for (const e of entries) {
      for (const icon of e.icons) allIcons.add(icon);
    }
    const withIssues = entries.filter((e) => e.issues.length > 0);
    const withoutAria = entries.filter((e) => !e.hasAriaAttr);

    let text = `Symfony UX Icons Statistics\n${'='.repeat(40)}\n\n`;
    text += `Package installed:        ${config.installed ? 'yes' : 'no'}\n`;
    text += `Templates using ux_icon:  ${entries.length}\n`;
    text += `Unique icon names:        ${allIcons.size}\n`;
    text += `Templates with issues:    ${withIssues.length}\n`;
    text += `Without aria attributes:  ${withoutAria.length}\n`;
    text += `Icon sets configured:     ${config.iconSets.length}\n`;
    text += `Sprite configured:        ${config.hasSprite ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonyTwigUxIconTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_twig_ux_icons',
      description: 'Detect ux_icon() usage in Twig templates; checks composer.json for symfony/ux-icons, ux_icons.yaml for icon sets and sprite config; warns on missing aria attributes, unconfigured icon sets, missing sprite, and icons in loops',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_twig_ux_icon_stats',
      description: 'Statistics on Symfony UX Icons usage: template count, unique icon names, aria attribute coverage, icon set configuration status',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
