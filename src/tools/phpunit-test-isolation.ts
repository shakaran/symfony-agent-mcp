import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpunitTestIsolationInfo {
  file: string;
  class: string;
  method: string;
  issue: string;
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

function extractMethodsFromContent(content: string): Array<{ name: string; lineNum: number; visibility: string }> {
  const methods: Array<{ name: string; lineNum: number; visibility: string }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*(public|protected|private)\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (m) {
      methods.push({ visibility: m[1], name: m[2], lineNum: i + 1 });
    }
  }
  return methods;
}

function buildPhpunitTestIsolationInfos(appPath: string): PhpunitTestIsolationInfo[] {
  const results: PhpunitTestIsolationInfo[] = [];
  const testsDir = path.join(appPath, 'tests');
  if (!fs.existsSync(testsDir)) return results;

  const phpFiles = scanDirRecursive(testsDir, '.php');

  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const isTestFile =
      content.includes('extends TestCase') ||
      content.includes('extends KernelTestCase') ||
      content.includes('extends WebTestCase') ||
      content.includes('PHPUnit');

    if (!isTestFile) continue;

    const relFile = path.relative(appPath, filePath);
    const className = extractClassName(content);
    const lines = content.split('\n');
    const methods = extractMethodsFromContent(content);

    const hasSetUp = methods.some((m) => m.name === 'setUp');
    const hasTearDown = methods.some((m) => m.name === 'tearDown');

    // Static variables in test classes — shared state
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const staticVarM = /static\s+\$([A-Za-z_][A-Za-z0-9_]{0,60})\s*[=;]/.exec(line);
      if (staticVarM && !line.includes('static function')) {
        results.push({
          file: relFile,
          class: className,
          method: '(class-level)',
          issue: `static $${staticVarM[1]} in test class — static properties persist between test method invocations and can cause order-dependent test failures; use instance properties instead`,
        });
      }
    }

    // setUp sets a side-effecting resource but no tearDown
    if (hasSetUp && !hasTearDown) {
      const setUpMethod = methods.find((m) => m.name === 'setUp');
      if (setUpMethod) {
        const setUpStart = setUpMethod.lineNum - 1;
        const setUpEnd = Math.min(lines.length - 1, setUpStart + 30);
        const setUpBody = lines.slice(setUpStart, setUpEnd + 1).join('\n');
        const hasSideEffect =
          setUpBody.includes('fopen(') ||
          setUpBody.includes('tmpfile(') ||
          setUpBody.includes('mkdir(') ||
          setUpBody.includes('putenv(') ||
          setUpBody.includes('$_ENV[') ||
          setUpBody.includes('$_SERVER[') ||
          setUpBody.includes('::getConnection(') ||
          setUpBody.includes('->getConnection(');
        if (hasSideEffect) {
          results.push({
            file: relFile,
            class: className,
            method: 'setUp',
            issue: 'setUp() sets a side-effecting resource (file/DB/putenv/global) but no tearDown() found — always clean up resources in tearDown() to prevent test pollution and resource leaks',
          });
        }
      }
    }

    // $this->createMock( without @backupStaticAttributes or #[BackupStaticProperties]
    if (content.includes('$this->createMock(')) {
      const hasStaticBackup =
        content.includes('@backupStaticAttributes') ||
        content.includes('#[BackupStaticProperties]') ||
        content.includes('BackupStaticProperties');
      const classHasStaticProps = /static\s+\$[A-Za-z_]/.test(content);
      if (classHasStaticProps && !hasStaticBackup) {
        results.push({
          file: relFile,
          class: className,
          method: '(class-level)',
          issue: 'createMock() used in class with static properties but @backupStaticAttributes / #[BackupStaticProperties] not found — static state from mocks can leak between tests; add #[BackupStaticProperties(enabled: true)] or @backupStaticAttributes enabled',
        });
      }
    }

    // $GLOBALS usage
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('$GLOBALS[')) {
        const method = methods.findLast((m) => m.lineNum <= i + 1);
        results.push({
          file: `${relFile}:${i + 1}`,
          class: className,
          method: method ? method.name : '(unknown)',
          issue: '$GLOBALS usage in test — global state pollutes the test environment and causes cross-test interference; refactor to use dependency injection or local variables',
        });
      }
    }

    // putenv() or $_ENV assignment without tearDown restoration
    const hasPutenv = content.includes('putenv(') || /\$_ENV\s*\[/.test(content);
    if (hasPutenv && !hasTearDown) {
      results.push({
        file: relFile,
        class: className,
        method: 'setUp/test methods',
        issue: 'putenv() or $_ENV modification detected without tearDown() — environment variable changes persist across tests; restore original values in tearDown() or use putenv() to unset',
      });
    }

    // @depends chains > 3
    const dependsMatches = [...content.matchAll(/@depends\s+([A-Za-z_][A-Za-z0-9_]{0,60})/g)];
    if (dependsMatches.length > 3) {
      results.push({
        file: relFile,
        class: className,
        method: '(multiple)',
        issue: `@depends chain of ${dependsMatches.length} found — dependency chains longer than 3 are fragile; a single failing test breaks all dependents; prefer independent tests`,
      });
    }

    // Missing @runInSeparateProcess when using define() or singleton patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('define(') && !content.includes('@runInSeparateProcess')) {
        const method = methods.findLast((m) => m.lineNum <= i + 1);
        results.push({
          file: `${relFile}:${i + 1}`,
          class: className,
          method: method ? method.name : '(unknown)',
          issue: 'define() called in test without @runInSeparateProcess — constants cannot be redefined; add @runInSeparateProcess to the test method to isolate constant definitions',
        });
        break; // only report once per file
      }
    }

    // ->expectException( without $this (typo)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?<!\$this)->expectException\s*\(/.test(line)) {
        const method = methods.findLast((m) => m.lineNum <= i + 1);
        results.push({
          file: `${relFile}:${i + 1}`,
          class: className,
          method: method ? method.name : '(unknown)',
          issue: '->expectException() called without $this — this is always a typo ($this->expectException() is the correct form); the assertion will be silently ignored, causing false positives',
        });
      }
    }
  }

  return results;
}

