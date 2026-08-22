/**
 * Symfony Translation Inspector
 *
 * Inspects translation files in translations/ to provide:
 *   - List of translation files per locale and domain
 *   - Key comparison across locales (missing translations)
 *   - Search within translation keys and values
 *   - Usage detection: find trans() calls in Twig and PHP
 *   - Statistics: coverage per locale vs reference locale
 *
 * Supports: YAML (.yaml/.yml), XLIFF (.xlf/.xliff), PHP (.php), JSON (.json)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface TranslationFile {
  locale: string;
  domain: string;
  format: string;
  file: string;
  keyCount: number;
  keys: string[];
}

interface MissingTranslation {
  key: string;
  referenceLocale: string;
  missingIn: string[];
}

// ─── File parsing ──────────────────────────────────────────────────────────

function parseTranslationFileName(filename: string): { locale: string; domain: string; format: string } | null {
  // Symfony convention: domain.locale.format
  // e.g. messages.en.yaml, validators.fr.xlf, messages+intl-icu.en.yaml
  const base = filename.replace(/\.(yaml|yml|xlf|xliff|php|json)$/, '');
  const format = filename.split('.').pop() ?? 'yaml';

  const parts = base.split('.');
  if (parts.length < 2) return null;

  const locale = parts[parts.length - 1];
  const domain = parts.slice(0, -1).join('.');

  // Basic locale validation: 2-char or 5-char (en, fr, en_US, fr_FR)
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(locale)) return null;

  return { locale, domain, format };
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = [];
  if (!obj || typeof obj !== 'object') return keys;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function parseYamlTranslationFile(filePath: string): string[] {
  const data = parseYamlFile(filePath);
  if (!data) return [];
  return flattenKeys(data);
}

function parseXliffFile(filePath: string): string[] {
  const keys: string[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // <trans-unit id="key"> or resname="key"
    for (const m of content.matchAll(/resname="([^"]+)"/g)) keys.push(m[1]);
    for (const m of content.matchAll(/<source>([^<]+)<\/source>/g)) {
      if (!keys.includes(m[1])) keys.push(m[1]);
    }
  } catch {
    // Skip
  }
  return keys;
}

function parsePhpTranslationFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const keys: string[] = [];
    // return ['key' => 'value', ...]
    for (const m of content.matchAll(/['"]([^'"]+)['"]\s*=>/g)) {
      keys.push(m[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

function parseJsonTranslationFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as unknown;
    return flattenKeys(data);
  } catch {
    return [];
  }
}

function loadTranslationFile(filePath: string, locale: string, domain: string, format: string): TranslationFile {
  let keys: string[] = [];

  switch (format) {
    case 'yaml': case 'yml':
      keys = parseYamlTranslationFile(filePath);
      break;
    case 'xlf': case 'xliff':
      keys = parseXliffFile(filePath);
      break;
    case 'php':
      keys = parsePhpTranslationFile(filePath);
      break;
    case 'json':
      keys = parseJsonTranslationFile(filePath);
      break;
  }

  return {
    locale,
    domain,
    format,
    file: path.basename(filePath),
    keyCount: keys.length,
    keys,
  };
}

function loadAllTranslations(appPath: string): TranslationFile[] {
  const translationsDir = path.join(appPath, 'translations');
  if (!fs.existsSync(translationsDir)) return [];

  const files: TranslationFile[] = [];
  try {
    for (const entry of fs.readdirSync(translationsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) continue;
      const parsed = parseTranslationFileName(entry.name);
      if (!parsed) continue;
      files.push(loadTranslationFile(
        path.join(translationsDir, entry.name),
        parsed.locale,
        parsed.domain,
        parsed.format
      ));
    }
  } catch {
    // Skip
  }
  return files;
}

// ─── Usage scanning ────────────────────────────────────────────────────────

function scanTransUsage(appPath: string): string[] {
  const usedKeys = new Set<string>();

  // Twig: {{ 'key'|trans }}, {{ 'key'|trans({}, 'domain') }}, {% trans %}key{% endtrans %}
  const templateDir = path.join(appPath, 'templates');
  if (fs.existsSync(templateDir)) {
    for (const file of getAllFiles(templateDir, ['.twig'])) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        for (const m of content.matchAll(/['"]([^'"]{2,})['"]\s*\|\s*trans/g)) usedKeys.add(m[1]);
        for (const m of content.matchAll(/\{%-?\s*trans\s*-?%\}([\s\S]*?)\{%-?\s*endtrans/g)) {
          const key = m[1].trim();
          if (key) usedKeys.add(key);
        }
      } catch {
        // Skip
      }
    }
  }

  // PHP: $translator->trans('key'), t('key') in Twig extensions
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllFiles(srcDir, ['.php'])) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        for (const m of content.matchAll(/->trans\(\s*['"]([^'"]+)['"]/g)) usedKeys.add(m[1]);
        for (const m of content.matchAll(/TranslatableMessage\(\s*['"]([^'"]+)['"]/g)) usedKeys.add(m[1]);
      } catch {
        // Skip
      }
    }
  }

  return Array.from(usedKeys).sort();
}

function getAllFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllFiles(full, extensions));
      else if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(full);
    }
  } catch {
    // Skip
  }
  return files;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listTranslationFiles(appPath: string): McpToolResult {
  try {
    const files = loadAllTranslations(appPath);

    if (files.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No translation files found in ${path.join(appPath, 'translations/')}.\n\nCreate with: php bin/console translation:extract --force en`,
        }],
      };
    }

    // Group by domain
    const domains: Record<string, TranslationFile[]> = {};
    for (const f of files) {
      (domains[f.domain] ??= []).push(f);
    }

    const locales = [...new Set(files.map((f) => f.locale))].sort();

    let text = `Translation Files\n${'='.repeat(50)}\n\n`;
    text += `Locales found: ${locales.join(', ')}\n`;
    text += `Domains found: ${Object.keys(domains).sort().join(', ')}\n\n`;

    for (const [domain, domainFiles] of Object.entries(domains).sort()) {
      text += `  ${domain}\n`;
      for (const f of domainFiles.sort((a, b) => a.locale.localeCompare(b.locale))) {
        text += `    ${f.locale.padEnd(8)} ${String(f.keyCount).padStart(4)} keys  [${f.format}]  ${f.file}\n`;
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

export function findMissingTranslations(appPath: string, referenceLocale: string = 'en'): McpToolResult {
  try {
    const files = loadAllTranslations(appPath);

    if (files.length === 0) {
      return { content: [{ type: 'text', text: 'No translation files found.' }] };
    }

    const domains = [...new Set(files.map((f) => f.domain))];
    const locales = [...new Set(files.map((f) => f.locale))].filter((l) => l !== referenceLocale);

    const missing: MissingTranslation[] = [];

    for (const domain of domains) {
      const ref = files.find((f) => f.domain === domain && f.locale === referenceLocale);
      if (!ref) continue;

      for (const key of ref.keys) {
        const missingIn: string[] = [];
        for (const locale of locales) {
          const trans = files.find((f) => f.domain === domain && f.locale === locale);
          if (!trans || !trans.keys.includes(key)) {
            missingIn.push(locale);
          }
        }
        if (missingIn.length > 0) {
          missing.push({ key, referenceLocale, missingIn });
        }
      }
    }

    if (missing.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `All translation keys from "${referenceLocale}" are present in all other locales. ✓`,
        }],
      };
    }

    const byLocale: Record<string, string[]> = {};
    for (const m of missing) {
      for (const locale of m.missingIn) {
        (byLocale[locale] ??= []).push(m.key);
      }
    }

    let text = `Missing Translations (reference: ${referenceLocale})\n${'='.repeat(50)}\n\n`;
    text += `Total missing: ${missing.length} key/locale combinations\n\n`;

    for (const [locale, keys] of Object.entries(byLocale).sort()) {
      text += `  ${locale}: ${keys.length} missing keys\n`;
      for (const key of keys.slice(0, 10)) {
        text += `    - ${key}\n`;
      }
      if (keys.length > 10) text += `    ... and ${keys.length - 10} more\n`;
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchTranslations(appPath: string, query: string, locale?: string): McpToolResult {
  try {
    const files = loadAllTranslations(appPath);
    const lq = query.toLowerCase();

    const filtered = locale ? files.filter((f) => f.locale === locale) : files;
    const results: Array<{ file: string; locale: string; domain: string; keys: string[] }> = [];

    for (const f of filtered) {
      const matchedKeys = f.keys.filter((k) => k.toLowerCase().includes(lq));
      if (matchedKeys.length > 0) {
        results.push({ file: f.file, locale: f.locale, domain: f.domain, keys: matchedKeys });
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No translation keys matching "${query}"${locale ? ` in locale "${locale}"` : ''}.` }] };
    }

    const totalKeys = results.reduce((s, r) => s + r.keys.length, 0);
    let text = `Translation keys matching "${query}" (${totalKeys} matches):\n\n`;

    for (const r of results) {
      text += `  [${r.locale}] ${r.domain} (${r.file})\n`;
      for (const key of r.keys.slice(0, 10)) text += `    - ${key}\n`;
      if (r.keys.length > 10) text += `    ... and ${r.keys.length - 10} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTranslationStats(appPath: string): McpToolResult {
  try {
    const files = loadAllTranslations(appPath);

    if (files.length === 0) {
      return { content: [{ type: 'text', text: 'No translation files found.' }] };
    }

    const locales = [...new Set(files.map((f) => f.locale))].sort();
    const domains = [...new Set(files.map((f) => f.domain))].sort();

    // Find reference locale (most keys = most complete)
    const localeKeyCounts = locales.map((l) => ({
      locale: l,
      total: files.filter((f) => f.locale === l).reduce((s, f) => s + f.keyCount, 0),
    }));
    const referenceLocale = localeKeyCounts.sort((a, b) => b.total - a.total)[0]?.locale ?? 'en';
    const refTotal = localeKeyCounts.find((l) => l.locale === referenceLocale)?.total ?? 1;

    let text = `Translation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Translation files: ${files.length}\n`;
    text += `Locales:           ${locales.join(', ')}\n`;
    text += `Domains:           ${domains.join(', ')}\n`;
    text += `Reference locale:  ${referenceLocale} (${refTotal} keys)\n`;

    text += `\nCoverage by locale:\n`;
    for (const { locale, total } of localeKeyCounts.sort((a, b) => b.total - a.total)) {
      const pct = Math.round((total / refTotal) * 100);
      const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
      text += `  ${locale.padEnd(8)} ${bar} ${pct}%  (${total} keys)\n`;
    }

    // Scan usage
    const usedKeys = scanTransUsage(appPath);
    if (usedKeys.length > 0) {
      text += `\nTranslation keys used in code/templates: ${usedKeys.length}\n`;
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

export function getTranslationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_translation_files',
      description: 'List all translation files in translations/ grouped by domain, showing locale, key count, and format',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'find_missing_translations',
      description: 'Compare translation keys across locales and report keys present in the reference locale but missing in others',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          reference_locale: { type: 'string', description: 'Reference locale to compare against (default: en)' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'search_translations',
      description: 'Search translation keys across all locales or a specific locale',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Key pattern to search for' },
          locale: { type: 'string', description: 'Limit search to a specific locale (optional)' },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'get_translation_stats',
      description: 'Show translation coverage statistics: key count per locale, coverage percentage vs reference, and usage in templates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
