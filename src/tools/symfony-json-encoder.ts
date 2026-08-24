// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony JsonEncoder Component Inspector
 *
 * Detects symfony/json-encoder component usage (Symfony 7.3+, experimental).
 * Scans src/ PHP for: use Symfony\Component\JsonEncoder, JsonEncoder, JsonDecoder,
 *   #[EncodedName], JsonEncodable, JsonDecodable.
 *
 * Checks composer.json for symfony/json-encoder.
 *
 * Warns on:
 *   - json-encoder used in same project as standard serializer for same entities
 *     (inconsistency)
 *   - #[EncodedName] without matching snake_case (naming mismatch)
 *   - JsonDecodable without readonly properties (not fully immutable decode target)
 *   - missing #[EncodedName] on properties with camelCase names (will serialize as camelCase)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface JsonEncoderInfo {
  file: string;
  className: string;
  hasEncodedName: boolean;
  hasReadonlyProps: boolean;
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

function hasJsonEncoderPackage(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    return 'symfony/json-encoder' in req;
  } catch { return false; }
}

function hasSerializerPackage(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    return 'symfony/serializer' in req;
  } catch { return false; }
}

function hasCamelCasePropsWithoutEncodedName(content: string): boolean {
  // Find public properties that look camelCase (have uppercase after first char)
  const propPattern = /(?:public|protected)\s+(?:readonly\s+)?(?:\??\w[\w\\]{0,60})\s+\$([a-z][a-zA-Z]{1,60})\b/g;
  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(content)) !== null) {
    const propName = m[1];
    // Check if camelCase: has uppercase letter in middle
    if (/[a-z][A-Z]/.test(propName)) {
      // Confirm this property doesn't have #[EncodedName] just before it
      const before = content.slice(Math.max(0, m.index - 150), m.index);
      if (!before.includes('#[EncodedName') && !before.includes('@EncodedName')) {
        return true;
      }
    }
  }
  return false;
}

function parseJsonEncoderFile(filePath: string): JsonEncoderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isJsonEncoder =
    content.includes('Symfony\\Component\\JsonEncoder') ||
    content.includes('JsonEncodable') ||
    content.includes('JsonDecodable') ||
    content.includes('JsonEncoder') ||
    content.includes('JsonDecoder') ||
    content.includes('#[EncodedName');

  if (!isJsonEncoder) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];

  const hasEncodedName = content.includes('#[EncodedName') || content.includes('@EncodedName');
  const hasReadonlyProps =
    content.includes('readonly class ') ||
    content.includes('readonly ');

  // Check JsonDecodable without readonly
  const isDecodable = content.includes('JsonDecodable') || content.includes('implements JsonDecodable');
  if (isDecodable && !hasReadonlyProps) {
    issues.push('JsonDecodable class does not use readonly properties — decoded objects may be mutated after construction; prefer readonly for immutability');
  }

  // Check camelCase properties without #[EncodedName]
  if (!hasEncodedName && hasCamelCasePropsWithoutEncodedName(content)) {
    issues.push('Class has camelCase properties without #[EncodedName] — properties will serialize using camelCase keys; add #[EncodedName] for explicit snake_case JSON keys');
  }

  // Check #[EncodedName] has snake_case value
  const encodedNamePattern = /#\[EncodedName\s*\(\s*['"]([^'"]{1,100})['"]/g;
  let enM: RegExpExecArray | null;
  while ((enM = encodedNamePattern.exec(content)) !== null) {
    const nameVal = enM[1];
    if (/[A-Z]/.test(nameVal)) {
      issues.push(`#[EncodedName("${nameVal}")] contains uppercase — JSON encoder names should be snake_case for consistency`);
    }
  }

  return { file: filePath, className, hasEncodedName, hasReadonlyProps, issues };
}

function loadJsonEncoderInfos(appPath: string): JsonEncoderInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: JsonEncoderInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseJsonEncoderFile(f);
    if (r) {
      r.file = path.relative(appPath, r.file);
      results.push(r);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyJsonEncoder(appPath: string): McpToolResult {
  try {
    const infos = loadJsonEncoderInfos(appPath);
    const hasPackage = hasJsonEncoderPackage(appPath);
    const hasSerializer = hasSerializerPackage(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No symfony/json-encoder usages found in src/.\n` +
            `symfony/json-encoder package: ${hasPackage ? 'installed' : 'not found in composer.json'}`,
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony JsonEncoder Inspector (${infos.length} usages)\n${'='.repeat(55)}\n`;
    text += `symfony/json-encoder: ${hasPackage ? 'installed' : 'not detected (experimental)'}\n`;
    text += `symfony/serializer:   ${hasSerializer ? 'also installed — verify no entity is handled by both' : 'not installed'}\n`;

    if (hasPackage && hasSerializer) {
      text += `WARN: Both symfony/json-encoder and symfony/serializer are present — ensure entities are handled by only one serialization mechanism\n`;
    }
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      const flags = [
        info.hasEncodedName ? 'has-@EncodedName' : 'no-@EncodedName',
        info.hasReadonlyProps ? 'readonly' : 'mutable',
      ].join(', ');
      text += `    flags: [${flags}]\n`;
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

export function getSymfonyJsonEncoderStats(appPath: string): McpToolResult {
  try {
    const infos = loadJsonEncoderInfos(appPath);
    const hasPackage = hasJsonEncoderPackage(appPath);
    const hasSerializer = hasSerializerPackage(appPath);

    let text = `JsonEncoder Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/json-encoder installed:  ${hasPackage ? 'yes' : 'no'}\n`;
    text += `symfony/serializer coexists:     ${hasSerializer ? 'yes (potential inconsistency)' : 'no'}\n`;
    text += `Files using JsonEncoder:         ${infos.length}\n`;
    text += `  With #[EncodedName]:           ${infos.filter((i) => i.hasEncodedName).length}\n`;
    text += `  With readonly props:           ${infos.filter((i) => i.hasReadonlyProps).length}\n`;
    text += `Issues:                          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyJsonEncoderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_json_encoder_usage',
      description: 'List Symfony 7.3+ JsonEncoder/JsonDecoder usages: detects #[EncodedName], readonly properties, JsonEncodable/JsonDecodable; warns on camelCase props without @EncodedName, mutable JsonDecodable, non-snake_case encoded names, serializer coexistence',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_json_encoder_stats',
      description: 'Show JsonEncoder statistics: total usages, EncodedName coverage, readonly props coverage, serializer coexistence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
