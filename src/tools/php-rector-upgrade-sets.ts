// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpRectorUpgradeSetsInfo {
  category: string;
  set: string;
  phpVersion: string | null;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

const PHP_VERSION_ORDER: Record<string, number> = {
  php53: 53, php54: 54, php55: 55, php56: 56,
  php70: 70, php71: 71, php72: 72, php73: 73, php74: 74,
  php80: 80, php81: 81, php82: 82, php83: 83, php84: 84,
  PHP_53: 53, PHP_54: 54, PHP_55: 55, PHP_56: 56,
  PHP_70: 70, PHP_71: 71, PHP_72: 72, PHP_73: 73, PHP_74: 74,
  PHP_80: 80, PHP_81: 81, PHP_82: 82, PHP_83: 83, PHP_84: 84,
};

function normalizePhpVersion(raw: string): string | null {
  // Normalize php82 / PHP_82 / PHP82 → "8.2"
  const m = /(?:php[_]?)([0-9])([0-9]+)/i.exec(raw.toLowerCase().replace(/_/g, ''));
  if (m) return `${m[1]}.${m[2]}`;
  return null;
}

function buildPhpRectorUpgradeSetsInfos(appPath: string): PhpRectorUpgradeSetsInfo[] {
  const results: PhpRectorUpgradeSetsInfo[] = [];

  // Locate rector.php or rector.config.php
  const rectorFiles = ['rector.php', 'rector.config.php'];
  let rectorContent: string | null = null;
  let rectorFile = '';

  for (const fname of rectorFiles) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (content) {
      rectorContent = content;
      rectorFile = fname;
      break;
    }
  }

  if (!rectorContent) {
    return results;
  }

  // ->withPhpSets( — PHP level upgrade
  const phpSetsM = /->withPhpSets\s*\(\s*([^)]{0,500})\)/.exec(rectorContent);
  if (phpSetsM) {
    const argsStr = phpSetsM[1];
    // Parse named arguments: php82: true, php83: true etc.
    const phpVersionMatches = [...argsStr.matchAll(/\b(php[_]?[0-9]{2,3})\s*:\s*true/gi)];
    const enabledVersions: string[] = [];

    for (const vm of phpVersionMatches) {
      const key = vm[1];
      const displayVersion = normalizePhpVersion(key) ?? key;
      enabledVersions.push(key);

      const versionNum = PHP_VERSION_ORDER[key] ?? PHP_VERSION_ORDER[key.toLowerCase()] ?? 0;
      let issue: string | null = null;

      if (versionNum > 0 && versionNum < 80) {
        issue = `PHP upgrade set "${key}" targets PHP < 8.0 — consider updating to at least php80 or higher; PHP 7.x reached end-of-life, and newer sets include more refactoring opportunities`;
      }

      results.push({
        category: 'withPhpSets',
        set: key,
        phpVersion: displayVersion,
        issue,
      });
    }

    // Check conflicting PHP versions (e.g., php74 and php81 both enabled)
    if (enabledVersions.length > 1) {
      const versionNums = enabledVersions
        .map((v) => ({ key: v, num: PHP_VERSION_ORDER[v] ?? PHP_VERSION_ORDER[v.toLowerCase()] ?? 0 }))
        .filter((v) => v.num > 0);

      if (versionNums.length > 1) {
        const sorted = versionNums.sort((a, b) => a.num - b.num);
        const lowest = sorted[0];
        const highest = sorted[sorted.length - 1];
        if (highest.num - lowest.num >= 20) {
          results.push({
            category: 'withPhpSets',
            set: `${lowest.key} + ${highest.key}`,
            phpVersion: null,
            issue: `Conflicting PHP version sets detected (${lowest.key} and ${highest.key} both enabled) — withPhpSets() should target a single PHP version; enabling multiple may cause unexpected rule interactions`,
          });
        }
      }
    }
  }

  // ->withPreparedSets( — prepared sets
  const preparedSetsM = /->withPreparedSets\s*\(\s*([^)]{0,500})\)/.exec(rectorContent);
  if (preparedSetsM) {
    const argsStr = preparedSetsM[1];
    const preparedSetNames = [
      'deadCode', 'codeQuality', 'codingStyle', 'typeDeclarations',
      'privatization', 'earlyReturn', 'instanceOf', 'strictBooleans',
    ];

    for (const setName of preparedSetNames) {
      if (argsStr.includes(`${setName}: true`) || argsStr.includes(`${setName}:true`)) {
        let issue: string | null = null;
        if (setName === 'deadCode') {
          issue = 'DeadCode prepared set enabled — verify CI does not fail on false positives (Rector may remove methods called via reflection or dynamic dispatch); run in --dry-run first';
        }
        results.push({
          category: 'withPreparedSets',
          set: setName,
          phpVersion: null,
          issue,
        });
      }
    }
  }

  // ->withSets([ — specific set constants
  const withSetsM = /->withSets\s*\(\s*\[\s*([^\]]{0,1000})\]/.exec(rectorContent);
  if (withSetsM) {
    const setsBlock = withSetsM[1];

    // SetList::PHP_* constants
    const setListPhpMatches = [...setsBlock.matchAll(/SetList::PHP_([0-9]{2,3})/g)];
    for (const sm of setListPhpMatches) {
      const versionKey = `PHP_${sm[1]}`;
      const displayVersion = normalizePhpVersion(versionKey) ?? versionKey;
      const versionNum = PHP_VERSION_ORDER[versionKey] ?? 0;
      results.push({
        category: 'withSets(SetList)',
        set: `SetList::PHP_${sm[1]}`,
        phpVersion: displayVersion,
        issue: versionNum > 0 && versionNum < 80
          ? `SetList::PHP_${sm[1]} targets PHP < 8.0 — end-of-life; consider upgrading to SetList::PHP_82 or higher`
          : null,
      });
    }

    // SymfonySetList::SYMFONY_*
    const symfonyMatches = [...setsBlock.matchAll(/SymfonySetList::SYMFONY_([0-9_]+)/g)];
    for (const sm of symfonyMatches) {
      const rawVersion = sm[1].replace(/_/g, '.');
      // Check Symfony version mismatch with composer.json
      let issue: string | null = null;
      const composerPath = path.join(appPath, 'composer.json');
      const composerContent = safeRead(composerPath, appPath);
      if (composerContent) {
        const composerSymfonyM = /"symfony[/][^"]+"\s*:\s*"\^?([0-9]+)\.[0-9]+"/.exec(composerContent);
        if (composerSymfonyM) {
          const composerMajor = composerSymfonyM[1];
          const rectorMajor = rawVersion.split('.')[0];
          if (composerMajor !== rectorMajor) {
            issue = `SymfonySetList::SYMFONY_${sm[1]} targets Symfony ${rawVersion} but composer.json requires symfony ^${composerMajor}.x — align the Rector Symfony set with the actual installed version`;
          }
        }
      }
      results.push({
        category: 'withSets(SymfonySetList)',
        set: `SymfonySetList::SYMFONY_${sm[1]}`,
        phpVersion: null,
        issue,
      });
    }

    // DoctrineSetList::DOCTRINE_*
    const doctrineMatches = [...setsBlock.matchAll(/DoctrineSetList::([A-Z0-9_]+)/g)];
    for (const dm of doctrineMatches) {
      results.push({
        category: 'withSets(DoctrineSetList)',
        set: `DoctrineSetList::${dm[1]}`,
        phpVersion: null,
        issue: null,
      });
    }

    // DeadCodeSetList::DEAD_CODE
    if (setsBlock.includes('DeadCodeSetList::DEAD_CODE') || setsBlock.includes('DEAD_CODE')) {
      results.push({
        category: 'withSets(DeadCodeSetList)',
        set: 'DeadCodeSetList::DEAD_CODE',
        phpVersion: null,
        issue: 'DeadCodeSetList::DEAD_CODE enabled — verify CI does not fail on false positives; Rector may remove methods invoked via reflection, event listeners registered by string, or Doctrine lifecycle callbacks',
      });
    }

    // Other SetList entries
    const otherSetMatches = [...setsBlock.matchAll(/SetList::([A-Z_]+)(?!\s*PHP)/g)];
    for (const sm of otherSetMatches) {
      if (sm[1].startsWith('PHP_')) continue;
      results.push({
        category: 'withSets(SetList)',
        set: `SetList::${sm[1]}`,
        phpVersion: null,
        issue: null,
      });
    }
  }

  // If no rector content found entries at all but file exists
  if (results.length === 0) {
    results.push({
      category: 'rector',
      set: rectorFile,
      phpVersion: null,
      issue: `${rectorFile} found but no withPhpSets/withPreparedSets/withSets upgrade sets detected — consider adding upgrade sets to benefit from automated refactoring`,
    });
  }

  return results;
}

