/**
 * Symfony Bundle Extension + Configuration Inspector
 *
 * Analyzes custom Symfony Bundle Extension and Configuration class pairs in src/.
 *
 * Detects:
 *   - Classes extending AbstractExtension or implementing ExtensionInterface (NOT from Symfony namespace)
 *   - getAlias() method return value
 *   - load(array $configs, ContainerBuilder $container) body
 *   - getConfigTreeBuilder() method presence
 *   - Classes implementing PrependExtensionInterface
 *   - prependExtensionConfig('section', ...) calls
 *
 * Warnings:
 *   - getAlias() return value that doesn't match snake_case convention
 *   - PrependExtensionInterface with empty prepend() body
 *   - load() that calls setParameter() with hardcoded non-env values
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

interface PrependSection {
  section: string;
}

interface ExtensionInfo {
  class: string;
  file: string;
  alias: string | null;
  hasLoad: boolean;
  hasConfigTreeBuilder: boolean;
  hasPrepend: boolean;
  prependSections: PrependSection[];
  hasHardcodedParams: boolean;
  aliasIssue: boolean;
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

function isExtensionFile(content: string): boolean {
  return (
    content.includes('extends AbstractExtension') ||
    content.includes('implements ExtensionInterface') ||
    content.includes('PrependExtensionInterface')
  );
}

function extractAlias(content: string): string | null {
  // Match: function getAlias(): string { return 'value'; }
  const re = /function\s+getAlias\s*\(\s*\)[^{]{0,40}\{([^}]{0,300})\}/;
  const m = re.exec(content);
  if (!m?.[1]) return null;
  const body = m[1];
  const returnM = /return\s+['"]([^'"]{1,80})['"]\s*;/.exec(body);
  return returnM?.[1] ?? null;
}

/**
 * Derive expected alias from class name.
 * E.g. "AcmeFooExtension" -> "acme_foo"
 * Strip trailing "Extension", convert to snake_case.
 */
function deriveExpectedAlias(className: string): string {
  const withoutSuffix = className.replace(/Extension$/, '');
  return withoutSuffix
    .replace(/([A-Z])/g, (_, c: string, offset: number) => (offset > 0 ? '_' : '') + (c as string).toLowerCase())
    .toLowerCase();
}

function isValidSnakeCase(s: string): boolean {
  return /^[a-z][a-z0-9_]{0,79}$/.test(s);
}

function extractPrependSections(content: string): PrependSection[] {
  const sections: PrependSection[] = [];
  // Match: ->prependExtensionConfig('section', ...)
  const re = /->prependExtensionConfig\s*\(\s*['"]([^'"]{1,80})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) sections.push({ section: m[1] });
  }
  return sections;
}

function hasPrependEmptyBody(content: string): boolean {
  // Extract prepend() method body
  const re = /function\s+prepend\s*\(\s*ContainerBuilder[^)]{0,80}\)[^{]{0,40}\{([^}]{0,600})\}/;
  const m = re.exec(content);
  if (!m?.[1]) return false;
  // Consider "empty" if body has no ->prependExtensionConfig and no meaningful statements
  const body = m[1].trim().replace(/\/\/[^\n]*/g, '').trim();
  return body.length === 0 || !/\$/.test(body);
}

function hasHardcodedSetParameter(content: string): boolean {
  // Find setParameter calls in load() method body (bounded)
  const re = /function\s+load\s*\([^)]{0,200}\)[^{]{0,40}\{([^}]{0,3000})\}/;
  const m = re.exec(content);
  if (!m?.[1]) return false;
  const body = m[1];
  // setParameter with a plain string/number value (not env() or %env(...)%)
  // Pattern: ->setParameter('key', 'value') or ->setParameter('key', 123)
  const paramRe = /->setParameter\s*\(\s*['"][^'"]{1,100}['"]\s*,\s*(?:'[^']{0,200}'|"[^"]{0,200}"|\d+)\s*\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(body)) !== null) {
    const call = pm[0];
    // Exclude env() calls and %env(...) references
    if (!call.includes('%env(') && !call.includes("'env(") && !call.includes('"env(')) {
      return true;
    }
  }
  return false;
}

