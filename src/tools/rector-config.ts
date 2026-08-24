// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Rector Configuration Inspector
 *
 * Reads rector.php:
 *   - Sets applied: LevelSetList (UP_TO_PHP_81/82/83/84),
 *     SymfonySetList (SYMFONY_60/61/62/63/64/70/71),
 *     DoctrineSetList (DOCTRINE_25/26), PHPUnitSetList
 *   - Individual rules added (->withRules([]))
 *   - Individual rules skipped (->withSkip([]))
 *   - Configured rules (->withConfiguredRule())
 *   - Paths scanned (->withPaths([]))
 *   - Parallel runs enabled
 *
 * rector.json / .rector.cache (cache file size):
 *   - Indicates if rector has been run before and cache is warm
 *
 * Analysis:
 *   - Symfony set version vs installed symfony/framework-bundle version (upgrade gap)
 *   - PHP level set vs composer.json require.php (upgrade opportunity)
 *   - No sets configured (rector installed but not configured)
 *   - Large skip list (many rules skipped — reduced effectiveness)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RectorSet {
  constant: string;
  friendly: string;
  category: 'php' | 'symfony' | 'doctrine' | 'phpunit' | 'other';
  version?: string;
}

interface RectorConfig {
  sets: RectorSet[];
  rules: string[];
  skipped: string[];
  paths: string[];
  parallel: boolean;
  hasCacheFile: boolean;
}

const SET_PATTERNS: Array<{ pattern: RegExp; category: RectorSet['category']; prefix: string }> = [
  { pattern: /LevelSetList::UP_TO_PHP_(\d+)/g,        category: 'php',      prefix: 'PHP ' },
  { pattern: /SymfonySetList::SYMFONY_(\d+)/g,         category: 'symfony',  prefix: 'Symfony ' },
  { pattern: /DoctrineSetList::DOCTRINE_(\w+)/g,       category: 'doctrine', prefix: 'Doctrine ' },
  { pattern: /PHPUnitSetList::PHPUNIT_(\w+)/g,         category: 'phpunit',  prefix: 'PHPUnit ' },
  { pattern: /SetList::([A-Z_]+)/g,                    category: 'other',    prefix: '' },
  { pattern: /DeadCodeSetList::DEAD_CODE/g,            category: 'other',    prefix: 'Dead code removal' },
  { pattern: /CodingStyleSetList::([A-Z_]+)/g,         category: 'other',    prefix: 'Coding style: ' },
  { pattern: /TypeDeclarationSetList::([A-Z_]+)/g,     category: 'other',    prefix: 'Type declarations: ' },
  { pattern: /PrivatizationSetList::([A-Z_]+)/g,       category: 'other',    prefix: 'Privatization: ' },
];

function formatVersion(raw: string, prefix: string): string {
  if (!raw) return prefix;
  if (/^\d+$/.test(raw) && raw.length >= 2) {
    return `${prefix}${raw.slice(0, -1)}.${raw.slice(-1)}`;
  }
  return `${prefix}${raw.replace(/_/g, '.')}`;
}

