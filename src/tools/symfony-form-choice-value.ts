// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form ChoiceType choice_value / choice_label / choice_attr Inspector
 *
 * Scans src/ PHP for:
 *   - 'choice_value' =>, 'choice_label' =>, 'choice_attr' =>, 'choices' =>
 *   - ChoiceType, EntityType, EnumType choice customization
 *
 * Warns on:
 *   - choice_value returning object (not scalar — form submission fails)
 *   - choice_label returning untranslated string (hardcoded non-English labels)
 *   - choice_attr returning non-array (TypeError)
 *   - choices array with integer keys (EntityType id collision)
 *   - choice_value stateful closure (choices differ on submit)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FormChoiceValueInfo {
  file: string;
  className: string;
  formType: string;
  hasChoiceValue: boolean;
  hasChoiceLabel: boolean;
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

function detectFormType(content: string): string {
  if (content.includes('EntityType')) return 'EntityType';
  if (content.includes('EnumType')) return 'EnumType';
  if (content.includes('ChoiceType')) return 'ChoiceType';
  return 'unknown';
}

function hasObjectReturnInCallback(content: string, option: string): boolean {
  // Look for option => function(...) { return $someObj-> or return new
  const pattern = new RegExp(
    `'${option}'\\s*=>\\s*(?:function|static\\s+function|fn)\\s*\\([^)]{0,200}\\)(?:[^{]{0,50}\\{[^}]{0,300}return\\s+(?:new\\s+\\w{1,80}|\\$\\w{1,60}->)|\\s*=>\\s*(?:new\\s+\\w{1,80}|\\$\\w{1,60}->))`,
    ''
  );
  return pattern.test(content);
}

function hasHardcodedLabel(content: string): boolean {
  // choice_label => function returning a plain string literal not via $translator
  const m = /'choice_label'\s*=>\s*(?:function|fn)\s*\([^)]{0,200}\)(?:[^{]{0,50}\{[^}]{0,300}return\s*['"][^'"]{1,200}['"]|[^=]{0,20}=>\s*['"][^'"]{1,200}['"])/.test(content);
  return m;
}

function hasNonArrayChoiceAttr(content: string): boolean {
  // choice_attr returning non-array: return 'string' or return $scalar
  return /'choice_attr'\s*=>\s*(?:function|fn)\s*\([^)]{0,200}\)(?:[^{]{0,50}\{[^}]{0,200}return\s*['"\d$][^;[]{0,100};)/.test(content);
}

function scanFormChoiceValues(appPath: string): FormChoiceValueInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: FormChoiceValueInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasChoiceOption = content.includes("'choice_value'") ||
      content.includes("'choice_label'") ||
      content.includes("'choice_attr'") ||
      content.includes("'choices'");

    const isFormRelated = content.includes('ChoiceType') ||
      content.includes('EntityType') ||
      content.includes('EnumType') ||
      content.includes('FormBuilderInterface') ||
      content.includes('AbstractType');

    if (!hasChoiceOption || !isFormRelated) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');
    const formType = detectFormType(content);

    const hasChoiceValue = content.includes("'choice_value'");
    const hasChoiceLabel = content.includes("'choice_label'");

    const issues: string[] = [];

    if (hasChoiceValue && hasObjectReturnInCallback(content, 'choice_value')) {
      issues.push(`choice_value callback may return an object — must return a scalar (string/int) or form submission fails`);
    }

    if (hasChoiceLabel && hasHardcodedLabel(content)) {
      issues.push(`choice_label callback returns a hardcoded string literal — consider using $this->translator for i18n`);
    }

    if (content.includes("'choice_attr'") && hasNonArrayChoiceAttr(content)) {
      issues.push(`choice_attr callback may not return an array — will cause TypeError when rendering`);
    }

    if (formType === 'EntityType' && content.includes("'choices'")) {
      const intKeyPattern = /['"]choices['"]\s*=>\s*\[\s*\d{1,10}\s*=>/.test(content);
      if (intKeyPattern) {
        issues.push(`EntityType choices with integer keys — risk of id collision between different entity sets`);
      }
    }

    // Stateful closure risk: choice_value that references external $variable (not $item param)
    const statePattern = /\bchoice_value\b[^;]{0,400}use\s*\([^)]{1,200}\)/.test(content);
    if (hasChoiceValue && statePattern) {
      issues.push(`choice_value closure uses "use" capture — if captured value changes between form build and submit, choices will differ`);
    }

    if (issues.length > 0 || hasChoiceValue || hasChoiceLabel) {
      results.push({ file, className, formType, hasChoiceValue, hasChoiceLabel, issues });
    }
  }

  return results;
}

export function listFormChoiceValues(appPath: string): McpToolResult {
  try {
    const infos = scanFormChoiceValues(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No ChoiceType / EntityType choice_value or choice_label patterns found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Form ChoiceType Analysis\n${'='.repeat(55)}\n\n`;
    text += `Form types with choice options: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.className}  (${path.relative(appPath, info.file)})\n`;
      text += `    formType: ${info.formType}  choice_value: ${info.hasChoiceValue ? 'yes' : 'no'}  choice_label: ${info.hasChoiceLabel ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFormChoiceValueStats(appPath: string): McpToolResult {
  try {
    const infos = scanFormChoiceValues(appPath);

    let text = `Form ChoiceType Statistics\n${'='.repeat(40)}\n\n`;
    text += `Form types scanned:          ${infos.length}\n`;
    text += `  With choice_value:         ${infos.filter((i) => i.hasChoiceValue).length}\n`;
    text += `  With choice_label:         ${infos.filter((i) => i.hasChoiceLabel).length}\n`;
    text += `  EntityType:                ${infos.filter((i) => i.formType === 'EntityType').length}\n`;
    text += `  EnumType:                  ${infos.filter((i) => i.formType === 'EnumType').length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// Spec-required export aliases
export const listSymfonyFormChoiceValues = listFormChoiceValues;
export const getSymfonyFormChoiceValueStats = getFormChoiceValueStats;

export function getFormChoiceValueTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_form_choice_values',
      description: 'Scan src/ for Symfony ChoiceType/EntityType/EnumType choice_value, choice_label, choice_attr callbacks; warns on object return in choice_value, untranslated labels, non-array choice_attr, integer key collision, stateful closures',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_form_choice_value_stats',
      description: 'Statistics for Symfony form choice option usage: type count, choice_value/label coverage, EntityType/EnumType breakdown, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}

export const getSymfonyFormChoiceValueTools = getFormChoiceValueTools;