function parseExtension(filePath: string, appPath: string): ExtensionInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!isExtensionFile(content)) return null;
  // Skip Symfony core
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const alias = extractAlias(content);
  const hasLoad = /function\s+load\s*\(/.test(content);
  const hasConfigTreeBuilder = content.includes('getConfigTreeBuilder');
  const hasPrepend = content.includes('PrependExtensionInterface') || content.includes('function prepend(');
  const prependSections = hasPrepend ? extractPrependSections(content) : [];
  const hasHardcodedParams = hasLoad ? hasHardcodedSetParameter(content) : false;

  const issues: string[] = [];

  // Alias convention check
  let aliasIssue = false;
  if (alias) {
    const expected = deriveExpectedAlias(classM[1]);
    if (!isValidSnakeCase(alias)) {
      issues.push(`getAlias() returns '${alias}' which is not valid snake_case`);
      aliasIssue = true;
    } else if (alias !== expected) {
      issues.push(`getAlias() returns '${alias}' but convention suggests '${expected}' (snake_case of class prefix)`);
      aliasIssue = true;
    }
  }

  // Empty prepend body
  if (hasPrepend && hasPrependEmptyBody(content)) {
    issues.push('PrependExtensionInterface implemented but prepend() body is empty — no config is prepended');
  }

  // Hardcoded parameters
  if (hasHardcodedParams) {
    issues.push('load() calls setParameter() with hardcoded non-env value — consider using env() or bundle config');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    alias,
    hasLoad,
    hasConfigTreeBuilder,
    hasPrepend,
    prependSections,
    hasHardcodedParams,
    aliasIssue,
    issues,
  };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listConfigExtensions(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const extensions: ExtensionInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const ext = parseExtension(file, appPath);
      if (ext) extensions.push(ext);
    }

    if (extensions.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom bundle extensions found in src/.\n\nExample:\n  class AcmeFooExtension extends AbstractExtension\n  {\n    public function getAlias(): string { return \'acme_foo\'; }\n    public function load(array $configs, ContainerBuilder $container): void { ... }\n    public function getConfigTreeBuilder(): TreeBuilder { ... }\n  }',
        }],
      };
    }

    const totalIssues = extensions.reduce((s, e) => s + e.issues.length, 0);
    let text = `Symfony Bundle Extensions\n${'='.repeat(55)}\n`;
    text += `\nExtensions found: ${extensions.length}  Issues: ${totalIssues}\n`;

    for (const ext of extensions.sort((a, b) => a.class.localeCompare(b.class))) {
      text += `\n  ${ext.class}  (${ext.file})\n`;
      text += `    Alias:             ${ext.alias ?? '(none)'}\n`;

      const caps: string[] = [];
      if (ext.hasLoad) caps.push('load()');
      if (ext.hasConfigTreeBuilder) caps.push('getConfigTreeBuilder()');
      if (ext.hasPrepend) caps.push('PrependExtensionInterface');
      text += `    Capabilities:      ${caps.join(', ') || '(none)'}\n`;

      if (ext.prependSections.length > 0) {
        text += `    Prepends:          ${ext.prependSections.map((s) => s.section).join(', ')}\n`;
      }

      for (const issue of ext.issues) {
        text += `    WARNING: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getConfigExtensionStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files = fs.existsSync(srcDir) ? getAllPhpFiles(srcDir) : [];
    const extensions: ExtensionInfo[] = [];

    for (const file of files) {
      const ext = parseExtension(file, appPath);
      if (ext) extensions.push(ext);
    }

    let text = `Bundle Extension Statistics\n${'='.repeat(40)}\n\n`;
    text += `Extensions found:        ${extensions.length}\n`;
    text += `  With load():           ${extensions.filter((e) => e.hasLoad).length}\n`;
    text += `  With ConfigTree:       ${extensions.filter((e) => e.hasConfigTreeBuilder).length}\n`;
    text += `  With Prepend:          ${extensions.filter((e) => e.hasPrepend).length}\n`;
    text += `  Alias issues:          ${extensions.filter((e) => e.aliasIssue).length}\n`;
    text += `  Hardcoded params:      ${extensions.filter((e) => e.hasHardcodedParams).length}\n`;
    text += `Issues detected:         ${extensions.reduce((s, e) => s + e.issues.length, 0)}\n`;

    if (extensions.length > 0) {
      const aliasesList = extensions.filter((e) => e.alias).map((e) => `${e.class}: '${e.alias}'`);
      if (aliasesList.length > 0) {
        text += `\nAliases:\n`;
        for (const a of aliasesList) text += `  ${a}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getConfigExtensionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_config_extensions',
      description: 'Show custom Symfony bundle extensions: AbstractExtension/ExtensionInterface implementations, getAlias() values, load() body, getConfigTreeBuilder() presence, PrependExtensionInterface usage, prependExtensionConfig sections, alias convention and hardcoded-param warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_config_extension_stats',
      description: 'Show bundle extension statistics: count of extensions with load/config-tree/prepend, alias issues, hardcoded parameter count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
