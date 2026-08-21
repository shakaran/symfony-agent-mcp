import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpunitTestNamingInfo {
  file: string;
  class: string;
  method: string;
  style: 'annotation' | 'prefix' | 'mixed' | 'non-public' | 'other';
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassName(content: string): string {
  const m = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends|implements|\{)/.exec(content);
  return m ? m[1] : '(unknown)';
}

interface MethodInfo {
  name: string;
  lineNum: number;
  visibility: string;
  docblock: string;
  hasTestAnnotation: boolean;
  hasAttrTest: boolean;
}

function extractMethodInfos(lines: string[]): MethodInfo[] {
  const methods: MethodInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*(public|protected|private)\s+function\s+([A-Za-z_][A-Za-z0-9_]{0,100})\s*\(/.exec(line);
    if (!m) continue;

    // Collect docblock (look back up to 20 lines)
    let docblock = '';
    let hasTestAnnotation = false;
    let hasAttrTest = false;
    for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
      const prev = lines[j].trim();
      if (prev.startsWith('*/') || prev.startsWith('*') || prev.startsWith('/**') || prev.startsWith('//')) {
        docblock = prev + '\n' + docblock;
        if (prev.includes('@test')) hasTestAnnotation = true;
      } else if (prev.includes('#[Test]') || prev.includes('#[\\PHPUnit\\Framework\\Attributes\\Test]')) {
        hasAttrTest = true;
      } else if (prev === '') {
        continue;
      } else {
        break;
      }
    }

    methods.push({ name: m[2], lineNum: i + 1, visibility: m[1], docblock, hasTestAnnotation, hasAttrTest });
  }
  return methods;
}