export function listPhpRectorUpgradeSets(appPath: string): McpToolResult {
  try {
    const infos = buildPhpRectorUpgradeSetsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No rector.php / rector.config.php found or no upgrade sets configured.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `PHP Rector Upgrade Sets Analysis\n${'='.repeat(55)}\n\nSets: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      const versionStr = info.phpVersion ? ` (PHP ${info.phpVersion})` : '';
      text += `\n  [${info.category}]  ${info.set}${versionStr}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRectorUpgradeSetsStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpRectorUpgradeSetsInfos(appPath);
    const byCategory: Record<string, number> = {};
    for (const info of infos) {
      byCategory[info.category] = (byCategory[info.category] ?? 0) + 1;
    }
    const issues = infos.filter((i) => i.issue !== null);
    const phpVersions = infos.filter((i) => i.phpVersion !== null).map((i) => i.phpVersion as string);
    let text = `PHP Rector Upgrade Sets Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total sets:   ${infos.length}\n`;
    for (const [cat, count] of Object.entries(byCategory)) {
      text += `  ${cat}: ${count}\n`;
    }
    if (phpVersions.length > 0) {
      text += `PHP versions targeted: ${[...new Set(phpVersions)].join(', ')}\n`;
    }
    text += `Issues:       ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.set}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpRectorUpgradeSetsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_rector_upgrade_sets',
      description: 'Scan rector.php/rector.config.php for Rector upgrade sets: ->withPhpSets() PHP level (php74/php80/php81/php82/php83/php84), ->withPreparedSets() (deadCode/codeQuality/codingStyle/typeDeclarations/privatization/earlyReturn/instanceOf/strictBooleans), ->withSets([]) specific constants (SetList::PHP_*, SymfonySetList::SYMFONY_*, DoctrineSetList::*, DeadCodeSetList::DEAD_CODE). Flags old PHP targets (<8.0), conflicting version sets, Symfony set/composer version mismatch, DeadCode false positives warning.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_rector_upgrade_sets_stats',
      description: 'Statistics for PHP Rector upgrade sets: category breakdown, PHP versions targeted, issue count.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
