/**
 * Symfony Translation Lint All Inspector
 *
 * Scans translations/** for cross-locale consistency:
 *   - Keys present in one locale but missing in others
 *   - Plural forms count mismatch (English=2, Russian=3 forms via | count)
 *   - Empty translation values
 *   - Duplicate keys within same file
 *   - ICU message format without all required plural forms
 *   - XLIFF files with untranslated <target> matching <source>
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TranslationFile {
  locale: string;
  domain: string;
  format: string;
  filePath: string;
  keys: Map<string, string>;
}

interface TranslationIssue {
  type: string;
  file: string;
  key?: string;
  description: string;
}

function getAllTranslationFiles(translationsDir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(translationsDir, { withFileTypes: true })) {
      const full = path.join(translationsDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllTranslationFiles(full));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.yaml', '.yml', '.xlf', '.xliff', '.php', '.json'].includes(ext)) {
          files.push(full);
        }
      }
    }
  } catch { /* skip */ }
  return files;
}

function parseLocaleAndDomain(filename: string): { locale: string; domain: string; format: string } {
  const base = path.basename(filename);
  // Expected: domain.locale.format  e.g. messages.en.yaml, validators.fr_FR.xlf
  const parts = base.split('.');
  if (parts.length >= 3) {
    const format = parts[parts.length - 1] ?? 'yaml';
    const locale = parts[parts.length - 2] ?? 'en';
    const domain = parts.slice(0, parts.length - 2).join('.');
    return { locale, domain, format };
  }
  return { locale: 'unknown', domain: parts[0] ?? 'messages', format: parts[parts.length - 1] ?? 'yaml' };
}

function parseYamlTranslations(content: string, prefix = ''): Map<string, string> {
  const keys = new Map<string, string>();
  const lines = content.split('\n');
  const stack: Array<{ indent: number; key: string }> = [];

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) {
      stack.pop();
    }

    const kvMatch = /^(\s*)([^:]+):\s*(.*)$/.exec(line);
    if (!kvMatch) continue;

    const key = kvMatch[2].trim();
    const val = kvMatch[3].trim();
    const parentKey = stack.length > 0 ? `${stack[stack.length - 1]?.key ?? ''}.` : '';
    const fullKey = prefix ? `${prefix}.${parentKey}${key}` : `${parentKey}${key}`;

    if (val !== '') {
      keys.set(fullKey, val.replace(/^['"]|['"]$/g, ''));
    } else {
      stack.push({ indent, key: fullKey });
    }
  }

  return keys;
}

function parseXliffTranslations(content: string): Map<string, string> {
  const keys = new Map<string, string>();
  const unitRegex = /<trans-unit[^>]*id="([^"]+)"[^>]*>([\s\S]+?)<\/trans-unit>/g;
  let m: RegExpExecArray | null;

  while ((m = unitRegex.exec(content)) !== null) {
    const id = m[1];
    const unitContent = m[2];
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(unitContent);
    const targetMatch = /<target[^>]*>([\s\S]*?)<\/target>/i.exec(unitContent);
    const source = sourceMatch ? sourceMatch[1].trim() : '';
    const target = targetMatch ? targetMatch[1].trim() : '';
    keys.set(id, target !== '' ? target : source);
  }

  return keys;
}

function loadTranslationFile(filePath: string): TranslationFile {
  const { locale, domain, format } = parseLocaleAndDomain(filePath);
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* skip */ }

  let keys = new Map<string, string>();

  if (format === 'yaml' || format === 'yml') {
    keys = parseYamlTranslations(content);
  } else if (format === 'xlf' || format === 'xliff') {
    keys = parseXliffTranslations(content);
  } else if (format === 'json') {
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      for (const [k, v] of Object.entries(json)) {
        keys.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    } catch { /* skip */ }
  }

  return { locale, domain, filePath, format, keys };
}

function getExpectedPluralCount(locale: string): number {
  // Simplified plural count by language family
  const twoForms = ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'fi', 'nb', 'tr'];
  const threeForms = ['ru', 'uk', 'be', 'bs', 'hr', 'sr', 'sk', 'cs', 'pl'];
  const fourForms = ['sl', 'ga'];
  const oneForms = ['zh', 'ja', 'ko', 'vi', 'th', 'id'];

  const lang = locale.split('_')[0] ?? locale;
  if (oneForms.includes(lang)) return 1;
  if (twoForms.includes(lang)) return 2;
  if (threeForms.includes(lang)) return 3;
  if (fourForms.includes(lang)) return 4;
  return 2; // default
}