function buildPhpunitTestNamingInfos(appPath: string): PhpunitTestNamingInfo[] {
  const results: PhpunitTestNamingInfo[] = [];
  const testsDir = path.join(appPath, 'tests');
  if (!fs.existsSync(testsDir)) return results;

  const phpFiles = scanDirRecursive(testsDir, '.php');

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const isTestClass =
      content.includes('extends TestCase') ||
      content.includes('extends KernelTestCase') ||
      content.includes('extends WebTestCase') ||
      content.includes('extends DatabaseTestCase') ||
      content.includes('extends ApiTestCase') ||
      content.includes('extends IntegrationTestCase');

    const relFile = path.relative(appPath, filePath);
    const className = extractClassName(content);
    const lines = content.split('\n');
    const methods = extractMethodInfos(lines);

    // Check if class is missing TestCase extension but has test methods
    const hasTestMethods = methods.some((m) => m.name.startsWith('test') || m.hasTestAnnotation || m.hasAttrTest);
    if (!isTestClass && hasTestMethods && content.includes('class ')) {
      results.push({
        file: relFile,
        class: className,
        method: '(class)',
        style: 'other',
        issue: `Test class ${className} has test methods but does not extend TestCase (or KernelTestCase/WebTestCase) — PHPUnit will not discover or run these tests`,
      });
    }

    if (!isTestClass) continue;

    // Coverage annotations
    const hasCoversAnnotation =
      content.includes('@coversClass') ||
      content.includes('@covers ') ||
      content.includes('#[CoversClass') ||
      content.includes('#[CoversFunction');

    // Categorize methods — count annotation vs prefix style
    let annotationCount = 0;
    let prefixCount = 0;

    for (const method of methods) {
      const isAnnotation = method.hasTestAnnotation || method.hasAttrTest;
      const isPrefix = method.name.startsWith('test');
      const isBddIt = method.name.startsWith('it') && method.name.length > 2;

      if (!isAnnotation && !isPrefix && !isBddIt) continue;

      if (isAnnotation) annotationCount++;
      if (isPrefix) prefixCount++;

      // Non-public test methods
      if ((isAnnotation || isPrefix) && method.visibility !== 'public') {
        results.push({
          file: `${relFile}:${method.lineNum}`,
          class: className,
          method: method.name,
          style: 'non-public',
          issue: `${method.visibility} test method ${method.name}() — PHPUnit only runs public test methods; ${method.visibility} methods will be silently skipped`,
        });
      }

      // Vague method names (< 15 chars after test prefix)
      const nameWithoutPrefix = isPrefix ? method.name.slice(4) : method.name;
      if (isPrefix && method.name.length < 15 && !isAnnotation) {
        results.push({
          file: `${relFile}:${method.lineNum}`,
          class: className,
          method: method.name,
          style: 'prefix',
          issue: `Test method name "${method.name}" is too vague (< 15 chars after "test" prefix: "${nameWithoutPrefix}") — use descriptive names like testUserCannotLoginWithInvalidCredentials() to document behavior`,
        });
      }

      // BDD-style "it" prefix without @test annotation
      if (isBddIt && !isAnnotation) {
        results.push({
          file: `${relFile}:${method.lineNum}`,
          class: className,
          method: method.name,
          style: 'other',
          issue: `Method ${method.name}() starts with "it" (BDD style) without @test annotation — PHPUnit will NOT run this method; add /** @test */ annotation or rename to start with "test"`,
        });
      }

      // Coverage annotation check
      if ((isAnnotation || isPrefix) && method.visibility === 'public' && !hasCoversAnnotation) {
        // Only flag once per class
        if (results.filter((r) => r.class === className && r.issue?.includes('@CoversClass')).length === 0) {
          results.push({
            file: relFile,
            class: className,
            method: '(class)',
            style: 'other',
            issue: `Test class ${className} has no @coversClass / #[CoversClass] annotation — without coverage annotations, coverage reports may attribute test coverage to unrelated classes; add #[CoversClass(MyClass::class)]`,
          });
        }
      }
    }

    // Mixed annotation styles in same class
    if (annotationCount > 0 && prefixCount > 0) {
      results.push({
        file: relFile,
        class: className,
        method: '(class)',
        style: 'mixed',
        issue: `Test class ${className} mixes naming styles: ${annotationCount} @test annotation(s) and ${prefixCount} test prefix method(s) — pick one style for consistency; @test annotation style is preferred for readability`,
      });
    }

    // Overall style detection
    for (const method of methods) {
      const isAnnotation = method.hasTestAnnotation || method.hasAttrTest;
      const isPrefix = method.name.startsWith('test') && method.visibility === 'public';

      if (isAnnotation && !isPrefix) {
        results.push({
          file: `${relFile}:${method.lineNum}`,
          class: className,
          method: method.name,
          style: 'annotation',
          issue: null,
        });
      } else if (isPrefix && !isAnnotation) {
        // Only report if not already flagged for vague name
        const alreadyFlagged = results.some((r) => r.file.includes(relFile) && r.method === method.name && r.style === 'prefix' && r.issue !== null);
        if (!alreadyFlagged) {
          results.push({
            file: `${relFile}:${method.lineNum}`,
            class: className,
            method: method.name,
            style: 'prefix',
            issue: null,
          });
        }
      }
    }
  }

  return results;
}

export function listPhpunitTestNaming(appPath: string): McpToolResult {
  try {
    const infos = buildPhpunitTestNamingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPUnit test naming issues found or no test files detected.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `PHPUnit Test Naming Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.style.toUpperCase()}]  ${info.file}  ${info.class}::${info.method}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpunitTestNamingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpunitTestNamingInfos(appPath);
    const byStyle: Record<string, number> = {};
    for (const info of infos) {
      byStyle[info.style] = (byStyle[info.style] ?? 0) + 1;
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `PHPUnit Test Naming Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total entries: ${infos.length}\n`;
    for (const [style, count] of Object.entries(byStyle)) {
      text += `  ${style}: ${count}\n`;
    }
    text += `Issues:        ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.class}::${info.method}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpunitTestNamingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_test_naming',
      description: 'Scan tests/**/*.php for PHPUnit test naming convention issues: @test annotation vs test prefix methods, mixed styles in same class, vague names under 15 chars (testFoo/test1), non-public test methods, BDD "it" prefix without @test annotation, missing @coversClass/#[CoversClass] coverage annotations, class with test methods not extending TestCase.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_test_naming_stats',
      description: 'Statistics for PHPUnit test naming: breakdown by style (annotation/prefix/mixed/non-public/other) and issue count.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
