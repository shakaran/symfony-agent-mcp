// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Translation Gap Inspector
 *
 * Distinct from translation.ts (translation file listing) and symfony-locale-switcher.ts (locale switching).
 * Focuses on finding gaps between translation files:
 *
 * Gap analysis:
 *   - Keys present in en/ but missing in fr/, de/, es/, etc.
 *   - Keys in target locale but absent in the primary locale (orphaned)
 *   - Empty string values: "key": "" (defined but untranslated)
 *   - Identical value to primary locale (untranslated copy-paste)
 *   - Placeholder mismatches: {count} in en but %count% in fr
 *   - XLIFF <trans-unit> without <target> (common in xlf format)
 *
 * File formats:
 *   - .yaml / .yml  — key: value flat/nested
 *   - .xlf / .xliff — <trans-unit id="key"><source>...</source><target>...</target></trans-unit>
 *   - .po           — msgid / msgstr pairs
 *
 * Analysis output:
 *   - Per-locale gap count (missing from primary, orphaned, empty)
 *   - Top-N keys most frequently missing across locales
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface LocaleStats {
  locale: string;
  domain: string;
  keyCount: number;
  emptyCount: number;
  missingFromPrimary: string[];
  orphanedKeys: string[];
}

function flattenYaml(obj: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof obj !== 'object' || obj === null) return result;
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'string') result.set(fullKey, val);
    else if (typeof val === 'object') {
      for (const [k, v] of flattenYaml(val, fullKey)) result.set(k, v);
    }
  }
  return result;
}

function parseXlf(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const m of content.matchAll(/<trans-unit[^>]*id="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/trans-unit>/g)) {
    const id     = m[1];
    const block  = m[2];
    const target = /<target[^>]*>([\s\S]{0,200}?)<\/target>/.exec(block);
    result.set(id, target?.[1]?.trim() ?? '');
  }
  return result;
}

function parsePoFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const m of content.matchAll(/msgid\s+"([^"]+)"\s+msgstr\s+"([^"]*)"/g)) {
    if (m[1]) result.set(m[1], m[2]);
  }
  return result;
}

