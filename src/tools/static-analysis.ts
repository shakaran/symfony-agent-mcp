/**
 * Static Analysis Config Inspector
 *
 * Reads PHPStan and Psalm configuration:
 *   - phpstan.neon / phpstan.neon.dist — level, paths, excludes, extensions
 *   - phpstan-baseline.neon — baseline error count and top files
 *   - psalm.xml / psalm.xml.dist — errorLevel, plugins, suppressions
 *   - .php-cs-fixer.php / .php-cs-fixer.dist.php — ruleset name
 *   - rector.php — configured rule sets
 *
 * Shows quality posture: configured level, unresolved errors, strict mode.
 * Pure static analysis — no PHP execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PHPStanConfig {
  level?: number | string;
  paths: string[];
  excludes: string[];
  extensions: string[];
  strictRules: boolean;
  bleedingEdge: boolean;
}

interface PHPStanBaseline {
  errorCount: number;
  topFiles: Array<{ file: string; count: number }>;
}

interface PsalmConfig {
  errorLevel?: number;
  plugins: string[];
  suppressions: string[];
  strictMode: boolean;
}

interface CsFixerConfig {
  ruleSet?: string;
  detected: boolean;
}

interface RectorConfig {
  sets: string[];
  detected: boolean;
}

// ─── NEON parser (minimal — just for PHPStan) ──────────────────────────────

function parseNeon(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  const listValues: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const keyM = /^(\w+)\s*:(.*)$/.exec(trimmed);
    if (keyM) {
      if (currentKey && listValues.length > 0) {
        result[currentKey] = [...listValues];
        listValues.length = 0;
      }
      currentKey = keyM[1];
      const val = keyM[2].trim();
      if (val) result[currentKey] = val;
    } else if (trimmed.startsWith('- ') && currentKey) {
      listValues.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
    }
  }

  if (currentKey && listValues.length > 0) {
    result[currentKey] = [...listValues];
  }

  return result;
}

// ─── PHPStan ───────────────────────────────────────────────────────────────

function loadPhpStanConfig(appPath: string): PHPStanConfig | null {
  const candidates = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'];
  let content = '';

  for (const fname of candidates) {
    try {
      content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      break;
    } catch { /* try next */ }
  }

  if (!content) return null;

  // Parse the parameters section
  const paramsMatch = /parameters\s*:([\s\S]*?)(?=^[a-zA-Z]|$)/m.exec(content);
  const params = paramsMatch ? parseNeon(paramsMatch[1]) : {};

  const levelM = /level\s*:\s*(\w+)/.exec(content);
  const paths: string[] = [];
  const excludes: string[] = [];
  const extensions: string[] = [];

  for (const m of content.matchAll(/paths\s*:([^-]*(?:\s+-[^\n]+)*)/g)) {
    for (const p of m[1].matchAll(/- (.+)/g)) paths.push(p[1].trim().replace(/['"]/g, ''));
  }
  for (const m of content.matchAll(/excludePaths\s*:([^-]*(?:\s+-[^\n]+)*)/g)) {
    for (const p of m[1].matchAll(/- (.+)/g)) excludes.push(p[1].trim().replace(/['"]/g, ''));
  }
  for (const m of content.matchAll(/includes\s*:([^-]*(?:\s+-[^\n]+)*)/g)) {
    for (const p of m[1].matchAll(/- (.+)/g)) extensions.push(p[1].trim().replace(/['"]/g, ''));
  }

  return {
    level: levelM ? levelM[1] : String(params['level'] ?? '?'),
    paths: paths.length > 0 ? paths : ['src/'],
    excludes,
    extensions: extensions.filter((e) => e.includes('phpstan') || e.includes('extension') || e.includes('neon')),
    strictRules: content.includes('strict-rules') || content.includes('phpstan-strict'),
    bleedingEdge: content.includes('bleedingEdge') || content.includes('bleeding_edge'),
  };
}

function loadPhpStanBaseline(appPath: string): PHPStanBaseline | null {
  const candidates = ['phpstan-baseline.neon', 'phpstan.baseline.neon', 'baseline.neon'];
  let content = '';

  for (const fname of candidates) {
    try {
      content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      break;
    } catch { /* try next */ }
  }

  if (!content) return null;

  const fileCounts = new Map<string, number>();
  let totalErrors = 0;

  for (const m of content.matchAll(/path:\s*(.+)/g)) {
    const file = m[1].trim().replace(/['"]/g, '');
    const count = (fileCounts.get(file) ?? 0) + 1;
    fileCounts.set(file, count);
    totalErrors++;
  }

  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, count }));

  return { errorCount: totalErrors, topFiles };
}

// ─── Psalm ─────────────────────────────────────────────────────────────────

function loadPsalmConfig(appPath: string): PsalmConfig | null {
  const candidates = ['psalm.xml', 'psalm.xml.dist'];
  let content = '';

  for (const fname of candidates) {
    try {
      content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      break;
    } catch { /* try next */ }
  }

  if (!content) return null;

  const levelM = /errorLevel="(\d+)"/.exec(content);
  const plugins: string[] = [];
  for (const m of content.matchAll(/pluginClass="([^"]+)"/g)) plugins.push(m[1]);
  for (const m of content.matchAll(/pluginFileName="([^"]+)"/g)) plugins.push(m[1]);

  const suppressions: string[] = [];
  for (const m of content.matchAll(/type="([^"]+)"/g)) {
    if (!suppressions.includes(m[1])) suppressions.push(m[1]);
  }

  return {
    errorLevel: levelM ? parseInt(levelM[1], 10) : undefined,
    plugins,
    suppressions: suppressions.slice(0, 10),
    strictMode: content.includes('findUnusedCode="always"') || content.includes('strictBinaryOperands="true"'),
  };
}

// ─── CS Fixer ────────────────────────────────────────────────────────────

function loadCsFixerConfig(appPath: string): CsFixerConfig {
  const candidates = ['.php-cs-fixer.php', '.php-cs-fixer.dist.php', '.php_cs', '.php_cs.dist'];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      const ruleSetM = /->setRules\s*\(\s*\[\s*['"]([^'"]+)['"]\s*=>/g.exec(content)
        ?? /new Rules\\([A-Z][A-Za-z]+)/g.exec(content)
        ?? /Symfony|PER|PSR12|PSR2/i.exec(content);
      return { detected: true, ruleSet: ruleSetM?.[1] };
    } catch { /* try next */ }
  }
  return { detected: false };
}

// ─── Rector ────────────────────────────────────────────────────────────────

function loadRectorConfig(appPath: string): RectorConfig {
  const candidates = ['rector.php', 'rector.php.dist'];
  for (const fname of candidates) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      const sets: string[] = [];
      for (const m of content.matchAll(/->withSets\s*\(\s*\[([^\]]+)\]/g)) {
        for (const sm of m[1].matchAll(/(\w+)::\s*\w+|SetList::\s*(\w+)/g)) {
          sets.push((sm[1] ?? sm[2]).trim());
        }
      }
      for (const m of content.matchAll(/SetList::(\w+)/g)) {
        if (!sets.includes(m[1])) sets.push(m[1]);
      }
      return { detected: true, sets: [...new Set(sets)].slice(0, 10) };
    } catch { /* try next */ }
  }
  return { detected: false, sets: [] };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function getStaticAnalysisConfig(appPath: string): McpToolResult {
  try {
    const phpstan = loadPhpStanConfig(appPath);
    const baseline = loadPhpStanBaseline(appPath);
    const psalm = loadPsalmConfig(appPath);
    const csFixer = loadCsFixerConfig(appPath);
    const rector = loadRectorConfig(appPath);

    if (!phpstan && !psalm && !csFixer.detected && !rector.detected) {
      return {
        content: [{
          type: 'text',
          text: 'No static analysis tools configured.\n\nInstall:\n  composer require --dev phpstan/phpstan\n  composer require --dev psalm/phar\n  composer require --dev friendsofphp/php-cs-fixer',
        }],
      };
    }

    let text = `Static Analysis Configuration\n${'='.repeat(55)}\n`;

    if (phpstan) {
      text += `\nPHPStan\n`;
      text += `  Level:       ${phpstan.level} / 10\n`;
      text += `  Paths:       ${phpstan.paths.join(', ')}\n`;
      if (phpstan.excludes.length > 0) text += `  Excludes:    ${phpstan.excludes.slice(0, 3).join(', ')}\n`;
      if (phpstan.extensions.length > 0) text += `  Extensions:  ${phpstan.extensions.length} included\n`;
      if (phpstan.strictRules) text += `  Strict rules: yes\n`;
      if (phpstan.bleedingEdge) text += `  Bleeding edge: yes\n`;

      if (baseline) {
        text += `\n  Baseline: ${baseline.errorCount} suppressed errors\n`;
        if (baseline.topFiles.length > 0) {
          text += `  Top files with baseline errors:\n`;
          for (const { file, count } of baseline.topFiles) {
            text += `    ${count.toString().padStart(3)}x  ${file}\n`;
          }
        }
      } else {
        text += `  Baseline: none (all errors must pass)\n`;
      }
    }

    if (psalm) {
      text += `\nPsalm\n`;
      if (psalm.errorLevel !== undefined) text += `  Error level: ${psalm.errorLevel} / 8 (lower = stricter)\n`;
      if (psalm.plugins.length > 0) {
        text += `  Plugins (${psalm.plugins.length}):\n`;
        for (const p of psalm.plugins.slice(0, 5)) text += `    ${p}\n`;
      }
      if (psalm.strictMode) text += `  Strict mode: yes\n`;
      if (psalm.suppressions.length > 0) text += `  Suppressed types (${psalm.suppressions.length}): ${psalm.suppressions.slice(0, 4).join(', ')}\n`;
    }

    if (csFixer.detected) {
      text += `\nPHP CS Fixer\n`;
      if (csFixer.ruleSet) text += `  Rule set: ${csFixer.ruleSet}\n`;
    }

    if (rector.detected) {
      text += `\nRector\n`;
      if (rector.sets.length > 0) {
        text += `  Sets: ${rector.sets.join(', ')}\n`;
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

export function getStaticAnalysisStats(appPath: string): McpToolResult {
  try {
    const phpstan = loadPhpStanConfig(appPath);
    const baseline = loadPhpStanBaseline(appPath);
    const psalm = loadPsalmConfig(appPath);
    const csFixer = loadCsFixerConfig(appPath);
    const rector = loadRectorConfig(appPath);

    let text = `Static Analysis Statistics\n${'='.repeat(40)}\n\n`;
    text += `PHPStan:    ${phpstan ? `level ${phpstan.level}` : 'not configured'}\n`;
    text += `Psalm:      ${psalm ? `level ${psalm.errorLevel ?? '?'}` : 'not configured'}\n`;
    text += `CS Fixer:   ${csFixer.detected ? 'configured' : 'not found'}\n`;
    text += `Rector:     ${rector.detected ? `configured (${rector.sets.length} sets)` : 'not found'}\n`;

    if (baseline) {
      text += `\nPHPStan baseline: ${baseline.errorCount} suppressed errors\n`;
      if (baseline.errorCount > 100) {
        text += `⚠ Large baseline — consider resolving errors to increase level\n`;
      }
    }

    if (phpstan?.strictRules || psalm?.strictMode) {
      text += `\n✓ Strict mode enabled\n`;
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

export function getStaticAnalysisTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'get_static_analysis_config',
      description: 'Show PHPStan level/paths/extensions/baseline, Psalm error level/plugins, PHP CS Fixer ruleset, and Rector sets configured for the project',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_static_analysis_stats',
      description: 'Show static analysis summary: tools configured, PHPStan level, baseline error count, strict mode status',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
