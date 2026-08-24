// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GedmoSluggableInfo {
  file: string;
  entity: string;
  slugField: string;
  sourceFields: string[];
  unique: boolean;
  updatable: boolean;
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

function extractSourceFields(slugAttrText: string): string[] {
  const fieldsMatch = /fields\s*:\s*\[([^\]]{0,500})\]/.exec(slugAttrText);
  if (!fieldsMatch) return [];
  return fieldsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

function extractBoolAttr(text: string, attrName: string, defaultVal: boolean): boolean {
  const re = new RegExp(`${attrName}\\s*:\\s*(true|false)`);
  const m = re.exec(text);
  if (!m) return defaultVal;
  return m[1] === 'true';
}

function hasIndexOnField(content: string, fieldName: string): boolean {
  const indexRe = new RegExp(`#\\[ORM\\\\Index[^\\]]{0,300}${fieldName}[^\\]]{0,200}\\]|#\\[ORM\\\\UniqueConstraint[^\\]]{0,300}${fieldName}[^\\]]{0,200}\\]`);
  return indexRe.test(content);
}

function buildGedmoSluggableInfos(appPath: string): GedmoSluggableInfo[] {
  const results: GedmoSluggableInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasSlug = content.includes('Gedmo\\Slug') || content.includes('@Slug');
    if (!hasSlug) continue;

    const relFile = path.relative(appPath, file);
    const entity = extractEntityName(content, file);

    const slugAttrRe = /#\[Gedmo\\Slug\s*\(([^)]{0,600})\)\][^;]{0,300}(?:private|protected|public)\s+[^\s$]+\s+\$([a-zA-Z_][a-zA-Z0-9_]{0,100})/g;
    let sm: RegExpExecArray | null;
    while ((sm = slugAttrRe.exec(content)) !== null) {
      const attrArgs = sm[1];
      const slugFieldName = sm[2];
      const issues: string[] = [];

      const sourceFields = extractSourceFields(attrArgs);
      const unique = extractBoolAttr(attrArgs, 'unique', true);
      const updatable = extractBoolAttr(attrArgs, 'updatable', true);

      if (!unique) {
        issues.push(`Slug field "${slugFieldName}" in "${entity}" has unique: false — duplicate slugs possible; add custom uniqueness handling or set unique: true`);
      }

      if (updatable) {
        issues.push(`Slug field "${slugFieldName}" in "${entity}" has updatable: true (default) — slug changes when source field changes; if slug is used in URLs this breaks bookmarks/external links; set updatable: false for permalink stability`);
      }

      const hasIndex = hasIndexOnField(content, slugFieldName) || content.includes(`'${slugFieldName}'`) && content.includes('index');
      if (!hasIndex && unique) {
        issues.push(`Slug field "${slugFieldName}" in "${entity}" with unique: true but no explicit @ORM\\Index — Doctrine adds unique constraint but explicit index aids lookup performance; add #[ORM\\UniqueConstraint(fields: ['${slugFieldName}'])]`);
      }

      if (content.includes('#[Gedmo\\SlugHandler')) {
        const handlerRe = /#\[Gedmo\\SlugHandler\s*\([^)]{0,300}\)\]/g;
        let hm: RegExpExecArray | null;
        while ((hm = handlerRe.exec(content)) !== null) {
          const handlerText = hm[0];
          if (handlerText.includes('UniqueActiveSlugHandler') || handlerText.includes('TreeSlugHandler') || handlerText.includes('RelativeSlugHandler')) {
            issues.push(`SlugHandler detected on "${entity}.${slugFieldName}" — ensure handler class is registered as service; check handler-specific requirements`);
          }
        }
      }

      results.push({ file: relFile, entity, slugField: slugFieldName, sourceFields, unique, updatable, issues });
    }

    const annotSlugRe = /@Slug\s*\(\s*fields\s*=\s*\{([^}]{0,300})\}([^)]{0,300})\)/g;
    let as: RegExpExecArray | null;
    while ((as = annotSlugRe.exec(content)) !== null) {
      const fieldStr = as[1];
      const rest = as[2];
      const sourceFields = fieldStr.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
      const uniqueMatch = /unique\s*=\s*(true|false)/.exec(rest);
      const unique = uniqueMatch ? uniqueMatch[1] === 'true' : true;
      const updatableMatch = /updatable\s*=\s*(true|false)/.exec(rest);
      const updatable = updatableMatch ? updatableMatch[1] === 'true' : true;
      const issues: string[] = [];
      if (!unique) {
        issues.push(`@Slug in "${entity}" has unique=false — duplicate slugs possible`);
      }
      if (updatable) {
        issues.push(`@Slug in "${entity}" has updatable=true — slug changes break existing URLs`);
      }
      results.push({ file: relFile, entity, slugField: 'slug', sourceFields, unique, updatable, issues });
    }
  }

  return results;
}

export function listDoctrineGedmoSluggable(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoSluggableInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Gedmo Sluggable entities found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Gedmo Sluggable Analysis\n${'='.repeat(55)}\n\nSlugs: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.entity}.${info.slugField}  (${info.file})\n`;
      text += `    source: [${info.sourceFields.join(', ')}]  unique: ${info.unique}  updatable: ${info.updatable}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoSluggableStats(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoSluggableInfos(appPath);
    let text = `Gedmo Sluggable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Slug fields:    ${infos.length}\n`;
    text += `Unique:         ${infos.filter((i) => i.unique).length}\n`;
    text += `Non-unique:     ${infos.filter((i) => !i.unique).length}\n`;
    text += `Updatable:      ${infos.filter((i) => i.updatable).length}\n`;
    text += `Non-updatable:  ${infos.filter((i) => !i.updatable).length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoSluggableTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_gedmo_sluggable',
      description: 'Scan PHP entities for Gedmo Sluggable extension; detects #[Gedmo\\Slug] fields with source fields, unique/updatable flags; warns on unique: false (duplicate slugs), updatable: true (URL breakage), missing database index, SlugHandler usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_gedmo_sluggable_stats',
      description: 'Statistics for Gedmo Sluggable: slug count, unique/non-unique split, updatable/non-updatable split, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
