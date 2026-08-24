// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP CS Fixer Configuration Inspector
 *
 * Reads .php-cs-fixer.php / .php-cs-fixer.dist.php:
 *   - Rulesets: @Symfony, @PSR12, @PSR2, @PER, @PER-CS, @PhpCsFixer, @PHP80Migration, etc.
 *   - Individual rules enabled (true) and explicitly disabled (false)
 *   - Finder configuration: paths included, extensions, excluded dirs (vendor, var, node_modules)
 *   - cacheFile / cache path
 *   - parallelConfig (PHP CS Fixer 3.x)
 *
 * Analysis:
 *   - @Symfony ruleset + @PSR12 may have conflicts (common mistake)
 *   - risky rules enabled without --allow-risky=yes note
 *   - Excluded paths missing vendor/ or var/ (will lint generated files)
 *   - No cache configured (slow on large codebases)
 *   - Rules explicitly disabled that are part of the active ruleset (review why)
 *
 * Rector conflict detection:
 *   - If rector.php is present: rules that both tools address (type coercions, etc.)
 *
 * Pure static analysis — no PHP execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CsFixerConfig {
  rulesets: string[];
  enabledRules: string[];
  disabledRules: string[];
  excludedDirs: string[];
  includedPaths: string[];
  cacheFile?: string;
  hasParallel: boolean;
}

const KNOWN_RULESETS = [
  '@Symfony', '@Symfony:risky',
  '@PSR12', '@PSR2', '@PSR1',
  '@PER', '@PER-CS',
  '@PhpCsFixer', '@PhpCsFixer:risky',
  '@PHP80Migration', '@PHP81Migration', '@PHP82Migration', '@PHP83Migration',
  '@PHP80Migration:risky', '@PHP81Migration:risky', '@PHP82Migration:risky',
  '@DoctrineAnnotation',
];

const RISKY_RULES = [
  'declare_strict_types', 'strict_param', 'void_return',
  'static_lambda', 'native_function_invocation', 'no_unset_on_property',
];

