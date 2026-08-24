// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHPStan Configuration Inspector
 *
 * Reads phpstan.neon / phpstan.dist.neon / phpstan.neon.dist:
 *
 * Core configuration:
 *   - level (0–10) — analysis strictness
 *   - paths analyzed (paths vs src default)
 *   - phpVersion target
 *
 * Includes (extensions):
 *   - phpstan/phpstan-symfony — Symfony-specific rules
 *   - phpstan/phpstan-doctrine — Doctrine entity analysis
 *   - phpstan/phpstan-phpunit — PHPUnit assertions awareness
 *   - phpstan/phpstan-deprecation-rules
 *   - phpstan/phpstan-strict-rules
 *   - phpstan/extension-installer (auto-include)
 *
 * Baseline:
 *   - includeBaseline or ignoreErrors → baseline
 *   - Baseline file size (line count estimate of suppressed errors)
 *   - reportUnmatchedIgnoredErrors flag
 *
 * Ignore patterns:
 *   - ignoreErrors count (inline suppressions)
 *   - excludePaths patterns
 *   - treatPhpDocTypesAsCertain (common gotcha)
 *
 * Analysis:
 *   - level < 5: quality warning
 *   - Large baseline (> 200 entries): technical debt warning
 *   - Missing Symfony extension in Symfony app
 *   - Missing Doctrine extension when doctrine/orm detected
 *   - reportUnmatchedIgnoredErrors: false (silently outdated suppressions)
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

interface PhpStanConfig {
  level?: number;
  paths: string[];
  phpVersion?: string;
  includes: string[];
  ignoreErrorCount: number;
  excludePaths: string[];
  hasBaseline: boolean;
  baselineFile?: string;
  baselineSize?: number;
  reportUnmatched?: boolean;
  treatPhpDocAsCertain?: boolean;
  parallelism?: number;
  tmpDir?: string;
}

const KNOWN_EXTENSIONS: Record<string, string> = {
  'phpstan-symfony':           'Symfony',
  'phpstan-doctrine':          'Doctrine',
  'phpstan-phpunit':           'PHPUnit',
  'phpstan-deprecation-rules': 'Deprecations',
  'phpstan-strict-rules':      'Strict',
  'extension-installer':       'Auto-installer',
  'phpstan-webmozart-assert':  'webmozart/assert',
  'phpstan-beberlei-assert':   'beberlei/assert',
};

function parseNeonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (content.length > 500_000) return null;

  const result: Record<string, unknown> = {};

  // Extract level
  const levelM = /^level\s*:\s*(\d+)/m.exec(content);
  if (levelM) result['level'] = parseInt(levelM[1], 10);

  // Extract paths
  const pathsSection = /^paths\s*:(.*?)(?=^\w)/ms.exec(content);
  const paths: string[] = [];
  if (pathsSection) {
    for (const m of pathsSection[1].matchAll(/[-\s]+['"]?(%?[^'"\n#]+)['"]?/g)) {
      const p = m[1].trim().replace(/^%rootDir%\//, '');
      if (p && !p.startsWith('#')) paths.push(p);
    }
  }
  result['paths'] = paths;

  // Extract includes
  const includesSection = /^includes\s*:(.*?)(?=^\w)/ms.exec(content);
  const includes: string[] = [];
  if (includesSection) {
    for (const m of includesSection[1].matchAll(/[-\s]+['"]?([^'"\n#]+)['"]?/g)) {
      const inc = m[1].trim();
      if (inc) includes.push(inc);
    }
  }
  result['includes'] = includes;

  // ignoreErrors
  const ignoreSection = /^ignoreErrors\s*:(.*?)(?=^\w)/ms.exec(content);
  result['ignoreErrorCount'] = ignoreSection
    ? (ignoreSection[1].match(/^\s*-/mg) ?? []).length
    : 0;

  // excludePaths
  const excludeSection = /^excludePaths\s*:(.*?)(?=^\w)/ms.exec(content);
  const excludePaths: string[] = [];
  if (excludeSection) {
    for (const m of excludeSection[1].matchAll(/[-\s]+['"]?([^'"\n#]+)['"]?/g)) {
      const p = m[1].trim();
      if (p) excludePaths.push(p);
    }
  }
  result['excludePaths'] = excludePaths;

  // Baseline
  const baselineM = /(?:includeBaseline|baseline)\s*:\s*['"]?([^'"\n#]+)['"]?/m.exec(content);
  result['hasBaseline'] = !!baselineM;
  result['baselineFile'] = baselineM?.[1]?.trim();

  // Other flags
  const reportM = /reportUnmatchedIgnoredErrors\s*:\s*(true|false)/i.exec(content);
  if (reportM) result['reportUnmatched'] = reportM[1] === 'true';

  const phpDocM = /treatPhpDocTypesAsCertain\s*:\s*(true|false)/i.exec(content);
  if (phpDocM) result['treatPhpDocAsCertain'] = phpDocM[1] === 'true';

  const parallelM = /maximumNumberOfProcesses\s*:\s*(\d+)/i.exec(content);
  if (parallelM) result['parallelism'] = parseInt(parallelM[1], 10);

  const phpVerM = /phpVersion\s*:\s*(\d+)/m.exec(content);
  if (phpVerM) result['phpVersion'] = phpVerM[1];

  return result;
}

