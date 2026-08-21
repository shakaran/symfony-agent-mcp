/**
 * Symfony Form Data Class Inspector
 *
 * Scans src/ PHP for AbstractType subclasses:
 *   - configureOptions() with data_class, empty_data
 *   - mapped: false fields (via buildForm addOption patterns)
 *
 * Detects:
 *   - data_class pointing to Doctrine entity vs DTO class
 *     (heuristic: entity has #[ORM\Entity] or @ORM\Entity)
 *
 * Warns about:
 *   - Form with entity data_class but no mapped: false fields (potential PropertyAccessException)
 *   - empty_data not set when data_class is set (Symfony throws if form submitted with null entity)
 *   - data_class entity directly modified in form (prefer DTO)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FormDataClassInfo {
  file: string;
  class?: string;
  dataClass?: string;
  isEntityDataClass: boolean;
  hasMappedFalseFields: boolean;
  hasEmptyData: boolean;
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

function isEntityClass(classFile: string): boolean {
  let content = '';
  try { content = fs.readFileSync(classFile, 'utf-8'); } catch { return false; }
  return content.includes('#[ORM\\Entity') || content.includes('@ORM\\Entity') ||
    content.includes('#[Entity') || /\[ORM\\Entity/.test(content);
}

function resolveClassFile(appPath: string, fqcn: string): string | null {
  // Convert FQCN to file path heuristic: App\Entity\User -> src/Entity/User.php
  const withoutApp = fqcn.replace(/^App\\/, '').replace(/\\/g, path.sep);
  const candidate = path.join(appPath, 'src', withoutApp + '.php');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* skip */ }
  return null;
}

function parseFormDataClassFile(filePath: string, appPath: string): FormDataClassInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isAbstractType = content.includes('extends AbstractType') ||
    content.includes('extends BaseType');
  if (!isAbstractType) return null;
  if (!content.includes('configureOptions')) return null;
  if (!content.includes('data_class')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const issues: string[] = [];

  // Extract data_class value
  const dcM = /['"]data_class['"]\s*=>\s*([^,\]]{1,200})/.exec(content);
  let dataClass: string | undefined;
  if (dcM) {
    const raw = dcM[1].trim();
    // Handle ::class notation
    const classNotation = /(\w{1,120})::class/.exec(raw);
    if (classNotation) {
      // Try to resolve from use statements
      const useM = new RegExp(`use\\s+([\\w\\\\]{1,200}${classNotation[1]});`).exec(content);
      dataClass = useM ? useM[1] : classNotation[1];
    } else {
      const strM = /['"]([^'"]{1,200})['"]/.exec(raw);
      dataClass = strM ? strM[1] : undefined;
    }
  }

  // Check if data_class is an entity
  let isEntityDataClass = false;
  if (dataClass) {
    const classFile = resolveClassFile(appPath, dataClass);
    if (classFile) {
      isEntityDataClass = isEntityClass(classFile);
    } else {
      // Heuristic: if class is in Entity namespace
      isEntityDataClass = dataClass.includes('\\Entity\\') || dataClass.includes('/Entity/');
    }
  }

  // Check for mapped: false fields
  const hasMappedFalseFields = /['"]mapped['"]\s*=>\s*false/.test(content);

  // Check for empty_data
  const hasEmptyData = content.includes('empty_data');

  // Generate issues
  if (dataClass && !hasEmptyData) {
    issues.push('data_class set but empty_data not configured — Symfony throws if form submitted with null entity');
  }
  if (isEntityDataClass) {
    issues.push(`data_class points to entity "${dataClass}" — prefer using a DTO to avoid coupling form to persistence layer`);
    if (!hasMappedFalseFields) {
      issues.push('Entity data_class without any mapped:false fields — all form fields must match entity properties or PropertyAccessException will be thrown');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    dataClass,
    isEntityDataClass,
    hasMappedFalseFields,
    hasEmptyData,
    issues,
  };
}

function loadFormDataClassInfos(appPath: string): FormDataClassInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FormDataClassInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseFormDataClassFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listFormDataClass(appPath: string): McpToolResult {
  try {
    const infos = loadFormDataClassInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No form types with data_class found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Form data_class Inspector (${infos.length} forms)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      text += '\n';
      if (info.dataClass) {
        const entityTag = info.isEntityDataClass ? ' [entity]' : ' [DTO]';
        text += `    data_class: ${info.dataClass}${entityTag}\n`;
      }
      const flags = [
        info.hasMappedFalseFields ? 'has-mapped-false' : '',
        info.hasEmptyData ? 'has-empty_data' : '',
      ].filter(Boolean).join(', ');
      if (flags) text += `    flags: [${flags}]\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormDataClassStats(appPath: string): McpToolResult {
  try {
    const infos = loadFormDataClassInfos(appPath);

    let text = `Form data_class Statistics\n${'='.repeat(40)}\n\n`;
    text += `Forms with data_class:      ${infos.length}\n`;
    text += `  Entity data_class:        ${infos.filter((i) => i.isEntityDataClass).length}\n`;
    text += `  DTO data_class:           ${infos.filter((i) => !i.isEntityDataClass && !!i.dataClass).length}\n`;
    text += `  With empty_data:          ${infos.filter((i) => i.hasEmptyData).length}\n`;
    text += `  With mapped:false fields: ${infos.filter((i) => i.hasMappedFalseFields).length}\n`;
    text += `Issues:                     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormDataClassTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_data_class',
      description: 'List Symfony form types with data_class: detects entity vs DTO data classes, missing empty_data, mapped:false fields; warns about entity data_class coupling and PropertyAccessException risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_data_class_stats',
      description: 'Show form data_class statistics: total forms, entity vs DTO data classes, empty_data coverage, mapped:false field usage, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
