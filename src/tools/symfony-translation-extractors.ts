// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Translation Extractor Inspector
 *
 * Scans src/**\/*.php for translation usage: $this->trans(), TranslatableMessage,
 * TranslatableInterface, #[Translatable].
 * Scans templates/**\/*.html.twig for: {{ 'key'|trans }}, {% trans %}.
 * Compares found keys against translations/messages.*.yaml to detect untranslated keys.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TranslationExtractorInfo {
  type: 'php' | 'twig' | 'attribute';
  file: string;
  key: string;
  domain: string;
}

function collectPhpFiles(dir: string, base: string): string[] {
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
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function collectConfigFiles(dir: string, base: string, exts: string[]): string[] {
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
    if (stat.isDirectory()) results.push(...collectConfigFiles(full, base, exts));
    else if (exts.some(e => entry.endsWith(e))) results.push(full);
  }
  return results;
}

function extractKeysFromTranslationFile(content: string): string[] {
  const keys: string[] = [];
  // Simple YAML key extraction: top-level and nested
  const lines = content.split('\n');
  const stack: Array<{ indent: number; prefix: string }> = [];

  for (const line of lines) {
    if (line.trim().startsWith('#') || !line.trim()) continue;
    const keyMatch = /^(\s*)(\w[^:]{0,100}):\s*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const indent = keyMatch[1].length;
    const key = keyMatch[2].trim();
    const value = keyMatch[3].trim();

    // Pop stack to current indent
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const prefix = stack.length > 0 ? stack[stack.length - 1].prefix + '.' : '';
    const fullKey = prefix + key;

    if (value && !value.startsWith('{') && !value.startsWith('[')) {
      keys.push(fullKey);
    } else {
      stack.push({ indent, prefix: fullKey });
    }
  }

  return keys;
}

function buildTranslationExtractorInfos(appPath: string): TranslationExtractorInfo[] {
  const infos: TranslationExtractorInfo[] = [];

  // Scan PHP files
  const srcDir = path.join(appPath, 'src');
  const srcDirR = path.resolve(srcDir);
  if (srcDirR.startsWith(path.resolve(appPath) + path.sep)) {
    let srcStat;
    try { srcStat = fs.lstatSync(srcDir); } catch { srcStat = null; }
    if (srcStat && srcStat.isSymbolicLink()) srcStat = null;
    if (srcStat && srcStat.isDirectory()) {
      for (const file of collectPhpFiles(srcDir, appPath)) {
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        const relFile = path.relative(appPath, file);

        const hasTranslation = /\$this->trans\(|TranslatableMessage|TranslatableInterface|#\[Translatable/.test(content);
        if (!hasTranslation) continue;

        // $this->trans('key', [], 'domain')
        const transPattern = /\$this->trans\s*\(\s*['"]([^'"]{1,200})['"](?:\s*,\s*\[[^\]]{0,300}\]\s*,\s*['"]([^'"]{1,80})['"])?/g;
        let m: RegExpExecArray | null;
        while ((m = transPattern.exec(content)) !== null) {
          infos.push({ type: 'php', file: relFile, key: m[1], domain: m[2] ?? 'messages' });
        }

        // TranslatableMessage('key', [], 'domain')
        const tmPattern = /new\s+TranslatableMessage\s*\(\s*['"]([^'"]{1,200})['"](?:\s*,\s*\[[^\]]{0,300}\]\s*,\s*['"]([^'"]{1,80})['"])?/g;
        while ((m = tmPattern.exec(content)) !== null) {
          infos.push({ type: 'php', file: relFile, key: m[1], domain: m[2] ?? 'messages' });
        }

        // #[Translatable] attribute — extract from property/parameter names
        const attrPattern = /#\[Translatable(?:\([^)]{0,200}\))?\]\s*(?:public\s+)?(?:\w+\s+)?\$(\w{1,80})/g;
        while ((m = attrPattern.exec(content)) !== null) {
          infos.push({ type: 'attribute', file: relFile, key: m[1], domain: 'messages' });
        }
      }
    }
  }

  // Scan Twig templates
  const templatesDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'app', 'Resources', 'views'),
  ];

  for (const tmplDir of templatesDirs) {
    const tmplDirR = path.resolve(tmplDir);
    if (!tmplDirR.startsWith(path.resolve(appPath) + path.sep)) continue;
    let tmplStat;
    try { tmplStat = fs.lstatSync(tmplDir); } catch { continue; }
    if (tmplStat.isSymbolicLink()) continue;
    if (!tmplStat.isDirectory()) continue;

    const twigFiles = collectConfigFiles(tmplDir, appPath, ['.twig']);
    for (const file of twigFiles) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const relFile = path.relative(appPath, file);

      if (!content.includes('|trans') && !content.includes('{% trans') && !content.includes('trans(')) continue;

      // {{ 'key'|trans }} or {{ 'key'|trans({}, 'domain') }}
      const filterPattern = /['"]([^'"]{1,200})['"]\s*\|\s*trans(?:\s*\(\s*\{[^}]{0,200}\}\s*,\s*['"]([^'"]{1,80})['"])?/g;
      let m: RegExpExecArray | null;
      while ((m = filterPattern.exec(content)) !== null) {
        infos.push({ type: 'twig', file: relFile, key: m[1], domain: m[2] ?? 'messages' });
      }

      // {% trans %}key{% endtrans %} or {% trans from 'domain' %}key{% endtrans %}
      const tagPattern = /\{%\s*trans(?:\s+from\s+['"]([^'"]{1,80})['"])?\s*%\}([^{%]{1,200})\{%\s*endtrans\s*%\}/g;
      while ((m = tagPattern.exec(content)) !== null) {
        const key = m[2].trim();
        if (key) infos.push({ type: 'twig', file: relFile, key, domain: m[1] ?? 'messages' });
      }
    }
  }

  return infos;
}

function loadDefinedTranslationKeys(appPath: string): Set<string> {
  const keys = new Set<string>();
  const translationsDir = path.join(appPath, 'translations');
  const translationsDirR = path.resolve(translationsDir);
  if (!translationsDirR.startsWith(path.resolve(appPath) + path.sep)) return keys;

  let stat;
  try { stat = fs.lstatSync(translationsDir); } catch { return keys; }
  if (stat.isSymbolicLink()) return keys;
  if (!stat.isDirectory()) return keys;

  const files = collectConfigFiles(translationsDir, appPath, ['.yaml', '.yml']);
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const key of extractKeysFromTranslationFile(content)) {
      keys.add(key);
    }
  }

  return keys;
}

export function listSymfonyTranslationExtractors(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationExtractorInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No translation usage found in src/ or templates/.' }] };
    }

    const definedKeys = loadDefinedTranslationKeys(appPath);
    const untranslated = infos.filter(i => !definedKeys.has(i.key) && !i.key.includes('%') && !i.key.includes('{'));

    let text = `Symfony Translation Extractor\n${'='.repeat(55)}\n\n`;
    text += `Translation usages found: ${infos.length}\n`;
    text += `Defined keys in translations/: ${definedKeys.size}\n`;
    text += `Potentially untranslated keys: ${untranslated.length}\n\n`;

    const byType = new Map<string, TranslationExtractorInfo[]>();
    for (const info of infos) {
      const bucket = byType.get(info.type) ?? [];
      bucket.push(info);
      byType.set(info.type, bucket);
    }

    for (const [type, items] of byType) {
      text += `  ${type.toUpperCase()} (${items.length})\n`;
      for (const item of items.slice(0, 10)) {
        const missing = !definedKeys.has(item.key) && !item.key.includes('%') ? '  [UNTRANSLATED]' : '';
        text += `    domain:${item.domain.padEnd(12)} ${item.key}${missing}\n`;
        text += `           ${item.file}\n`;
      }
      if (items.length > 10) text += `    ... and ${items.length - 10} more\n`;
      text += '\n';
    }

    if (untranslated.length > 0) {
      text += `Untranslated keys (first 10):\n`;
      for (const u of untranslated.slice(0, 10)) {
        text += `  [${u.type}] "${u.key}" (domain: ${u.domain}) — ${u.file}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationExtractorsStats(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationExtractorInfos(appPath);
    const definedKeys = loadDefinedTranslationKeys(appPath);
    const php = infos.filter(i => i.type === 'php').length;
    const twig = infos.filter(i => i.type === 'twig').length;
    const attrs = infos.filter(i => i.type === 'attribute').length;
    const untranslated = infos.filter(i => !definedKeys.has(i.key) && !i.key.includes('%') && !i.key.includes('{')).length;
    const domains = new Set(infos.map(i => i.domain));

    let text = `Symfony Translation Extractor Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total usages found: ${infos.length}\n`;
    text += `  PHP (trans/TranslatableMessage): ${php}\n`;
    text += `  Twig (|trans / {% trans %}):     ${twig}\n`;
    text += `  Attribute (#[Translatable]):     ${attrs}\n`;
    text += `Defined keys in translations/:     ${definedKeys.size}\n`;
    text += `Potentially untranslated:          ${untranslated}\n`;
    text += `Domains used: ${[...domains].join(', ') || 'none'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationExtractorsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_translation_extractors',
      description: 'List Symfony translation usages from PHP and Twig: keys with domain, type (php/twig/attribute), and comparison against translations/ to flag untranslated keys',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_translation_extractors_stats',
      description: 'Get Symfony translation extractor statistics: counts by source type (php/twig/attribute), defined vs untranslated keys, domains used',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
