/**
 * Symfony Object Normalizer Inspector
 *
 * Scans src/ PHP for:
 *   - ObjectNormalizer, PropertyNormalizer, GetSetMethodNormalizer, DateTimeNormalizer
 *   - Context options: ATTRIBUTES, IGNORED_ATTRIBUTES, CIRCULAR_REFERENCE_HANDLER,
 *     MAX_DEPTH, ENABLE_MAX_DEPTH
 *
 * Warns about:
 *   - ObjectNormalizer without circular_reference_handler (throws by default)
 *   - MAX_DEPTH without ENABLE_MAX_DEPTH: true (depth limit ignored)
 *   - IGNORED_ATTRIBUTES as empty array (ignores nothing — likely bug)
 *   - Normalizer registered without priority (may conflict with API Platform)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ObjectNormalizerInfo {
  file: string;
  class: string;
  normalizerType: string;
  hasCircularRefHandler: boolean;
  hasMaxDepth: boolean;
  hasEnabledMaxDepth: boolean;
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

const NORMALIZER_TYPES = [
  'ObjectNormalizer',
  'PropertyNormalizer',
  'GetSetMethodNormalizer',
  'DateTimeNormalizer',
  'DateTimeZoneNormalizer',
  'DateIntervalNormalizer',
];

function detectNormalizerType(content: string): string {
  for (const t of NORMALIZER_TYPES) {
    if (content.includes(t)) return t;
  }
  return 'unknown';
}

function hasEmptyIgnoredAttributes(content: string): boolean {
  return /IGNORED_ATTRIBUTES[^,;]{0,100}=>\s*\[\s*\]/.test(content) ||
    /ignored_attributes[^,;]{0,100}=>\s*\[\s*\]/.test(content);
}

function hasPriority(content: string): boolean {
  return /priority\s*[=:>]{1,2}\s*-?\d{1,6}/.test(content) ||
    content.includes('getSubscribedServices') ||
    content.includes('kernel.event_subscriber');
}

function scanNormalizers(appPath: string): ObjectNormalizerInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ObjectNormalizerInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const normalizerType = detectNormalizerType(content);
    if (normalizerType === 'unknown') continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasCircularRefHandler =
      content.includes('CIRCULAR_REFERENCE_HANDLER') ||
      content.includes('circular_reference_handler') ||
      content.includes('setCircularReferenceHandler');
    const hasMaxDepth =
      content.includes('MAX_DEPTH') ||
      content.includes('max_depth') ||
      content.includes('AbstractNormalizer::MAX_DEPTH');
    const hasEnabledMaxDepth =
      content.includes('ENABLE_MAX_DEPTH') ||
      content.includes('enable_max_depth');

    const issues: string[] = [];

    if (normalizerType === 'ObjectNormalizer' && !hasCircularRefHandler) {
      issues.push('ObjectNormalizer without CIRCULAR_REFERENCE_HANDLER — circular references throw CircularReferenceException by default');
    }
    if (hasMaxDepth && !hasEnabledMaxDepth) {
      issues.push('MAX_DEPTH context option set but ENABLE_MAX_DEPTH not enabled — depth limit is silently ignored');
    }
    if (hasEmptyIgnoredAttributes(content)) {
      issues.push('IGNORED_ATTRIBUTES set to empty array — ignores nothing, likely unintentional (use null to clear, or remove)');
    }
    if (!hasPriority(content) && content.includes('NormalizerInterface')) {
      issues.push('Normalizer implements NormalizerInterface without explicit priority — may conflict with API Platform or other normalizers');
    }

    results.push({
      file,
      class: className,
      normalizerType,
      hasCircularRefHandler,
      hasMaxDepth,
      hasEnabledMaxDepth,
      issues,
    });
  }

  return results;
}

export function listObjectNormalizerUsage(appPath: string): McpToolResult {
  try {
    const infos = scanNormalizers(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No ObjectNormalizer, PropertyNormalizer, or GetSetMethodNormalizer usage found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Object Normalizer Usage\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  [${info.normalizerType}]  (${path.relative(appPath, info.file)})\n`;
      text += `    circularRefHandler: ${info.hasCircularRefHandler ? 'yes' : 'no'}`;
      text += `  maxDepth: ${info.hasMaxDepth ? 'yes' : 'no'}`;
      text += `  enableMaxDepth: ${info.hasEnabledMaxDepth ? 'yes' : 'no'}\n`;
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

export function getObjectNormalizerStats(appPath: string): McpToolResult {
  try {
    const infos = scanNormalizers(appPath);

    let text = `Object Normalizer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total normalizer classes:         ${infos.length}\n`;
    text += `  ObjectNormalizer:               ${infos.filter((i) => i.normalizerType === 'ObjectNormalizer').length}\n`;
    text += `  PropertyNormalizer:             ${infos.filter((i) => i.normalizerType === 'PropertyNormalizer').length}\n`;
    text += `  GetSetMethodNormalizer:         ${infos.filter((i) => i.normalizerType === 'GetSetMethodNormalizer').length}\n`;
    text += `  DateTimeNormalizer:             ${infos.filter((i) => i.normalizerType === 'DateTimeNormalizer').length}\n`;
    text += `  With circularRefHandler:        ${infos.filter((i) => i.hasCircularRefHandler).length}\n`;
    text += `  With maxDepth enabled:          ${infos.filter((i) => i.hasMaxDepth && i.hasEnabledMaxDepth).length}\n`;
    text += `Total issues:                     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getObjectNormalizerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_object_normalizer_usage',
      description: 'Scan src/ for ObjectNormalizer, PropertyNormalizer, GetSetMethodNormalizer, DateTimeNormalizer; warns on missing CIRCULAR_REFERENCE_HANDLER, MAX_DEPTH without ENABLE_MAX_DEPTH, empty IGNORED_ATTRIBUTES, missing priority',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_object_normalizer_stats',
      description: 'Statistics for object normalizer usage: class count by type, circular-ref handler coverage, max-depth configuration, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
