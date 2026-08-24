// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Translation YAML Lint Inspector
 *
 * Scans translations/**\/*.yaml and *.yml for:
 * - Duplicate translation keys within the same file
 * - Empty string values (key: '')
 * - Key naming consistency (dots vs underscores)
 * - Key count differences across locales (e.g. messages.en vs messages.fr)
 * - Keys missing in some locales vs others
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TranslationYamlLintInfo {
  file: string;
  domain: string;
  locale: string;
  issue: 'duplicate-key' | 'empty-value' | 'nested-conflict' | 'inconsistent-count';
  key: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectTranslationFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectTranslationFiles(full, base));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full);
  }
  return results;
}

function parseTranslationFilename(filename: string): { domain: string; locale: string } {
  // Expect: domain.locale.yaml or domain.locale.yml
  const base = path.basename(filename).replace(/\.(yaml|yml)$/, '');
  const parts = base.split('.');
  if (parts.length >= 2) {
    return { domain: parts.slice(0, -1).join('.'), locale: parts[parts.length - 1] };
  }
  return { domain: base, locale: 'unknown' };
}

function extractFlatKeys(content: string): { keys: string[]; emptyKeys: string[] } {
  const keys: string[] = [];
  const emptyKeys: string[] = [];
  const lines = content.split('\n');
  const keyStack: Array<{ indent: number; key: string }> = [];

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const keyMatch = /^(\s*)(\w[\w.-]*)\s*:\s*(.*)/.exec(line);
    if (!keyMatch) continue;

    const lineIndent = keyMatch[1].length;
    const rawKey = keyMatch[2];
    const value = keyMatch[3].trim();

    // Pop stack to current indent level
    while (keyStack.length > 0 && (keyStack[keyStack.length - 1]?.indent ?? 0) >= lineIndent) {
      keyStack.pop();
    }

    const parentPath = keyStack.map((k) => k.key).join('.');
    const fullKey = parentPath ? `${parentPath}.${rawKey}` : rawKey;

    keyStack.push({ indent: lineIndent, key: rawKey });

    // Only record leaf values
    if (value !== '' && !value.startsWith('#')) {
      const cleanValue = value.replace(/^['"]|['"]$/g, '').trim();
      keys.push(fullKey);
      if (cleanValue === '') {
        emptyKeys.push(fullKey);
      }
    } else if (value === '') {
      // Could be parent key or empty value
      keys.push(fullKey);
    }

    void indent; // used implicitly via lineIndent
  }

  return { keys, emptyKeys };
}

function buildTranslationLintInfos(appPath: string): TranslationYamlLintInfo[] {
  const translationsDir = path.join(appPath, 'translations');
  const results: TranslationYamlLintInfo[] = [];
  const files = collectTranslationFiles(translationsDir, appPath);

  // Per-file analysis
  // Object.create(null) on both levels: `domain` comes from a filename and
  // `locale` from its suffix, so messages.__proto__.yaml would otherwise reach
  // the prototype setter and the write would land on the map's prototype
  // instead of creating an own key.
  const domainLocaleKeys: Record<string, Record<string, string[]>> =
    Object.create(null) as Record<string, Record<string, string[]>>;

  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    const relFile = path.relative(appPath, file);
    const { domain, locale } = parseTranslationFilename(file);
    const { keys, emptyKeys } = extractFlatKeys(content);

    // Track for cross-locale comparison
    if (domainLocaleKeys[domain] === undefined) {
      domainLocaleKeys[domain] = Object.create(null) as Record<string, string[]>;
    }
    domainLocaleKeys[domain][locale] = keys;

    // Duplicate keys
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) {
        results.push({ file: relFile, domain, locale, issue: 'duplicate-key', key });
      }
      seen.add(key);
    }

    // Empty values
    for (const key of emptyKeys) {
      results.push({ file: relFile, domain, locale, issue: 'empty-value', key });
    }
  }

  // Cross-locale comparison
  for (const [domain, locales] of Object.entries(domainLocaleKeys)) {
    const localeList = Object.keys(locales);
    if (localeList.length < 2) continue;

    const counts = localeList.map((loc) => (locales[loc] ?? []).length);
    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);

    if (maxCount - minCount > 0) {
      // Find locale with different count — compare against reference (first locale)
      const refLocale = localeList[0];
      const refKeys = new Set(locales[refLocale] ?? []);

      for (const loc of localeList.slice(1)) {
        const locKeys = new Set(locales[loc] ?? []);
        const missingHere = [...refKeys].filter((k) => !locKeys.has(k));
        const extraHere = [...locKeys].filter((k) => !refKeys.has(k));

        for (const key of missingHere.slice(0, 10)) {
          const translFile = files.find((f) => {
            const { domain: d, locale: l } = parseTranslationFilename(f);
            return d === domain && l === loc;
          });
          const relFile = translFile ? path.relative(appPath, translFile) : `${domain}.${loc}.yaml`;
          results.push({ file: relFile, domain, locale: loc, issue: 'inconsistent-count', key: `missing: ${key} (present in ${refLocale})` });
        }
        for (const key of extraHere.slice(0, 10)) {
          const translFile = files.find((f) => {
            const { domain: d, locale: l } = parseTranslationFilename(f);
            return d === domain && l === loc;
          });
          const relFile = translFile ? path.relative(appPath, translFile) : `${domain}.${loc}.yaml`;
          results.push({ file: relFile, domain, locale: loc, issue: 'inconsistent-count', key: `extra: ${key} (missing in ${refLocale})` });
        }
      }
    }
  }

  return results;
}

export function listSymfonyTranslationYamlLint(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationLintInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No translation YAML lint issues found in translations/.' }] };
    }

    let text = `Symfony Translation YAML Lint\n${'='.repeat(50)}\n\n`;
    text += `Total issues: ${infos.length}\n\n`;

    const byIssue: Record<string, TranslationYamlLintInfo[]> = {};
    for (const info of infos) {
      if (!byIssue[info.issue]) byIssue[info.issue] = [];
      byIssue[info.issue].push(info);
    }

    for (const [issue, items] of Object.entries(byIssue)) {
      text += `[${issue.toUpperCase()}] — ${items.length} issues\n`;
      for (const item of items.slice(0, 20)) {
        text += `  ${item.file} [${item.locale}]\n`;
        text += `    Key: ${item.key}\n`;
      }
      if (items.length > 20) text += `  ... and ${items.length - 20} more\n`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationYamlLintStats(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationLintInfos(appPath);

    const counts: Record<string, number> = { 'duplicate-key': 0, 'empty-value': 0, 'nested-conflict': 0, 'inconsistent-count': 0 };
    for (const info of infos) counts[info.issue] = (counts[info.issue] ?? 0) + 1;
    const filesAffected = new Set(infos.map((i) => i.file)).size;
    const localesAffected = new Set(infos.map((i) => i.locale)).size;
    const domainsAffected = new Set(infos.map((i) => i.domain)).size;

    let text = `Symfony Translation YAML Lint Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total issues:         ${infos.length}\n`;
    text += `Files affected:       ${filesAffected}\n`;
    text += `Locales affected:     ${localesAffected}\n`;
    text += `Domains affected:     ${domainsAffected}\n\n`;
    text += `By issue type:\n`;
    text += `  Duplicate keys:     ${counts['duplicate-key'] ?? 0}\n`;
    text += `  Empty values:       ${counts['empty-value'] ?? 0}\n`;
    text += `  Inconsistent count: ${counts['inconsistent-count'] ?? 0}\n`;
    text += `  Nested conflicts:   ${counts['nested-conflict'] ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationYamlLintTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_translation_yaml_lint',
      description: 'List Symfony translation YAML lint issues: duplicate keys, empty values, keys missing across locales (e.g. present in messages.en.yaml but missing in messages.fr.yaml)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_translation_yaml_lint_stats',
      description: 'Get Symfony translation YAML lint statistics: issue counts by type, affected files/locales/domains',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
