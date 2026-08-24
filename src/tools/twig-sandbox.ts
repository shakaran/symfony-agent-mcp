// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Twig Sandbox Extension Inspector
 *
 * Distinct from twig-extensions.ts (extension registration), twig-globals.ts (globals),
 * and twig-components.ts (Live Components).
 * Focuses on Twig SandboxExtension — for safely executing user-provided templates:
 *
 * SecurityPolicy:
 *   $policy = new SecurityPolicy(
 *     allowedTags:       ['if', 'for'],
 *     allowedFilters:    ['upper', 'lower', 'date'],
 *     allowedMethods:    ['Product' => ['getName', 'getPrice']],
 *     allowedProperties: ['Product' => ['name']],
 *     allowedFunctions:  ['range'],
 *   );
 *
 * SandboxExtension:
 *   $sandbox = new SandboxExtension($policy);
 *   $twig->addExtension($sandbox);
 *
 * Sandbox mode on specific template:
 *   $twig->load('user_template.twig')->render($context);
 *   // Or:
 *   $template = $twig->createTemplate($userInput);
 *   $template->render($sandbox_context);
 *
 * Template::sandbox():
 *   $sandboxedTemplate = $twig->loadTemplate($name, null, true);
 *
 * Analysis:
 *   - SecurityPolicy with empty allowedTags/allowedFilters (sandbox may not actually restrict)
 *   - createTemplate() without sandbox active — user-provided template not sandboxed
 *   - SandboxExtension added but no SecurityPolicy configured
 *   - loadTemplate($userInput) — user-controlled template path (path traversal risk)
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

interface SandboxUsage {
  file: string;
  class?: string;
  hasSandboxExtension: boolean;
  hasSecurityPolicy: boolean;
  hasCreateTemplate: boolean;
  hasLoadTemplate: boolean;
  allowedTagCount: number;
  allowedFilterCount: number;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseSandboxUsage(filePath: string, appPath: string): SandboxUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const hasSandboxExtension = content.includes('SandboxExtension');
  const hasSecurityPolicy   = content.includes('SecurityPolicy');
  const hasCreateTemplate   = content.includes('createTemplate(');
  const hasLoadTemplate     = content.includes('loadTemplate(');

  if (!hasSandboxExtension && !hasSecurityPolicy && !hasCreateTemplate) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Twig\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);

  let allowedTagCount    = 0;
  let allowedFilterCount = 0;

  const policyM = /new\s+SecurityPolicy\s*\(([\s\S]{0,800})\)/.exec(content);
  if (policyM) {
    const block = policyM[1];
    const tagsM    = /allowedTags\s*[:=]\s*\[([^\]]*)\]/.exec(block);
    const filtersM = /allowedFilters\s*[:=]\s*\[([^\]]*)\]/.exec(block);
    allowedTagCount    = tagsM    ? (tagsM[1].match(/['"][^'"]+['"]/g) ?? []).length : 0;
    allowedFilterCount = filtersM ? (filtersM[1].match(/['"][^'"]+['"]/g) ?? []).length : 0;
  }

  const issues: string[] = [];

  if (hasSandboxExtension && !hasSecurityPolicy) {
    issues.push('SandboxExtension without SecurityPolicy — sandbox has no access restrictions');
  }
  if (hasSecurityPolicy && allowedTagCount === 0) {
    issues.push('SecurityPolicy with no allowedTags — all tags blocked; verify intended');
  }
  if (hasSecurityPolicy && allowedFilterCount === 0) {
    issues.push('SecurityPolicy with no allowedFilters — all filters blocked; verify intended');
  }
  if (hasCreateTemplate && !hasSandboxExtension) {
    issues.push('createTemplate() used without SandboxExtension — user-provided template executes without sandboxing');
  }
  if (hasLoadTemplate) {
    // Detect if user variable is passed to loadTemplate
    if (/loadTemplate\s*\(\s*\$(?!this)/.test(content)) {
      issues.push('loadTemplate() with variable argument — potential path traversal if argument is user-controlled');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    hasSandboxExtension,
    hasSecurityPolicy,
    hasCreateTemplate,
    hasLoadTemplate,
    allowedTagCount,
    allowedFilterCount,
    issues,
  };
}

export function listTwigSandbox(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: SandboxUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseSandboxUsage(file, appPath);
      if (u) usages.push(u);
    }

    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Twig SandboxExtension or SecurityPolicy usage found.\n\nUse Twig sandbox when rendering user-provided templates:\n  $policy = new SecurityPolicy(allowedTags: [\'if\', \'for\'], allowedFilters: [\'upper\']);\n  $sandbox = new SandboxExtension($policy, sandboxed: false);\n  $twig->addExtension($sandbox);\n\n  // Render a specific template in sandbox mode:\n  $template = $twig->load(\'user_template.html.twig\');\n  $sandbox->enableSandbox();\n  $result = $template->render($context);\n  $sandbox->disableSandbox();',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);

    let text = `Twig Sandbox Extension\n${'='.repeat(55)}\n`;
    text += `\nFiles with sandbox usage: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  SandboxExtension:    ${usages.filter((u) => u.hasSandboxExtension).length}\n`;
    text += `  SecurityPolicy:      ${usages.filter((u) => u.hasSecurityPolicy).length}\n`;
    text += `  createTemplate():    ${usages.filter((u) => u.hasCreateTemplate).length}\n`;

    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      const tags    = u.hasSecurityPolicy ? `  allowedTags:${u.allowedTagCount}  allowedFilters:${u.allowedFilterCount}` : '';
      text += `\n  ${u.class ?? '(file)'}${tags}  (${u.file})\n`;
      for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigSandboxStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: SandboxUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseSandboxUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `Twig Sandbox Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with sandbox usage:  ${usages.length}\n`;
    text += `  SandboxExtension:        ${usages.filter((u) => u.hasSandboxExtension).length}\n`;
    text += `  SecurityPolicy:          ${usages.filter((u) => u.hasSecurityPolicy).length}\n`;
    text += `  createTemplate():        ${usages.filter((u) => u.hasCreateTemplate).length}\n`;
    text += `  loadTemplate():          ${usages.filter((u) => u.hasLoadTemplate).length}\n`;
    text += `Issues:                    ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTwigSandboxTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_sandbox',
      description: 'Show Twig SandboxExtension and SecurityPolicy usage: sandbox/policy detection, allowed tags/filters counts, createTemplate() without sandbox warning, loadTemplate() with variable path traversal risk, SecurityPolicy without allowed tags/filters warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_sandbox_stats',
      description: 'Show Twig sandbox statistics: file count, SandboxExtension/SecurityPolicy/createTemplate/loadTemplate counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
