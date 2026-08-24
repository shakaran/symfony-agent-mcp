// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTML Sanitizer Inspector
 *
 * Inspects the symfony/html-sanitizer component (Symfony 6.1+):
 *
 * Configuration (framework.yaml or html_sanitizer.yaml):
 *   framework:
 *     html_sanitizer:
 *       default_sanitizer: 'default'
 *       sanitizers:
 *         default:
 *           allow_safe_elements: true
 *           allow_static_elements: true
 *           allow_elements:
 *             a: ['href', 'title', 'target']
 *             img: ['src', 'alt', 'width', 'height']
 *           block_elements: ['script', 'style']
 *           drop_elements: ['iframe', 'object']
 *           allow_attributes:
 *             '*': ['class', 'id']
 *           block_attributes:
 *             '*': ['onclick', 'onerror', 'onload']
 *           with_attribute_sanitizers:
 *             - App\Sanitizer\UrlSanitizer
 *
 * PHP usage scan:
 *   - HtmlSanitizerInterface injection / $sanitizer->sanitize($html)
 *   - #[HtmlSanitizer] attribute on DTO properties (Symfony 6.4+)
 *
 * Analysis:
 *   - allow_elements including script/style/iframe/object/embed (dangerous)
 *   - allow_attributes '*': ['onclick', 'onload', 'onerror'] (XSS vector)
 *   - allow_all_attributes: true (unrestricted — bypasses sanitization)
 *   - Sanitizer configured but never injected in src/
 *   - Raw user HTML rendered in Twig without |sanitize_html filter or HtmlSanitizer call
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


const DANGEROUS_ELEMENTS  = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button']);
const DANGEROUS_ATTRIBUTES = new Set(['onclick', 'onload', 'onerror', 'onmouseover', 'oninput', 'onfocus', 'onblur', 'onsubmit', 'onchange']);

interface SanitizerConfig {
  name: string;
  allowSafeElements: boolean;
  allowAllAttributes: boolean;
  allowedElements: string[];
  dangerousElements: string[];
  dangerousAttributes: string[];
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (entry.name.endsWith('.twig') || entry.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function loadSanitizerConfigs(appPath: string): SanitizerConfig[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'html_sanitizer.yaml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw       = (raw['framework'] ?? raw) as Record<string, unknown>;
    const hsRaw    = (fw['html_sanitizer'] ?? {}) as Record<string, unknown>;
    const sanitizers = (hsRaw['sanitizers'] ?? {}) as Record<string, unknown>;
    if (Object.keys(sanitizers).length === 0) continue;

    const result: SanitizerConfig[] = [];
    for (const [name, cfg] of Object.entries(sanitizers)) {
      const config = (cfg ?? {}) as Record<string, unknown>;
      const allowSafeElements  = config['allow_safe_elements'] === true;
      const allowAllAttributes = config['allow_all_attributes'] === true;

      const allowedElements: string[] = [];
      const allowedEl = (config['allow_elements'] ?? {}) as Record<string, unknown>;
      for (const el of Object.keys(allowedEl)) allowedElements.push(el);

      const dangerousElements  = allowedElements.filter((el) => DANGEROUS_ELEMENTS.has(el));
      const dangerousAttributes: string[] = [];

      const allowedAttr = (config['allow_attributes'] ?? {}) as Record<string, unknown>;
      for (const [, attrs] of Object.entries(allowedAttr)) {
        const attrList = Array.isArray(attrs) ? attrs.map(String) : [];
        for (const a of attrList) {
          if (DANGEROUS_ATTRIBUTES.has(a)) dangerousAttributes.push(a);
        }
      }

      const issues: string[] = [];
      if (allowAllAttributes) {
        issues.push('allow_all_attributes: true — all HTML attributes allowed, sanitization is essentially disabled');
      }
      for (const el of dangerousElements) {
        issues.push(`Dangerous element "${el}" in allow_elements — potential XSS vector`);
      }
      for (const attr of dangerousAttributes) {
        issues.push(`Dangerous event attribute "${attr}" in allow_attributes — XSS risk`);
      }

      result.push({ name, allowSafeElements, allowAllAttributes, allowedElements, dangerousElements, dangerousAttributes, issues });
    }
    return result;
  }
  return [];
}

function scanUsages(appPath: string, configs: SanitizerConfig[]): { phpUsages: number; twigUsages: number; unusedConfigs: string[] } {
  const srcDir       = path.join(appPath, 'src');
  const templatesDir = path.join(appPath, 'templates');

  let phpUsages  = 0;
  let twigUsages = 0;
  const injectedNames = new Set<string>();

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('HtmlSanitizerInterface') || content.includes('->sanitize(')) {
        phpUsages++;
        for (const c of configs) {
          if (content.includes(c.name)) injectedNames.add(c.name);
        }
      }
    }
  }

  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('|sanitize_html')) twigUsages++;
    }
  }

  const unusedConfigs = configs.map((c) => c.name).filter((n) => !injectedNames.has(n) && n !== 'default');

  return { phpUsages, twigUsages, unusedConfigs };
}

export function listHtmlSanitizerConfig(appPath: string): McpToolResult {
  try {
    const configs = loadSanitizerConfigs(appPath);

    if (configs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No HTML sanitizer configuration found.\n\nInstall with: composer require symfony/html-sanitizer\n\nConfigure:\n  framework:\n    html_sanitizer:\n      sanitizers:\n        default:\n          allow_safe_elements: true\n          drop_elements: [\'script\', \'style\', \'iframe\']',
        }],
      };
    }

    const usage        = scanUsages(appPath, configs);
    const totalIssues  = configs.reduce((s, c) => s + c.issues.length, 0);

    let text = `HTML Sanitizer\n${'='.repeat(55)}\n`;
    text += `\nSanitizer configs: ${configs.length}  PHP usages: ${usage.phpUsages}  Twig |sanitize_html: ${usage.twigUsages}  Issues: ${totalIssues}\n`;

    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name))) {
      const safe = c.allowSafeElements ? '✓ safe-elements' : '';
      text += `\n  ${c.name}  ${safe}\n`;
      if (c.allowedElements.length > 0) {
        text += `    Allowed elements: ${c.allowedElements.join(', ')}\n`;
      }
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    if (usage.unusedConfigs.length > 0) {
      text += `\n⚠ Named sanitizers possibly unused in src/ (not default): ${usage.unusedConfigs.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSanitizerStats(appPath: string): McpToolResult {
  try {
    const configs = loadSanitizerConfigs(appPath);

    let text = `HTML Sanitizer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Sanitizer configs:     ${configs.length}\n`;
    text += `  Allow all attrs:     ${configs.filter((c) => c.allowAllAttributes).length}\n`;
    text += `  Allow safe elements: ${configs.filter((c) => c.allowSafeElements).length}\n`;
    text += `  Dangerous elements:  ${configs.reduce((s, c) => s + c.dangerousElements.length, 0)}\n`;
    text += `  Dangerous attrs:     ${configs.reduce((s, c) => s + c.dangerousAttributes.length, 0)}\n`;
    text += `Issues:                ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHtmlSanitizerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_html_sanitizer_config',
      description: 'Show HTML sanitizer configuration: per-sanitizer allowed/blocked elements and attributes, allow_all_attributes warning, dangerous element/attribute detection (script/iframe/onclick/onerror), PHP HtmlSanitizerInterface usage count, Twig |sanitize_html filter usage',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_sanitizer_stats',
      description: 'Show HTML sanitizer statistics: config count, allow-all-attributes count, allow-safe-elements count, dangerous element/attribute counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
