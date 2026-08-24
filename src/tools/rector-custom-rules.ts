// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Rector Custom Rules Inspector
 *
 * Scans src/ PHP for:
 *   - Classes extending AbstractRector or implementing RectorInterface
 *   - getRuleDefinition() method (documentation)
 *   - getNodeTypes() method returning array of Node classes
 *   - refactor() method
 *
 * Reads rector.php:
 *   - withConfiguredRule() calls (registered custom rectors)
 *   - Custom sets (local set files)
 *
 * Warns about:
 *   - Custom rector without getRuleDefinition() (no documentation)
 *   - Rector extending AbstractRector but not registered in rector.php
 *   - refactor() method that always returns null (no-op rule)
 *   - getNodeTypes() returning Expression::class (too broad)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface RectorCustomRuleInfo {
  file: string;
  class: string;
  nodeTypes: string[];
  hasDefinition: boolean;
  isRegistered: boolean;
  hasTests: boolean;
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

function parseRectorPhp(appPath: string): Set<string> {
  const registered = new Set<string>();
  const candidates = [
    path.join(appPath, 'rector.php'),
    path.join(appPath, 'rector.dist.php'),
  ];

  for (const filePath of candidates) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    // withConfiguredRule(SomeRector::class, [...])
    const configPattern = /withConfiguredRule\s*\(\s*([\w\\]{1,200})::class/g;
    let m: RegExpExecArray | null;
    while ((m = configPattern.exec(content)) !== null) {
      const parts = m[1].split('\\');
      registered.add(parts[parts.length - 1] ?? m[1]);
      registered.add(m[1]);
    }

    // withRules([SomeRector::class, ...])
    const rulesPattern = /([\w\\]{1,200})::class/g;
    while ((m = rulesPattern.exec(content)) !== null) {
      const cls = m[1];
      if (cls.endsWith('Rector') || cls.includes('Rector\\')) {
        const parts = cls.split('\\');
        registered.add(parts[parts.length - 1] ?? cls);
        registered.add(cls);
      }
    }
  }

  return registered;
}

function extractNodeTypes(content: string): string[] {
  const nodeTypes: string[] = [];
  // Match getNodeTypes return array: return [Xxx::class, Yyy::class]
  const returnMatch = /getNodeTypes\s*\([^)]{0,50}\)[^{]{0,50}\{[^}]{0,500}return\s*\[([^\]]{0,500})\]/.exec(content);
  if (!returnMatch) return nodeTypes;

  const arrayContent = returnMatch[1];
  const classPattern = /([\w\\]{1,100})::class/g;
  let m: RegExpExecArray | null;
  while ((m = classPattern.exec(arrayContent)) !== null) {
    const parts = m[1].split('\\');
    nodeTypes.push(parts[parts.length - 1] ?? m[1]);
  }
  return nodeTypes;
}

function isRefactorAlwaysNull(content: string): boolean {
  // Find refactor() method body
  const refactorMatch = /\bfunction\s+refactor\s*\([^)]{0,200}\)[^{]{0,100}\{/.exec(content);
  if (!refactorMatch) return false;

  let depth = 0;
  let idx = refactorMatch.index + refactorMatch[0].length - 1;
  const end = Math.min(content.length, idx + 3000);
  let body = '';
  for (; idx < end; idx++) {
    if (content[idx] === '{') depth++;
    else if (content[idx] === '}') {
      depth--;
      if (depth === 0) { body = content.substring(refactorMatch.index, idx + 1); break; }
    }
  }

  if (!body) return false;
  // If all return statements return null (or there are no non-null returns)
  const returns = body.match(/\breturn\s+([^;]{0,100});/g) ?? [];
  if (returns.length === 0) return true; // implicit null
  return returns.every((r) => /\breturn\s+null\s*;/.test(r));
}

function hasTestFile(filePath: string, appPath: string): boolean {
  const baseName = path.basename(filePath, '.php');
  const testCandidates = [
    path.join(appPath, 'tests', 'Rector', `${baseName}Test.php`),
    path.join(appPath, 'tests', `${baseName}Test.php`),
    path.join(appPath, 'src', 'Tests', 'Rector', `${baseName}Test.php`),
  ];
  return testCandidates.some((c) => fs.existsSync(c));
}

function parseRectorClass(filePath: string, appPath: string, registered: Set<string>): RectorCustomRuleInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isRector =
    content.includes('AbstractRector') ||
    (content.includes('RectorInterface') && content.includes('implements'));
  if (!isRector) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const nodeTypes = extractNodeTypes(content);
  const hasDefinition = content.includes('getRuleDefinition') || content.includes('RuleDefinition');
  const isRegistered = registered.has(className) || registered.has(classMatch[1]);
  const noOpRefactor = isRefactorAlwaysNull(content);
  const hasTests = hasTestFile(filePath, appPath);

  const issues: string[] = [];

  if (!hasDefinition) {
    issues.push(`${className}: no getRuleDefinition() method — rule has no documentation`);
  }
  if (!isRegistered) {
    issues.push(`${className}: extends AbstractRector but not found in rector.php — rule is inactive`);
  }
  if (noOpRefactor) {
    issues.push(`${className}: refactor() always returns null — rule never transforms code (no-op)`);
  }
  if (nodeTypes.includes('Expression') || nodeTypes.includes('Stmt_Expression')) {
    issues.push(`${className}: getNodeTypes() returns Expression::class — too broad, visits every statement`);
  }

  return {
    file: path.basename(filePath),
    class: className,
    nodeTypes,
    hasDefinition,
    isRegistered,
    hasTests,
    issues,
  };
}

