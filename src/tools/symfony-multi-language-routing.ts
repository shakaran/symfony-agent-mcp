import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MultiLangRoutingInfo {
  file: string;
  type: 'prefix' | 'locale-route' | 'hreflang' | 'default-locale' | 'config';
  pattern: string;
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildMultiLangRoutingInfos(appPath: string): MultiLangRoutingInfo[] {
  const results: MultiLangRoutingInfo[] = [];

  const routingYamlCandidates = [
    path.join(appPath, 'config', 'routes.yaml'),
    path.join(appPath, 'config', 'routing.yaml'),
    path.join(appPath, 'config', 'routes', 'annotations.yaml'),
  ];

  for (const routingYaml of routingYamlCandidates) {
    if (!fs.existsSync(routingYaml)) continue;
    let content = '';
    try { content = fs.readFileSync(routingYaml, 'utf-8'); } catch { continue; }

    if (content.includes('{_locale}') || content.includes('prefix:') && content.includes('locale')) {
      const issues: string[] = [];
      const hasRequirements = content.includes('requirements:') || content.includes('_locale:');
      if (!hasRequirements) {
        issues.push('Locale route "{_locale}" without requirements constraint — any string matches including invalid locales; add requirements: _locale: "en|fr|de|es"');
      }

      const hasDefault = content.includes('defaults:') && content.includes('_locale');
      if (!hasDefault) {
        issues.push('Locale route without default _locale — if no locale prefix in URL, _locale will be empty; add defaults: { _locale: "%app_default_locale%" }');
      }

      results.push({ file: path.relative(appPath, routingYaml), type: 'prefix', pattern: 'locale prefix routing', issues });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('{_locale}') && !content.includes('_locale') && !content.includes('#[Route')) continue;

      const relFile = path.relative(appPath, file);
      const hasLocaleInRoute = content.includes('{_locale}') || content.includes("name: '_locale'");

      if (hasLocaleInRoute) {
        const issues: string[] = [];
        const hasRequirements = content.includes('requirements') && content.includes('_locale');
        if (!hasRequirements) {
          issues.push(`Route with {_locale} in "${relFile}" without requirements — add requirements: ['_locale' => 'en|fr|de'] to prevent invalid locale injection`);
        }

        const hasTranslatablePrefix = content.includes('localizedRoutes') || content.includes('#[Route(path:');
        if (!hasTranslatablePrefix && !content.includes('requirements')) {
          issues.push(`Multi-language route in "${relFile}" without localized path — consider using separate routes per locale or Symfony route translation with translation keys as paths`);
        }

        results.push({ file: relFile, type: 'locale-route', pattern: 'locale in route path', issues });
      }
    }
  }

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    let content = '';
    try { content = fs.readFileSync(frameworkYaml, 'utf-8'); } catch { /* skip */ }

    const defaultLocaleMatch = /default_locale\s*:\s*(\S+)/.exec(content);
    const defaultLocale = defaultLocaleMatch ? defaultLocaleMatch[1] : '';

    if (!defaultLocale) {
      results.push({ file: 'config/packages/framework.yaml', type: 'default-locale', pattern: 'framework.default_locale not set', issues: ['framework.default_locale not set — defaults to "en"; set explicitly to avoid locale-dependent behavior changing across Symfony versions'] });
    } else {
      results.push({ file: 'config/packages/framework.yaml', type: 'default-locale', pattern: `default_locale: ${defaultLocale}`, issues: [] });
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    const layoutFiles = getAllTwigFiles(templatesDir).filter((f) => f.includes('layout') || f.includes('base'));
    for (const file of layoutFiles) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (!content.includes('<html') && !content.includes('lang=')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const hasHtmlLang = content.includes('lang=');
      const hasDynamicLang = content.includes("lang=\"{{ app.request.locale") || content.includes("lang='{{ app.request.locale");
      if (hasHtmlLang && !hasDynamicLang) {
        issues.push(`"<html lang=>" in "${relFile}" uses static locale — use lang="{{ app.request.locale }}" to reflect the active locale for screen readers and search engines`);
      }

      const hasHreflang = content.includes('hreflang') || content.includes('alternate');
      if (!hasHreflang && hasHtmlLang) {
        issues.push(`Layout "${relFile}" missing hreflang alternate links — search engines need <link rel="alternate" hreflang="x"> tags to index multi-language versions`);
      }

      results.push({ file: relFile, type: 'hreflang', pattern: 'HTML lang attribute', issues });
    }
  }

  return results;
}

export function listSymfonyMultiLanguageRouting(appPath: string): McpToolResult {
  try {
    const infos = buildMultiLangRoutingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No multi-language routing patterns found (no {_locale} routes or locale configuration).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Multi-Language Routing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMultiLanguageRoutingStats(appPath: string): McpToolResult {
  try {
    const infos = buildMultiLangRoutingInfos(appPath);
    let text = `Multi-Language Routing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Locale routes:  ${infos.filter((i) => i.type === 'locale-route').length}\n`;
    text += `Prefixes:       ${infos.filter((i) => i.type === 'prefix').length}\n`;
    text += `Hreflang:       ${infos.filter((i) => i.type === 'hreflang').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMultiLanguageRoutingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_multi_language_routing', description: 'Analyze multi-language routing patterns; warns on {_locale} without requirements constraint, missing default locale, static HTML lang attribute, missing hreflang alternate links', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_multi_language_routing_stats', description: 'Statistics for multi-language routing: locale-route/prefix/hreflang count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