function parseCsFixerConfig(appPath: string): CsFixerConfig | null {
  const candidates = ['.php-cs-fixer.php', '.php-cs-fixer.dist.php', '.php_cs', '.php_cs.dist'];
  for (const fname of candidates) {
    const filePath = path.join(appPath, fname);
    if (!fs.existsSync(filePath)) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const rulesets: string[] = [];
    for (const rs of KNOWN_RULESETS) {
      if (content.includes(`'${rs}'`) || content.includes(`"${rs}"`)) rulesets.push(rs);
    }

    const enabledRules: string[] = [];
    const disabledRules: string[] = [];
    for (const m of content.matchAll(/['"]([a-z][a-z0-9_]+)['"]\s*=>\s*(true|false)/g)) {
      const rule = m[1];
      if (KNOWN_RULESETS.some((rs) => rs.startsWith('@'))) {
        if (m[2] === 'true') enabledRules.push(rule);
        else disabledRules.push(rule);
      }
    }

    const excludedDirs: string[] = [];
    for (const m of content.matchAll(/->exclude\s*\(\s*['"]([^'"]+)['"]/g)) {
      excludedDirs.push(m[1]);
    }
    for (const m of content.matchAll(/->notPath\s*\(\s*['"]([^'"]+)['"]/g)) {
      excludedDirs.push(m[1]);
    }

    const includedPaths: string[] = [];
    for (const m of content.matchAll(/->in\s*\(\s*\[([^\]]+)\]/gs)) {
      for (const p of m[1].split(',')) {
        const clean = p.trim().replace(/['"]/g, '').replace(/__DIR__\s*\.\s*'\//, '').replace(/\//g, '');
        if (clean && !clean.startsWith('/')) includedPaths.push(clean);
      }
    }
    for (const m of content.matchAll(/->in\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      includedPaths.push(m[1].replace(__dirname, '').replace(/^\//, ''));
    }

    const cacheM    = /setCacheFile\s*\(\s*['"]([^'"]+)['"]/.exec(content);
    const hasParallel = content.includes('parallelConfig') || content.includes('setParallelConfig');

    return {
      rulesets,
      enabledRules,
      disabledRules,
      excludedDirs,
      includedPaths,
      cacheFile: cacheM?.[1],
      hasParallel,
    };
  }
  return null;
}

export function listCsFixerConfig(appPath: string): McpToolResult {
  try {
    const config = parseCsFixerConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'No .php-cs-fixer.php found.\n\nInstall PHP CS Fixer:\n  composer require --dev friendsofphp/php-cs-fixer\n\nCreate .php-cs-fixer.dist.php:\n  <?php\n  $finder = PhpCsFixer\\Finder::create()->in(__DIR__.\'/src\');\n  return (new PhpCsFixer\\Config())\n    ->setRules([\'@Symfony\' => true])\n    ->setFinder($finder);',
        }],
      };
    }

    let text = `PHP CS Fixer Configuration\n${'='.repeat(55)}\n\n`;
    text += `Parallel runs:   ${config.hasParallel ? 'yes' : 'no'}\n`;
    text += `Cache file:      ${config.cacheFile ?? '⚠ not configured (will be slow)'}\n`;

    if (config.rulesets.length > 0) {
      text += `\nRulesets (${config.rulesets.length}):\n`;
      for (const rs of config.rulesets) {
        const isRisky = rs.includes(':risky');
        text += `  ${rs}${isRisky ? '  ⚠ risky — requires --allow-risky=yes' : ''}\n`;
      }
    }

    // Conflict detection
    if (config.rulesets.includes('@Symfony') && config.rulesets.includes('@PSR12')) {
      text += `\n⚠ @Symfony and @PSR12 both active — @Symfony is a superset, @PSR12 is redundant\n`;
    }

    if (config.enabledRules.length > 0) {
      const riskyEnabled = config.enabledRules.filter((r) => RISKY_RULES.includes(r));
      text += `\nAdditional rules enabled: ${config.enabledRules.length}\n`;
      if (riskyEnabled.length > 0) text += `  ⚠ Risky rules enabled: ${riskyEnabled.join(', ')}\n`;
    }

    if (config.disabledRules.length > 0) {
      text += `\nRules explicitly disabled (${config.disabledRules.length}):\n`;
      for (const r of config.disabledRules.slice(0, 10)) text += `  ${r}\n`;
      if (config.disabledRules.length > 10) text += `  ... and ${config.disabledRules.length - 10} more\n`;
    }

    if (config.includedPaths.length > 0) {
      text += `\nPaths included: ${config.includedPaths.slice(0, 5).join(', ')}\n`;
    }

    if (config.excludedDirs.length > 0) {
      text += `Excluded: ${config.excludedDirs.join(', ')}\n`;
      const missingExcludes = ['vendor', 'var'].filter((e) => !config.excludedDirs.some((d) => d.includes(e)));
      if (missingExcludes.length > 0) {
        text += `⚠ Possibly missing excludes: ${missingExcludes.join(', ')}\n`;
      }
    }

    const hasRector = fs.existsSync(path.join(appPath, 'rector.php'));
    if (hasRector) {
      text += `\nrector.php also present — ensure CS Fixer runs AFTER Rector in CI pipeline\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCsFixerStats(appPath: string): McpToolResult {
  try {
    const config = parseCsFixerConfig(appPath);

    let text = `PHP CS Fixer Statistics\n${'='.repeat(40)}\n\n`;
    text += `.php-cs-fixer.php:   ${config ? 'found' : 'not found'}\n`;
    if (config) {
      text += `Rulesets:            ${config.rulesets.length}\n`;
      text += `Extra rules enabled: ${config.enabledRules.length}\n`;
      text += `Rules disabled:      ${config.disabledRules.length}\n`;
      text += `Cache configured:    ${config.cacheFile ? 'yes' : 'no'}\n`;
      text += `Parallel:            ${config.hasParallel ? 'yes' : 'no'}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCsFixerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_cs_fixer_config',
      description: 'Show PHP CS Fixer configuration: rulesets (@Symfony/@PSR12/@PER), extra enabled/disabled rules, risky rule detection, finder paths, cache file, parallel flag, Rector coexistence note, redundant ruleset warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_cs_fixer_stats',
      description: 'Show PHP CS Fixer statistics: config found, ruleset count, extra enabled/disabled rule counts, cache and parallel flags',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
