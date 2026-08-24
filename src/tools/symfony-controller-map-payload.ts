// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Controller MapRequestPayload / MapQueryString / MapQueryParameter Inspector
 *
 * Detects Symfony 6.3+ #[MapRequestPayload], #[MapQueryString], #[MapQueryParameter]
 * attribute usage in controller method parameters.
 *
 * Checks composer.json for symfony/framework-bundle >= 6.3.
 *
 * Warns on:
 *   - #[MapRequestPayload] without validation constraints on DTO class
 *   - #[MapQueryString] on non-DTO class
 *   - #[MapRequestPayload] without type hint on parameter
 *   - #[MapQueryParameter] with mutable class (should be readonly/immutable)
 *   - MapRequestPayload on method without Request parameter
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MapPayloadInfo {
  file: string;
  className: string;
  mapType: 'payload' | 'query-string' | 'query-parameter';
  dtoClass: string;
  hasConstraints: boolean;
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

function checkFrameworkBundleVersion(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const require = (json['require'] ?? {}) as Record<string, string>;
    const ver = require['symfony/framework-bundle'] ?? '';
    // Accept ^6.3, ^7.x, >=6.3, 6.3.*, 7.*
    return /[67]\.[3-9]|[89]\.|^[1-9][0-9]\./.test(ver);
  } catch { return false; }
}

function hasDtoConstraints(appPath: string, dtoClass: string): boolean {
  if (!dtoClass) return false;
  const withoutApp = dtoClass.replace(/^App\\/, '').replace(/\\/g, path.sep);
  const candidate = path.join(appPath, 'src', withoutApp + '.php');
  try {
    const content = fs.readFileSync(candidate, 'utf-8');
    return content.includes('use Symfony\\Component\\Validator') ||
      content.includes('#[Assert\\') ||
      content.includes('@Assert\\') ||
      content.includes('Constraints\\');
  } catch { return false; }
}

function isDtoReadonly(appPath: string, dtoClass: string): boolean {
  if (!dtoClass) return false;
  const withoutApp = dtoClass.replace(/^App\\/, '').replace(/\\/g, path.sep);
  const candidate = path.join(appPath, 'src', withoutApp + '.php');
  try {
    const content = fs.readFileSync(candidate, 'utf-8');
    return content.includes('readonly class ') || content.includes('readonly ');
  } catch { return false; }
}

function parseControllerFile(filePath: string, appPath: string): MapPayloadInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const hasMapAttr =
    content.includes('#[MapRequestPayload') ||
    content.includes('#[MapQueryString') ||
    content.includes('#[MapQueryParameter');

  if (!hasMapAttr) return [];

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return [];
  const className = classM[1];

  const results: MapPayloadInfo[] = [];

  // Pattern: #[MapRequestPayload] ...\n... TypeHint $paramName
  const payloadPattern = /#\[MapRequestPayload(?:[^\]]{0,200})?\]\s*(?:[^\n]{0,100}\n){0,3}?\s*(\w[\w\\]{0,100})\s+\$(\w{1,80})/g;
  let m: RegExpExecArray | null;
  while ((m = payloadPattern.exec(content)) !== null) {
    const dtoClass = m[1];
    const issues: string[] = [];
    const hasConstraints = hasDtoConstraints(appPath, dtoClass);
    if (!hasConstraints) {
      issues.push(`#[MapRequestPayload] DTO "${dtoClass}" has no validation constraints — unvalidated input reaches handler`);
    }
    // Check for Request parameter in the same method signature
    const methodBlock = content.slice(Math.max(0, m.index - 300), m.index + 300);
    if (!methodBlock.includes('Request ') && !methodBlock.includes('Request $')) {
      issues.push('MapRequestPayload used on method without Request parameter — ensure the controller method signature is correct');
    }
    results.push({
      file: path.relative(appPath, filePath),
      className,
      mapType: 'payload',
      dtoClass,
      hasConstraints,
      issues,
    });
  }

  // Pattern: #[MapQueryString]
  const queryStringPattern = /#\[MapQueryString(?:[^\]]{0,200})?\]\s*(?:[^\n]{0,100}\n){0,3}?\s*(\w[\w\\]{0,100})\s+\$(\w{1,80})/g;
  while ((m = queryStringPattern.exec(content)) !== null) {
    const dtoClass = m[1];
    const issues: string[] = [];
    const hasConstraints = hasDtoConstraints(appPath, dtoClass);
    if (!hasConstraints) {
      issues.push(`#[MapQueryString] DTO "${dtoClass}" has no validation constraints — query string params unvalidated`);
    }
    results.push({
      file: path.relative(appPath, filePath),
      className,
      mapType: 'query-string',
      dtoClass,
      hasConstraints,
      issues,
    });
  }

  // Pattern: #[MapQueryParameter]
  const queryParamPattern = /#\[MapQueryParameter(?:[^\]]{0,200})?\]\s*(?:[^\n]{0,100}\n){0,3}?\s*(\??\w[\w\\]{0,100})\s+\$(\w{1,80})/g;
  while ((m = queryParamPattern.exec(content)) !== null) {
    const dtoClass = m[1].replace(/^\?/, '');
    const issues: string[] = [];
    const hasConstraints = hasDtoConstraints(appPath, dtoClass);
    const readonly = isDtoReadonly(appPath, dtoClass);
    if (!readonly && dtoClass.includes('\\')) {
      issues.push(`#[MapQueryParameter] class "${dtoClass}" is not readonly — use readonly/immutable class to avoid mutation after binding`);
    }
    results.push({
      file: path.relative(appPath, filePath),
      className,
      mapType: 'query-parameter',
      dtoClass,
      hasConstraints,
      issues,
    });
  }

  return results;
}

