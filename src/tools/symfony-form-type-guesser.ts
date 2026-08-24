// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony FormTypeGuesserInterface Inspector
 *
 * Scans src/**\/*.php for classes implementing FormTypeGuesserInterface or
 * extending AbstractFormTypeGuesser, and config/packages/ YAML for
 * form.type_guesser service tags.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FormTypeGuesserInfo {
  file: string;
  class: string;
  methods: string[];
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadAbs(filePath: string): string | null {
  try { return fs.readFileSync(path.resolve(filePath), 'utf-8'); } catch { return null; }
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

function collectYamlFiles(dir: string, base: string): string[] {
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
    if (stat.isDirectory()) results.push(...collectYamlFiles(full, base));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full);
  }
  return results;
}

const GUESSER_METHODS = ['guessType', 'guessRequired', 'guessMaxLength', 'guessPattern'];

// Deprecated form type classes that should not be returned from guessType
const DEPRECATED_TYPES = [
  'TextType', 'ChoiceType', 'DateType', 'IntegerType', 'NumberType', 'CheckboxType',
];

function analysePhpFile(filePath: string, base: string): FormTypeGuesserInfo | null {
  const content = safeRead(filePath, base);
  if (!content) return null;

  // Must implement FormTypeGuesserInterface or extend AbstractFormTypeGuesser
  if (!content.includes('FormTypeGuesserInterface') && !content.includes('AbstractFormTypeGuesser')) return null;

  const classMatch = /class\s+([A-Za-z_][A-Za-z0-9_]{0,80})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const foundMethods: string[] = [];
  const issues: string[] = [];

  for (const method of GUESSER_METHODS) {
    if (new RegExp(`function\\s+${method}\\s*\\(`).test(content)) {
      foundMethods.push(method);
    }
  }

  if (foundMethods.length === 0) {
    issues.push('No guessType/guessRequired/guessMaxLength/guessPattern methods found — guesser is a no-op');
  }

  // Check for deprecated type returns
  for (const deprecated of DEPRECATED_TYPES) {
    const re = new RegExp(`new\\s+${deprecated}\\s*\\(|${deprecated}::class`);
    if (re.test(content)) {
      issues.push(`Guesser may return deprecated type class ${deprecated} — use fully-qualified namespace and ensure type is not removed in Symfony 7+`);
      break;
    }
  }

  // Check if guessType returns null for all branches
  if (foundMethods.includes('guessType')) {
    const guessTypeMatch = /function\s+guessType\s*\([^)]{0,200}\)(?:\s*:\s*[?\\\w|]{1,80})?\s*\{([^}]{0,2000})\}/s.exec(content);
    if (guessTypeMatch) {
      const body = guessTypeMatch[1];
      const hasNonNullReturn = /return\s+new\s+TypeGuess/.test(body);
      if (!hasNonNullReturn) {
        issues.push('guessType() does not appear to return a TypeGuess — guesser may always return null');
      }
    }
  }

  // Check for service tag in PHP attribute
  const hasTagAttr = /#\[AutoconfigureTag\s*\(\s*['"]\s*form\.type_guesser/.test(content);
  if (!hasTagAttr) {
    // Soft warning — may be tagged in YAML
    issues.push('No #[AutoconfigureTag(\'form.type_guesser\')] attribute found — ensure service is tagged form.type_guesser in services.yaml');
  }

  return { file: filePath, class: className, methods: foundMethods, issues };
}

function checkYamlForGuesserTags(appPath: string): string[] {
  const configDir = path.join(appPath, 'config');
  const yamlFiles = collectYamlFiles(configDir, configDir);
  const taggedServices: string[] = [];
  for (const f of yamlFiles) {
    const raw = safeReadAbs(f);
    if (!raw || !raw.includes('form.type_guesser')) continue;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/form\.type_guesser/.test(lines[i])) {
        // Find service name: look back for the service key
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          const svcMatch = /^\s{4}([A-Za-z_\\][A-Za-z0-9_\\]{0,120})\s*:/.exec(lines[j]);
          if (svcMatch) {
            taggedServices.push(`${svcMatch[1]} (tagged in ${path.relative(appPath, f)}:${i + 1})`);
            break;
          }
        }
      }
    }
  }
  return taggedServices;
}

function loadGuessers(appPath: string): { guessers: FormTypeGuesserInfo[]; yamlTagged: string[] } {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const guessers: FormTypeGuesserInfo[] = [];
  for (const f of files) {
    const info = analysePhpFile(f, srcDir);
    if (info) guessers.push(info);
  }
  const yamlTagged = checkYamlForGuesserTags(appPath);
  return { guessers, yamlTagged };
}

export function listSymfonyFormTypeGuesser(appPath: string): McpToolResult {
  try {
    const { guessers, yamlTagged } = loadGuessers(appPath);
    if (guessers.length === 0 && yamlTagged.length === 0) {
      return { content: [{ type: 'text', text: 'No FormTypeGuesserInterface implementations found.\n\nExample:\n  class MyGuesser implements FormTypeGuesserInterface {\n    public function guessType(string $class, string $property): ?TypeGuess { ... }\n  }' }] };
    }
    const totalIssues = guessers.reduce((s, g) => s + g.issues.length, 0);
    let text = `Symfony FormTypeGuesser\n${'='.repeat(55)}\n\nGuessers: ${guessers.length}  Issues: ${totalIssues}\n`;
    for (const g of guessers) {
      const rel = path.relative(appPath, g.file);
      text += `\n  ${g.class}  [${rel}]\n`;
      if (g.methods.length > 0) text += `    methods: ${g.methods.join(', ')}\n`;
      for (const issue of g.issues) text += `    ⚠ ${issue}\n`;
    }
    if (yamlTagged.length > 0) {
      text += `\nServices tagged form.type_guesser in YAML:\n`;
      for (const t of yamlTagged) text += `  ${t}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormTypeGuesserStats(appPath: string): McpToolResult {
  try {
    const { guessers, yamlTagged } = loadGuessers(appPath);
    const methodCounts: Record<string, number> = {};
    for (const g of guessers) for (const m of g.methods) methodCounts[m] = (methodCounts[m] ?? 0) + 1;
    let text = `Symfony FormTypeGuesser Statistics\n${'='.repeat(40)}\n\n`;
    text += `Guesser classes: ${guessers.length}\nYAML-tagged services: ${yamlTagged.length}\nTotal issues: ${guessers.reduce((s, g) => s + g.issues.length, 0)}\n\nMethod coverage:\n`;
    for (const m of GUESSER_METHODS) text += `  ${m}: ${methodCounts[m] ?? 0} / ${guessers.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyFormTypeGuesserTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_form_type_guesser', description: 'Scan src/**/*.php for FormTypeGuesserInterface implementations and config/ for form.type_guesser tags — flags no-op guessers, deprecated type returns, missing service tags', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_form_type_guesser_stats', description: 'Statistics for FormTypeGuesser: guesser count, YAML-tagged services, method coverage (guessType/guessRequired/guessMaxLength/guessPattern), issues total', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