function scanRectorClasses(appPath: string): RectorCustomRuleInfo[] {
  const registered = parseRectorPhp(appPath);
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: RectorCustomRuleInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseRectorClass(file, appPath, registered);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listRectorCustomRules(appPath: string): McpToolResult {
  try {
    const rules = scanRectorClasses(appPath);

    const rectorPhpExists = fs.existsSync(path.join(appPath, 'rector.php')) ||
                            fs.existsSync(path.join(appPath, 'rector.dist.php'));

    if (rules.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No custom Rector rules found in src/.${rectorPhpExists ? '' : '\n\nrector.php not found — install Rector:\n  composer require rector/rector --dev'}\n\nCreate a custom rector rule:\n  php vendor/bin/rector generate`,
        }],
      };
    }

    let text = `Rector Custom Rules\n${'='.repeat(55)}\n`;
    text += `\nrector.php found: ${rectorPhpExists ? 'yes' : 'no'}\n`;
    let totalIssues = 0;

    for (const rule of rules) {
      const regMark = rule.isRegistered ? '[active]' : '[INACTIVE]';
      const testMark = rule.hasTests ? '[tested]' : '[no tests]';
      text += `\n${rule.class} (${rule.file}) ${regMark} ${testMark}\n`;
      if (rule.nodeTypes.length > 0) {
        text += `  NodeTypes: ${rule.nodeTypes.join(', ')}\n`;
      }
      if (!rule.hasDefinition) text += `  No documentation (getRuleDefinition missing)\n`;
      for (const issue of rule.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    if (totalIssues === 0) {
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

export function getRectorCustomRuleStats(appPath: string): McpToolResult {
  try {
    const rules = scanRectorClasses(appPath);

    let text = `Rector Custom Rule Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total custom rules:       ${rules.length}\n`;
    text += `  Active (registered):    ${rules.filter((r) => r.isRegistered).length}\n`;
    text += `  Inactive:               ${rules.filter((r) => !r.isRegistered).length}\n`;
    text += `  With documentation:     ${rules.filter((r) => r.hasDefinition).length}\n`;
    text += `  With tests:             ${rules.filter((r) => r.hasTests).length}\n`;
    text += `  No-op (always null):    ${rules.filter((r) => r.issues.some((i) => i.includes('no-op'))).length}\n`;
    text += `  Too-broad Expression:   ${rules.filter((r) => r.nodeTypes.includes('Expression')).length}\n`;
    text += `Total warnings:           ${rules.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRectorCustomRuleTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_rector_custom_rules',
      description: 'Analyze custom Rector rules in src/: detect AbstractRector subclasses, getNodeTypes return values, refactor() no-op detection, registration status in rector.php, missing getRuleDefinition documentation, overly broad Expression node type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_rector_custom_rule_stats',
      description: 'Statistics for custom Rector rules: total count, active/inactive split, documented count, tested count, no-op count, too-broad node type count, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
