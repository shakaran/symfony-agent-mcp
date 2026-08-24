// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GedmoTranslatableInfo {
  file: string;
  entity: string;
  translatableFields: string[];
  hasLocaleField: boolean;
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

function extractEntityName(content: string, filePath: string): string {
  const classMatch = /class\s+([A-Za-z_][A-Za-z0-9_]{0,100})/.exec(content);
  return classMatch ? classMatch[1] : path.basename(filePath, '.php');
}

function extractTranslatableFields(content: string): string[] {
  const fields: string[] = [];
  const attrRe = /#\[Gedmo\\Translatable\][^\n]{0,200}\n[^\n]{0,200}(?:private|protected|public)\s+[^\s$]+\s+\$([a-zA-Z_][a-zA-Z0-9_]{0,100})/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(content)) !== null) {
    if (!fields.includes(m[1])) fields.push(m[1]);
  }
  const annotRe = /@Translatable[^\n]{0,100}\n[^\n]{0,200}(?:private|protected|public)\s+[^\s$]+\s+\$([a-zA-Z_][a-zA-Z0-9_]{0,100})/g;
  let an: RegExpExecArray | null;
  while ((an = annotRe.exec(content)) !== null) {
    if (!fields.includes(an[1])) fields.push(an[1]);
  }
  const countRe = (content.match(/#\[Gedmo\\Translatable\]|@Translatable\b/g) ?? []).length;
  if (countRe > 0 && fields.length === 0) {
    for (let i = 0; i < countRe; i++) fields.push(`field_${i + 1}`);
  }
  return fields;
}

function buildGedmoTranslatableInfos(appPath: string): GedmoTranslatableInfo[] {
  const results: GedmoTranslatableInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  let hasTranslationListener = false;

  const servicesYaml = path.join(appPath, 'config', 'services.yaml');
  if (fs.existsSync(servicesYaml)) {
    try {
      const svcContent = fs.readFileSync(servicesYaml, 'utf-8');
      if (svcContent.includes('TranslatableListener') || svcContent.includes('translatable')) {
        hasTranslationListener = true;
      }
    } catch { /* skip */ }
  }

  const stofYaml = path.join(appPath, 'config', 'packages', 'stof_doctrine_extensions.yaml');
  if (fs.existsSync(stofYaml)) {
    try {
      const stofContent = fs.readFileSync(stofYaml, 'utf-8');
      if (stofContent.includes('translatable: true')) hasTranslationListener = true;
    } catch { /* skip */ }
  }

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasTranslatable = content.includes('Gedmo\\Translatable') || content.includes('@Translatable');
    if (!hasTranslatable) continue;

    const relFile = path.relative(appPath, file);
    const entity = extractEntityName(content, file);
    const issues: string[] = [];

    if (content.includes('AbstractTranslation')) {
      results.push({ file: relFile, entity, translatableFields: [], hasLocaleField: false, issues: [] });
      continue;
    }

    const translatableFields = extractTranslatableFields(content);
    const hasLocaleField = content.includes('#[Gedmo\\Locale]') || content.includes('@Locale');

    if (!hasLocaleField) {
      issues.push(`Entity "${entity}" uses #[Gedmo\\Translatable] fields but has no #[Gedmo\\Locale] property — locale won't be set automatically from request; add: #[Gedmo\\Locale] private ?string $locale = null`);
    }

    if (!hasTranslationListener) {
      issues.push(`Entity "${entity}" uses Translatable but no TranslatableListener or stof_doctrine_extensions translatable config found — translations won't be applied without the listener`);
    }

    if (content.includes('setTranslatableLocale') && !content.includes('fallback')) {
      issues.push(`Entity "${entity}" calls setTranslatableLocale() but no fallback locale configured — untranslated content returns empty string instead of default locale value`);
    }

    const translationClassMatch = /translatable_class\s*=\s*["']([^"']{1,200})["']/.exec(content);
    if (translatableFields.length > 0 && !translationClassMatch) {
      const hasTranslationClass = content.includes('Translation') || content.includes('translation_class');
      if (!hasTranslationClass) {
        issues.push(`Entity "${entity}" has translatable fields but no custom translation entity class configured — Gedmo uses a generic translation entity; consider a dedicated translation entity for better query performance`);
      }
    }

    results.push({ file: relFile, entity, translatableFields, hasLocaleField, issues });
  }

  return results;
}

export function listDoctrineGedmoTranslatable(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoTranslatableInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Gedmo Translatable entities found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Gedmo Translatable Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.entity}  (${info.file})\n`;
      text += `    locale field: ${info.hasLocaleField ? 'yes' : 'NO'}\n`;
      if (info.translatableFields.length) text += `    translatable: ${info.translatableFields.join(', ')}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoTranslatableStats(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoTranslatableInfos(appPath);
    let text = `Gedmo Translatable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities:         ${infos.length}\n`;
    text += `With locale field: ${infos.filter((i) => i.hasLocaleField).length}\n`;
    text += `Without locale:    ${infos.filter((i) => !i.hasLocaleField && i.translatableFields.length > 0).length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoTranslatableTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_gedmo_translatable',
      description: 'Scan PHP entities for Gedmo Translatable extension; detects #[Gedmo\\Translatable] fields, missing #[Gedmo\\Locale] property, missing TranslatableListener config, setTranslatableLocale without fallback locale, missing custom translation entity',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_gedmo_translatable_stats',
      description: 'Statistics for Gedmo Translatable: entity count, locale field presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
