// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface TranslationCacheInfo {
  source: string;
  type: 'cache-pool' | 'catalogue-cache' | 'fallback' | 'config' | 'runtime';
  directive: string;
  value: string;
  issues: string[];
}

function buildTranslationCacheInfos(appPath: string): TranslationCacheInfo[] {
  const results: TranslationCacheInfo[] = [];

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    const cfg = parseYamlFile(frameworkYaml) as Record<string, unknown> | null;
    if (cfg) {
      const framework = (cfg['framework'] ?? {}) as Record<string, unknown>;
      const translator = (framework['translator'] ?? {}) as Record<string, unknown>;

      const cacheDir = translator['cache_dir'] ?? null;
      const enabledLocales = translator['enabled_locales'] as string[] | null;
      const fallbacks = translator['fallbacks'] as string[] | null;

      if (!cacheDir) {
        results.push({ source: 'framework.yaml', type: 'catalogue-cache', directive: 'translator.cache_dir', value: '(default)', issues: ['translator.cache_dir not explicitly configured — defaults to %kernel.cache_dir%/translations; in multi-server deployments ensure shared cache or use a cache pool'] });
      }

      if (!enabledLocales || enabledLocales.length === 0) {
        results.push({ source: 'framework.yaml', type: 'config', directive: 'translator.enabled_locales', value: '(not set)', issues: ['translator.enabled_locales not set — Symfony will scan for ALL locale files; setting enabled_locales reduces cache size and startup time by 30-70% on multi-language apps'] });
      } else {
        results.push({ source: 'framework.yaml', type: 'config', directive: 'translator.enabled_locales', value: enabledLocales.join(', '), issues: [] });
      }

      if (fallbacks && Array.isArray(fallbacks)) {
        const hasCyclicFallback = fallbacks.length > 3;
        const issues: string[] = [];
        if (hasCyclicFallback) {
          issues.push(`${fallbacks.length} fallback locales defined — deep fallback chains increase translation catalogue load time; keep to 1-2 fallbacks`);
        }
        results.push({ source: 'framework.yaml', type: 'fallback', directive: 'translator.fallbacks', value: fallbacks.join(' → '), issues });
      }
    }
  }

  const cacheYaml = path.join(appPath, 'config', 'packages', 'cache.yaml');
  if (fs.existsSync(cacheYaml)) {
    let content = '';
    try { content = fs.readFileSync(cacheYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('translations') || content.includes('translator')) {
      results.push({ source: 'cache.yaml', type: 'cache-pool', directive: 'translation cache pool', value: 'configured', issues: [] });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkPhpFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkPhpFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('TranslatorInterface') && !content.includes('->trans(')) return;

            const relFile = path.relative(appPath, full);
            const inLoop = /{%.*for.*%}[\s\S]{0,500}->trans\(/.test(content) || /foreach[\s\S]{0,200}->trans\(/.test(content);
            if (inLoop) {
              results.push({ source: relFile, type: 'runtime', directive: 'trans() in loop', value: 'loop detected', issues: ['trans() called inside a loop — catalogue is cached after first load but repeated calls still add overhead; pre-translate values outside the loop and pass the translated strings in'] });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkPhpFiles(srcDir);
  }

  const translationsDir = path.join(appPath, 'translations');
  if (fs.existsSync(translationsDir)) {
    try {
      const files = fs.readdirSync(translationsDir);
      const locales = new Set(files.map((f) => f.split('.')[1] ?? '').filter((l) => l.length > 0));
      const domains = new Set(files.map((f) => f.split('.')[0] ?? '').filter((d) => d.length > 0));
      if (locales.size > 10) {
        results.push({ source: 'translations/', type: 'config', directive: 'translation locales', value: `${locales.size} locales`, issues: [`${locales.size} locale files found — consider using enabled_locales in framework.yaml to load only needed locales and reduce memory usage`] });
      }
      if (domains.size > 20) {
        results.push({ source: 'translations/', type: 'config', directive: 'translation domains', value: `${domains.size} domains`, issues: [`${domains.size} translation domains — many domains means more catalogue files loaded; consolidate rarely-used domains`] });
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listSymfonyTranslationCache(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationCacheInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No translation cache configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Translation Cache Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationCacheStats(appPath: string): McpToolResult {
  try {
    const infos = buildTranslationCacheInfos(appPath);
    let text = `Translation Cache Statistics\n${'='.repeat(40)}\n\n`;
    text += `Cache pools:   ${infos.filter((i) => i.type === 'cache-pool').length}\n`;
    text += `Config issues: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTranslationCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_translation_cache', description: 'Analyze Symfony translation catalogue caching; warns on missing enabled_locales (slow startup), deep fallback chains, trans() inside loops, many locales/domains without restriction, missing cache_dir for multi-server', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_translation_cache_stats', description: 'Statistics for translation cache: pool/config count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