function countPluralForms(value: string): number {
  if (!value.includes('|')) return 1;
  return value.split('|').length;
}

function analyzeTranslations(appPath: string): { files: TranslationFile[]; issues: TranslationIssue[] } {
  const resolvedBase = path.resolve(appPath);
  const transDir = path.join(resolvedBase, 'translations');

  if (!fs.existsSync(transDir)) {
    return { files: [], issues: [] };
  }

  const allFiles = getAllTranslationFiles(transDir)
    .filter((f) => path.resolve(f).startsWith(resolvedBase + path.sep));

  const files = allFiles.map((f) => loadTranslationFile(f));
  const issues: TranslationIssue[] = [];

  // Group by domain
  const byDomain = new Map<string, TranslationFile[]>();
  for (const file of files) {
    const domainFiles = byDomain.get(file.domain) ?? [];
    domainFiles.push(file);
    byDomain.set(file.domain, domainFiles);
  }

  for (const [domain, domainFiles] of byDomain.entries()) {
    if (domainFiles.length < 2) continue;

    // Build union of all keys
    const allKeys = new Set<string>();
    for (const f of domainFiles) {
      for (const key of f.keys.keys()) allKeys.add(key);
    }

    for (const key of allKeys) {
      const missingIn: string[] = [];
      for (const f of domainFiles) {
        if (!f.keys.has(key)) {
          missingIn.push(f.locale);
        }
      }
      if (missingIn.length > 0 && missingIn.length < domainFiles.length) {
        const relFile = path.relative(appPath, domainFiles[0]?.filePath ?? '');
        issues.push({
          type: 'missing-key',
          file: `${domain} (${relFile})`,
          key,
          description: `Key "${key}" in domain "${domain}" is missing for locale(s): ${missingIn.join(', ')}`,
        });
      }
    }

    // Plural form mismatch
    for (const f of domainFiles) {
      const expectedForms = getExpectedPluralCount(f.locale);
      for (const [key, value] of f.keys.entries()) {
        if (value.includes('|')) {
          const actualForms = countPluralForms(value);
          if (actualForms !== expectedForms) {
            const relFile = path.relative(appPath, f.filePath);
            issues.push({
              type: 'plural-mismatch',
              file: relFile,
              key,
              description: `Key "${key}" in ${f.locale}: has ${actualForms} plural form(s), expected ${expectedForms} for this locale`,
            });
          }
        }
      }
    }
  }

  // Empty values
  for (const f of files) {
    const relFile = path.relative(appPath, f.filePath);
    for (const [key, value] of f.keys.entries()) {
      if (value.trim() === '') {
        issues.push({
          type: 'empty-value',
          file: relFile,
          key,
          description: `Key "${key}" has an empty translation value in ${f.locale}`,
        });
      }
    }
  }

  // Duplicate keys within same file
  for (const f of files) {
    const relFile = path.relative(appPath, f.filePath);
    let content = '';
    try { content = fs.readFileSync(f.filePath, 'utf-8'); } catch { continue; }
    const seen = new Set<string>();
    const lines = content.split('\n');
    for (const line of lines) {
      const kvMatch = /^(\s*)([^:]+):\s/.exec(line);
      if (!kvMatch) continue;
      const indent = kvMatch[1].length;
      if (indent > 0) continue; // Only check top-level for simplicity
      const key = kvMatch[2].trim();
      if (seen.has(key)) {
        issues.push({
          type: 'duplicate-key',
          file: relFile,
          key,
          description: `Duplicate top-level key "${key}" in ${relFile}`,
        });
      }
      seen.add(key);
    }
  }

  // XLIFF untranslated (target === source)
  for (const f of files) {
    if (f.format !== 'xlf' && f.format !== 'xliff') continue;
    const relFile = path.relative(appPath, f.filePath);
    let content = '';
    try { content = fs.readFileSync(f.filePath, 'utf-8'); } catch { continue; }

    const unitRegex = /<trans-unit[^>]*id="([^"]+)"[^>]*>([\s\S]+?)<\/trans-unit>/g;
    let m: RegExpExecArray | null;
    while ((m = unitRegex.exec(content)) !== null) {
      const id = m[1];
      const unitContent = m[2];
      const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(unitContent);
      const targetMatch = /<target[^>]*>([\s\S]*?)<\/target>/i.exec(unitContent);
      if (sourceMatch && targetMatch) {
        const source = sourceMatch[1].trim();
        const target = targetMatch[1].trim();
        if (source === target && source.length > 0) {
          issues.push({
            type: 'xliff-untranslated',
            file: relFile,
            key: id,
            description: `XLIFF unit "${id}" has <target> identical to <source> "${source.slice(0, 50)}" — likely untranslated`,
          });
        }
      }
    }
  }

  // ICU format check
  for (const f of files) {
    const relFile = path.relative(appPath, f.filePath);
    for (const [key, value] of f.keys.entries()) {
      if (value.includes('{count, plural,') || value.includes('{num, plural,')) {
        const hasOne = value.includes('one{') || value.includes('=1{');
        const hasOther = value.includes('other{');
        if (!hasOne || !hasOther) {
          issues.push({
            type: 'icu-incomplete',
            file: relFile,
            key,
            description: `ICU plural message "${key}" missing required forms — needs at minimum one{...} other{...}`,
          });
        }
      }
    }
  }

  return { files, issues };
}

