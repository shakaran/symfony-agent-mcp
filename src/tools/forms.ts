// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form Type Analyzer
 *
 * Parses Form type classes from src/Form/ to extract:
 *   - Field names, types, and options
 *   - Constraints and validation rules
 *   - Form hierarchy (parent type, data class)
 *   - Available form types and their files
 *
 * Uses static regex analysis of PHP source — no PHP execution required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FormField {
  name: string;
  type: string;
  options: Record<string, string>;
  constraints: string[];
  required: boolean;
}

interface FormType {
  name: string;
  file: string;
  namespace: string;
  dataClass?: string;
  parentType?: string;
  fields: FormField[];
  fieldCount: number;
}

// ─── PHP form parsing ──────────────────────────────────────────────────────

function parseFormFile(content: string, filePath: string): FormType | null {
  // Must extend AbstractType or implement FormTypeInterface
  const isFormType =
    /extends\s+AbstractType/.test(content) ||
    /implements\s+FormTypeInterface/.test(content) ||
    /extends\s+AbstractTypeExtension/.test(content);

  if (!isFormType) return null;

  const classMatch = /class\s+(\w+)/.exec(content);
  if (!classMatch) return null;

  const name = classMatch[1];
  const nsMatch = /namespace\s+([\w\\]+)\s*;/.exec(content);
  const namespace = nsMatch ? nsMatch[1] : '';

  // Extract data_class from configureOptions
  const dataClassMatch = /['"]data_class['"]\s*=>\s*([^,\]]+)/.exec(content);
  let dataClass: string | undefined;
  if (dataClassMatch) {
    const raw = dataClassMatch[1].trim();
    // Strip ::class, quotes
    dataClass = raw.replace(/::class$/, '').replace(/['"]/g, '').split('\\').pop();
  }

  // Extract parent type from getParent()
  const parentMatch = /function\s+getParent\s*\(\s*\)[^{]*\{[^}]*return\s+([^;]+);/.exec(content);
  let parentType: string | undefined;
  if (parentMatch) {
    parentType = parentMatch[1].trim().replace(/::class$/, '').replace(/['"]/g, '').split('\\').pop();
  }

  const fields = parseFormFields(content);

  return {
    name,
    file: path.basename(filePath),
    namespace: namespace ? `${namespace}\\${name}` : name,
    dataClass,
    parentType,
    fields,
    fieldCount: fields.length,
  };
}

function parseFormFields(content: string): FormField[] {
  const fields: FormField[] = [];

  // Extract the buildForm() method body
  const buildFormMatch = /function\s+buildForm\s*\([^)]+\)\s*\{([\s\S]*?)(?=\n {4}\}|\n\})/m.exec(content);
  if (!buildFormMatch) return fields;

  const methodBody = buildFormMatch[1];

  // Match ->add('fieldName', TypeClass::class, [...]) patterns
  // Handles multi-line definitions
  const addPattern = /->add\(\s*['"](\w+)['"]\s*(?:,\s*([\w\\:]+(?:::class)?)\s*)?(?:,\s*\[([\s\S]*?)\])?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = addPattern.exec(methodBody)) !== null) {
    const fieldName = match[1];
    const rawType = match[2] ?? '';
    const optionsBlock = match[3] ?? '';

    const fieldType = extractFieldType(rawType);
    const options = parseFieldOptions(optionsBlock);
    const constraints = extractConstraints(optionsBlock);
    const required = !optionsBlock.includes("'required' => false") &&
      !optionsBlock.includes('"required" => false') &&
      !optionsBlock.includes("'required'=>false");

    fields.push({ name: fieldName, type: fieldType, options, constraints, required });
  }

  return fields;
}

function extractFieldType(raw: string): string {
  if (!raw) return 'TextType';
  // Strip namespace and ::class suffix
  return raw.replace(/::class$/, '').split('\\').pop() ?? raw;
}

function parseFieldOptions(optionsBlock: string): Record<string, string> {
  const options: Record<string, string> = {};
  if (!optionsBlock) return options;

  // Match 'key' => value or "key" => value pairs (simple values only)
  const optPattern = /['"](\w+)['"]\s*=>\s*(?!'constraints')([^,[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = optPattern.exec(optionsBlock)) !== null) {
    const key = m[1];
    if (key === 'constraints') continue; // Handled separately
    options[key] = m[2].trim().replace(/['"]/g, '');
  }
  return options;
}

function extractConstraints(optionsBlock: string): string[] {
  const constraints: string[] = [];
  if (!optionsBlock) return constraints;

  // Find constraints array content
  const constraintsMatch = /['"]constraints['"]\s*=>\s*\[([\s\S]*?)\]/s.exec(optionsBlock);
  if (!constraintsMatch) return constraints;

  // Extract constraint class names: new NotBlank(), new Length(...)
  const constraintPattern = /new\s+([\w\\]+)\s*[({]/g;
  let m: RegExpExecArray | null;
  while ((m = constraintPattern.exec(constraintsMatch[1])) !== null) {
    const cn = m[1].split('\\').pop() ?? m[1];
    constraints.push(cn);
  }

  return constraints;
}


function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch {
    // Skip
  }
  return files;
}

function loadFormTypes(appPath: string): FormType[] {
  const formDir = path.join(appPath, 'src', 'Form');
  if (!fs.existsSync(formDir)) return [];

  const types: FormType[] = [];
  for (const file of getAllPhpFiles(formDir)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const ft = parseFormFile(content, file);
      if (ft) types.push(ft);
    } catch {
      // Skip
    }
  }
  return types;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listFormTypes(appPath: string): McpToolResult {
  try {
    const forms = loadFormTypes(appPath);

    if (forms.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Form types found in src/Form/.\n\nCreate a form with: php bin/console make:form',
        }],
      };
    }

    let text = `Symfony Form Types (${forms.length}):\n${'─'.repeat(60)}\n\n`;
    for (const form of forms) {
      text += `  ${form.name}`;
      if (form.dataClass) text += `  → ${form.dataClass}`;
      text += `\n`;
      text += `    Fields: ${form.fieldCount}  |  File: ${form.file}\n`;
      if (form.parentType && form.parentType !== 'FormType') {
        text += `    Extends: ${form.parentType}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing form types: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormTypeDetails(appPath: string, formName: string): McpToolResult {
  try {
    const forms = loadFormTypes(appPath);
    const form = forms.find(
      (f) => f.name.toLowerCase() === formName.toLowerCase() ||
        f.name.toLowerCase().replace(/type$/, '') === formName.toLowerCase()
    );

    if (!form) {
      const names = forms.map((f) => f.name).join(', ');
      const hint = names ? `\n\nAvailable forms: ${names}` : '\n\nNo forms found in src/Form/.';
      return {
        content: [{ type: 'text', text: `Form type "${formName}" not found.${hint}` }],
        isError: true,
      };
    }

    let text = `Form Type: ${form.name}\n${'='.repeat(50)}\n\n`;
    text += `File:      ${form.file}\n`;
    text += `Namespace: ${form.namespace}\n`;
    if (form.dataClass) text += `Data class: ${form.dataClass}\n`;
    if (form.parentType) text += `Parent:    ${form.parentType}\n`;
    text += `Fields:    ${form.fieldCount}\n`;

    if (form.fields.length > 0) {
      text += `\nFields:\n${'─'.repeat(50)}\n`;
      for (const field of form.fields) {
        text += `\n  ${field.name}  (${field.type})`;
        text += field.required ? '  [required]' : '  [optional]';
        text += '\n';

        if (Object.keys(field.options).length > 0) {
          const optStr = Object.entries(field.options)
            .filter(([k]) => k !== 'required')
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          if (optStr) text += `    Options: ${optStr}\n`;
        }

        if (field.constraints.length > 0) {
          text += `    Constraints: ${field.constraints.join(', ')}\n`;
        }
      }
    } else {
      text += '\nNo fields detected (buildForm() could not be parsed statically).';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error getting form details: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function searchFormTypes(appPath: string, query: string): McpToolResult {
  try {
    const forms = loadFormTypes(appPath);
    const lq = query.toLowerCase();
    const matches = forms.filter(
      (f) =>
        f.name.toLowerCase().includes(lq) ||
        (f.dataClass ?? '').toLowerCase().includes(lq) ||
        f.fields.some((field) => field.name.toLowerCase().includes(lq) || field.type.toLowerCase().includes(lq))
    );

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No form types matching "${query}" found.` }] };
    }

    let text = `Form types matching "${query}" (${matches.length}):\n\n`;
    for (const f of matches) {
      const matchedFields = f.fields.filter(
        (field) => field.name.toLowerCase().includes(lq) || field.type.toLowerCase().includes(lq)
      );
      text += `  ${f.name}`;
      if (f.dataClass) text += ` → ${f.dataClass}`;
      text += `  (${f.fieldCount} fields)\n`;
      if (matchedFields.length > 0 && matchedFields.length < f.fieldCount) {
        text += `    Matching fields: ${matchedFields.map((field) => field.name).join(', ')}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error searching forms: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormStats(appPath: string): McpToolResult {
  try {
    const forms = loadFormTypes(appPath);

    if (forms.length === 0) {
      return {
        content: [{ type: 'text', text: 'No form types found in src/Form/.' }],
      };
    }

    const totalFields = forms.reduce((sum, f) => sum + f.fieldCount, 0);
    const fieldTypeCounts: Record<string, number> = {};
    const constraintCounts: Record<string, number> = {};

    for (const form of forms) {
      for (const field of form.fields) {
        fieldTypeCounts[field.type] = (fieldTypeCounts[field.type] ?? 0) + 1;
        for (const constraint of field.constraints) {
          constraintCounts[constraint] = (constraintCounts[constraint] ?? 0) + 1;
        }
      }
    }

    const topTypes = Object.entries(fieldTypeCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([type, count]) => `    ${type.padEnd(30)} ${count}x`).join('\n');

    const topConstraints = Object.entries(constraintCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([name, count]) => `    ${name.padEnd(30)} ${count}x`).join('\n');

    let text = `Form Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total form types:  ${forms.length}\n`;
    text += `Total fields:      ${totalFields}\n`;
    text += `Avg fields/form:   ${(totalFields / forms.length).toFixed(1)}\n`;
    text += `Forms with data:   ${forms.filter((f) => f.dataClass).length}\n`;
    text += `\nTop field types:\n${topTypes || '    (none)'}\n`;
    if (topConstraints) {
      text += `\nTop constraints:\n${topConstraints}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error getting form stats: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getFormTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'list_form_types',
      description: 'List all Symfony Form types in src/Form/ with their data class, field count, and file location',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_form_type_details',
      description: 'Get detailed info for a form type: all fields with their types, options, constraints, and required status',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          form_name: { type: 'string', description: 'Form type class name (e.g. UserType or User)' },
        },
        required: ['app_path', 'form_name'],
      },
    },
    {
      name: 'search_form_types',
      description: 'Search form types by name, data class, or field name/type',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Search query' },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'get_form_stats',
      description: 'Get statistics about form types: total forms, total fields, most-used field types and constraints',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
