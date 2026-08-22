/**
 * Symfony Form CollectionType Inspector
 *
 * Scans src/ PHP files for CollectionType usage in buildForm():
 *   - allow_add, allow_delete, entry_type, prototype_name, delete_empty options
 *   - ResizeFormListener usage
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CollectionItem {
  formClass: string;
  entryType: string | null;
  hasAllowAdd: boolean;
  hasAllowDelete: boolean;
  hasDeleteEmpty: boolean;
  hasPrototypeName: boolean;
  options: string[];
  issues: string[];
}

interface FormCollectionInfo {
  file: string;
  class: string;
  count: number;
  items: CollectionItem[];
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

function extractClassFromContent(content: string): string | null {
  const m = /class\s+(\w{1,120})\b/.exec(content);
  return m ? m[1] : null;
}

function analyzeCollectionType(content: string, className: string): CollectionItem[] {
  const items: CollectionItem[] = [];

  // Find each CollectionType add() call block
  const addCallPattern = /->add\s*\(\s*['"](\w{1,120})['"]\s*,\s*\\?(?:\w+\\){0,10}CollectionType::class([^;]{0,800})/g;
  let m: RegExpExecArray | null;

  while ((m = addCallPattern.exec(content)) !== null) {
    const fieldName = m[1];
    const optionsBlock = m[2];

    const hasAllowAdd = /allow_add\s*=>\s*true/.test(optionsBlock);
    const hasAllowDelete = /allow_delete\s*=>\s*true/.test(optionsBlock);
    const hasDeleteEmpty = /delete_empty/.test(optionsBlock);
    const hasPrototypeName = /prototype_name/.test(optionsBlock);

    const entryTypeMatch = /entry_type\s*=>\s*([^\s,\]]{1,120})/.exec(optionsBlock);
    const entryType = entryTypeMatch ? entryTypeMatch[1].replace(/::class$/, '').split('\\').pop() ?? null : null;

    const optionsList: string[] = [];
    if (hasAllowAdd) optionsList.push('allow_add');
    if (hasAllowDelete) optionsList.push('allow_delete');
    if (hasDeleteEmpty) optionsList.push('delete_empty');
    if (hasPrototypeName) optionsList.push('prototype_name');
    if (entryType) optionsList.push(`entry_type:${entryType}`);

    const issues: string[] = [];
    if (hasAllowAdd && !hasAllowDelete) {
      issues.push(`Field "${fieldName}": allow_add=true but allow_delete is missing (collection may grow without removal)`);
    }
    if (!hasDeleteEmpty && hasAllowDelete) {
      issues.push(`Field "${fieldName}": allow_delete=true but delete_empty callback not set (orphan objects risk)`);
    }
    if (!hasPrototypeName) {
      issues.push(`Field "${fieldName}": prototype_name not set (JS prototype handling harder, default "__name__" used)`);
    }
    if (!entryType) {
      issues.push(`Field "${fieldName}": entry_type not specified (CollectionType requires entry_type)`);
    }

    items.push({
      formClass: className,
      entryType,
      hasAllowAdd,
      hasAllowDelete,
      hasDeleteEmpty,
      hasPrototypeName,
      options: optionsList,
      issues,
    });
  }

  return items;
}

function scanFormCollections(appPath: string): FormCollectionInfo[] {
  const results: FormCollectionInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const files = getAllPhpFiles(srcDir);

  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('CollectionType')) continue;

    const className = extractClassFromContent(content) ?? path.basename(file, '.php');
    const items = analyzeCollectionType(content, className);

    if (items.length === 0) continue;

    const hasResizeListener = content.includes('ResizeFormListener');
    const fileIssues: string[] = [];

    if (hasResizeListener) {
      fileIssues.push('ResizeFormListener detected — ensure it is used intentionally (replaces allow_add/allow_delete behavior)');
    }

    const allItemIssues = items.flatMap(i => i.issues);
    fileIssues.push(...allItemIssues.filter((v, idx, arr) => arr.indexOf(v) === idx));

    results.push({
      file: path.relative(appPath, file),
      class: className,
      count: items.length,
      items,
      issues: fileIssues,
    });
  }

  return results;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFormCollectionTypes(appPath: string): McpToolResult {
  try {
    const collections = scanFormCollections(appPath);

    if (collections.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No CollectionType usages found in src/.\n\nCollectionType allows embedding collections of forms.\nExample:\n  $builder->add(\'items\', CollectionType::class, [\n      \'entry_type\' => ItemType::class,\n      \'allow_add\' => true,\n      \'allow_delete\' => true,\n      \'prototype_name\' => \'__item__\',\n      \'delete_empty\' => true,\n  ]);',
        }],
      };
    }

    const totalIssues = collections.reduce((s, c) => s + c.issues.length, 0);
    let text = `Form CollectionType Usages\n${'='.repeat(50)}\n`;
    text += `Total files: ${collections.length}  |  Total collections: ${collections.reduce((s, c) => s + c.count, 0)}  |  Issues: ${totalIssues}\n`;

    for (const info of collections) {
      text += `\n${info.file}  (${info.class})\n`;
      for (const item of info.items) {
        text += `  CollectionType\n`;
        text += `    entry_type:     ${item.entryType ?? '(not set)'}\n`;
        text += `    allow_add:      ${item.hasAllowAdd}\n`;
        text += `    allow_delete:   ${item.hasAllowDelete}\n`;
        text += `    delete_empty:   ${item.hasDeleteEmpty}\n`;
        text += `    prototype_name: ${item.hasPrototypeName}\n`;
        if (item.issues.length > 0) {
          text += `    Issues:\n`;
          for (const issue of item.issues) {
            text += `      ⚠ ${issue}\n`;
          }
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error scanning form collection types: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormCollectionStats(appPath: string): McpToolResult {
  try {
    const collections = scanFormCollections(appPath);

    const totalCollections = collections.reduce((s, c) => s + c.count, 0);
    const withAllowAdd = collections.flatMap(c => c.items).filter(i => i.hasAllowAdd).length;
    const withAllowDelete = collections.flatMap(c => c.items).filter(i => i.hasAllowDelete).length;
    const withDeleteEmpty = collections.flatMap(c => c.items).filter(i => i.hasDeleteEmpty).length;
    const withPrototypeName = collections.flatMap(c => c.items).filter(i => i.hasPrototypeName).length;
    const withEntryType = collections.flatMap(c => c.items).filter(i => i.entryType !== null).length;
    const totalIssues = collections.reduce((s, c) => s + c.issues.length, 0);

    const text = [
      'Form CollectionType Statistics',
      '='.repeat(45),
      `Files with CollectionType:  ${collections.length}`,
      `Total collection fields:    ${totalCollections}`,
      `With allow_add:             ${withAllowAdd}`,
      `With allow_delete:          ${withAllowDelete}`,
      `With delete_empty:          ${withDeleteEmpty}`,
      `With prototype_name:        ${withPrototypeName}`,
      `With entry_type:            ${withEntryType}`,
      `Total issues:               ${totalIssues}`,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error computing form collection stats: ${String(err)}` }],
      isError: true,
    };
  }
}

export function getFormCollectionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'list_form_collection_types',
      description: 'List all CollectionType usages in Symfony forms, including allow_add/allow_delete/entry_type options and configuration issues.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_form_collection_stats',
      description: 'Get statistics about CollectionType usage across the application.',
      inputSchema: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Absolute path to the Symfony application root' },
        },
        required: ['app_path'],
      },
    },
  ];
}