export function listSymfonyTranslationLintAll(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { files, issues } = analyzeTranslations(appPath);

    if (files.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No translation files found in translations/.\n\nExpected format: translations/messages.en.yaml, translations/validators.fr.xlf',
        }],
      };
    }

    // Group files by domain
    const byDomain = new Map<string, TranslationFile[]>();
    for (const f of files) {
      const df = byDomain.get(f.domain) ?? [];
      df.push(f);
      byDomain.set(f.domain, df);
    }

    let text = `Symfony Translation Lint Report\n${'='.repeat(55)}\n\n`;
    text += `Translation files: ${files.length}  Domains: ${byDomain.size}\n\n`;

    for (const [domain, df] of [...byDomain.entries()].sort()) {
      const locales = df.map((f) => f.locale).sort().join(', ');
      const keyCount = Math.max(...df.map((f) => f.keys.size));
      text += `  ${domain.padEnd(30)} locales: [${locales}]  max-keys: ${keyCount}\n`;
    }

    text += '\n';

    if (issues.length === 0) {
      text += 'No translation issues found.\n';
    } else {
      // Group by type
      const byType = new Map<string, TranslationIssue[]>();
      for (const issue of issues) {
        const ti = byType.get(issue.type) ?? [];
        ti.push(issue);
        byType.set(issue.type, ti);
      }

      text += `Issues found: ${issues.length}\n\n`;
      for (const [type, typeIssues] of [...byType.entries()].sort()) {
        text += `[${type}] (${typeIssues.length}):\n`;
        for (const issue of typeIssues.slice(0, 20)) {
          text += `  ${issue.file}: ${issue.description}\n`;
        }
        if (typeIssues.length > 20) {
          text += `  ... and ${typeIssues.length - 20} more\n`;
        }
        text += '\n';
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

export function getSymfonyTranslationLintAllStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { files, issues } = analyzeTranslations(appPath);

    const domains = new Set(files.map((f) => f.domain)).size;
    const locales = new Set(files.map((f) => f.locale)).size;
    const totalKeys = files.reduce((s, f) => s + f.keys.size, 0);

    const byType = new Map<string, number>();
    for (const issue of issues) {
      byType.set(issue.type, (byType.get(issue.type) ?? 0) + 1);
    }

    let text = `Symfony Translation Lint Stats\n${'='.repeat(40)}\n\n`;
    text += `Translation files: ${files.length}\n`;
    text += `Domains:           ${domains}\n`;
    text += `Locales:           ${locales}\n`;
    text += `Total keys:        ${totalKeys}\n`;
    text += `Total issues:      ${issues.length}\n\n`;

    for (const [type, count] of [...byType.entries()].sort()) {
      text += `  ${type.padEnd(25)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyTranslationLintAllTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_translation_lint_all',
      description: 'Cross-locale translation lint: missing keys per locale, plural form count mismatch (en=2, ru=3), empty values, duplicate keys, ICU plural completeness, XLIFF untranslated units (target === source)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_translation_lint_all_stats',
      description: 'Statistics for translation lint: file count, domain/locale counts, total keys, issues by type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
