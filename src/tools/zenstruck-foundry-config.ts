// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FoundryConfigInfo {
  source: string;
  type: 'factory' | 'story' | 'state' | 'reset' | 'persistence';
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

function buildZenstruckFoundryConfigInfos(appPath: string): FoundryConfigInfo[] {
  const results: FoundryConfigInfo[] = [];

  // Check composer.json for zenstruck/foundry
  const composerPath = path.join(appPath, 'composer.json');
  let foundryInstalled = false;
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    foundryInstalled = composerContent.includes('zenstruck/foundry');
  }

  // Scan src/ and tests/ for Factory and Story classes
  const srcFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  const testFiles = scanDirRecursive(path.join(appPath, 'tests'), '.php');
  const allFiles = [...srcFiles, ...testFiles];

  let factoryUsageFound = false;

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(appPath, filePath);

    // Factory classes extending ModelFactory
    if (/extends\s+ModelFactory/.test(content)) {
      factoryUsageFound = true;
      results.push({
        source: relPath,
        type: 'factory',
        pattern: 'extends-ModelFactory',
        issues: [],
      });

      // State methods in factory
      if (/->state\s*\(|->withStates\s*\(|function\s+\w+State\b/.test(content)) {
        results.push({
          source: relPath,
          type: 'state',
          pattern: 'factory-state-defined',
          issues: [],
        });
      }
    }

    // Persistence patterns
    if (/withoutPersisting\s*\(|->persist\s*\(/.test(content)) {
      factoryUsageFound = true;
      results.push({
        source: relPath,
        type: 'persistence',
        pattern: 'persistence-control',
        issues: [],
      });
    }

    // Many/times calls
    if (/Many::times\s*\(|->many\s*\(|::createMany\s*\(/.test(content)) {
      factoryUsageFound = true;
      results.push({
        source: relPath,
        type: 'factory',
        pattern: 'many-factory-call',
        issues: [],
      });
    }

    // Story classes
    if (/extends\s+Story/.test(content)) {
      results.push({
        source: relPath,
        type: 'story',
        pattern: 'extends-Story',
        issues: [],
      });
    }

    // Story load calls in tests
    if (/Story::load\s*\(|::load\s*\(\s*\)/.test(content) && testFiles.includes(filePath)) {
      results.push({
        source: relPath,
        type: 'story',
        pattern: 'story-load-call',
        issues: [],
      });
    }

    // ResetDatabase trait in test classes
    if (testFiles.includes(filePath)) {
      const hasResetDatabase = /use\s+ResetDatabase/.test(content);
      const hasFactoryUsage = /Factory::(create|createMany|new)\s*\(|ModelFactory/.test(content);

      if (hasResetDatabase) {
        results.push({
          source: relPath,
          type: 'reset',
          pattern: 'ResetDatabase-trait',
          issues: [],
        });
      } else if (hasFactoryUsage) {
        results.push({
          source: relPath,
          type: 'reset',
          pattern: 'factory-without-reset',
          issues: [
            'Factory usage in test without ResetDatabase trait — database state from one test may leak into the next; add the ResetDatabase trait to your test class',
          ],
        });
      }
    }
  }

  // Issue if factory usage found but foundry not installed
  if (factoryUsageFound && !foundryInstalled) {
    results.push({
      source: 'composer.json',
      type: 'factory',
      pattern: 'missing-foundry-dependency',
      issues: [
        'Foundry factories detected without zenstruck/foundry in require-dev — install with: composer require --dev zenstruck/foundry',
      ],
    });
  }

  return results;
}

export function listZenstruckFoundryConfig(appPath: string): McpToolResult {
  try {
    const infos = buildZenstruckFoundryConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Zenstruck Foundry configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Zenstruck Foundry Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
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

export function getZenstruckFoundryConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildZenstruckFoundryConfigInfos(appPath);
    let text = `Zenstruck Foundry Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Factory: ${infos.filter((i) => i.type === 'factory').length}\n`;
    text += `Story: ${infos.filter((i) => i.type === 'story').length}\n`;
    text += `State: ${infos.filter((i) => i.type === 'state').length}\n`;
    text += `Reset: ${infos.filter((i) => i.type === 'reset').length}\n`;
    text += `Persistence: ${infos.filter((i) => i.type === 'persistence').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getZenstruckFoundryConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_zenstruck_foundry_config',
      description: 'Analyze Zenstruck Foundry factory/story configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_zenstruck_foundry_config_stats',
      description: 'Statistics for Zenstruck Foundry configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
