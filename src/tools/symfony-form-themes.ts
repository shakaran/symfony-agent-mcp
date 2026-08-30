// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form Theme Inspector
 *
 * Reads framework.yaml templating.form.resources[] for global themes.
 * Scans templates/ for {% form_theme %} tags.
 * Detects theme types and warns about mixing or misconfiguration.
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type ThemeType = 'bootstrap5' | 'tailwind' | 'foundation' | 'custom';
type ThemeSource = 'global' | 'local';

interface FormThemeInfo {
  source: ThemeSource;
  template: string;
  file?: string;
  themeType: ThemeType;
  issues: string[];
}

function classifyTheme(template: string): ThemeType {
  if (template.includes('bootstrap_5') || template.includes('bootstrap_4') || template.includes('bootstrap_3')) return 'bootstrap5';
  if (template.includes('tailwind')) return 'tailwind';
  if (template.includes('foundation')) return 'foundation';
  return 'custom';
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadGlobalThemes(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
    path.join(appPath, 'config', 'framework.yaml'),
    path.join(appPath, 'config', 'framework.yml'),
  ];

  for (const configPath of candidates) {
    const raw = parseYamlFile(configPath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = raw['framework'] as Record<string, unknown> | undefined ?? raw;
    const templating = framework['templating'] as Record<string, unknown> | undefined;
    const twig = framework['twig'] as Record<string, unknown> | undefined;

    // Check framework.templating.form.resources
    const formSection = templating?.['form'] as Record<string, unknown> | undefined;
    const resources = formSection?.['resources'];
    if (Array.isArray(resources)) {
      return resources.map(String);
    }

    // Also check twig.form_themes
    const twigThemes = twig?.['form_themes'];
    if (Array.isArray(twigThemes)) {
      return twigThemes.map(String);
    }
  }

  // Also check twig.yaml
  const twigConfigPath = path.join(appPath, 'config', 'packages', 'twig.yaml');
  const twigRaw = parseYamlFile(twigConfigPath) as Record<string, unknown> | null;
  if (twigRaw) {
    const twigSection = twigRaw['twig'] as Record<string, unknown> | undefined ?? twigRaw;
    const twigThemes = twigSection?.['form_themes'];
    if (Array.isArray(twigThemes)) {
      return twigThemes.map(String);
    }
  }

  return [];
}

function scanLocalFormThemes(appPath: string): Array<{ template: string; file: string }> {
  const results: Array<{ template: string; file: string }> = [];
  const templatesDir = path.join(appPath, 'templates');
  const files = getAllTwigFiles(templatesDir);

  for (const file of files) {
    const content = safeRead(file, appPath); if (content === null) continue;

    // Match {% form_theme form 'some/template.html.twig' %} or {% form_theme form with [...] %}
    const pattern = /\{%-?\s*form_theme\s+\w{1,60}\s+['"]([^'"]{1,250})['"]/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      results.push({ template: m[1], file: path.relative(appPath, file) });
    }
  }

  return results;
}

function buildThemeInfoList(appPath: string): FormThemeInfo[] {
  const themes: FormThemeInfo[] = [];

  // Global themes
  const globalThemes = loadGlobalThemes(appPath);
  for (const tmpl of globalThemes) {
    const themeType = classifyTheme(tmpl);
    const issues: string[] = [];
    if (themeType === 'custom') {
      // Check if the custom template extends a base layout
      const tmplPath = path.join(appPath, 'templates', tmpl);
      const tmplContent = safeRead(tmplPath, appPath) ?? '';
      if (tmplContent && !tmplContent.includes('{% use ') && !tmplContent.includes('{% extends ')) {
        issues.push(`Custom theme "${tmpl}" does not extend or use a base form layout`);
      }
    }
    themes.push({ source: 'global', template: tmpl, themeType, issues });
  }

  // Local themes
  const localThemes = scanLocalFormThemes(appPath);

  // Count how many files use each template
  const templateUsageCount: Record<string, number> = {};
  for (const lt of localThemes) {
    templateUsageCount[lt.template] = (templateUsageCount[lt.template] ?? 0) + 1;
  }

  for (const lt of localThemes) {
    const themeType = classifyTheme(lt.template);
    const issues: string[] = [];

    const usageCount = templateUsageCount[lt.template] ?? 0;
    if (usageCount > 3) {
      issues.push(`Template "${lt.template}" used as local form_theme in ${usageCount} files — consider making it a global theme`);
    }

    themes.push({ source: 'local', template: lt.template, file: lt.file, themeType, issues });
  }

  // Warn about mixing base themes
  const globalBaseTypes = new Set(themes.filter(t => t.source === 'global').map(t => t.themeType).filter(t => t !== 'custom'));
  if (globalBaseTypes.size > 1) {
    const mixing = [...globalBaseTypes].join(' + ');
    for (const t of themes.filter(t => t.source === 'global')) {
      t.issues.push(`Multiple base themes detected globally (${mixing}) — mixing layout systems may cause styling conflicts`);
    }
  }

  return themes;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFormThemes(appPath: string): McpToolResult {
  try {
    const themes = buildThemeInfoList(appPath);

    if (themes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No form themes found.\n\nAdd a global theme in config/packages/twig.yaml:\n  twig:\n    form_themes: [\'bootstrap_5_layout.html.twig\']\n\nOr use locally in a Twig template:\n  {% form_theme form \'bootstrap_5_layout.html.twig\' %}',
        }],
      };
    }

    const totalIssues = themes.reduce((s, t) => s + t.issues.length, 0);
    let text = `Form Themes\n${'='.repeat(45)}\n`;
    text += `Total themes: ${themes.length}  |  Issues: ${totalIssues}\n`;

    const globalThemes = themes.filter(t => t.source === 'global');
    const localThemes = themes.filter(t => t.source === 'local');

    if (globalThemes.length > 0) {
      text += `\nGlobal Themes (${globalThemes.length}):\n`;
      for (const t of globalThemes) {
        text += `  [${t.themeType}] ${t.template}\n`;
        for (const issue of t.issues) {
          text += `    ⚠ ${issue}\n`;
        }
      }
    }

    if (localThemes.length > 0) {
      text += `\nLocal Themes (${localThemes.length}):\n`;
      for (const t of localThemes) {
        text += `  [${t.themeType}] ${t.template}  in ${t.file ?? '(unknown)'}\n`;
        for (const issue of t.issues) {
          text += `    ⚠ ${issue}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning form themes: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormThemeStats(appPath: string): McpToolResult {
  try {
    const themes = buildThemeInfoList(appPath);

    const globalCount = themes.filter(t => t.source === 'global').length;
    const localCount = themes.filter(t => t.source === 'local').length;
    const byType: Record<string, number> = {};
    for (const t of themes) {
      byType[t.themeType] = (byType[t.themeType] ?? 0) + 1;
    }
    const totalIssues = themes.reduce((s, t) => s + t.issues.length, 0);

    let text = `Form Theme Statistics\n${'='.repeat(40)}\n`;
    text += `Global themes: ${globalCount}\n`;
    text += `Local themes:  ${localCount}\n`;
    text += `\nBy type:\n`;
    for (const [type, count] of Object.entries(byType)) {
      text += `  ${type}: ${count}\n`;
    }
    text += `\nTotal issues: ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing form theme stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormThemeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_form_themes',
      description: 'List all global and local Symfony form themes, their type (Bootstrap 5, Tailwind, Foundation, custom), and configuration issues.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_form_theme_stats',
      description: 'Get statistics about form theme usage in the Symfony application.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
