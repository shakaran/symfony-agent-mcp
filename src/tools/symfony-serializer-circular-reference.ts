// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Serializer Circular Reference Inspector
 *
 * Scans src/**\/*.php for circular reference handler patterns:
 *   - setCircularReferenceHandler usage
 *   - circular_reference_handler config in serializer context
 *   - AbstractNormalizer::CIRCULAR_REFERENCE_HANDLER constant
 *   - max_depth context keys
 *
 * Also checks config/packages/serializer.yaml for circular_reference_handler.
 * Flags: missing handler with bidirectional relations, max_depth without handler,
 *        null id serialization risks.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CircularReferenceInfo {
  file: string;
  class: string;
  handler: 'callback' | 'none' | 'max-depth';
  maxDepth: number;
  issues: string[];
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function parseCircularReferenceFile(filePath: string, appPath: string): CircularReferenceInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSerializerContext = content.includes('CIRCULAR_REFERENCE_HANDLER') ||
    content.includes('circular_reference_handler') ||
    content.includes('setCircularReferenceHandler') ||
    content.includes('max_depth') ||
    content.includes('ENABLE_MAX_DEPTH') ||
    content.includes('AbstractNormalizer');

  if (!hasSerializerContext) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasCallbackHandler = content.includes('setCircularReferenceHandler') ||
    content.includes('CIRCULAR_REFERENCE_HANDLER') ||
    content.includes('circular_reference_handler');

  const hasMaxDepth = content.includes('max_depth') ||
    content.includes('ENABLE_MAX_DEPTH') ||
    content.includes('MAX_DEPTH_HANDLER');

  let handler: 'callback' | 'none' | 'max-depth' = 'none';
  if (hasCallbackHandler) handler = 'callback';
  else if (hasMaxDepth) handler = 'max-depth';

  // Extract max_depth value if present
  let maxDepth = 0;
  const maxDepthM = /max_depth['"]\s*=>\s*(\d+)/.exec(content);
  if (maxDepthM) maxDepth = parseInt(maxDepthM[1], 10);

  const issues: string[] = [];

  // Check for bidirectional relation patterns without handler
  const hasBidirectional = /OneToMany|ManyToOne|ManyToMany|OneToOne/.test(content) &&
    /inversedBy|mappedBy/.test(content);

  if (hasBidirectional && handler === 'none') {
    issues.push('Bidirectional relation detected without circular reference handler — serialization will throw CircularReferenceException');
  }

  if (hasMaxDepth && !hasCallbackHandler) {
    issues.push('max_depth set without circular_reference_handler — consider adding a handler for more control');
  }

  // Check for null id serialization risk (common workaround that can cause issues)
  if (content.includes('CIRCULAR_REFERENCE_HANDLER') && content.includes('null')) {
    const handlerBody = /CIRCULAR_REFERENCE_HANDLER['"]\s*=>\s*function[^}]{0,200}/s.exec(content);
    if (handlerBody && handlerBody[0].includes('null')) {
      issues.push('Circular reference handler returning null — may cause data loss; prefer returning getId() or a scalar identifier');
    }
  }

  if (handler === 'none' && (content.includes('serialize(') || content.includes('->normalize('))) {
    issues.push('Serializer usage without circular reference handler — risky if entities have relations');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    handler,
    maxDepth,
    issues,
  };
}

function checkSerializerYaml(appPath: string): string[] {
  const issues: string[] = [];
  const yamlPath = path.join(appPath, 'config', 'packages', 'serializer.yaml');
  const resolved = path.resolve(yamlPath);
  if (!resolved.startsWith(path.resolve(appPath) + path.sep)) return issues;

  let content = '';
  try { content = fs.readFileSync(yamlPath, 'utf-8'); } catch { return issues; }

  if (!content.includes('circular_reference_handler') && !content.includes('max_depth')) {
    if (content.includes('enable_annotations') || content.includes('mapping')) {
      issues.push('serializer.yaml: no circular_reference_handler configured globally — classes must configure handlers individually');
    }
  }

  return issues;
}

function buildCircularReferenceInfos(appPath: string): CircularReferenceInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: CircularReferenceInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  const yamlIssues = checkSerializerYaml(appPath);

  for (const file of collectPhpFiles(srcDir, srcDir)) {
    const info = parseCircularReferenceFile(file, appPath);
    if (info) {
      if (yamlIssues.length > 0 && info.handler === 'none') {
        info.issues.push(...yamlIssues);
      }
      results.push(info);
    }
  }

  return results;
}

export function listSymfonySerializerCircularReference(appPath: string): McpToolResult {
  try {
    const infos = buildCircularReferenceInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No circular reference handler patterns found in src/ PHP files.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony Serializer Circular Reference Analysis\n${'='.repeat(55)}\n\n`;
    text += `Files with serializer circular reference patterns: ${infos.length}\n`;
    text += `Files with issues: ${withIssues.length}\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  ${info.class}  (${info.file})\n`;
      text += `    Handler:   ${info.handler}\n`;
      if (info.maxDepth > 0) text += `    Max depth: ${info.maxDepth}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK — handler configured\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySerializerCircularReferenceStats(appPath: string): McpToolResult {
  try {
    const infos = buildCircularReferenceInfos(appPath);

    const withCallback = infos.filter((i) => i.handler === 'callback').length;
    const withMaxDepth = infos.filter((i) => i.handler === 'max-depth').length;
    const withNone = infos.filter((i) => i.handler === 'none').length;
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);

    let text = `Symfony Serializer Circular Reference Statistics\n${'='.repeat(50)}\n\n`;
    text += `Total files with serializer patterns: ${infos.length}\n`;
    text += `  With callback handler:    ${withCallback}\n`;
    text += `  With max-depth only:      ${withMaxDepth}\n`;
    text += `  Without handler:          ${withNone}\n`;
    text += `Total issues:               ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonySerializerCircularReferenceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_serializer_circular_reference',
      description: 'List Symfony serializer circular reference handler patterns: detects missing handlers on bidirectional relations, max_depth without handler, null id serialization risks, and checks serializer.yaml config',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_serializer_circular_reference_stats',
      description: 'Show Symfony serializer circular reference statistics: count by handler type (callback/max-depth/none), total issues found',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
