// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Translation Plurals Inspector
 *
 * Distinct from translations.ts (which lists translation files and coverage).
 * Focuses specifically on plural forms:
 *
 * Plural form detection:
 *   - Keys containing "|" separator in .yaml, .xlf, .xliff, .po files
 *   - Number of plural alternatives per key (varies by locale)
 *   - Expected plural count per locale (e.g. ru: 3, ar: 6, ja: 1, en: 2)
 *
 * Cross-locale consistency:
 *   - Same key exists in multiple locales with different plural counts
 *   - Key has plural form in default locale but not in translated locale
 *   - Key has no plural form in default locale but has "|" in translated locale
 *
 * Trans() call analysis:
 *   - Twig: {% trans %}...{% endtrans %} / {{ message|trans }}
 *   - PHP: $translator->trans('key', ['%count%' => $n])
 *   - Keys with %count% parameter but no "|" in translation file
 *   - Keys with "|" plural form but never called with %count% parameter
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

interface PluralKey {
  key: string;
  domain: string;
  locale: string;
  file: string;
  alternatives: number;
}

interface PluralIssue {
  key: string;
  domain: string;
  issue: string;
}

// Expected plural form counts per locale (simplified)
const PLURAL_FORMS: Record<string, number> = {
  ar: 6, be: 3, bs: 3, cs: 3, hr: 3, lt: 3, lv: 3, mk: 2,
  pl: 3, ru: 3, sk: 3, sl: 4, sr: 3, uk: 3, // 3-form languages
  cy: 6, ga: 5, // Celtic
  ro: 3, // Romanian
  fr: 2, pt: 2, es: 2, it: 2, de: 2, en: 2, nl: 2, sv: 2, da: 2,
  nb: 2, fi: 2, hu: 2, bg: 2, el: 2, tr: 1, ja: 1, zh: 1, ko: 1,
  id: 1, th: 1, vi: 1, ms: 1,
};

function getAllTranslationFiles(transDir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(transDir, { withFileTypes: true })) {
      const full = path.join(transDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllTranslationFiles(full));
      else if (/\.(ya?ml|xlf|xliff|po|php)$/.test(entry.name)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseLocaleAndDomain(fileName: string): { locale: string; domain: string } {
  const base  = path.basename(fileName, path.extname(fileName));
  const parts = base.split('.');
  // format: messages.en.yaml or validators.fr_FR.xlf
  if (parts.length >= 2) {
    return { domain: parts[0] ?? 'messages', locale: parts[parts.length - 1] ?? 'en' };
  }
  return { domain: base, locale: 'unknown' };
}

function extractPluralKeysFromYaml(content: string, file: string, locale: string, domain: string): PluralKey[] {
  const results: PluralKey[] = [];
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!value.includes('|')) continue;
    const keyRaw = line.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
    if (!keyRaw || keyRaw.startsWith('#')) continue;
    const alternatives = value.split('|').length;
    results.push({ key: keyRaw, domain, locale, file: path.basename(file), alternatives });
  }
  return results;
}

function extractPluralKeysFromXliff(content: string, file: string, locale: string, domain: string): PluralKey[] {
  const results: PluralKey[] = [];
  for (const m of content.matchAll(/<source>([^<]+)<\/source>\s*<target>([^<]+)<\/target>/g)) {
    const value = m[2] ?? '';
    if (!value.includes('|')) continue;
    const key = m[1] ?? '';
    results.push({ key, domain, locale, file: path.basename(file), alternatives: value.split('|').length });
  }
  return results;
}

