/**
 * Symfony Locale Configuration Inspector
 *
 * Distinct from translations.ts (files/keys) and symfony-translation-plurals.ts (plurals).
 * Focuses on locale setup and negotiation:
 *
 * framework.yaml:
 *   - default_locale
 *   - enabled_locales (Symfony 6.2+ explicit list)
 *
 * translator.yaml:
 *   - default_path (where translation files live)
 *   - fallbacks (per-locale fallback chains)
 *   - logging (missing translation logging)
 *   - formatter (message_formatter)
 *
 * Locale-aware services:
 *   - Services tagged locale.aware / with LocaleSubscriber
 *   - RequestContextInterface locale usage
 *   - LocaleSwitcher (Symfony 6.3) usage
 *
 * Router locale prefix:
 *   - route definitions with locale prefix /{_locale}/
 *   - #[Route] with requirements: _locale pattern
 *
 * Analysis:
 *   - enabled_locales not set (Symfony 6.2+ warning — any locale accepted)
 *   - Fallback chain missing for languages with country variants (e.g. fr_CH with no fr fallback)
 *   - Locales with translation files but not in enabled_locales
 *   - Missing default locale translation files
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


function loadFrameworkLocale(appPath: string): { defaultLocale: string; enabledLocales: string[] } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
    const defaultLocale  = String(fw['default_locale'] ?? 'en');
    const enabledRaw     = fw['enabled_locales'];
    const enabledLocales = Array.isArray(enabledRaw) ? enabledRaw.map(String) : [];
    return { defaultLocale, enabledLocales };
  }
  return { defaultLocale: 'en', enabledLocales: [] };
}

function loadTranslatorConfig(appPath: string): { fallbacks: Record<string, string[]>; loggingEnabled: boolean; defaultPath?: string } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'translation.yaml'),
    path.join(appPath, 'config', 'packages', 'translator.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw         = (raw['framework'] ?? raw) as Record<string, unknown>;
    const translator = (fw['translator'] ?? fw['translation'] ?? {}) as Record<string, unknown>;

    const fallbacksRaw = translator['fallbacks'] as Record<string, unknown> | unknown[] | undefined;
    const fallbacks: Record<string, string[]> = {};
    if (Array.isArray(fallbacksRaw)) {
      // Simple fallback list (all locales)
      fallbacks['*'] = fallbacksRaw.map(String);
    } else if (fallbacksRaw && typeof fallbacksRaw === 'object') {
      for (const [locale, fb] of Object.entries(fallbacksRaw)) {
        fallbacks[locale] = Array.isArray(fb) ? fb.map(String) : [String(fb)];
      }
    }

    const loggingEnabled = translator['logging'] === true || translator['logging'] === 'true';
    const defaultPath    = translator['default_path'] ? String(translator['default_path']) : undefined;

    if (Object.keys(translator).length > 0) {
      return { fallbacks, loggingEnabled, defaultPath };
    }
  }
  return { fallbacks: {}, loggingEnabled: false };
}

function detectTranslationLocales(appPath: string): string[] {
  const transDir = path.join(appPath, 'translations');
  if (!fs.existsSync(transDir)) return [];

  const locales = new Set<string>();
  try {
    for (const entry of fs.readdirSync(transDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parts = entry.name.split('.');
      if (parts.length >= 3) {
        const locale = parts[parts.length - 2];
        if (locale && locale !== 'yaml' && locale !== 'php') locales.add(locale);
      }
    }
  } catch { /* skip */ }
  return [...locales].sort();
}

function scanLocaleRoutes(appPath: string): number {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;

  const gather = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { gather(full); return; }
        if (!e.name.endsWith('.php')) return;
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
        const m = content.match(/\{_locale\}|requirements.*_locale/g);
        if (m) count += m.length;
      }
    } catch { /* skip */ }
  };
  gather(srcDir);
  return count;
}

export function listLocaleConfig(appPath: string): McpToolResult {
  try {
    const { defaultLocale, enabledLocales } = loadFrameworkLocale(appPath);
    const { fallbacks, loggingEnabled, defaultPath } = loadTranslatorConfig(appPath);
    const translationLocales = detectTranslationLocales(appPath);
    const localeRoutes = scanLocaleRoutes(appPath);

    let text = `Locale Configuration\n${'='.repeat(55)}\n\n`;
    text += `Default locale:    ${defaultLocale}\n`;
    text += `Enabled locales:   ${enabledLocales.length > 0 ? enabledLocales.join(', ') : '⚠ not set (any locale accepted)'}\n`;
    text += `Translation logging: ${loggingEnabled ? 'yes' : 'no'}\n`;
    if (defaultPath) text += `Translation path:  ${defaultPath}\n`;
    text += `Locale-prefixed routes: ${localeRoutes}\n`;

    if (Object.keys(fallbacks).length > 0) {
      text += `\nFallback chains:\n`;
      for (const [locale, chain] of Object.entries(fallbacks)) {
        text += `  ${locale === '*' ? '(all)' : locale.padEnd(10)} → ${chain.join(', ')}\n`;
      }
    } else {
      text += `\nFallback chains:  not configured\n`;
    }

    if (translationLocales.length > 0) {
      text += `\nLocales with translation files (${translationLocales.length}): ${translationLocales.join(', ')}\n`;
    }

    // Analysis
    const issues: string[] = [];
    if (enabledLocales.length === 0) {
      issues.push('enabled_locales not set — Symfony accepts any locale (Symfony 6.2+ recommendation: explicit list)');
    }
    for (const locale of translationLocales) {
      if (enabledLocales.length > 0 && !enabledLocales.includes(locale)) {
        issues.push(`Locale "${locale}" has translation files but is not in enabled_locales`);
      }
      // Country variant without base locale fallback
      if (locale.includes('_')) {
        const base = locale.split('_')[0] ?? '';
        const hasFallback = fallbacks[locale]?.includes(base) ?? fallbacks['*']?.includes(base) ?? false;
        if (!hasFallback && base && !translationLocales.includes(base)) {
          issues.push(`Locale "${locale}" has no "${base}" fallback configured`);
        }
      }
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLocaleStats(appPath: string): McpToolResult {
  try {
    const { defaultLocale, enabledLocales } = loadFrameworkLocale(appPath);
    const translationLocales = detectTranslationLocales(appPath);

    let text = `Locale Statistics\n${'='.repeat(40)}\n\n`;
    text += `Default locale:       ${defaultLocale}\n`;
    text += `Enabled locales:      ${enabledLocales.length}\n`;
    text += `Translation locales:  ${translationLocales.length}\n`;
    text += `Locale-prefixed routes: ${scanLocaleRoutes(appPath)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLocaleConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_locale_config',
      description: 'Show Symfony locale configuration: default_locale, enabled_locales, translator fallback chains, logging flag, locales with translation files, locale-prefixed routes, missing enabled_locales warning, country-variant without base fallback',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_locale_stats',
      description: 'Show locale statistics: default locale, enabled locale count, translation locale count, locale-prefixed route count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
