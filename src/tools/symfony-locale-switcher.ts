import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface LocaleSwitcherInfo {
  file: string;
  type: 'switcher' | 'routing' | 'session' | 'listener';
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

function buildLocaleSwitcherInfos(appPath: string): LocaleSwitcherInfo[] {
  const results: LocaleSwitcherInfo[] = [];

  const routingFiles = [
    path.join(appPath, 'config', 'routes.yaml'),
    path.join(appPath, 'config', 'routes', 'annotations.yaml'),
  ];

  for (const routingFile of routingFiles) {
    if (!fs.existsSync(routingFile)) continue;
    let content = '';
    try { content = fs.readFileSync(routingFile, 'utf-8'); } catch { continue; }

    if (content.includes('{_locale}') || content.includes('locale_prefix')) {
      const issues: string[] = [];
      if (!content.includes('requirements') && content.includes('{_locale}')) {
        issues.push('Route uses {_locale} without requirements constraint — any string matches (e.g. /invalid_locale/ is accepted)');
      }
      results.push({ file: path.relative(appPath, routingFile), type: 'routing', pattern: '{_locale} prefix', issues });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    if (content.includes('LocaleSwitcherInterface') || content.includes('->runWithLocale(') || content.includes('->setLocale(')) {
      const usesRunWith = content.includes('->runWithLocale(');
      if (!usesRunWith && content.includes('->setLocale(') && !content.includes('->resetLocale()')) {
        issues.push('->setLocale() used without corresponding ->resetLocale() — locale may leak between requests');
      }
      results.push({ file: relFile, type: 'switcher', pattern: 'LocaleSwitcherInterface', issues });
    }

    const sessionLocale = content.includes("->set('_locale'") || content.includes("->set(\"_locale\"");
    if (sessionLocale) {
      if (!content.includes('getSupportedLocales') && !content.includes('in_array') && !content.includes('supported_locales')) {
        issues.push('Session locale set without validation against supported_locales — invalid locales can be injected via form/query param');
      }
      results.push({ file: relFile, type: 'session', pattern: "session->set('_locale')", issues });
    }

    const isLocaleListener = (content.includes('LocaleListener') || content.includes('onKernelRequest')) &&
      content.includes('setLocale(');
    if (isLocaleListener) {
      const hasCookieFallback = content.includes('cookie') || content.includes('Cookie');
      if (!hasCookieFallback) {
        issues.push('Locale listener sets locale without cookie fallback — locale is lost when session expires');
      }
      results.push({ file: relFile, type: 'listener', pattern: 'KernelRequest locale listener', issues });
    }
  }

  return results;
}

export function listSymfonyLocaleSwitcher(appPath: string): McpToolResult {
  try {
    const infos = buildLocaleSwitcherInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No locale switcher patterns found (no {_locale} routes, LocaleSwitcherInterface, session locale, or locale listener).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Locale Switcher Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLocaleSwitcherStats(appPath: string): McpToolResult {
  try {
    const infos = buildLocaleSwitcherInfos(appPath);
    let text = `Locale Switcher Statistics\n${'='.repeat(40)}\n\n`;
    text += `Switchers:  ${infos.filter((i) => i.type === 'switcher').length}\n`;
    text += `Routing:    ${infos.filter((i) => i.type === 'routing').length}\n`;
    text += `Session:    ${infos.filter((i) => i.type === 'session').length}\n`;
    text += `Listeners:  ${infos.filter((i) => i.type === 'listener').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLocaleSwitcherTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_locale_switcher', description: 'Detect locale switching patterns; warns on {_locale} without requirements, setLocale without reset, session locale without validation, locale listener without cookie fallback', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_locale_switcher_stats', description: 'Statistics for locale switching: switcher/routing/session/listener count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
