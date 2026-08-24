// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony PropertyInfo Extractors Inspector
 *
 * Distinct from serializer.ts (serializer config) and form-types.ts.
 * Focuses on the PropertyInfo component's extractor stack:
 *
 * Built-in extractors (enabled via configuration or presence of dependencies):
 *   - ReflectionExtractor        — always available, uses PHP reflection
 *   - PhpDocExtractor            — parses PHPDoc @var/@property annotations
 *   - SerializerExtractor        — uses serializer metadata (Groups, etc.)
 *   - DoctrineExtractor          — uses Doctrine ORM mapping metadata
 *   - PhpStanExtractor           — uses PHPStan types (symfony/phpstan-bridge)
 *   - ConstructorExtractor       — uses constructor parameter types
 *
 * Custom extractors:
 *   - PropertyListExtractorInterface — listProperties()
 *   - PropertyTypeExtractorInterface — getTypes()
 *   - PropertyAccessExtractorInterface — isReadable(), isWritable()
 *   - PropertyDescriptionExtractorInterface — getShortDescription(), getLongDescription()
 *   - PropertyInitializableExtractorInterface — isInitializable()
 *
 * Configuration (framework.yaml):
 *   framework:
 *     property_info:
 *       enabled: true
 *
 * Usage patterns in src/:
 *   - PropertyInfoExtractorInterface injection
 *   - PropertyInfo::create() static helper
 *   - Denormalizer using PropertyInfo (AbstractNormalizer)
 *
 * Analysis:
 *   - No PhpDocExtractor when project uses @var annotations (loss of type info)
 *   - No DoctrineExtractor when project uses Doctrine (loss of ORM type info)
 *   - Custom extractor not tagged as symfony service (not auto-discovered)
 *   - PropertyInfo used but not enabled in config
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

const EXTRACTOR_INTERFACES = [
  'PropertyListExtractorInterface',
  'PropertyTypeExtractorInterface',
  'PropertyAccessExtractorInterface',
  'PropertyDescriptionExtractorInterface',
  'PropertyInitializableExtractorInterface',
];

const BUILTIN_EXTRACTORS = [
  'ReflectionExtractor', 'PhpDocExtractor', 'SerializerExtractor',
  'DoctrineExtractor', 'PhpStanExtractor', 'ConstructorExtractor',
];

interface CustomExtractor {
  class: string;
  file: string;
  interfaces: string[];
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

function isPropertyInfoEnabled(appPath: string): boolean | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw   = (raw['framework'] ?? raw) as Record<string, unknown>;
    const pi   = (fw['property_info'] ?? {}) as Record<string, unknown>;
    if (pi['enabled'] !== undefined) return pi['enabled'] === true || pi['enabled'] === 'true';
    return null;
  }
  return null;
}

function scanExtractorUsage(appPath: string): { usesPropertyInfo: boolean; usedExtractors: string[] } {
  const srcDir = path.join(appPath, 'src');
  let usesPropertyInfo = false;
  const usedExtractors = new Set<string>();

  if (!fs.existsSync(srcDir)) return { usesPropertyInfo: false, usedExtractors: [] };

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (content.includes('PropertyInfoExtractor')) usesPropertyInfo = true;
    for (const ext of BUILTIN_EXTRACTORS) {
      if (content.includes(ext)) usedExtractors.add(ext);
    }
  }

  return { usesPropertyInfo, usedExtractors: [...usedExtractors] };
}

function scanCustomExtractors(appPath: string): CustomExtractor[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const extractors: CustomExtractor[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const hasInterface = EXTRACTOR_INTERFACES.some((i) => content.includes(i));
    if (!hasInterface) continue;
    if (content.includes('namespace Symfony\\')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const interfaces = EXTRACTOR_INTERFACES.filter((i) => content.includes(i));
    const issues: string[] = [];

    if (!content.includes('#[AutoconfigureTag') && !content.includes('kernel.event_subscriber')) {
      if (!content.includes('implements') || !interfaces.some((i) => content.includes(i))) {
        issues.push('Custom extractor may not be auto-tagged — verify service configuration');
      }
    }

    extractors.push({
      class: classM[1],
      file: path.relative(appPath, file),
      interfaces,
      issues,
    });
  }

  return extractors;
}

export function listPropertyInfoExtractors(appPath: string): McpToolResult {
  try {
    const enabled   = isPropertyInfoEnabled(appPath);
    const usage     = scanExtractorUsage(appPath);
    const custom    = scanCustomExtractors(appPath);

    let text = `PropertyInfo Extractors\n${'='.repeat(55)}\n`;
    text += `\nPropertyInfo enabled: ${enabled === null ? 'not explicitly configured' : String(enabled)}\n`;
    text += `Used in src/:         ${usage.usesPropertyInfo ? 'yes' : 'no'}\n`;

    if (usage.usedExtractors.length > 0) {
      text += `\nDetected extractor references:\n`;
      for (const ext of usage.usedExtractors) {
        text += `  ${ext}\n`;
      }
    }

    if (custom.length > 0) {
      text += `\nCustom extractors (${custom.length}):\n`;
      for (const c of custom) {
        text += `  ${c.class}  implements: ${c.interfaces.map((i) => i.replace('ExtractorInterface', '')).join(', ')}  (${c.file})\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    const issues: string[] = [];
    if (usage.usesPropertyInfo && enabled === false) {
      issues.push('PropertyInfoExtractorInterface used in src/ but property_info.enabled: false in config');
    }

    if (issues.length > 0) {
      text += `\nIssues:\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    if (!usage.usesPropertyInfo && custom.length === 0) {
      text += `\nPropertyInfo component not used in src/. It powers the serializer, form and API Platform type resolution.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPropertyInfoStats(appPath: string): McpToolResult {
  try {
    const enabled = isPropertyInfoEnabled(appPath);
    const usage   = scanExtractorUsage(appPath);
    const custom  = scanCustomExtractors(appPath);

    let text = `PropertyInfo Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config enabled:          ${enabled === null ? 'not set' : String(enabled)}\n`;
    text += `Used in src/:            ${usage.usesPropertyInfo ? 'yes' : 'no'}\n`;
    text += `Built-in refs detected:  ${usage.usedExtractors.length}\n`;
    text += `Custom extractors:       ${custom.length}\n`;
    text += `Issues:                  ${custom.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPropertyInfoTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_property_info_extractors',
      description: 'Show PropertyInfo extractor configuration: enabled status, ReflectionExtractor/PhpDocExtractor/SerializerExtractor/DoctrineExtractor references, custom PropertyListExtractorInterface/PropertyTypeExtractorInterface implementations, enabled-but-unused warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_property_info_stats',
      description: 'Show PropertyInfo statistics: config enabled status, src/ usage, built-in extractor reference count, custom extractor count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
