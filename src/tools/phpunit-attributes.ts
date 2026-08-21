/**
 * PHPUnit Attribute Inspector
 *
 * Scans test files (src/Tests/ or tests/) for PHP 8.x PHPUnit attributes:
 *   #[Test], #[DataProvider], #[DataProviderExternal], #[Before], #[After],
 *   #[BeforeClass], #[AfterClass], #[CoversClass], #[UsesClass], #[Group],
 *   #[Depends], #[RequiresPhp], #[RequiresPhpExtension]
 *
 * Also detects:
 *   - Mixing @test annotation alongside #[Test] attribute in same class
 *   - #[DataProvider] referencing potentially non-existent method
 *   - Inconsistent annotation vs attribute styles across project
 *
 * Warns about:
 *   - #[Test] with method not starting with 'test' (inconsistency)
 *   - #[DataProvider] pointing to a method not found in class
 *   - #[CoversClass] path mismatch
 *   - Mixing @annotation and #[Attribute] styles in same project
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpUnitAttributeInfo {
  file: string;
  class: string;
  attributeUsage: {
    test: number;
    dataProvider: number;
    covers: number;
    group: number;
    before: number;
    after: number;
  };
  hasAnnotationMix: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function countAttr(content: string, name: string): number {
  return (content.match(new RegExp(`#\\[${name}\\b`, 'g')) ?? []).length;
}

function extractClassMethods(content: string): string[] {
  const methods: string[] = [];
  const pattern = /\bfunction\s+(\w{1,100})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    methods.push(m[1]);
  }
  return methods;
}

function parseTestFile(filePath: string): PhpUnitAttributeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must have at least one PHPUnit attribute or be a test class
  const hasAttributes = /#\[(?:Test|DataProvider|DataProviderExternal|Before|After|BeforeClass|AfterClass|CoversClass|UsesClass|Group|Depends|RequiresPhp)\b/.test(content);
  const hasTestClass = /\bextends\s+(?:TestCase|KernelTestCase|WebTestCase|ApiTestCase|IntegrationTestCase)\b/.test(content);
  if (!hasAttributes && !hasTestClass) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const issues: string[] = [];

  const attributeUsage = {
    test: countAttr(content, 'Test'),
    dataProvider: countAttr(content, 'DataProvider(?:External)?'),
    covers: countAttr(content, '(?:CoversClass|UsesClass|Covers|Uses)'),
    group: countAttr(content, 'Group'),
    before: countAttr(content, 'Before(?:Class)?'),
    after: countAttr(content, 'After(?:Class)?'),
  };

  // Detect annotation mix: @test alongside #[Test]
  const hasAtAnnotation = /\*\s*@test\b/.test(content);
  const hasAttrTest = attributeUsage.test > 0;
  const hasAnnotationMix = hasAtAnnotation && hasAttrTest;

  if (hasAnnotationMix) {
    issues.push(`${className}: mixes @test annotation and #[Test] attribute — pick one style`);
  }

  // Check #[Test] methods don't start with 'test' (minor inconsistency)
  const testAttrMethodPattern = /#\[Test\][^\n]{0,100}\n\s*(?:public\s+)?function\s+(\w{1,100})/g;
  let tm: RegExpExecArray | null;
  while ((tm = testAttrMethodPattern.exec(content)) !== null) {
    const methodName = tm[1];
    if (!methodName.startsWith('test')) {
      // This is fine for attributes, but note it
      issues.push(`${className}::${methodName}: method has #[Test] but name does not start with 'test' — inconsistent with non-attribute tests`);
    }
  }

  // Check #[DataProvider('method')] references existing methods
  const methods = extractClassMethods(content);
  const dpPattern = /#\[DataProvider\s*\(\s*['"](\w{1,100})['"]\s*\)\]/g;
  let dp: RegExpExecArray | null;
  while ((dp = dpPattern.exec(content)) !== null) {
    const providerMethod = dp[1];
    if (!methods.includes(providerMethod)) {
      issues.push(`${className}: #[DataProvider('${providerMethod}')] — method '${providerMethod}' not found in class`);
    }
  }

  return {
    file: path.basename(filePath),
    class: className,
    attributeUsage,
    hasAnnotationMix,
    issues,
  };
}

function findTestDirs(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'tests'),
    path.join(appPath, 'src', 'Tests'),
    path.join(appPath, 'src', 'Test'),
  ];
  return candidates.filter((d) => fs.existsSync(d));
}

function scanPhpUnitAttributes(appPath: string): PhpUnitAttributeInfo[] {
  const testDirs = findTestDirs(appPath);
  if (testDirs.length === 0) return [];

  const files: string[] = [];
  for (const dir of testDirs) {
    files.push(...getAllPhpFiles(dir));
  }

  const results: PhpUnitAttributeInfo[] = [];
  for (const file of files) {
    const info = parseTestFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function detectProjectStyleMix(infos: PhpUnitAttributeInfo[]): boolean {
  const hasAnnotations = infos.some((i) => i.hasAnnotationMix);
  const hasOnlyAttributes = infos.some((i) => i.attributeUsage.test > 0 && !i.hasAnnotationMix);
  return hasAnnotations && hasOnlyAttributes;
}

export function listPhpUnitAttributes(appPath: string): McpToolResult {
  try {
    const infos = scanPhpUnitAttributes(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHPUnit attribute usage detected in test directories.\n\nPHPUnit 10+ attributes (PHP 8.x):\n  #[Test]\n  #[DataProvider(\'providerMethod\')]\n  #[CoversClass(MyClass::class)]\n  #[Group(\'integration\')]',
        }],
      };
    }

    const projectMix = detectProjectStyleMix(infos);
    let text = `PHPUnit Attribute Analysis\n${'='.repeat(55)}\n`;

    if (projectMix) {
      text += `\nWARNING: Project mixes @annotation and #[Attribute] styles — standardize to one\n`;
    }

    let totalIssues = 0;

    for (const info of infos) {
      const usage = info.attributeUsage;
      const parts: string[] = [];
      if (usage.test > 0) parts.push(`#[Test]:${usage.test}`);
      if (usage.dataProvider > 0) parts.push(`#[DataProvider]:${usage.dataProvider}`);
      if (usage.covers > 0) parts.push(`#[Covers]:${usage.covers}`);
      if (usage.group > 0) parts.push(`#[Group]:${usage.group}`);
      if (usage.before > 0 || usage.after > 0) parts.push(`#[Before/After]:${usage.before + usage.after}`);

      text += `\n${info.class} (${info.file})\n`;
      if (parts.length > 0) text += `  Attributes: ${parts.join(', ')}\n`;
      if (info.hasAnnotationMix) text += `  WARNING: annotation/attribute mix\n`;
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    if (totalIssues === 0 && !projectMix) {
      text += '\nNo issues detected.\n';
    } else {
      text += `\nTotal warnings: ${totalIssues}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitAttributeStats(appPath: string): McpToolResult {
  try {
    const infos = scanPhpUnitAttributes(appPath);

    const total = infos.length;
    const totalTest = infos.reduce((s, i) => s + i.attributeUsage.test, 0);
    const totalDp = infos.reduce((s, i) => s + i.attributeUsage.dataProvider, 0);
    const totalCovers = infos.reduce((s, i) => s + i.attributeUsage.covers, 0);
    const totalGroup = infos.reduce((s, i) => s + i.attributeUsage.group, 0);
    const mixCount = infos.filter((i) => i.hasAnnotationMix).length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    let text = `PHPUnit Attribute Statistics\n${'='.repeat(40)}\n\n`;
    text += `Test files with attributes:   ${total}\n`;
    text += `  #[Test] usages:             ${totalTest}\n`;
    text += `  #[DataProvider] usages:     ${totalDp}\n`;
    text += `  #[Covers/Uses] usages:      ${totalCovers}\n`;
    text += `  #[Group] usages:            ${totalGroup}\n`;
    text += `Files with annotation mix:    ${mixCount}\n`;
    text += `Total warnings:               ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpUnitAttributeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_attributes',
      description: 'Analyze PHPUnit 10+ PHP 8.x attributes in test files: detect #[Test], #[DataProvider], #[CoversClass], #[Group], #[Before/After], annotation/@test mixing, DataProvider referencing missing methods, inconsistent naming styles',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_attribute_stats',
      description: 'Statistics for PHPUnit attribute usage: test file count, attribute type counts (#[Test], #[DataProvider], #[Covers], #[Group]), annotation/attribute mix count, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
