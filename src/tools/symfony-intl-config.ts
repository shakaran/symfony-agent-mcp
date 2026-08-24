// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface IntlConfigInfo {
  type: 'number' | 'date' | 'currency' | 'locale';
  locale: string;
  pattern: string;
  source: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildIntlInfos(appPath: string): IntlConfigInfo[] {
  const results: IntlConfigInfo[] = [];

  let defaultLocale = '';
  const translationYaml = path.join(appPath, 'config', 'packages', 'translation.yaml');
  if (fs.existsSync(translationYaml)) {
    const cfg = parseYamlFile(translationYaml) as Record<string, unknown> | null;
    if (cfg) {
      const framework = (cfg['framework'] ?? cfg) as Record<string, unknown>;
      defaultLocale = String(framework['default_locale'] ?? '');
    }
  }

  if (!defaultLocale) {
    const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
    if (fs.existsSync(frameworkYaml)) {
      const cfg = parseYamlFile(frameworkYaml) as Record<string, unknown> | null;
      if (cfg) {
        const framework = (cfg['framework'] ?? cfg) as Record<string, unknown>;
        defaultLocale = String(framework['default_locale'] ?? '');
      }
    }
  }

  results.push({
    type: 'locale',
    locale: defaultLocale || '(not set)',
    pattern: defaultLocale || 'missing',
    source: 'config/packages/translation.yaml',
    issues: defaultLocale ? [] : ['default_locale not configured in framework.yaml or translation.yaml'],
  });

  let hasIntlPackage = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/intl'] || req['twig/intl-extra']) hasIntlPackage = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const relFile = path.relative(appPath, file);

      if (content.includes('new \\NumberFormatter(') || content.includes('new NumberFormatter(')) {
        const withoutLocale = /new\s+\\?NumberFormatter\(\s*(?:null|\$(?!locale)\w{1,60}|''\s*)/.test(content);
        if (withoutLocale) {
          results.push({ type: 'number', locale: '(none)', pattern: 'NumberFormatter', source: relFile, issues: ['NumberFormatter created without locale argument — uses PHP system locale (inconsistent across servers)'] });
        }
      }

      if (content.includes('new \\IntlDateFormatter(') || content.includes('new IntlDateFormatter(')) {
        const hardcodedEn = /new\s+\\?IntlDateFormatter\(\s*['"]en(?:_[A-Z]{2})?['"]/.test(content);
        if (hardcodedEn) {
          results.push({ type: 'date', locale: 'en', pattern: 'IntlDateFormatter', source: relFile, issues: [`IntlDateFormatter created with hardcoded locale 'en' — should use $request->getLocale() or the configured default_locale`] });
        }
      }
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    const intlFilters = ['format_number', 'format_currency', 'format_date', 'format_datetime', 'format_time'];
    const allTwigContent: string[] = [];
    try {
      for (const e of fs.readdirSync(templatesDir, { withFileTypes: true })) {
        const full = path.join(templatesDir, e.name);
        if (e.isFile() && (e.name.endsWith('.twig') || e.name.endsWith('.html'))) {
          try { allTwigContent.push(fs.readFileSync(full, 'utf-8')); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    const usesIntlFilters = intlFilters.some((f) => allTwigContent.some((c) => c.includes(`|${f}`)));
    if (usesIntlFilters && !hasIntlPackage) {
      results.push({ type: 'number', locale: '', pattern: 'Twig intl filters', source: 'templates/', issues: ['Twig intl filters (|format_number, |format_currency) used but twig/intl-extra not in composer.json'] });
    }
  }

  return results;
}

export function listSymfonyIntlConfig(appPath: string): McpToolResult {
  try {
    const infos = buildIntlInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Intl Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  locale: ${info.locale}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyIntlStats(appPath: string): McpToolResult {
  try {
    const infos = buildIntlInfos(appPath);
    let text = `Symfony Intl Statistics\n${'='.repeat(40)}\n\n`;
    text += `Locale configs:  ${infos.filter((i) => i.type === 'locale').length}\n`;
    text += `Number formatters: ${infos.filter((i) => i.type === 'number').length}\n`;
    text += `Date formatters: ${infos.filter((i) => i.type === 'date').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyIntlTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_intl_config', description: 'Analyze Symfony Intl component usage; warns on missing default_locale, NumberFormatter without locale, hardcoded locale in IntlDateFormatter, Twig intl filters without twig/intl-extra', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_intl_stats', description: 'Statistics for Symfony Intl: locale configs, number/date formatters, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