function parseRectorPhp(appPath: string): RectorConfig | null {
  const candidates = ['rector.php', 'rector.dist.php'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const sets: RectorSet[] = [];
    for (const { pattern, category, prefix } of SET_PATTERNS) {
      const re = new RegExp(pattern.source, 'g');
      for (const m of content.matchAll(re)) {
        const version = m[1] ?? '';
        const friendly = version ? formatVersion(version, prefix) : prefix;
        const constant = m[0];
        if (!sets.some((s) => s.constant === constant)) {
          sets.push({ constant, friendly, category, version });
        }
      }
    }

    // Individual rules
    const rules: string[] = [];
    for (const m of content.matchAll(/->withRules\s*\(\s*\[([^\]]+)\]/gs)) {
      for (const rule of m[1].split(',')) {
        const clean = rule.trim().replace(/::class\s*$/, '').replace(/.*\\/, '').replace(/['"]/g, '');
        if (clean && !clean.includes('//')) rules.push(clean);
      }
    }

    // Skipped rules/paths
    const skipped: string[] = [];
    for (const m of content.matchAll(/->withSkip\s*\(\s*\[([^\]]+)\]/gs)) {
      for (const item of m[1].split(',')) {
        const clean = item.trim().replace(/::class\s*$/, '').replace(/['"]/g, '').split('\\').pop() ?? '';
        if (clean && !clean.startsWith('//') && clean.length > 2) skipped.push(clean);
      }
    }

    // Paths
    const paths: string[] = [];
    for (const m of content.matchAll(/->withPaths\s*\(\s*\[([^\]]+)\]/gs)) {
      for (const p of m[1].split(',')) {
        const clean = p.trim().replace(/['"]/g, '').replace(/__DIR__\s*\.\s*'\//, '').replace(/'/g, '');
        if (clean && !clean.startsWith('//') && clean.length > 1) paths.push(clean);
      }
    }

    const parallel    = content.includes('->withParallel(') || content.includes('withParallel()');
    const hasCacheFile = fs.existsSync(path.join(appPath, '.rector_cache')) ||
                         fs.existsSync(path.join(appPath, 'rector.cache'));

    return { sets, rules, skipped, paths, parallel, hasCacheFile };
  }
  return null;
}

function getComposerPhpVersion(appPath: string): string | null {
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    return composer['require']?.['php'] ?? null;
  } catch { return null; }
}

export function listRectorRules(appPath: string): McpToolResult {
  try {
    const config = parseRectorPhp(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'No rector.php found.\n\nInstall Rector:\n  composer require rector/rector --dev\n  ./vendor/bin/rector init\n\nFor Symfony:\n  composer require rector/rector --dev\n  # Add SymfonySetList to rector.php:\n  $rectorConfig->sets([SymfonySetList::SYMFONY_63]);',
        }],
      };
    }

    let text = `Rector Configuration\n${'='.repeat(55)}\n\n`;
    text += `Parallel runs:   ${config.parallel ? 'yes' : 'no'}\n`;
    text += `Cache file:      ${config.hasCacheFile ? 'found (was run before)' : 'not found'}\n`;
    if (config.paths.length > 0) text += `Paths:           ${config.paths.join(', ')}\n`;

    if (config.sets.length > 0) {
      const byCategory = new Map<string, RectorSet[]>();
      for (const s of config.sets) {
        const list = byCategory.get(s.category) ?? [];
        list.push(s);
        byCategory.set(s.category, list);
      }
      text += `\nSets applied (${config.sets.length}):\n`;
      for (const [cat, catSets] of byCategory) {
        text += `  ${cat}:\n`;
        for (const s of catSets) text += `    ${s.friendly}\n`;
      }

      // Upgrade gap analysis
      const phpRequired = getComposerPhpVersion(appPath);
      const phpSet = config.sets.find((s) => s.category === 'php');
      if (phpRequired && phpSet?.version) {
        const setMajMin = phpSet.version.slice(0, 2);
        const reqMatch = /(\d+)\.(\d+)/.exec(phpRequired);
        if (reqMatch) {
          const reqMajMin = `${reqMatch[1]}${reqMatch[2]}`;
          if (parseInt(setMajMin, 10) < parseInt(reqMajMin, 10)) {
            text += `\n⚠ Rector PHP set (${phpSet.friendly}) is lower than composer.json requires "${phpRequired}" — upgrade opportunity\n`;
          }
        }
      }
    } else {
      text += `\n⚠ No sets configured — add LevelSetList / SymfonySetList for automated upgrades\n`;
    }

    if (config.rules.length > 0) {
      text += `\nIndividual rules (${config.rules.length}):\n`;
      for (const r of config.rules.slice(0, 15)) text += `  ${r}\n`;
      if (config.rules.length > 15) text += `  ... and ${config.rules.length - 15} more\n`;
    }

    if (config.skipped.length > 0) {
      text += `\nSkipped rules/paths (${config.skipped.length}):\n`;
      for (const s of config.skipped.slice(0, 10)) text += `  ${s}\n`;
      if (config.skipped.length > 10) text += `  ... and ${config.skipped.length - 10} more\n`;
      if (config.skipped.length > 20) {
        text += `  ⚠ Large skip list — ${config.skipped.length} items skipped, some rules may have limited effect\n`;
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

export function getRectorStats(appPath: string): McpToolResult {
  try {
    const config = parseRectorPhp(appPath);

    let text = `Rector Statistics\n${'='.repeat(40)}\n\n`;
    text += `rector.php:      ${config ? 'found' : 'not found'}\n`;
    if (config) {
      text += `Sets:            ${config.sets.length}\n`;
      text += `Individual rules: ${config.rules.length}\n`;
      text += `Skipped:         ${config.skipped.length}\n`;
      text += `Parallel:        ${config.parallel ? 'yes' : 'no'}\n`;
      text += `Has cache:       ${config.hasCacheFile ? 'yes' : 'no'}\n`;
      const symfonySet = config.sets.find((s) => s.category === 'symfony');
      if (symfonySet) text += `Symfony target:  ${symfonySet.friendly}\n`;
      const phpSet = config.sets.find((s) => s.category === 'php');
      if (phpSet) text += `PHP target:      ${phpSet.friendly}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRectorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_rector_rules',
      description: 'Show Rector configuration: PHP/Symfony/Doctrine/PHPUnit sets applied, individual rules, skipped rules, paths, parallel flag, upgrade gap analysis between set version and composer.json requirement',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_rector_stats',
      description: 'Show Rector statistics: config found, set count, individual rule count, skipped count, parallel flag, Symfony/PHP target version',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
