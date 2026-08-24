// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form Type Guesser Inspector
 *
 * Scans src/ PHP for:
 *   - FormTypeGuesserInterface implementations
 *     (getTypeGuess, getRequiredGuess, getMaxLengthGuess, getPatternGuess)
 *   - DoctrineOrmTypeGuesser usage, ValidatorTypeGuesser
 *   - Form fields where type is NOT specified (null as second arg to add())
 *     — these rely on the type guesser
 *
 * Warns about:
 *   - Form field without explicit type relying on guesser (guessing can be wrong)
 *   - Custom TypeGuesser not tagged as form.type_guesser
 *   - TypeGuesser that always returns null (no-op)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FormTypeGuessInfo {
  file: string;
  class?: string;
  isGuesser: boolean;
  hasDoctrineGuesser: boolean;
  fieldsWithGuessedType: string[];
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

function parseFormTypeGuessFile(filePath: string, appPath: string): FormTypeGuessInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isGuesser = content.includes('FormTypeGuesserInterface') && content.includes('implements') &&
    /implements[^{]{0,300}FormTypeGuesserInterface/.test(content);

  const hasDoctrineGuesser = content.includes('DoctrineOrmTypeGuesser') ||
    content.includes('ValidatorTypeGuesser');

  const isAbstractType = content.includes('extends AbstractType') || content.includes('extends BaseType');

  if (!isGuesser && !hasDoctrineGuesser && !isAbstractType) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const issues: string[] = [];
  const fieldsWithGuessedType: string[] = [];

  // Find form fields without explicit type (null as second arg or only one arg to ->add())
  if (isAbstractType && content.includes('->add(')) {
    // Pattern: ->add('fieldName') with no second arg or ->add('fieldName', null, ...)
    const addNoTypePattern = /->add\s*\(\s*['"]([^'"]{1,100})['"]\s*(?:,\s*null\s*)?\)/g;
    let m: RegExpExecArray | null;
    while ((m = addNoTypePattern.exec(content)) !== null) {
      fieldsWithGuessedType.push(m[1]);
      issues.push(`Form field "${m[1]}" has no explicit type — relies on type guesser which may produce incorrect type`);
    }
    // Also catch ->add('field', null, [...options...])
    const addNullTypePattern = /->add\s*\(\s*['"]([^'"]{1,100})['"]\s*,\s*null\s*,\s*\[/g;
    while ((m = addNullTypePattern.exec(content)) !== null) {
      if (!fieldsWithGuessedType.includes(m[1])) {
        fieldsWithGuessedType.push(m[1]);
        issues.push(`Form field "${m[1]}" uses null type — explicitly relies on type guesser`);
      }
    }
  }

  // Check guesser implementation
  if (isGuesser) {
    const hasGetTypeGuess = content.includes('getTypeGuess');
    const returnsNull = /getTypeGuess[^{]{0,50}\{[^}]{0,200}return\s+null/.test(content);
    if (returnsNull) {
      issues.push('TypeGuesser.getTypeGuess() always returns null — guesser is a no-op, remove or implement it');
    }
    if (!hasGetTypeGuess) {
      issues.push('FormTypeGuesserInterface implemented but getTypeGuess() not found — incomplete implementation');
    }
    // Check if tagged as form.type_guesser — heuristic: look for tag in annotations or attributes
    const hasTag = content.includes('form.type_guesser') || content.includes('AutoconfigureTag') ||
      /AsTaggedItem\s*\(\s*['"]{0,1}form\.type_guesser/.test(content);
    if (!hasTag) {
      issues.push('Custom TypeGuesser not tagged as form.type_guesser — must be tagged in services.yaml or via #[AsTaggedItem]');
    }
  }

  if (!isGuesser && !hasDoctrineGuesser && fieldsWithGuessedType.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    isGuesser,
    hasDoctrineGuesser,
    fieldsWithGuessedType,
    issues,
  };
}

function loadFormTypeGuessInfos(appPath: string): FormTypeGuessInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FormTypeGuessInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseFormTypeGuessFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listFormTypeGuess(appPath: string): McpToolResult {
  try {
    const infos = loadFormTypeGuessInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No form type guesser usage found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Form Type Guesser Inspector (${infos.length} files)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    const guessers = infos.filter((i) => i.isGuesser);
    if (guessers.length > 0) {
      text += `\nCustom Type Guessers (${guessers.length}):\n`;
      for (const g of guessers) {
        text += `\n  ${g.file}`;
        if (g.class) text += `  [${g.class}]`;
        text += '\n';
        for (const issue of g.issues) text += `    WARN: ${issue}\n`;
      }
    }

    const withGuessedFields = infos.filter((i) => i.fieldsWithGuessedType.length > 0);
    if (withGuessedFields.length > 0) {
      text += `\nForm types with guessed fields (${withGuessedFields.length}):\n`;
      for (const info of withGuessedFields) {
        text += `\n  ${info.file}`;
        if (info.class) text += `  [${info.class}]`;
        text += '\n';
        text += `    guessed fields: ${info.fieldsWithGuessedType.join(', ')}\n`;
        for (const issue of info.issues) text += `    WARN: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormTypeGuessStats(appPath: string): McpToolResult {
  try {
    const infos = loadFormTypeGuessInfos(appPath);

    let text = `Form Type Guesser Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom TypeGuesser implementations: ${infos.filter((i) => i.isGuesser).length}\n`;
    text += `DoctrineOrmTypeGuesser usage:        ${infos.filter((i) => i.hasDoctrineGuesser).length}\n`;
    text += `Files with guessed-type fields:      ${infos.filter((i) => i.fieldsWithGuessedType.length > 0).length}\n`;
    text += `Total guessed-type fields:           ${infos.reduce((s, i) => s + i.fieldsWithGuessedType.length, 0)}\n`;
    text += `Issues:                              ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormTypeGuessTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_type_guess',
      description: 'List Symfony form type guesser usage: custom FormTypeGuesserInterface implementations, DoctrineOrmTypeGuesser, fields without explicit type; warns about no-op guessers, missing form.type_guesser tag, null-typed fields',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_type_guess_stats',
      description: 'Show form type guesser statistics: custom guesser count, doctrine guesser usage, guessed-type field count, issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
