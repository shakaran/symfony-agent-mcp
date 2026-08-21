/**
 * Psalm Configuration Inspector
 *
 * Reads psalm.xml / psalm.xml.dist:
 *   - Analysis level (1–8, lower = stricter)
 *   - Plugins: psalm/plugin-symfony, psalm/plugin-doctrine, weirdan/twig-psalm-plugin
 *   - <issueHandlers>: suppressed issue types and counts
 *   - Error baseline file (errorBaseline attribute) and baseline size
 *   - Directories scanned / excluded
 *   - cacheDirectory, totallyTyped, findUnusedCode flags
 *
 * Reads .psalm/ directory:
 *   - baseline.xml: count of suppressed errors per file
 *
 * Analysis:
 *   - Level 1–3: very strict — note it
 *   - Level 7–8: permissive — warn
 *   - Large baseline (>200 suppressions) — technical debt flag
 *   - Symfony/Doctrine plugin missing despite framework present
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

interface PsalmPlugin {
  class: string;
  friendly: string;
}

interface PsalmConfig {
  level: number;
  plugins: PsalmPlugin[];
  suppressedIssues: string[];
  errorBaselineFile?: string;
  baselineSize: number;
  excludedPaths: string[];
  findUnusedCode: boolean;
  totallyTyped: boolean;
}

const KNOWN_PLUGINS: Record<string, string> = {
  'Psalm\\Plugin\\Symfony\\SymfonyPlugin':       'psalm/plugin-symfony',
  'Psalm\\PhpUnitPlugin\\Plugin':                'psalm/plugin-phpunit',
  'Weirdan\\TwigPsalmPlugin\\Plugin':           'weirdan/twig-psalm-plugin',
  'Psalm\\DoctrinePlugin\\Plugin':               'psalm/plugin-doctrine',
  'Psalm\\MutationTestingPlugin\\Plugin':        'mutation-testing',
  'Psalm\\EnumPlugin\\Plugin':                   'psalm/plugin-enum',
};

function parsePsalmXml(appPath: string): PsalmConfig | null {
  const candidates = ['psalm.xml', 'psalm.xml.dist', '.psalm/psalm.xml'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    const content = safeRead(filePath, appPath);
    if (content === null) continue;

    const levelM = /errorLevel\s*=\s*["'](\d+)["']/.exec(content);
    const level  = levelM ? parseInt(levelM[1], 10) : 5;

    const plugins: PsalmPlugin[] = [];
    for (const m of content.matchAll(/<plugin[^>]+class\s*=\s*["']([^"']+)["']/g)) {
      const cls = m[1];
      plugins.push({ class: cls, friendly: KNOWN_PLUGINS[cls] ?? cls });
    }

    const suppressedIssues: string[] = [];
    for (const m of content.matchAll(/<(\w+)\s+errorLevel\s*=\s*["']suppress["']/g)) {
      suppressedIssues.push(m[1]);
    }
    for (const m of content.matchAll(/<issueHandler[^>]*>\s*<(\w+)/g)) {
      if (!suppressedIssues.includes(m[1])) suppressedIssues.push(m[1]);
    }

    const baselineM = /errorBaseline\s*=\s*["']([^"']+)["']/.exec(content);
    const errorBaselineFile = baselineM?.[1];

    const excludedPaths: string[] = [];
    for (const m of content.matchAll(/<ignoreFiles[^>]*>[\s\S]*?<directory[^>]+name\s*=\s*["']([^"']+)["']/g)) {
      excludedPaths.push(m[1]);
    }
    for (const m of content.matchAll(/<directory[^>]+name\s*=\s*["']([^"']+)["'][^>]*\/>/g)) {
      if (content.slice(Math.max(0, content.indexOf(m[0]) - 50), content.indexOf(m[0])).includes('ignoreFiles')) {
        excludedPaths.push(m[1]);
      }
    }

    const findUnusedCode = content.includes('findUnusedCode="always"') || content.includes('findUnusedCode="true"');
    const totallyTyped   = content.includes('totallyTyped="true"');

    // Count baseline suppressions
    let baselineSize = 0;
    if (errorBaselineFile) {
      const baselinePath = path.join(appPath, errorBaselineFile);
      const bl = safeRead(baselinePath, appPath);
      if (bl !== null) baselineSize = (bl.match(/<entry/g) ?? []).length;
    }
    // Also check .psalm/baseline.xml
    if (baselineSize === 0) {
      const bl = safeRead(path.join(appPath, '.psalm', 'baseline.xml'), appPath);
      if (bl !== null) baselineSize = (bl.match(/<entry/g) ?? []).length;
    }

    return { level, plugins, suppressedIssues, errorBaselineFile, baselineSize, excludedPaths, findUnusedCode, totallyTyped };
  }
  return null;
}

function hasSymfonyInProject(appPath: string): boolean {
  try {
    const raw = safeRead(path.join(appPath, 'composer.json'), appPath);
    if (raw === null) return false;
    const composer = JSON.parse(raw) as Record<string, Record<string, string>>;
    const deps = { ...composer['require'], ...composer['require-dev'] };
    return 'symfony/framework-bundle' in deps || 'symfony/symfony' in deps;
  } catch { return false; }
}

export function listPsalmConfig(appPath: string): McpToolResult {
  try {
    const config = parsePsalmXml(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'No psalm.xml found.\n\nInstall Psalm:\n  composer require --dev vimeo/psalm\n  ./vendor/bin/psalm --init src/ 5\n\nFor Symfony:\n  composer require --dev psalm/plugin-symfony\n  ./vendor/bin/psalm-plugin enable psalm/plugin-symfony',
        }],
      };
    }

    let text = `Psalm Configuration\n${'='.repeat(55)}\n\n`;
    text += `Analysis level:   ${config.level}/8`;

    if (config.level <= 3)      text += '  (strict)\n';
    else if (config.level <= 5) text += '  (moderate)\n';
    else                        text += '  ⚠ (permissive — consider lowering)\n';

    text += `Find unused code: ${config.findUnusedCode ? 'yes' : 'no'}\n`;
    text += `Totally typed:    ${config.totallyTyped ? 'yes' : 'no'}\n`;

    if (config.plugins.length > 0) {
      text += `\nPlugins (${config.plugins.length}):\n`;
      for (const p of config.plugins) text += `  ${p.friendly}\n`;
    }

    const symfonyPresent = hasSymfonyInProject(appPath);
    const hasSymfonyPlugin = config.plugins.some((p) => p.friendly.includes('plugin-symfony'));
    if (symfonyPresent && !hasSymfonyPlugin) {
      text += `\n⚠ Symfony project without psalm/plugin-symfony — add it for better analysis\n`;
    }

    if (config.suppressedIssues.length > 0) {
      text += `\nSuppressed issue types (${config.suppressedIssues.length}):\n`;
      for (const issue of config.suppressedIssues.slice(0, 15)) text += `  ${issue}\n`;
      if (config.suppressedIssues.length > 15) text += `  ... and ${config.suppressedIssues.length - 15} more\n`;
    }

    if (config.errorBaselineFile) {
      text += `\nError baseline: ${config.errorBaselineFile}`;
      text += ` (${config.baselineSize} suppressed entry/entries)`;
      if (config.baselineSize > 200) text += '  ⚠ large baseline — significant technical debt';
      text += '\n';
    }

    if (config.excludedPaths.length > 0) {
      text += `\nExcluded paths: ${config.excludedPaths.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPsalmStats(appPath: string): McpToolResult {
  try {
    const config = parsePsalmXml(appPath);

    let text = `Psalm Statistics\n${'='.repeat(40)}\n\n`;
    if (!config) {
      text += 'psalm.xml: not found\n';
      return { content: [{ type: 'text', text }] };
    }

    text += `psalm.xml:           found\n`;
    text += `Level:               ${config.level}/8\n`;
    text += `Plugins:             ${config.plugins.length}\n`;
    text += `Suppressed types:    ${config.suppressedIssues.length}\n`;
    text += `Baseline entries:    ${config.baselineSize}\n`;
    text += `Find unused code:    ${config.findUnusedCode ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPsalmTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_psalm_config',
      description: 'Show Psalm static analysis configuration: level (1–8), plugins (psalm/plugin-symfony, Doctrine, Twig), suppressed issue types, error baseline size, excluded paths, findUnusedCode/totallyTyped flags',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_psalm_stats',
      description: 'Show Psalm statistics: config found, level, plugin count, suppressed type count, baseline entry count, find-unused-code flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
