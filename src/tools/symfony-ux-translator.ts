import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface UxTranslatorInfo {
  file: string;
  type: 'config' | 'js-call' | 'locale' | 'dump';
  pattern: string;
  issues: string[];
}

function buildUxTranslatorInfos(appPath: string): UxTranslatorInfo[] {
  const results: UxTranslatorInfo[] = [];

  let hasUxTranslator = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/ux-translator']) hasUxTranslator = true;
    } catch { /* ignore */ }
  }

  if (!hasUxTranslator) {
    results.push({ file: 'composer.json', type: 'config', pattern: 'symfony/ux-translator', issues: ['symfony/ux-translator not installed — install with: composer require symfony/ux-translator'] });
    return results;
  }

  const translatorConfig = path.join(appPath, 'config', 'packages', 'ux_translator.yaml');
  if (fs.existsSync(translatorConfig)) {
    let content = '';
    try { content = fs.readFileSync(translatorConfig, 'utf-8'); } catch { /* skip */ }
    const issues: string[] = [];
    if (!content.includes('dump_path')) {
      issues.push('ux_translator.yaml missing dump_path — translated messages will not be available to JavaScript; configure dump_path: "%kernel.project_dir%/assets/translations"');
    }
    results.push({ file: 'config/packages/ux_translator.yaml', type: 'config', pattern: 'UX Translator config', issues });
  }

  const translationsDumpPath = path.join(appPath, 'assets', 'translations');
  if (fs.existsSync(translationsDumpPath)) {
    try {
      const files = fs.readdirSync(translationsDumpPath);
      const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
      if (jsFiles.length === 0) {
        results.push({ file: 'assets/translations/', type: 'dump', pattern: 'no dumped translations', issues: ['Translation dump directory exists but is empty — run: bin/console translation:dump --force to generate JS translation files'] });
      } else {
        results.push({ file: 'assets/translations/', type: 'dump', pattern: `${jsFiles.length} translation files`, issues: [] });
      }
    } catch { /* skip */ }
  }

  const assetsDir = path.join(appPath, 'assets');
  if (fs.existsSync(assetsDir)) {
    const jsFiles: string[] = [];
    const scanDir = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (!e.isSymbolicLink() && e.isDirectory() && !e.name.includes('translations') && !e.name.includes('node_modules')) scanDir(full);
          else if (e.name.endsWith('.js') || e.name.endsWith('.ts')) jsFiles.push(full);
        }
      } catch { /* skip */ }
    };
    scanDir(assetsDir);

    for (const jsFile of jsFiles.slice(0, 20)) {
      let content = '';
      try { content = fs.readFileSync(jsFile, 'utf-8'); } catch { continue; }
      if (!content.includes('trans(') && !content.includes('from \'@symfony/ux-translator\'')) continue;

      const relFile = path.relative(appPath, jsFile);
      const issues: string[] = [];

      if (content.includes('trans(') && !content.includes('from \'@symfony/ux-translator\'') && !content.includes('from "@symfony/ux-translator"')) {
        issues.push(`"trans()" used in "${relFile}" without importing from @symfony/ux-translator — ensure the import is present or translation function may be undefined`);
      }

      const hasLocaleParam = content.includes(', {') && content.includes('locale');
      if (!hasLocaleParam && content.includes('trans(')) {
        issues.push(`Translation call in "${relFile}" without explicit locale — will use browser locale which may not match server locale; pass locale parameter for consistency`);
      }

      results.push({ file: relFile, type: 'js-call', pattern: 'trans() call in JS', issues });
    }
  }

  return results;
}

export function listSymfonyUxTranslator(appPath: string): McpToolResult {
  try {
    const infos = buildUxTranslatorInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `UX Translator Analysis\n${'='.repeat(50)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTranslatorStats(appPath: string): McpToolResult {
  try {
    const infos = buildUxTranslatorInfos(appPath);
    let text = `UX Translator Statistics\n${'='.repeat(40)}\n\n`;
    text += `JS calls:  ${infos.filter((i) => i.type === 'js-call').length}\n`;
    text += `Config:    ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyUxTranslatorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_ux_translator', description: 'Analyze Symfony UX Translator JS translation bundles; warns on missing dump_path config, empty translation dump dir, trans() without import, trans() without explicit locale parameter', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_ux_translator_stats', description: 'Statistics for UX Translator: JS call/config count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