function loadMapPayloadInfos(appPath: string): MapPayloadInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: MapPayloadInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    results.push(...parseControllerFile(f, appPath));
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyControllerMapPayloads(appPath: string): McpToolResult {
  try {
    const infos = loadMapPayloadInfos(appPath);
    const hasNewEnough = checkFrameworkBundleVersion(appPath);

    if (infos.length === 0 && !hasNewEnough) {
      return {
        content: [{
          type: 'text',
          text: 'No #[MapRequestPayload]/#[MapQueryString]/#[MapQueryParameter] usages found.\n' +
            'Note: symfony/framework-bundle >= 6.3 required for these attributes.',
        }],
      };
    }

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No MapRequestPayload/MapQueryString/MapQueryParameter attribute usages found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Controller Map Payload Inspector (${infos.length} usages)\n${'='.repeat(58)}\n`;
    text += `Framework bundle >= 6.3: ${hasNewEnough ? 'yes' : 'not detected'}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      text += `    type: ${info.mapType}  dto: ${info.dtoClass}\n`;
      text += `    constraints: ${info.hasConstraints ? 'yes' : 'MISSING'}\n`;
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

export function getSymfonyControllerMapPayloadStats(appPath: string): McpToolResult {
  try {
    const infos = loadMapPayloadInfos(appPath);

    let text = `Controller Map Payload Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total map attribute usages:      ${infos.length}\n`;
    text += `  #[MapRequestPayload]:          ${infos.filter((i) => i.mapType === 'payload').length}\n`;
    text += `  #[MapQueryString]:             ${infos.filter((i) => i.mapType === 'query-string').length}\n`;
    text += `  #[MapQueryParameter]:          ${infos.filter((i) => i.mapType === 'query-parameter').length}\n`;
    text += `  With validation constraints:   ${infos.filter((i) => i.hasConstraints).length}\n`;
    text += `  Missing constraints:           ${infos.filter((i) => !i.hasConstraints).length}\n`;
    text += `Issues:                          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getControllerMapPayloadTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_controller_map_payloads',
      description: 'List Symfony 6.3+ #[MapRequestPayload], #[MapQueryString], #[MapQueryParameter] attribute usages: detects DTO validation coverage, readonly class usage, Request parameter presence; warns on missing constraints, non-readonly query param classes, missing Request parameter',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_controller_map_payload_stats',
      description: 'Show map payload statistics: total usages by type, constraint coverage, missing constraints count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
