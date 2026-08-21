import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PantherTestingInfo {
  source: string;
  type: 'driver' | 'assertion' | 'artifact' | 'config' | 'waitfor';
  pattern: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...scanDirRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildPantherTestingInfos(appPath: string): PantherTestingInfo[] {
  const results: PantherTestingInfo[] = [];

  // Check composer.json for symfony/panther
  const composerPath = path.join(appPath, 'composer.json');
  let pantherInstalled = false;
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    pantherInstalled = composerContent.includes('symfony/panther');
  }

  // Scan test files for PantherTestCase
  const testsDir = path.join(appPath, 'tests');
  const testFiles = scanDirRecursive(testsDir, '.php');

  let pantherTestCaseFound = false;

  for (const testFile of testFiles) {
    const content = fs.readFileSync(testFile, 'utf8');
    const relPath = path.relative(appPath, testFile);

    if (!content.includes('PantherTestCase')) continue;

    pantherTestCaseFound = true;

    // Driver: extends PantherTestCase
    if (/extends\s+PantherTestCase/.test(content)) {
      results.push({
        source: relPath,
        type: 'driver',
        pattern: 'extends-PantherTestCase',
        issues: [],
      });
    }

    // WaitFor calls
    if (/\$client->waitFor(Visibility)?\s*\(/.test(content)) {
      results.push({
        source: relPath,
        type: 'waitfor',
        pattern: 'waitFor-call',
        issues: [],
      });
    }

    // Assertion patterns
    const assertionPatterns = ['assertSelectorTextContains', 'assertSelectorExists', 'assertSelectorAttributeContains'];
    for (const assertPat of assertionPatterns) {
      if (content.includes(assertPat)) {
        // Check if dynamic content assertion without waitFor
        const hasWaitFor = /\$client->waitFor/.test(content);
        const issues: string[] = [];
        if (!hasWaitFor && /assertSelectorExists/.test(content)) {
          issues.push(
            "Panther test without waitFor before assertion on dynamic element — use $client->waitFor('.selector') before assertSelectorExists to avoid race conditions with JavaScript",
          );
        }
        results.push({
          source: relPath,
          type: 'assertion',
          pattern: assertPat,
          issues,
        });
        break;
      }
    }

    // Artifact patterns
    if (/takeScreenshot|getWebDriver/.test(content)) {
      results.push({
        source: relPath,
        type: 'artifact',
        pattern: 'screenshot-or-webdriver',
        issues: [],
      });
    }
  }

  // Issue if PantherTestCase found but panther not installed
  if (pantherTestCaseFound && !pantherInstalled) {
    results.push({
      source: 'composer.json',
      type: 'driver',
      pattern: 'missing-panther-dependency',
      issues: [
        'PantherTestCase extends found but symfony/panther not in require-dev — install with: composer require --dev symfony/panther',
      ],
    });
  }

  // Check phpunit.xml for Panther configuration
  const phpunitFiles = ['phpunit.xml', 'phpunit.xml.dist'];
  for (const phpunitFile of phpunitFiles) {
    const phpunitPath = path.join(appPath, phpunitFile);
    if (fs.existsSync(phpunitPath)) {
      const phpunitContent = fs.readFileSync(phpunitPath, 'utf8');
      if (phpunitContent.includes('PANTHER_BROWSER') || phpunitContent.includes('PANTHER_CHROME_DRIVER_BINARY')) {
        results.push({
          source: phpunitFile,
          type: 'config',
          pattern: 'panther-env-config',
          issues: [],
        });
      }
    }
  }

  return results;
}

export function listPantherTesting(appPath: string): McpToolResult {
  try {
    const infos = buildPantherTestingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Panther testing configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Panther Testing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
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

export function getPantherTestingStats(appPath: string): McpToolResult {
  try {
    const infos = buildPantherTestingInfos(appPath);
    let text = `Panther Testing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Driver: ${infos.filter((i) => i.type === 'driver').length}\n`;
    text += `Assertion: ${infos.filter((i) => i.type === 'assertion').length}\n`;
    text += `Artifact: ${infos.filter((i) => i.type === 'artifact').length}\n`;
    text += `Config: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `WaitFor: ${infos.filter((i) => i.type === 'waitfor').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPantherTestingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_panther_testing',
      description: 'Analyze Symfony Panther end-to-end testing configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_panther_testing_stats',
      description: 'Statistics for Panther testing',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
