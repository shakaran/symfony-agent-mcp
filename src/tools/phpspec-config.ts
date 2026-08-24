// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

/**
 * The indentation this document uses for one nesting level.
 *
 * Two spaces is the common style and four is equally valid YAML; assuming two
 * meant a four-space file parsed as having nothing in it. Taken from the first
 * child of the given key rather than guessed.
 */
function indentUnder(content: string, key: string): number {
  const m = new RegExp(`^${key}\\s*:\\s*\\n( +)\\S`, 'm').exec(content);
  return m ? m[1].length : 2;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface PhpspecConfigInfo {
  source: string;
  type: 'config' | 'spec-structure' | 'naming' | 'double' | 'code-gen';
  pattern: string;
  issues: string[];
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

function buildPhpspecConfigInfos(appPath: string): PhpspecConfigInfo[] {
  const results: PhpspecConfigInfo[] = [];

  // Check for phpspec.yaml or phpspec.yml
  const configFiles = ['phpspec.yaml', 'phpspec.yml'];
  let configFound = false;
  let configContent = '';
  let configFile = '';

  for (const fname of configFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      configFound = true;
      configContent = fs.readFileSync(fpath, 'utf8');
      configFile = fname;
      break;
    }
  }

  if (!configFound) {
    results.push({
      source: 'phpspec.yaml',
      type: 'config',
      pattern: 'missing-config',
      issues: [],
    });
  } else {
    // Parse suites section
    const suitesMatch = configContent.match(/^suites:([\s\S]*?)(?:^[a-z]|$)/m);
    if (suitesMatch) {
      const suitesContent = suitesMatch[1];
      const suiteNames = suitesContent.match(
      new RegExp(`^ {${indentUnder(suitesContent, 'suites')}}(?! )\\w[\\w_-]*:`, 'gm')
    );
      if (suiteNames) {
        for (const suiteName of suiteNames) {
          results.push({
            source: configFile,
            type: 'config',
            pattern: `suite:${suiteName.trim().replace(':', '')}`,
            issues: [],
          });
        }
      }
    }

    // Namespace mapping
    if (/namespace:/i.test(configContent)) {
      results.push({
        source: configFile,
        type: 'config',
        pattern: 'namespace-mapping',
        issues: [],
      });
    }
  }

  // Scan spec/ directory for spec files
  const specDir = path.join(appPath, 'spec');
  const specFiles = scanDirRecursive(specDir, '.php');

  // Check composer.json for phpspec/phpspec
  const composerPath = path.join(appPath, 'composer.json');
  let phpspecInstalled = false;
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    phpspecInstalled = composerContent.includes('phpspec/phpspec');
  }

  if (specFiles.length > 0 && !phpspecInstalled) {
    results.push({
      source: 'composer.json',
      type: 'config',
      pattern: 'missing-phpspec-dependency',
      issues: [
        'spec/ directory found without phpspec/phpspec in require-dev — install with: composer require --dev phpspec/phpspec',
      ],
    });
  }

  for (const specFile of specFiles) {
    const content = safeRead(specFile, appPath);
    if (content === null) continue;
    const relPath = path.relative(appPath, specFile);

    // Files ending in Spec.php extending ObjectBehavior
    if (specFile.endsWith('Spec.php') && /extends\s+ObjectBehavior/.test(content)) {
      results.push({
        source: relPath,
        type: 'spec-structure',
        pattern: 'ObjectBehavior-spec',
        issues: [],
      });
    }

    // beConstructedWith
    if (/\$this->beConstructedWith\s*\(/.test(content)) {
      results.push({
        source: relPath,
        type: 'spec-structure',
        pattern: 'beConstructedWith',
        issues: [],
      });
    }

    // Method naming — it_ prefix
    const methodMatches = content.match(/public\s+function\s+([\w_]+)\s*\(/g);
    if (methodMatches) {
      for (const match of methodMatches) {
        const methodName = match.replace(/public\s+function\s+/, '').replace(/\s*\(.*/, '');
        // Skip constructor, let_*, getMatchers
        if (methodName === '__construct' || methodName === 'let' || methodName === 'letGo' || methodName === 'getMatchers') {
          continue;
        }
        if (methodName.startsWith('it_')) {
          results.push({
            source: relPath,
            type: 'naming',
            pattern: `it_method:${methodName}`,
            issues: [],
          });
        } else {
          results.push({
            source: relPath,
            type: 'naming',
            pattern: `bad-method:${methodName}`,
            issues: [
              `PHPSpec method '${methodName}' doesn't follow it_snake_case naming — PHPSpec spec methods must start with 'it_' prefix to be recognized as examples`,
            ],
          });
        }
      }
    }

    // Test doubles: willReturn, shouldBeCalled, shouldHaveBeenCalled
    if (/->willReturn\s*\(|->shouldBeCalled\s*\(|->shouldHaveBeenCalled\s*\(/.test(content)) {
      results.push({
        source: relPath,
        type: 'double',
        pattern: 'test-double-usage',
        issues: [],
      });
    }
  }

  return results;
}

export function listPhpspecConfig(appPath: string): McpToolResult {
  try {
    const infos = buildPhpspecConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHPSpec configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHPSpec Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getPhpspecConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpspecConfigInfos(appPath);
    let text = `PHPSpec Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Spec-structure: ${infos.filter((i) => i.type === 'spec-structure').length}\n`;
    text += `Naming: ${infos.filter((i) => i.type === 'naming').length}\n`;
    text += `Double: ${infos.filter((i) => i.type === 'double').length}\n`;
    text += `Code-gen: ${infos.filter((i) => i.type === 'code-gen').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpspecConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpspec_config',
      description: 'Analyze PHPSpec specification configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpspec_config_stats',
      description: 'Statistics for PHPSpec configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