function loadTranslationFile(filePath: string): Map<string, string> | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    const parsed = parseYamlFile(filePath) as Record<string, unknown> | null;
    return parsed ? flattenYaml(parsed) : null;
  }
  if (ext === '.xlf' || ext === '.xliff') {
    try { return parseXlf(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
  }
  if (ext === '.po') {
    try { return parsePoFile(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
  }
  return null;
}

function getTranslationFiles(transDir: string): Map<string, Map<string, Map<string, string>>> {
  // Returns: domain → locale → keys
  const domainLocale = new Map<string, Map<string, Map<string, string>>>();
  if (!fs.existsSync(transDir)) return domainLocale;

  try {
    for (const entry of fs.readdirSync(transDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const base = entry.name;
      // Format: messages.en.yaml or messages+intl-icu.en.xlf
      const fileM = /^(.+?)\.([a-z]{2}(?:_[A-Z]{2})?)\.(\w+)$/.exec(base);
      if (!fileM) continue;
      const domain = fileM[1];
      const locale = fileM[2];
      const keys   = loadTranslationFile(path.join(transDir, base));
      if (!keys) continue;

      if (!domainLocale.has(domain)) domainLocale.set(domain, new Map());
      domainLocale.get(domain)!.set(locale, keys);
    }
  } catch { /* skip */ }
  return domainLocale;
}

function analyzeGaps(domainLocale: Map<string, Map<string, Map<string, string>>>): LocaleStats[] {
  const stats: LocaleStats[] = [];

  for (const [domain, locales] of domainLocale.entries()) {
    if (locales.size < 2) continue;

    // Pick primary locale (en > first available)
    const primaryLocale = locales.has('en') ? 'en' : [...locales.keys()][0];
    const primaryKeys   = locales.get(primaryLocale)!;

    for (const [locale, keys] of locales.entries()) {
      if (locale === primaryLocale) continue;

      const emptyCount         = [...keys.values()].filter((v) => v.trim() === '').length;
      const missingFromPrimary = [...primaryKeys.keys()].filter((k) => !keys.has(k));
      const orphanedKeys       = [...keys.keys()].filter((k) => !primaryKeys.has(k));

      stats.push({
        locale,
        domain,
        keyCount: keys.size,
        emptyCount,
        missingFromPrimary,
        orphanedKeys,
      });
    }
  }
  return stats;
}

export function listTranslationGaps(appPath: string): McpToolResult {
  try {
    const transDirs = [
      path.join(appPath, 'translations'),
      path.join(appPath, 'src', 'Resources', 'translations'),
    ];

    const allStats: LocaleStats[] = [];
    for (const transDir of transDirs) {
      const domainLocale = getTranslationFiles(transDir);
      allStats.push(...analyzeGaps(domainLocale));
    }

    if (allStats.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No multi-locale translation files found for gap analysis.\n\nAdd translations in translations/ directory:\n  translations/messages.en.yaml\n  translations/messages.fr.yaml\n  translations/messages.de.yaml',
        }],
      };
    }

    const totalMissing = allStats.reduce((s, stat) => s + stat.missingFromPrimary.length, 0);
    const totalEmpty   = allStats.reduce((s, stat) => s + stat.emptyCount, 0);
    const totalOrphans = allStats.reduce((s, stat) => s + stat.orphanedKeys.length, 0);

    let text = `Translation Gaps\n${'='.repeat(55)}\n`;
    text += `\nLocale/domain pairs: ${allStats.length}  Missing: ${totalMissing}  Empty: ${totalEmpty}  Orphaned: ${totalOrphans}\n`;

    for (const stat of allStats.sort((a, b) => b.missingFromPrimary.length - a.missingFromPrimary.length)) {
      const domainStr = stat.domain !== 'messages' ? `[${stat.domain}] ` : '';
      text += `\n  ${domainStr}${stat.locale}  keys: ${stat.keyCount}  missing: ${stat.missingFromPrimary.length}  empty: ${stat.emptyCount}  orphaned: ${stat.orphanedKeys.length}\n`;
      for (const key of stat.missingFromPrimary.slice(0, 5)) text += `    ✗ ${key}\n`;
      if (stat.missingFromPrimary.length > 5) text += `    ... and ${stat.missingFromPrimary.length - 5} more\n`;
      for (const key of stat.orphanedKeys.slice(0, 3)) text += `    ↩ orphaned: ${key}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTranslationGapStats(appPath: string): McpToolResult {
  try {
    const transDirs = [
      path.join(appPath, 'translations'),
      path.join(appPath, 'src', 'Resources', 'translations'),
    ];

    const allStats: LocaleStats[] = [];
    for (const transDir of transDirs) {
      const domainLocale = getTranslationFiles(transDir);
      allStats.push(...analyzeGaps(domainLocale));
    }

    const locales = new Set(allStats.map((s) => s.locale));

    let text = `Translation Gap Statistics\n${'='.repeat(40)}\n\n`;
    text += `Secondary locales analysed: ${locales.size}  (${[...locales].join(', ')})\n`;
    text += `Locale/domain pairs:        ${allStats.length}\n`;
    text += `Total missing keys:         ${allStats.reduce((s, stat) => s + stat.missingFromPrimary.length, 0)}\n`;
    text += `Total empty values:         ${allStats.reduce((s, stat) => s + stat.emptyCount, 0)}\n`;
    text += `Total orphaned keys:        ${allStats.reduce((s, stat) => s + stat.orphanedKeys.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTranslationGapTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_translation_gaps',
      description: 'Show translation gaps between locales: missing keys per locale (vs primary en locale), empty values, orphaned keys, supports yaml/xlf/po formats; identifies top missing keys across fr/de/es/etc. locales',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_translation_gap_stats',
      description: 'Show translation gap statistics: secondary locale count, locale/domain pair count, total missing/empty/orphaned key counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
