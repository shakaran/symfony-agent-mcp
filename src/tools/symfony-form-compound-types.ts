/**
 * Symfony Form Compound Types Inspector
 *
 * Scans src/**\/*.php for classes extending AbstractType that embed other
 * custom form types via $builder->add(). Detects compound types, flags
 * missing configureOptions, deep nesting, and missing data_class on nested types.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CompoundFormTypeInfo {
  class: string;
  file: string;
  parentTypes: string[];
  fields: number;
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

interface FormTypeAnalysis {
  className: string;
  extendsAbstractType: boolean;
  hasBuildForm: boolean;
  hasConfigureOptions: boolean;
  hasDataClass: boolean;
  embeddedTypes: string[];
  fieldCount: number;
}

function analyzeFormType(content: string): FormTypeAnalysis | null {
  // Must extend AbstractType
  if (!content.includes('AbstractType') || !content.includes('buildForm')) return null;

  const classMatch = /\bclass\s+(\w{1,80})\s+extends\s+AbstractType/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const extendsAbstractType = true;

  const hasBuildForm = /function\s+buildForm\s*\(/.test(content);
  const hasConfigureOptions = /function\s+configureOptions\s*\(/.test(content);
  const hasDataClass = /data_class/.test(content);

  // Find all $builder->add() calls to detect embedded custom types
  const addPattern = /\$builder\s*->\s*add\s*\(\s*['"][^'"]{1,80}['"]\s*,\s*([A-Za-z][A-Za-z0-9_\\]{0,120}Type)(?:::class)?/g;
  const embeddedTypes: string[] = [];
  let fieldCount = 0;

  let m: RegExpExecArray | null;
  // Count all $builder->add calls
  const addAllPattern = /\$builder\s*->\s*add\s*\(/g;
  while ((addAllPattern.exec(content)) !== null) {
    fieldCount++;
  }

  while ((m = addPattern.exec(content)) !== null) {
    const typeName = m[1];
    // Exclude built-in Symfony form types
    const builtinTypes = [
      'TextType', 'EmailType', 'PasswordType', 'HiddenType', 'IntegerType',
      'NumberType', 'MoneyType', 'PercentType', 'CheckboxType', 'RadioType',
      'ChoiceType', 'EntityType', 'CountryType', 'LanguageType', 'LocaleType',
      'TimezoneType', 'CurrencyType', 'DateType', 'DateTimeType', 'TimeType',
      'DateIntervalType', 'BirthdayType', 'CollectionType', 'RepeatedType',
      'FileType', 'ButtonType', 'SubmitType', 'ResetType', 'SearchType',
      'TelType', 'UrlType', 'RangeType', 'TextareaType', 'ColorType',
      'UlidType', 'UuidType', 'WeekType', 'FormType',
    ];
    const shortName = typeName.split('\\').pop() ?? typeName;
    if (!builtinTypes.includes(shortName) && !embeddedTypes.includes(typeName)) {
      embeddedTypes.push(typeName);
    }
  }

  return {
    className,
    extendsAbstractType,
    hasBuildForm,
    hasConfigureOptions,
    hasDataClass,
    embeddedTypes,
    fieldCount,
  };
}

function buildCompoundFormTypeInfos(appPath: string): CompoundFormTypeInfo[] {
  const infos: CompoundFormTypeInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  const srcDirR = path.resolve(srcDir);
  if (!srcDirR.startsWith(path.resolve(appPath) + path.sep)) return infos;

  let srcStat;
  try { srcStat = fs.lstatSync(srcDir); } catch { return infos; }
  if (srcStat.isSymbolicLink()) return infos;
  if (!srcStat.isDirectory()) return infos;

  // First pass: collect all custom form type class names
  const allFormTypeClasses = new Set<string>();
  for (const file of collectPhpFiles(srcDir, appPath)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('AbstractType')) continue;
    const classMatch = /\bclass\s+(\w{1,80})\s+extends\s+AbstractType/.exec(content);
    if (classMatch) allFormTypeClasses.add(classMatch[1]);
  }

  // Second pass: analyze each form type for compound patterns
  for (const file of collectPhpFiles(srcDir, appPath)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('AbstractType') || !content.includes('buildForm')) continue;

    const analysis = analyzeFormType(content);
    if (!analysis) continue;

    // Only care about compound types (those embedding other custom types)
    if (analysis.embeddedTypes.length === 0) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    // Missing configureOptions
    if (!analysis.hasConfigureOptions) {
      issues.push(`Missing configureOptions() — compound types should define data_class and allowed options`);
    }

    // Missing data_class on type that embeds other types
    if (!analysis.hasDataClass && analysis.hasConfigureOptions) {
      issues.push(`No data_class option set — compound types embedding custom types should bind to a data object`);
    }

    // Detect deep nesting: embedded types that are themselves compound
    const deeplyNested: string[] = [];
    for (const embeddedType of analysis.embeddedTypes) {
      const shortName = embeddedType.split('\\').pop() ?? embeddedType;
      // Check if this embedded type is also compound (it embeds other types)
      for (const f of collectPhpFiles(srcDir, appPath)) {
        let c = '';
        try { c = fs.readFileSync(f, 'utf-8'); } catch { continue; }
        const classMatch = /\bclass\s+(\w{1,80})\s+extends\s+AbstractType/.exec(c);
        if (!classMatch || classMatch[1] !== shortName) continue;
        // Check if it also has custom embedded types
        const innerAnalysis = analyzeFormType(c);
        if (innerAnalysis && innerAnalysis.embeddedTypes.length > 0) {
          deeplyNested.push(shortName);
        }
        break;
      }
    }

    if (deeplyNested.length > 0) {
      issues.push(`Deep form nesting detected: embeds ${deeplyNested.join(', ')} which are also compound types — consider flattening or using form events`);
    }

    // Large number of fields
    if (analysis.fieldCount > 15) {
      issues.push(`${analysis.fieldCount} fields in one compound type — consider splitting into sub-types for maintainability`);
    }

    infos.push({
      class: analysis.className,
      file: relFile,
      parentTypes: analysis.embeddedTypes,
      fields: analysis.fieldCount,
      issues,
    });
  }

  return infos;
}

export function listSymfonyFormCompoundTypes(appPath: string): McpToolResult {
  try {
    const infos = buildCompoundFormTypeInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No compound form types found in src/ (no AbstractType subclasses embedding custom form types).' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony Form Compound Types\n${'='.repeat(55)}\n\n`;
    text += `Compound form types found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  Class: ${info.class}  (${info.fields} fields)\n`;
      text += `  File:  ${info.file}\n`;
      text += `  Embeds: ${info.parentTypes.join(', ')}\n`;
      for (const issue of info.issues) {
        text += `  ! ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormCompoundTypesStats(appPath: string): McpToolResult {
  try {
    const infos = buildCompoundFormTypeInfos(appPath);
    const withIssues = infos.filter(i => i.issues.length > 0).length;
    const missingConfigureOptions = infos.filter(i => i.issues.some(s => s.includes('configureOptions'))).length;
    const missingDataClass = infos.filter(i => i.issues.some(s => s.includes('data_class'))).length;
    const deeplyNested = infos.filter(i => i.issues.some(s => s.includes('Deep form nesting'))).length;
    const largeTypes = infos.filter(i => i.fields > 15).length;
    const totalEmbeds = infos.reduce((s, i) => s + i.parentTypes.length, 0);

    let text = `Symfony Form Compound Types Statistics\n${'='.repeat(40)}\n\n`;
    text += `Compound form types: ${infos.length}\n`;
    text += `  With issues:                ${withIssues}\n`;
    text += `  Missing configureOptions:   ${missingConfigureOptions}\n`;
    text += `  Missing data_class:         ${missingDataClass}\n`;
    text += `  Deeply nested:              ${deeplyNested}\n`;
    text += `  Large (>15 fields):         ${largeTypes}\n`;
    text += `  Total embedded type refs:   ${totalEmbeds}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormCompoundTypesTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const propSimple = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_form_compound_types',
      description: 'List Symfony compound form types: AbstractType subclasses embedding custom form types, with field counts, embedded type names, and issues (missing configureOptions, data_class, deep nesting)',
      inputSchema: { type: 'object', properties: propSimple, required: ['app_path'] },
    },
    {
      name: 'get_symfony_form_compound_types_stats',
      description: 'Get Symfony compound form type statistics: total compound types, counts by issue category (missing configureOptions/data_class, deep nesting, large types)',
      inputSchema: { type: 'object', properties: propSimple, required: ['app_path'] },
    },
  ];
}
