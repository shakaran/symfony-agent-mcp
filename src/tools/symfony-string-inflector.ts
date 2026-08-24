// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony String Inflector Inspector
 *
 * Detects Symfony String inflector component usage.
 * Scans src/ PHP for: EnglishInflector, use Symfony\Component\String\Inflector,
 *   pluralize(), singularize(), AbstractInflector.
 *
 * Checks composer.json for symfony/string.
 *
 * Warns on:
 *   - inflector used without caching results (expensive operation called repeatedly)
 *   - singularize/pluralize used on already-plural/singular word (double transformation)
 *   - inflector not checking for irregular words (manual list needed)
 *   - inflector used for slug generation (use SluggerInterface instead)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface InflectorInfo {
  file: string;
  className: string;
  inflectorType: string;
  usesCache: boolean;
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

function hasSymfonyString(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    return 'symfony/string' in req;
  } catch { return false; }
}

function parseInflectorFile(filePath: string): InflectorInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasInflector =
    content.includes('EnglishInflector') ||
    content.includes('Symfony\\Component\\String\\Inflector') ||
    content.includes('AbstractInflector') ||
    (content.includes('pluralize(') && content.includes('Inflect')) ||
    (content.includes('singularize(') && content.includes('Inflect'));

  if (!hasInflector) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];

  // Determine inflector type
  let inflectorType = 'unknown';
  if (content.includes('EnglishInflector')) inflectorType = 'EnglishInflector';
  else if (content.includes('AbstractInflector')) inflectorType = 'AbstractInflector';
  else if (content.includes('InflectorInterface')) inflectorType = 'InflectorInterface';

  // Check for caching: look for static cache, CacheInterface, array $cache, memoize patterns
  const usesCache =
    content.includes('static $') ||
    content.includes('CacheInterface') ||
    content.includes('$this->cache') ||
    content.includes('array_key_exists') ||
    content.includes('isset($cache') ||
    content.includes('memoize') ||
    content.includes('$cache[');

  if (!usesCache) {
    issues.push('Inflector used without result caching — pluralize()/singularize() are expensive; cache results to avoid repeated calls');
  }

  // Check for slug generation misuse
  if (content.includes('slug') || content.includes('Slug') || content.includes('url')) {
    issues.push('Inflector appears to be used for slug generation — use SluggerInterface (AsciiSlugger) instead for URL-safe slug creation');
  }

  // Check for irregular word handling
  if (!content.includes('irregular') && !content.includes('Irregular') && !content.includes('exceptions')) {
    issues.push('Inflector does not define irregular words — built-in English inflector may produce wrong results for domain-specific terms');
  }

  // Detect potential double transformation: pluralize result fed back to pluralize
  if (/pluralize\s*\(\s*[^)]{0,100}pluralize/.test(content) ||
    /singularize\s*\(\s*[^)]{0,100}singularize/.test(content)) {
    issues.push('Possible double transformation: pluralize()/singularize() called on an already-transformed result');
  }

  return { file: filePath, className, inflectorType, usesCache, issues };
}

function loadInflectorInfos(appPath: string): InflectorInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: InflectorInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseInflectorFile(f);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyStringInflectors(appPath: string): McpToolResult {
  try {
    const infos = loadInflectorInfos(appPath);
    const hasPackage = hasSymfonyString(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Symfony String Inflector usages found in src/.\n` +
            `symfony/string package: ${hasPackage ? 'installed' : 'not found in composer.json'}`,
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony String Inflector Inspector (${infos.length} usages)\n${'='.repeat(55)}\n`;
    text += `symfony/string installed: ${hasPackage ? 'yes' : 'not detected'}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      text += `    type: ${info.inflectorType}  cache: ${info.usesCache ? 'yes' : 'MISSING'}\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyStringInflectorStats(appPath: string): McpToolResult {
  try {
    const infos = loadInflectorInfos(appPath);
    const hasPackage = hasSymfonyString(appPath);

    let text = `String Inflector Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/string installed:     ${hasPackage ? 'yes' : 'not detected'}\n`;
    text += `Inflector usages:             ${infos.length}\n`;
    text += `  With result caching:        ${infos.filter((i) => i.usesCache).length}\n`;
    text += `  Without caching:            ${infos.filter((i) => !i.usesCache).length}\n`;
    text += `Issues:                       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getStringInflectorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_string_inflectors',
      description: 'List Symfony String EnglishInflector/AbstractInflector usages: detects caching of results, slug generation misuse, missing irregular word handling, double transformation; warns on uncached inflection, slug-via-inflector, domain irregular words',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_string_inflector_stats',
      description: 'Show string inflector statistics: total usages, cached vs uncached count, symfony/string package presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
