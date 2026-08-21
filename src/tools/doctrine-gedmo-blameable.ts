import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GedmoBlameableInfo {
  file: string;
  entity: string;
  extension: 'blameable' | 'loggable' | 'timestampable';
  fields: string[];
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function extractFieldNamesAfterAttr(content: string, attrPattern: RegExp): string[] {
  const fields: string[] = [];
  const attrRe = new RegExp(attrPattern.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(content)) !== null) {
    const after = content.substring(m.index + m[0].length, m.index + m[0].length + 300);
    const fieldMatch = /(?:private|protected|public)\s+[^\s$]+\s+\$([a-zA-Z_][a-zA-Z0-9_]{0,100})/.exec(after);
    if (fieldMatch && !fields.includes(fieldMatch[1])) fields.push(fieldMatch[1]);
  }
  return fields;
}

function buildGedmoBlameableInfos(appPath: string): GedmoBlameableInfo[] {
  const results: GedmoBlameableInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasBlameable = content.includes('Gedmo\\Blameable') || content.includes('@Blameable');
    const hasLoggable = content.includes('Gedmo\\Loggable') || content.includes('@Loggable') || content.includes('#[Gedmo\\Loggable');
    const hasTimestampable = content.includes('Gedmo\\Timestampable') || content.includes('@Timestampable');

    if (!hasBlameable && !hasLoggable && !hasTimestampable) continue;

    const relFile = path.relative(appPath, file);
    const entity = extractEntityName(content, file);

    if (hasBlameable) {
      const issues: string[] = [];
      const blameFields = extractFieldNamesAfterAttr(content, /#\[Gedmo\\Blameable\s*\([^)]{0,300}\)\]/);

      const changeOnRe = /#\[Gedmo\\Blameable\s*\(\s*on\s*:\s*["']change["'][^)]{0,300}\)\]/g;
      let cm: RegExpExecArray | null;
      while ((cm = changeOnRe.exec(content)) !== null) {
        const attrText = cm[0];
        const hasField = /field\s*:/.test(attrText) || /fields\s*:/.test(attrText);
        if (!hasField) {
          issues.push(`#[Gedmo\\Blameable(on: 'change')] in "${entity}" missing field: parameter — Gedmo requires field: to know which field change to track; e.g. on: 'change', field: 'status'`);
        }
      }

      const annotChangeRe = /@Blameable\s*\(\s*on\s*=\s*["']change["'][^)]{0,300}\)/g;
      let acm: RegExpExecArray | null;
      while ((acm = annotChangeRe.exec(content)) !== null) {
        const attrText = acm[0];
        const hasField = /field\s*=/.test(attrText) || /fields\s*=/.test(attrText);
        if (!hasField) {
          issues.push(`@Blameable(on="change") in "${entity}" missing field= parameter`);
        }
      }

      const blameFieldTypeRe = /(?:private|protected|public)\s+(int|float|bool|array)\s+\$([a-zA-Z_][a-zA-Z0-9_]{0,100})/g;
      let tfm: RegExpExecArray | null;
      while ((tfm = blameFieldTypeRe.exec(content)) !== null) {
        if (blameFields.includes(tfm[2]) && !['string', 'mixed'].includes(tfm[1])) {
          issues.push(`Blameable field "${tfm[2]}" in "${entity}" has type ${tfm[1]} — blameable field should be string (username) or a User entity relation`);
        }
      }

      results.push({ file: relFile, entity, extension: 'blameable', fields: blameFields, issues });
    }

    if (hasLoggable) {
      const issues: string[] = [];
      const isLogEntry = content.includes('AbstractLogEntry') || content.includes('LogEntry');

      if (!isLogEntry) {
        const versionedFields = extractFieldNamesAfterAttr(content, /#\[Gedmo\\Versioned\]/);
        const annotVersionedFields = extractFieldNamesAfterAttr(content, /@Versioned\b/);
        const allVersionedFields = [...new Set([...versionedFields, ...annotVersionedFields])];

        if (allVersionedFields.length > 10) {
          issues.push(`Entity "${entity}" has ${allVersionedFields.length} #[Gedmo\\Versioned] fields — many versioned fields creates many log entries per change; consider reducing tracked fields`);
        }

        const hasCustomLogEntry = content.includes('logEntryClass') || content.includes('log_entry_class');
        if (!hasCustomLogEntry) {
          issues.push(`Loggable entity "${entity}" does not specify a custom log entry class — Gedmo uses a generic LogEntry entity; for better namespacing and queries, create a dedicated log entry class`);
        }

        results.push({ file: relFile, entity, extension: 'loggable', fields: allVersionedFields, issues });
      }
    }

    if (hasTimestampable) {
      const issues: string[] = [];
      const tsFields = extractFieldNamesAfterAttr(content, /#\[Gedmo\\Timestampable\s*\([^)]{0,300}\)\]/);

      const changeOnRe = /#\[Gedmo\\Timestampable\s*\(\s*on\s*:\s*["']change["'][^)]{0,300}\)\]/g;
      let tcm: RegExpExecArray | null;
      while ((tcm = changeOnRe.exec(content)) !== null) {
        const attrText = tcm[0];
        const hasField = /field\s*:/.test(attrText) || /fields\s*:/.test(attrText);
        if (!hasField) {
          issues.push(`#[Gedmo\\Timestampable(on: 'change')] in "${entity}" missing field: parameter — specify which field change triggers the timestamp update`);
        }
      }

      const annotTsChangeRe = /@Timestampable\s*\(\s*on\s*=\s*["']change["'][^)]{0,300}\)/g;
      let atcm: RegExpExecArray | null;
      while ((atcm = annotTsChangeRe.exec(content)) !== null) {
        const attrText = atcm[0];
        const hasField = /field\s*=/.test(attrText) || /fields\s*=/.test(attrText);
        if (!hasField) {
          issues.push(`@Timestampable(on="change") in "${entity}" missing field= parameter`);
        }
      }

      results.push({ file: relFile, entity, extension: 'timestampable', fields: tsFields, issues });
    }
  }

  return results;
}

export function listDoctrineGedmoBlameable(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoBlameableInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Gedmo Blameable/Loggable/Timestampable entities found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Gedmo Blameable/Loggable/Timestampable Analysis\n${'='.repeat(55)}\n\nEntities: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.extension.toUpperCase()}] ${info.entity}  (${info.file})\n`;
      if (info.fields.length) text += `    fields: ${info.fields.join(', ')}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoBlameableStats(appPath: string): McpToolResult {
  try {
    const infos = buildGedmoBlameableInfos(appPath);
    let text = `Gedmo Blameable/Loggable/Timestampable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Blameable:     ${infos.filter((i) => i.extension === 'blameable').length}\n`;
    text += `Loggable:      ${infos.filter((i) => i.extension === 'loggable').length}\n`;
    text += `Timestampable: ${infos.filter((i) => i.extension === 'timestampable').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineGedmoBlameableTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_gedmo_blameable',
      description: 'Scan PHP entities for Gedmo Blameable (on: change missing field, non-string field type), Loggable (too many Versioned fields, missing custom log entry class), and Timestampable (on: change missing field) extensions',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_gedmo_blameable_stats',
      description: 'Statistics for Gedmo extensions: blameable/loggable/timestampable entity count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
