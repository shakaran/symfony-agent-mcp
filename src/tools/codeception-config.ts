import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CodeceptionConfigInfo {
  source: string;
  type: 'suite' | 'module' | 'actor' | 'webdriver' | 'cleanup';
  pattern: string;
  issues: string[];
}

function buildCodeceptionConfigInfos(appPath: string): CodeceptionConfigInfo[] {
  const results: CodeceptionConfigInfo[] = [];

  // Check for codeception.yml or codeception.yaml
  const configFiles = ['codeception.yml', 'codeception.yaml'];
  let configContent = '';
  let configFile = '';

  for (const fname of configFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      configContent = fs.readFileSync(fpath, 'utf8');
      configFile = fname;
      break;
    }
  }

  if (!configFile) {
    results.push({
      source: 'codeception.yml',
      type: 'suite',
      pattern: 'missing-config',
      issues: [],
    });
  } else {
    // Actor definition
    if (/actor:|tester:/i.test(configContent)) {
      results.push({
        source: configFile,
        type: 'actor',
        pattern: 'actor-defined',
        issues: [],
      });
    }

    // Suites section
    const suiteMatches = configContent.match(/^ {2}\w[\w_-]*:\s*$/gm);
    if (suiteMatches) {
      for (const suite of suiteMatches) {
        results.push({
          source: configFile,
          type: 'suite',
          pattern: `suite:${suite.trim().replace(':', '')}`,
          issues: [],
        });
      }
    }
  }

  // Check tests/ directory structure
  const testsDir = path.join(appPath, 'tests');
  if (fs.existsSync(testsDir)) {
    const suiteDirs = ['acceptance', 'functional', 'unit'];
    for (const suiteDir of suiteDirs) {
      if (fs.existsSync(path.join(testsDir, suiteDir))) {
        results.push({
          source: `tests/${suiteDir}`,
          type: 'suite',
          pattern: `directory-suite:${suiteDir}`,
          issues: [],
        });
      }
    }

    // Scan for *Cest.php files
    const scanForCest = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          scanForCest(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('Cest.php')) {
          results.push({
            source: path.relative(appPath, path.join(dir, entry.name)),
            type: 'suite',
            pattern: 'Cest-file',
            issues: [],
          });
        }
      }
    };
    scanForCest(testsDir);

    // _bootstrap.php
    if (fs.existsSync(path.join(testsDir, '_bootstrap.php'))) {
      results.push({
        source: 'tests/_bootstrap.php',
        type: 'suite',
        pattern: 'bootstrap-file',
        issues: [],
      });
    }
  }

  // Check acceptance.suite.yml for WebDriver
  const acceptanceSuiteFiles = [
    path.join(appPath, 'tests', 'acceptance.suite.yml'),
    path.join(appPath, 'tests', 'acceptance.suite.yaml'),
  ];
  for (const suiteFile of acceptanceSuiteFiles) {
    if (fs.existsSync(suiteFile)) {
      const suiteContent = fs.readFileSync(suiteFile, 'utf8');
      if (/WebDriver/i.test(suiteContent)) {
        results.push({
          source: path.relative(appPath, suiteFile),
          type: 'webdriver',
          pattern: 'WebDriver-module',
          issues: [],
        });

        if (!suiteContent.includes('WEBDRIVER_URL') && !/url\s*:/.test(suiteContent)) {
          results.push({
            source: path.relative(appPath, suiteFile),
            type: 'webdriver',
            pattern: 'missing-webdriver-url',
            issues: [
              'Codeception WebDriver module without WEBDRIVER_URL configuration — set url and browser in acceptance.suite.yml or via environment variable',
            ],
          });
        }
      }
    }
  }

  // Check functional.suite.yml for Symfony module
  const functionalSuiteFiles = [
    path.join(appPath, 'tests', 'functional.suite.yml'),
    path.join(appPath, 'tests', 'functional.suite.yaml'),
  ];
  for (const suiteFile of functionalSuiteFiles) {
    if (fs.existsSync(suiteFile)) {
      const suiteContent = fs.readFileSync(suiteFile, 'utf8');
      if (/Symfony/i.test(suiteContent)) {
        results.push({
          source: path.relative(appPath, suiteFile),
          type: 'module',
          pattern: 'Symfony-module',
          issues: [],
        });

        if (!/app_path\s*:/i.test(suiteContent)) {
          results.push({
            source: path.relative(appPath, suiteFile),
            type: 'module',
            pattern: 'missing-app-path',
            issues: [
              'Codeception Symfony module without app_path — configure app_path in functional.suite.yml for proper kernel bootstrapping',
            ],
          });
        }
      }
    }
  }

  // Check for data cleanup configuration
  const allSuiteFiles = [
    ...acceptanceSuiteFiles,
    ...functionalSuiteFiles,
    path.join(appPath, 'tests', 'unit.suite.yml'),
    path.join(appPath, 'tests', 'unit.suite.yaml'),
  ];

  let hasCleanup = false;
  for (const suiteFile of allSuiteFiles) {
    if (fs.existsSync(suiteFile)) {
      const suiteContent = fs.readFileSync(suiteFile, 'utf8');
      if (/cleanup\s*:\s*true/i.test(suiteContent)) {
        hasCleanup = true;
        results.push({
          source: path.relative(appPath, suiteFile),
          type: 'cleanup',
          pattern: 'db-cleanup-true',
          issues: [],
        });
      }
      if (/ORM\b|Doctrine2\b/.test(suiteContent)) {
        hasCleanup = true;
        results.push({
          source: path.relative(appPath, suiteFile),
          type: 'cleanup',
          pattern: 'orm-cleanup-module',
          issues: [],
        });
      }
    }
  }

  // Check codeception.yml for Db module
  if (configContent && /\bDb\b/.test(configContent)) {
    hasCleanup = true;
    results.push({
      source: configFile,
      type: 'cleanup',
      pattern: 'Db-module',
      issues: [],
    });
  }

  if (!hasCleanup && (fs.existsSync(path.join(appPath, 'tests')) || configFile)) {
    results.push({
      source: configFile || 'tests/',
      type: 'cleanup',
      pattern: 'missing-cleanup',
      issues: [
        'Codeception without data cleanup module — add Db or Doctrine2 module with cleanup: true to reset database state between tests',
      ],
    });
  }

  return results;
}

export function listCodeceptionConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCodeceptionConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Codeception configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Codeception Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getCodeceptionConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCodeceptionConfigInfos(appPath);
    let text = `Codeception Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Suite: ${infos.filter((i) => i.type === 'suite').length}\n`;
    text += `Module: ${infos.filter((i) => i.type === 'module').length}\n`;
    text += `Actor: ${infos.filter((i) => i.type === 'actor').length}\n`;
    text += `WebDriver: ${infos.filter((i) => i.type === 'webdriver').length}\n`;
    text += `Cleanup: ${infos.filter((i) => i.type === 'cleanup').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCodeceptionConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_codeception_config',
      description: 'Analyze Codeception testing framework configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_codeception_config_stats',
      description: 'Statistics for Codeception configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