export function listPhpunitTestIsolation(appPath: string): McpToolResult {
  try {
    const infos = buildPhpunitTestIsolationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPUnit test isolation issues found.' }] };
    }
    let text = `PHPUnit Test Isolation Issues\n${'='.repeat(55)}\n\nTotal issues: ${infos.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.class}::${info.method}]  ${info.file}\n`;
      text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpunitTestIsolationStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpunitTestIsolationInfos(appPath);
    const categorize = (keyword: string): number => infos.filter((i) => i.issue.includes(keyword)).length;
    let text = `PHPUnit Test Isolation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total issues:           ${infos.length}\n`;
    text += `Static property issues: ${categorize('static $')}\n`;
    text += `Missing tearDown:       ${categorize('tearDown()')}\n`;
    text += `$GLOBALS pollution:     ${categorize('$GLOBALS')}\n`;
    text += `putenv/ENV leaks:       ${categorize('putenv')}\n`;
    text += `@depends chains:        ${categorize('@depends chain')}\n`;
    text += `define() issues:        ${categorize('define()')}\n`;
    text += `expectException typos:  ${categorize('->expectException()')}\n`;
    text += `Static backup missing:  ${categorize('BackupStaticProperties')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpunitTestIsolationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_test_isolation',
      description: 'Scan tests/**/*.php for PHPUnit test isolation issues: static properties (shared state), setUp with side effects but no tearDown, createMock with static state missing @backupStaticAttributes/#[BackupStaticProperties], $GLOBALS usage, putenv/$_ENV without tearDown, @depends chains longer than 3, define() without @runInSeparateProcess, ->expectException() without $this (typo).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_test_isolation_stats',
      description: 'Statistics for PHPUnit test isolation: breakdown by issue category (static/tearDown/globals/putenv/depends/define/expectException).',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
