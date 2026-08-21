import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DomainUsage {
  domain: string;
  fileCount: number;
  locales: string[];
  usedInPhp: boolean;
  usedInTwig: boolean;
  issues: string[];
}

function getTranslationFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.\w{2,5}\.(yaml|yml|xlf|xliff|php|po|mo)$/.test(e.name)) files.push(path.join(dir, e.name));
    }
  } catch { /* skip */ }
  return files;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
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
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadTranslationDomains(appPath: string): DomainUsage[] {
  const translationsDir = path.join(appPath, 'translations');
  const transFiles = getTranslationFiles(translationsDir);
  const domainMap = new Map<string, { locales: Set<string>; fileCount: number }>();
  for (const f of transFiles) {
    const base = path.basename(f);
    // Pattern: domain.locale.format
    const parts = base.split('.');
    if (parts.length >= 3) {
      const domain = parts.slice(0, parts.length - 2).join('.');
      const locale = parts[parts.length - 2];
      if (!domainMap.has(domain)) domainMap.set(domain, { locales: new Set(), fileCount: 0 });
      const d = domainMap.get(domain)!;
      d.locales.add(locale);
      d.fileCount++;
    }
  }
  const srcDir = path.join(appPath, 'src');
  const templatesDir = path.join(appPath, 'templates');
  const phpContent = getAllPhpFiles(srcDir).map(f => safeRead(f, srcDir) ?? '').join('\n');
  const twigContent = getAllTwigFiles(templatesDir).map(f => safeRead(f, templatesDir) ?? '').join('\n');
  const results: DomainUsage[] = [];
  for (const [domain, info] of domainMap.entries()) {
    const domainRe = new RegExp(`['"]${domain.replace('.', '\\.')}['"]`, 'i');
    const usedInPhp = domainRe.test(phpContent) || phpContent.includes(`trans(`) && phpContent.includes(domain);
    const usedInTwig = twigContent.includes(domain);
    const issues: string[] = [];
    if (info.locales.size === 1) issues.push(`Domain "${domain}" has only 1 locale — missing translations for other locales`);
    if (domain === 'messages' && domainMap.size > 3) issues.push('Most translations in "messages" domain — consider splitting by feature into custom domains');
    results.push({ domain, fileCount: info.fileCount, locales: [...info.locales].sort(), usedInPhp, usedInTwig, issues });
  }
  return results.sort((a, b) => b.fileCount - a.fileCount);
}

export function listTranslationDomains(appPath: string): McpToolResult {
  try {
    const domains = loadTranslationDomains(appPath);
    if (domains.length === 0) return { content: [{ type: 'text', text: 'No translation files found in translations/.' }] };
    const totalIssues = domains.reduce((s, d) => s + d.issues.length, 0);
    let text = `Translation Domains\n${'='.repeat(55)}\n\nDomains: ${domains.length}  Issues: ${totalIssues}\n`;
    for (const d of domains) {
      text += `\n  ${d.domain}  files: ${d.fileCount}  locales: ${d.locales.join(', ')}  php: ${d.usedInPhp ? '✓' : '?'}  twig: ${d.usedInTwig ? '✓' : '?'}\n`;
      for (const i of d.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTranslationDomainStats(appPath: string): McpToolResult {
  try {
    const domains = loadTranslationDomains(appPath);
    const localeSet = new Set(domains.flatMap(d => d.locales));
    let text = `Translation Domain Statistics\n${'='.repeat(40)}\n\n`;
    text += `Domains: ${domains.length}\nLocales: ${localeSet.size} (${[...localeSet].sort().join(', ')})\nTotal files: ${domains.reduce((s, d) => s + d.fileCount, 0)}\nIssues: ${domains.reduce((s, d) => s + d.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTranslationDomainTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_translation_domains', description: 'Analyze translation domains: per-domain locale coverage, file count, PHP/Twig usage detection, single-locale warning, over-reliance on "messages" domain warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_translation_domain_stats', description: 'Translation domain statistics: domain count, locale count, total file count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
