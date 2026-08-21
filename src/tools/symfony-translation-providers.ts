/**
 * Symfony Translation Provider Inspector
 *
 * Reads translation.yaml (or framework.yaml translation section): providers map
 * with dsn, locales, domains.
 *
 * Detects provider type from DSN: crowdin://, lokalise://, phrase://,
 * loco://, transifex://, po-editor://, etc.
 *
 * Warns: hardcoded credentials in DSN (use env var), provider without domains
 * restriction (all translations synced), provider without locales restriction,
 * read_only not set (accidental push risk), no provider config.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TranslationProviderInfo {
  name: string;
  type: string;
  hasEnvVar: boolean;
  locales: string[];
  domains: string[];
  isReadOnly: boolean;
  issues: string[];
}

const KNOWN_PROVIDERS: Record<string, string> = {
  'crowdin://':    'Crowdin',
  'lokalise://':   'Lokalise',
  'phrase://':     'Phrase',
  'loco://':       'Loco',
  'transifex://':  'Transifex',
  'po-editor://':  'POEditor',
  'poeditor://':   'POEditor',
  'weblate://':    'Weblate',
  'smartling://':  'Smartling',
  'lingohub://':   'LingoHub',
};

function detectProviderType(dsn: string): string {
  for (const [prefix, label] of Object.entries(KNOWN_PROVIDERS)) {
    if (dsn.startsWith(prefix)) return label;
  }
  // Generic: scheme before ://
  const schemeM = /^([a-z0-9-]{1,40}):\/\//i.exec(dsn);
  return schemeM ? schemeM[1] : 'unknown';
}

function hasEnvVar(dsn: string): boolean {
  return dsn.includes('%env(') || dsn.includes('${') || dsn.includes('env(');
}

function hasHardcodedCredentials(dsn: string): boolean {
  if (hasEnvVar(dsn)) return false;
  // DSN with user:pass@host pattern
  const credRe = /^[a-z0-9-]{1,40}:\/\/[^@]{3,}@/i;
  return credRe.test(dsn);
}

function parseProviders(appPath: string): TranslationProviderInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'translation.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    // Support both top-level translation: and framework.translation:
    const translationSection =
      (raw['translation'] as Record<string, unknown> | undefined) ??
      ((raw['framework'] as Record<string, unknown> | undefined)?.['translation'] as Record<string, unknown> | undefined);

    if (!translationSection) continue;

    const providersRaw = translationSection['providers'] as Record<string, unknown> | undefined;
    if (!providersRaw) continue;

    const providers: TranslationProviderInfo[] = [];

    for (const [name, def] of Object.entries(providersRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;

      const dsn = d['dsn'] ? String(d['dsn']) : '';
      const localesRaw = d['locales'] as unknown[] | undefined;
      const domainsRaw = d['domains'] as unknown[] | undefined;
      const readOnly = d['read_only'] as boolean | undefined;

      const locales = Array.isArray(localesRaw) ? localesRaw.map((l) => String(l)) : [];
      const domains = Array.isArray(domainsRaw) ? domainsRaw.map((dm) => String(dm)) : [];
      const type = dsn ? detectProviderType(dsn) : 'unknown';
      const provHasEnvVar = hasEnvVar(dsn);
      const isReadOnly = Boolean(readOnly);

      const issues: string[] = [];

      if (dsn && hasHardcodedCredentials(dsn)) {
        issues.push('Hardcoded credentials in DSN — use environment variable (e.g. %env(TRANSLATION_DSN)%)');
      }
      if (domains.length === 0) {
        issues.push('No domains restriction — all translation domains will be synced with provider');
      }
      if (locales.length === 0) {
        issues.push('No locales restriction — all locales will be synced with provider');
      }
      if (!isReadOnly) {
        issues.push('read_only not set — accidental push of local translations to remote provider is possible');
      }

      providers.push({ name, type, hasEnvVar: provHasEnvVar, locales, domains, isReadOnly, issues });
    }

    return providers;
  }

  return [];
}

export function listTranslationProviders(appPath: string): McpToolResult {
  try {
    const providers = parseProviders(appPath);

    if (providers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No translation providers configured.\n\nProviders are configured in config/packages/translation.yaml:\n  translation:\n    providers:\n      crowdin:\n        dsn: "%env(CROWDIN_DSN)%"\n        locales: [en, fr, de]\n        domains: [messages]\n        read_only: true',
        }],
      };
    }

    const totalIssues = providers.reduce((s, p) => s + p.issues.length, 0);
    let text = `Symfony Translation Providers\n${'='.repeat(55)}\n`;
    text += `\nProviders: ${providers.length}  Issues: ${totalIssues}\n`;

    for (const p of providers.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${p.name} (${p.type})\n`;
      text += `    Env var DSN: ${p.hasEnvVar ? 'yes' : 'NO (check for credentials)'}  Read-only: ${p.isReadOnly ? 'yes' : 'NO'}\n`;
      text += `    Locales: ${p.locales.length > 0 ? p.locales.join(', ') : '(all)'}\n`;
      text += `    Domains: ${p.domains.length > 0 ? p.domains.join(', ') : '(all)'}\n`;
      for (const issue of p.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getTranslationProviderStats(appPath: string): McpToolResult {
  try {
    const providers = parseProviders(appPath);

    let text = `Translation Provider Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured providers:       ${providers.length}\n`;

    if (providers.length > 0) {
      const types = [...new Set(providers.map((p) => p.type))];
      text += `Provider types:             ${types.join(', ')}\n`;
      text += `  With env var DSN:         ${providers.filter((p) => p.hasEnvVar).length}\n`;
      text += `  Read-only:                ${providers.filter((p) => p.isReadOnly).length}\n`;
      text += `  With locale restriction:  ${providers.filter((p) => p.locales.length > 0).length}\n`;
      text += `  With domain restriction:  ${providers.filter((p) => p.domains.length > 0).length}\n`;
    }

    text += `Issues detected:            ${providers.reduce((s, p) => s + p.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTranslationProviderTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_translation_providers',
      description: 'Show Symfony translation provider configuration: Crowdin/Lokalise/Phrase/Loco/Transifex/POEditor DSN detection, locales, domains, read_only; warns on hardcoded credentials, missing locales/domains restriction, read_only not set',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_translation_provider_stats',
      description: 'Show translation provider statistics: provider count, types, env var DSN count, read-only count, locale/domain restriction count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