function readBaselineSize(appPath: string, baselineFile: string | undefined): number {
  if (!baselineFile) return 0;
  const fullPath = path.join(appPath, baselineFile);
  if (!fs.existsSync(fullPath)) return 0;
  const content = safeRead(fullPath, appPath);
  if (content === null) return 0;
  return (content.match(/^\s*-\s+message:/mg) ?? []).length ||
         (content.match(/message:/g) ?? []).length;
}

export function listPhpStanConfig(appPath: string): McpToolResult {
  try {
    const candidates = ['phpstan.neon', 'phpstan.dist.neon', 'phpstan.neon.dist'];
    let raw: Record<string, unknown> | null = null;
    let foundFile = '';
    for (const fname of candidates) {
      raw = parseNeonFile(path.join(appPath, fname));
      if (raw) { foundFile = fname; break; }
    }

    if (!raw) {
      return {
        content: [{
          type: 'text',
          text: 'No phpstan.neon found.\n\nInstall:\n  composer require --dev phpstan/phpstan\n  composer require --dev phpstan/phpstan-symfony\n\nCreate phpstan.neon:\n  includes:\n    - vendor/phpstan/phpstan-symfony/extension.neon\n  parameters:\n    level: 6\n    paths:\n      - src\n    symfony:\n      container_xml_path: var/cache/dev/App_KernelDevDebugContainer.xml',
        }],
      };
    }

    const config: PhpStanConfig = {
      level: raw['level'] as number | undefined,
      paths: raw['paths'] as string[],
      phpVersion: raw['phpVersion'] as string | undefined,
      includes: raw['includes'] as string[],
      ignoreErrorCount: raw['ignoreErrorCount'] as number,
      excludePaths: raw['excludePaths'] as string[],
      hasBaseline: raw['hasBaseline'] as boolean,
      baselineFile: raw['baselineFile'] as string | undefined,
      baselineSize: 0,
      reportUnmatched: raw['reportUnmatched'] as boolean | undefined,
      treatPhpDocAsCertain: raw['treatPhpDocAsCertain'] as boolean | undefined,
      parallelism: raw['parallelism'] as number | undefined,
    };
    config.baselineSize = readBaselineSize(appPath, config.baselineFile);

    const extensions = config.includes
      .map((inc) => {
        for (const [key, label] of Object.entries(KNOWN_EXTENSIONS)) {
          if (inc.includes(key)) return label;
        }
        return null;
      })
      .filter(Boolean) as string[];

    let text = `PHPStan Configuration\n${'='.repeat(55)}\n`;
    text += `\nConfig file:   ${foundFile}\n`;
    text += `Level:         ${config.level !== undefined ? `${config.level}/10` : '⚠ not set (defaults to 0)'}`;
    if (config.level !== undefined && config.level < 5) text += `  ⚠ below recommended level 5`;
    text += '\n';
    text += `PHP target:    ${config.phpVersion ?? 'not set (uses runtime PHP)'}\n`;
    text += `Paths:         ${config.paths.length > 0 ? config.paths.join(', ') : 'not set'}\n`;

    if (extensions.length > 0) {
      text += `\nExtensions (${extensions.length}):\n`;
      for (const ext of extensions) text += `  ✓ ${ext}\n`;
    }

    // Check for missing important extensions
    const hasComposerJson = fs.existsSync(path.join(appPath, 'composer.json'));
    if (hasComposerJson) {
      const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath) ?? '';
      if (composerContent.includes('symfony/framework-bundle') && !extensions.includes('Symfony')) {
        text += `  ⚠ Missing phpstan-symfony extension (Symfony app detected)\n`;
      }
      if (composerContent.includes('doctrine/orm') && !extensions.includes('Doctrine')) {
        text += `  ⚠ Missing phpstan-doctrine extension (Doctrine ORM detected)\n`;
      }
    }

    if (config.hasBaseline) {
      text += `\nBaseline:\n`;
      text += `  File: ${config.baselineFile}\n`;
      text += `  Size: ${config.baselineSize} suppressions`;
      if (config.baselineSize > 200) text += `  ⚠ large baseline — significant technical debt`;
      text += '\n';
      if (config.reportUnmatched === false) {
        text += `  ⚠ reportUnmatchedIgnoredErrors: false — outdated suppressions silently ignored\n`;
      }
    }

    if (config.ignoreErrorCount > 0) {
      text += `\nInline ignoreErrors: ${config.ignoreErrorCount}\n`;
    }

    if (config.excludePaths.length > 0) {
      text += `\nExcluded paths (${config.excludePaths.length}):\n`;
      for (const p of config.excludePaths.slice(0, 5)) text += `  ${p}\n`;
      if (config.excludePaths.length > 5) text += `  ... and ${config.excludePaths.length - 5} more\n`;
    }

    if (config.parallelism) text += `\nParallel processes: ${config.parallelism}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStanStats(appPath: string): McpToolResult {
  try {
    const candidates = ['phpstan.neon', 'phpstan.dist.neon', 'phpstan.neon.dist'];
    let raw: Record<string, unknown> | null = null;
    for (const fname of candidates) {
      raw = parseNeonFile(path.join(appPath, fname));
      if (raw) break;
    }

    let text = `PHPStan Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config found:        ${raw ? 'yes' : 'no'}\n`;
    if (raw) {
      const config: PhpStanConfig = {
        level: raw['level'] as number | undefined,
        paths: raw['paths'] as string[],
        phpVersion: raw['phpVersion'] as string | undefined,
        includes: raw['includes'] as string[],
        ignoreErrorCount: raw['ignoreErrorCount'] as number,
        excludePaths: raw['excludePaths'] as string[],
        hasBaseline: raw['hasBaseline'] as boolean,
        baselineFile: raw['baselineFile'] as string | undefined,
        baselineSize: 0,
        reportUnmatched: raw['reportUnmatched'] as boolean | undefined,
        treatPhpDocAsCertain: raw['treatPhpDocAsCertain'] as boolean | undefined,
        parallelism: raw['parallelism'] as number | undefined,
      };
      config.baselineSize = readBaselineSize(appPath, config.baselineFile);
      text += `Level:               ${config.level ?? 'not set'}/10\n`;
      text += `Extensions:          ${config.includes.length}\n`;
      text += `Inline suppressions: ${config.ignoreErrorCount}\n`;
      text += `Baseline:            ${config.hasBaseline ? `yes (${config.baselineSize} entries)` : 'no'}\n`;
      text += `Excluded paths:      ${config.excludePaths.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpStanTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpstan_config',
      description: 'Show PHPStan configuration: level (0-10, warns if < 5), includes/extensions (phpstan-symfony, phpstan-doctrine, phpstan-phpunit, strict-rules), baseline file and size (warns if > 200), ignoreErrors count, excludePaths, reportUnmatchedIgnoredErrors, missing extension warnings for detected Symfony/Doctrine',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpstan_stats',
      description: 'Show PHPStan statistics: config found, level, extension count, inline suppression count, baseline present and size, excluded path count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
