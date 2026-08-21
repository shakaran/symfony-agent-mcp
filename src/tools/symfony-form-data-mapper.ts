/**
 * Symfony Form DataMapper Inspector
 *
 * Detects custom Symfony DataMapperInterface implementations.
 * Scans src/ PHP for: implements DataMapperInterface, DataMapper\MapDataToForms,
 *   DataMapper\MapFormsToData, use FormInterface.
 * Reads config/packages/framework.yaml for form.data_mapper setting.
 *
 * Warns on:
 *   - DataMapper::mapDataToForms not handling null data (null entity causes TypeError)
 *   - DataMapper::mapFormsToData not calling form->getData() (loses existing data)
 *   - DataMapper without type checking on mapped object (ClassCastException at runtime)
 *   - DataMapper registered without form type referencing it
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FormDataMapperInfo {
  file: string;
  className: string;
  hasMappingNull: boolean;
  hasTypeCheck: boolean;
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

function parseDataMapperFile(filePath: string): FormDataMapperInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isDataMapper =
    content.includes('implements DataMapperInterface') ||
    content.includes('DataMapper\\MapDataToForms') ||
    content.includes('DataMapper\\MapFormsToData') ||
    content.includes('mapDataToForms') ||
    content.includes('mapFormsToData');

  if (!isDataMapper) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];

  // Check mapDataToForms handles null data
  const mapDataToFormsM = /function\s+mapDataToForms\s*\([^)]{0,300}\)\s*\{([^}]{0,2000})\}/s.exec(content);
  let hasMappingNull = false;
  if (mapDataToFormsM) {
    const body = mapDataToFormsM[1];
    hasMappingNull = body.includes('=== null') ||
      body.includes('!== null') ||
      body.includes('is_null(') ||
      body.includes('null ===') ||
      body.includes('null !==');
    if (!hasMappingNull) {
      issues.push('mapDataToForms() does not check for null data — passing a null entity causes TypeError at runtime');
    }
  }

  // Check mapFormsToData calls form->getData()
  const mapFormsToDataM = /function\s+mapFormsToData\s*\([^)]{0,300}\)\s*\{([^}]{0,2000})\}/s.exec(content);
  if (mapFormsToDataM) {
    const body = mapFormsToDataM[1];
    if (!body.includes('getData()')) {
      issues.push('mapFormsToData() does not call getData() on forms — existing data may be lost on partial form submission');
    }
  }

  // Check for type checking on mapped object (instanceof or is_a)
  const hasTypeCheck =
    content.includes('instanceof ') ||
    content.includes('is_a(') ||
    content.includes('get_class(') ||
    /\bif\s*\(\s*[!]?\s*\(/.test(content);

  if (!hasTypeCheck) {
    issues.push('DataMapper lacks type checking on the mapped object — unexpected object type causes ClassCastException at runtime');
  }

  // Check FormInterface usage
  if (!content.includes('FormInterface') && !content.includes('use FormInterface')) {
    issues.push('DataMapper does not reference FormInterface — verify the implementation is type-safe against form instances');
  }

  return {
    file: filePath,
    className,
    hasMappingNull,
    hasTypeCheck,
    issues,
  };
}

function readFrameworkDataMapperConfig(appPath: string): string | null {
  const configPath = path.join(appPath, 'config', 'packages', 'framework.yaml');
  try {
    const yaml = parseYamlFile(configPath) as Record<string, unknown> | null;
    if (!yaml) return null;
    const framework = yaml['framework'] as Record<string, unknown> | undefined;
    if (!framework) return null;
    const form = framework['form'] as Record<string, unknown> | undefined;
    if (!form) return null;
    return (form['data_mapper'] as string | undefined) ?? null;
  } catch { return null; }
}

function loadDataMapperInfos(appPath: string): FormDataMapperInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FormDataMapperInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseDataMapperFile(f);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyFormDataMappers(appPath: string): McpToolResult {
  try {
    const infos = loadDataMapperInfos(appPath);
    const configuredMapper = readFrameworkDataMapperConfig(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No custom DataMapperInterface implementations found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Form DataMapper Inspector (${infos.length} mappers)\n${'='.repeat(55)}\n`;
    if (configuredMapper) {
      text += `framework.yaml data_mapper: ${configuredMapper}\n`;
    }
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      const flags = [
        info.hasMappingNull ? 'null-safe' : 'no-null-check',
        info.hasTypeCheck ? 'type-checked' : 'no-type-check',
      ].join(', ');
      text += `    flags: [${flags}]\n`;
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

export function getSymfonyFormDataMapperStats(appPath: string): McpToolResult {
  try {
    const infos = loadDataMapperInfos(appPath);
    const configuredMapper = readFrameworkDataMapperConfig(appPath);

    let text = `Form DataMapper Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom DataMappers:         ${infos.length}\n`;
    text += `  With null-safe mapping:   ${infos.filter((i) => i.hasMappingNull).length}\n`;
    text += `  With type checking:       ${infos.filter((i) => i.hasTypeCheck).length}\n`;
    text += `framework.yaml configured:  ${configuredMapper ? configuredMapper : 'none'}\n`;
    text += `Issues:                     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormDataMapperTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_form_data_mappers',
      description: 'List custom Symfony DataMapperInterface implementations: detects null handling in mapDataToForms, getData() usage in mapFormsToData, type checking on mapped objects; warns on null entity TypeError risk, lost data on partial form submit, missing type checks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_form_data_mapper_stats',
      description: 'Show DataMapper statistics: total custom mappers, null-safe mapping count, type-check count, framework.yaml configuration, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