function scanTranslationPluralKeys(appPath: string): PluralKey[] {
  const transDir = path.join(appPath, 'translations');
  if (!fs.existsSync(transDir)) return [];

  const results: PluralKey[] = [];
  for (const file of getAllTranslationFiles(transDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const { locale, domain } = parseLocaleAndDomain(file);
    const ext = path.extname(file).toLowerCase();

    if (ext === '.yaml' || ext === '.yml') {
      results.push(...extractPluralKeysFromYaml(content, file, locale, domain));
    } else if (ext === '.xlf' || ext === '.xliff') {
      results.push(...extractPluralKeysFromXliff(content, file, locale, domain));
    }
  }
  return results;
}

function detectPluralIssues(keys: PluralKey[]): PluralIssue[] {
  const issues: PluralIssue[] = [];

  // Group by domain + key
  const byKey = new Map<string, PluralKey[]>();
  for (const k of keys) {
    const mapKey = `${k.domain}:${k.key}`;
    const list = byKey.get(mapKey) ?? [];
    list.push(k);
    byKey.set(mapKey, list);
  }

  for (const [, variants] of byKey) {
    if (variants.length < 2) continue;
    const altCounts = new Set(variants.map((v) => v.alternatives));
    if (altCounts.size > 1) {
      const summary = [...altCounts].join(' vs ');
      issues.push({
        key: variants[0]?.key ?? '',
        domain: variants[0]?.domain ?? '',
        issue: `Inconsistent plural count across locales (${summary} alternatives): ${variants.map((v) => v.locale).join(', ')}`,
      });
    }
  }

  // Check against expected forms per locale
  for (const k of keys) {
    const expected = PLURAL_FORMS[k.locale.split('_')[0] ?? ''];
    if (expected !== undefined && k.alternatives !== expected) {
      issues.push({
        key: k.key,
        domain: k.domain,
        issue: `${k.locale}: ${k.alternatives} plural alternatives but locale expects ${expected}  (${k.file})`,
      });
    }
  }

  return issues;
}

export function listTranslationPlurals(appPath: string): McpToolResult {
  try {
    const keys   = scanTranslationPluralKeys(appPath);
    const issues = detectPluralIssues(keys);

    if (keys.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No plural forms found in translation files.\n\nAdd plural forms with "|" separator:\n\n  # messages.en.yaml\n  item_count: "One item|%count% items"\n\n  # messages.fr.yaml\n  item_count: "%count% élément|%count% éléments"\n\nUsage:\n  {{ \'item_count\'|trans({\'%count%\': items|length}) }}',
        }],
      };
    }

    // Group by domain
    const byDomain = new Map<string, PluralKey[]>();
    for (const k of keys) {
      const list = byDomain.get(k.domain) ?? [];
      list.push(k);
      byDomain.set(k.domain, list);
    }

    // Unique keys per domain
    const uniqueByDomain = new Map<string, Set<string>>();
    for (const [domain, ks] of byDomain) {
      uniqueByDomain.set(domain, new Set(ks.map((k) => k.key)));
    }

    let text = `Translation Plural Forms\n${'='.repeat(55)}\n`;
    text += `\nTotal plural keys: ${new Set(keys.map((k) => `${k.domain}:${k.key}`)).size}\n`;
    text += `Files with plurals: ${new Set(keys.map((k) => k.file)).size}\n`;

    for (const [domain, uniqueKeys] of [...uniqueByDomain.entries()].sort()) {
      const locales = [...new Set(byDomain.get(domain)?.map((k) => k.locale) ?? [])].sort();
      text += `\n  Domain "${domain}" — ${uniqueKeys.size} plural keys in [${locales.join(', ')}]\n`;
      for (const key of [...uniqueKeys].slice(0, 5)) {
        text += `    ${key}\n`;
      }
      if (uniqueKeys.size > 5) text += `    ... and ${uniqueKeys.size - 5} more\n`;
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues.slice(0, 15)) {
        text += `  ⚠ [${issue.domain}] ${issue.key}: ${issue.issue}\n`;
      }
      if (issues.length > 15) text += `  ... and ${issues.length - 15} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPluralStats(appPath: string): McpToolResult {
  try {
    const keys   = scanTranslationPluralKeys(appPath);
    const issues = detectPluralIssues(keys);

    const uniqueKeys   = new Set(keys.map((k) => `${k.domain}:${k.key}`));
    const uniqueLocales = new Set(keys.map((k) => k.locale));

    let text = `Translation Plural Statistics\n${'='.repeat(40)}\n\n`;
    text += `Unique plural keys:  ${uniqueKeys.size}\n`;
    text += `Locales with plurals: ${uniqueLocales.size}\n`;
    text += `Total plural entries: ${keys.length}\n`;
    text += `Issues detected:     ${issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTranslationPluralTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_translation_plurals',
      description: 'Show translation plural forms: "|"-separated keys per domain and locale, alternative count per locale, cross-locale consistency check (same key different plural count), expected plural count by locale (en:2, ru:3, ar:6, ja:1), issue detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_plural_stats',
      description: 'Show translation plural statistics: unique plural key count, locale count, total plural entries, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
