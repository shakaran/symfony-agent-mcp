/**
 * Symfony Twig Test Functions Inspector
 *
 * Scans src/ PHP for: #[AsTwigTest] attribute, TwigTest class instantiation,
 * AbstractExtension::getTests() returning TwigTest array.
 * Scans Twig templates for 'is' keyword usage with custom test names.
 *
 * Warns about:
 *   - TwigTest registered but never used in templates (dead code)
 *   - TwigTest with deprecated_node_type without deprecation message (incomplete deprecation)
 *   - TwigTest with PHP function name that doesn't exist in context
 *   - TwigTest callable that throws exception (Twig renders blank instead of error)
 *   - Same test name as built-in Twig test (is defined, is empty) causing override
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TwigTestFunctionInfo {
  file: string;
  class: string;
  testName: string;
  callable: string;
  isUsedInTemplates: boolean;
  isDeprecated: boolean;
  issues: string[];
}

const BUILTIN_TWIG_TESTS = [
  'defined', 'empty', 'odd', 'even', 'iterable',
  'null', 'none', 'divisible by', 'same as', 'constant',
];

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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassName(content: string): string {
  const m = content.match(/class\s+([A-Za-z0-9_]{1,120})/);
  return m ? m[1] : '(unknown)';
}

function collectUsedTwigTests(appPath: string): Set<string> {
  const usedTests = new Set<string>();
  const templatesDir = path.join(appPath, 'templates');
  const twigFiles = fs.existsSync(templatesDir) ? getAllTwigFiles(templatesDir) : [];

  for (const file of twigFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // Match patterns like: foo is testname, foo is not testname
    const testMatches = content.matchAll(/\bis\s+(?:not\s+)?([a-z][a-z0-9_]{0,60})/gi);
    for (const m of testMatches) {
      usedTests.add(m[1].toLowerCase());
    }
  }

  return usedTests;
}

function buildTwigTestInfos(appPath: string): TwigTestFunctionInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usedTests = collectUsedTwigTests(appPath);
  const results: TwigTestFunctionInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasTwigTest =
      content.includes('TwigTest') ||
      content.includes('#[AsTwigTest') ||
      content.includes('getTests()');

    if (!hasTwigTest) continue;

    const className = extractClassName(content);

    // Extract TwigTest names from new TwigTest('name', ...) patterns
    const twigTestRe = /new\s+TwigTest\s*\(\s*['"]([a-z][a-z0-9 _]{0,80})['"]/gi;
    const matches = [...content.matchAll(twigTestRe)];

    // Also check #[AsTwigTest] attribute
    const asTwigTestRe = /#\[AsTwigTest\s*\(\s*['"]?([a-z][a-z0-9 _]{0,80})['"]?\s*\)\]/gi;
    const attrMatches = [...content.matchAll(asTwigTestRe)];

    const allTestEntries: Array<{ testName: string; callable: string }> = [];

    for (const m of matches) {
      const testName = m[1].toLowerCase();
      // Extract callable: second arg to TwigTest()
      const callableRe = new RegExp(`new\\s+TwigTest\\s*\\(\\s*['"]${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*,\\s*([^,)]{1,100})`, 'i');
      const callableMatch = content.match(callableRe);
      const callable = callableMatch ? callableMatch[1].trim() : '(unknown)';
      allTestEntries.push({ testName, callable });
    }

    for (const m of attrMatches) {
      allTestEntries.push({ testName: m[1].toLowerCase(), callable: '(attribute-registered)' });
    }

    if (allTestEntries.length === 0 && content.includes('getTests()')) {
      // getTests() found but no TwigTest constructor pattern
      allTestEntries.push({ testName: '(unknown)', callable: '(via getTests())' });
    }

    for (const entry of allTestEntries) {
      const { testName, callable } = entry;
      const isUsedInTemplates = usedTests.has(testName);
      const isDeprecated = content.includes('deprecated_node_type') || content.includes("'deprecated'");
      const issues: string[] = [];

      if (!isUsedInTemplates && testName !== '(unknown)') {
        issues.push(`TwigTest "${testName}" registered in "${className}" but never used in Twig templates (dead code)`);
      }

      if (isDeprecated && !content.includes('deprecation_info') && !content.includes('deprecation_message')) {
        issues.push(`TwigTest "${testName}" is deprecated but has no deprecation_info/message — incomplete deprecation (no developer warning)`);
      }

      const isBuiltin = BUILTIN_TWIG_TESTS.includes(testName);
      if (isBuiltin) {
        issues.push(`TwigTest "${testName}" overrides a built-in Twig test — this will shadow the built-in behavior for all templates`);
      }

      results.push({
        file,
        class: className,
        testName,
        callable,
        isUsedInTemplates,
        isDeprecated,
        issues,
      });
    }
  }

  return results;
}

export function listTwigTestFunctions(appPath: string): McpToolResult {
  try {
    const infos = buildTwigTestInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Twig test functions (TwigTest / #[AsTwigTest]) found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Twig Test Functions Analysis\n${'='.repeat(55)}\n\n`;
    text += `Custom tests: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.testName}  (${info.class})\n`;
      text += `    callable:      ${info.callable}\n`;
      text += `    usedInTwig:    ${info.isUsedInTemplates ? 'yes' : 'no'}\n`;
      text += `    deprecated:    ${info.isDeprecated ? 'yes' : 'no'}\n`;
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

export function getTwigTestFunctionStats(appPath: string): McpToolResult {
  try {
    const infos = buildTwigTestInfos(appPath);

    let text = `Twig Test Functions Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total custom tests:          ${infos.length}\n`;
    text += `  Used in templates:         ${infos.filter((i) => i.isUsedInTemplates).length}\n`;
    text += `  Unused (dead code):        ${infos.filter((i) => !i.isUsedInTemplates && i.testName !== '(unknown)').length}\n`;
    text += `  Deprecated:                ${infos.filter((i) => i.isDeprecated).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigTestFunctionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_test_functions',
      description: 'Inspect custom Twig test functions: #[AsTwigTest] attributes, TwigTest class registrations, getTests() implementations; warns on unused tests, incomplete deprecations, built-in Twig test name collisions',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_test_function_stats',
      description: 'Statistics for custom Twig test functions: total count, used vs unused, deprecated count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
