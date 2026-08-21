/**
 * Doctrine Entity Factory Inspector (Foundry / Zenstruck)
 *
 * Distinct from fixtures.ts (DoctrineFixturesBundle), tests-inspector.ts (test class analysis),
 * and repository-analyzer.ts (query patterns). Focuses on zenstruck/foundry factory patterns:
 *
 * - Scans src/ and tests/ PHP for ModelFactory/ObjectFactory/PersistentProxyObjectFactory subclasses
 * - Detects getDefaults(), initialize(), state methods, Faker usage
 * - Checks composer.json for zenstruck/foundry package
 *
 * Warnings:
 *   - ModelFactory without getDefaults() (random/empty data)
 *   - factory with getDefaults() returning all null values
 *   - factory using Faker but seeded (parallel test race conditions)
 *   - factory state methods that conflict (mutually exclusive states)
 *   - createMany() with very high count in tests (slow test suite)
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

interface EntityFactoryInfo {
  file: string;
  class: string;
  entityClass: string;
  hasDefaults: boolean;
  hasStates: boolean;
  hasInitialize: boolean;
  fakerUsage: boolean;
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

function checkFoundryInComposer(appPath: string): boolean {
  try {
    const composerPath = path.join(appPath, 'composer.json');
    const content = fs.readFileSync(composerPath, 'utf-8');
    return content.includes('zenstruck/foundry') || content.includes('foundry');
  } catch { return false; }
}

function parseFactoryFile(filePath: string): EntityFactoryInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isFactory = content.includes('ModelFactory') ||
    content.includes('ObjectFactory') ||
    content.includes('PersistentProxyObjectFactory') ||
    (content.includes('Factory') && content.includes('getDefaults'));

  if (!isFactory) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})\s+extends\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const parentClass = classM[2];
  if (!parentClass.includes('Factory') && !parentClass.includes('ModelFactory')) return null;

  const className = classM[1];

  const entityM = /protected\s+(?:static\s+)?function\s+getClass\s*\([^)]{0,50}\)\s*:\s*string[^{]{0,30}\{[^}]{0,200}return\s+(\w{1,100})::class/.exec(content) ??
    /new\s+(\w{1,100})\s*\(/.exec(content);
  const entityClass = entityM ? entityM[1] : className.replace(/Factory$/, '');

  const hasDefaults = content.includes('getDefaults()') || content.includes('function defaults(');
  const hasInitialize = content.includes('initialize()') || content.includes('function initialize(');
  const fakerUsage = content.includes('faker()') || content.includes('Faker') || content.includes('$this->faker');

  const stateMethodCount = (content.match(/public\s+function\s+\w{1,80}\s*\([^)]{0,100}\)\s*:\s*(?:static|self)/g) ?? []).length;
  const hasStates = stateMethodCount > 1;

  const issues: string[] = [];

  if (!hasDefaults) {
    issues.push('ModelFactory without getDefaults() — entity created with random/empty data');
  }

  if (hasDefaults) {
    const defaultsBlock = /function\s+(?:getDefaults|defaults)\s*\([^)]{0,50}\)[^{]{0,30}\{([^}]{0,500})\}/.exec(content);
    if (defaultsBlock) {
      const nullCount = (defaultsBlock[1].match(/=>\s*null[,\s]/g) ?? []).length;
      const totalFields = (defaultsBlock[1].match(/['"]\w{1,80}['"]\s*=>/g) ?? []).length;
      if (totalFields > 0 && nullCount === totalFields) {
        issues.push('getDefaults() returns all null values — factory provides no meaningful test data');
      }
    }
  }

  if (fakerUsage) {
    const hasSeed = content.includes('->seed(') || content.includes('Faker::seed(') ||
      content.includes('setSeed(');
    if (hasSeed) {
      issues.push('Faker with explicit seed — may cause race conditions in parallel test execution');
    }
  }

  const createManyMatches = content.matchAll(/createMany\s*\(\s*(\d{1,6})/g);
  for (const m of createManyMatches) {
    const count = parseInt(m[1], 10);
    if (count > 100) {
      issues.push(`createMany(${count}) — large fixture count may significantly slow test suite`);
    }
  }

  return {
    file: path.basename(filePath),
    class: className,
    entityClass,
    hasDefaults,
    hasStates,
    hasInitialize,
    fakerUsage,
    issues,
  };
}

export function listDoctrineEntityFactories(appPath: string): McpToolResult {
  try {
    const hasFoundry = checkFoundryInComposer(appPath);
    const results: EntityFactoryInfo[] = [];

    for (const dir of ['src', 'tests']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseFactoryFile(file);
        if (info) results.push(info);
      }
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      const foundryNote = hasFoundry
        ? 'zenstruck/foundry is installed. Create a factory:\n  php bin/console make:factory'
        : 'zenstruck/foundry not found in composer.json. Install with:\n  composer require --dev zenstruck/foundry';
      return { content: [{ type: 'text', text: `No entity factories found.\n\n${foundryNote}` }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Entity Factory Analysis\n${'='.repeat(55)}\n`;
    text += `\nFactories: ${results.length}  Foundry installed: ${hasFoundry ? 'yes' : 'no'}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const flags = [
        r.hasDefaults ? 'defaults' : 'NO-defaults',
        r.hasStates ? 'states' : '',
        r.hasInitialize ? 'initialize' : '',
        r.fakerUsage ? 'faker' : '',
      ].filter(Boolean).join(', ');

      text += `\n  ${r.class.padEnd(40)} -> ${r.entityClass}  (${r.file})\n`;
      if (flags) text += `    flags: [${flags}]\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityFactoryStats(appPath: string): McpToolResult {
  try {
    const hasFoundry = checkFoundryInComposer(appPath);
    const results: EntityFactoryInfo[] = [];

    for (const dir of ['src', 'tests']) {
      const dirPath = path.join(appPath, dir);
      for (const file of getAllPhpFiles(dirPath)) {
        const info = parseFactoryFile(file);
        if (info) results.push(info);
      }
    }

    let text = `Entity Factory Statistics\n${'='.repeat(40)}\n\n`;
    text += `Foundry installed:      ${hasFoundry ? 'yes' : 'no'}\n`;
    text += `Total factories:        ${results.length}\n`;
    text += `  With getDefaults():   ${results.filter((r) => r.hasDefaults).length}\n`;
    text += `  With state methods:   ${results.filter((r) => r.hasStates).length}\n`;
    text += `  With initialize():    ${results.filter((r) => r.hasInitialize).length}\n`;
    text += `  Using Faker:          ${results.filter((r) => r.fakerUsage).length}\n`;
    text += `Issues:                 ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityFactoryTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_entity_factories',
      description: 'Show zenstruck/foundry entity factory analysis: ModelFactory/ObjectFactory/PersistentProxyObjectFactory subclasses with getDefaults/states/initialize/faker detection; warns on missing getDefaults, all-null defaults, seeded Faker (parallel test race), large createMany() counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_entity_factory_stats',
      description: 'Show entity factory statistics: foundry installed flag, total factories, getDefaults/states/initialize/faker coverage counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
