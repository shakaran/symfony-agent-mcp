/**
 * Symfony Serializer Denormalization Inspector
 *
 * Distinct from serializer.ts (groups/profiles), api-platform-serialization-context.ts (API Platform),
 * and input-dto.ts (DTO validation). Focuses on denormalization patterns:
 *
 * - Scans src/ PHP for: OBJECT_TO_POPULATE context key, $serializer->denormalize() calls,
 *   AbstractNormalizer::OBJECT_TO_POPULATE, constructor argument denormalization
 *   (#[SerializedName] on constructor params), DenormalizableInterface implementations
 * - Detects context options used: OBJECT_TO_POPULATE, GROUPS, ALLOW_EXTRA_ATTRIBUTES, DISABLE_TYPE_ENFORCEMENT
 *
 * Warnings:
 *   - OBJECT_TO_POPULATE with entity fetched inside denormalizer (N+1 risk)
 *   - denormalize() without ALLOW_EXTRA_ATTRIBUTES: false (extra fields silently ignored)
 *   - DISABLE_TYPE_ENFORCEMENT: true (bypasses type safety)
 *   - DenormalizableInterface without handling unknown keys
 *   - denormalize to Doctrine entity with ID from user input (entity injection risk)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface SerializerDenormalizationInfo {
  file: string;
  class: string;
  usesObjectToPopulate: boolean;
  usesAllowExtra: boolean;
  usesDisableTypeEnforcement: boolean;
  hasDenormalizableInterface: boolean;
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

function parseDenormalizationFile(filePath: string): SerializerDenormalizationInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasDenormalize = content.includes('->denormalize(') ||
    content.includes('OBJECT_TO_POPULATE') ||
    content.includes('DenormalizableInterface') ||
    content.includes('ALLOW_EXTRA_ATTRIBUTES') ||
    content.includes('DISABLE_TYPE_ENFORCEMENT');

  if (!hasDenormalize) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const usesObjectToPopulate = content.includes('OBJECT_TO_POPULATE') ||
    content.includes('object_to_populate');

  const usesAllowExtra = content.includes('ALLOW_EXTRA_ATTRIBUTES') ||
    content.includes('allow_extra_attributes');

  const usesDisableTypeEnforcement = content.includes('DISABLE_TYPE_ENFORCEMENT') ||
    content.includes('disable_type_enforcement');

  const hasDenormalizableInterface = content.includes('DenormalizableInterface') ||
    content.includes('implements Denormalizable');

  const hasDenormalizeCall = content.includes('->denormalize(');
  const hasSerializedNameOnConstructor = content.includes('#[SerializedName]') &&
    content.includes('__construct');

  const issues: string[] = [];

  if (usesObjectToPopulate) {
    const hasEntityFetch = content.includes('->find(') || content.includes('->findOneBy(') ||
      content.includes('getRepository(');
    if (hasEntityFetch) {
      issues.push('OBJECT_TO_POPULATE with entity fetched inside denormalizer — N+1 risk if called per item in a collection');
    }
  }

  if (hasDenormalizeCall && !usesAllowExtra) {
    issues.push('denormalize() without ALLOW_EXTRA_ATTRIBUTES: false — extra fields from user input are silently ignored, masking data issues');
  }

  if (usesDisableTypeEnforcement) {
    issues.push('DISABLE_TYPE_ENFORCEMENT: true — bypasses type safety, values may be passed in wrong type without error');
  }

  if (hasDenormalizableInterface) {
    const hasUnknownKeyHandling = content.includes('array_diff_key') ||
      content.includes('array_keys') ||
      content.includes('unknown') ||
      content.includes('extra');
    if (!hasUnknownKeyHandling) {
      issues.push('DenormalizableInterface without handling unknown keys — extra properties from user input silently discarded');
    }
  }

  if (hasDenormalizeCall || usesObjectToPopulate) {
    const hasIdFromInput = (content.includes("['id']") || content.includes('["id"]') ||
      content.includes("->get('id')")) &&
      (content.includes('->find(') || content.includes('->findOneBy('));
    if (hasIdFromInput) {
      issues.push('denormalize to Doctrine entity with ID from user input — entity injection risk; validate/authorize the ID before fetching');
    }
  }

  if (hasSerializedNameOnConstructor) {
    const hasAllowExtraFalse = content.includes('ALLOW_EXTRA_ATTRIBUTES') &&
      (content.includes('false') || content.includes('FALSE'));
    if (!hasAllowExtraFalse) {
      issues.push('#[SerializedName] on constructor params without ALLOW_EXTRA_ATTRIBUTES: false — unknown constructor args silently ignored');
    }
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    usesObjectToPopulate,
    usesAllowExtra,
    usesDisableTypeEnforcement,
    hasDenormalizableInterface,
    issues,
  };
}

export function listSerializerDenormalization(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SerializerDenormalizationInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDenormalizationFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No serializer denormalization usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Serializer Denormalization Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const withIssues = results.filter((r) => r.issues.length > 0);
    const clean = results.filter((r) => r.issues.length === 0);

    if (withIssues.length > 0) {
      text += `\nFiles with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        const flags: string[] = [];
        if (r.usesObjectToPopulate) flags.push('OTP');
        if (r.usesAllowExtra) flags.push('ALLOW_EXTRA');
        if (r.usesDisableTypeEnforcement) flags.push('DISABLE_TYPE');
        if (r.hasDenormalizableInterface) flags.push('Denormalizable');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (clean.length > 0) {
      text += `\nClean files (${clean.length}):\n`;
      for (const r of clean) {
        const flags: string[] = [];
        if (r.usesObjectToPopulate) flags.push('OTP');
        if (r.usesAllowExtra) flags.push('ALLOW_EXTRA');
        if (r.hasDenormalizableInterface) flags.push('Denormalizable');
        text += `  ${r.class.padEnd(45)} (${r.file})`;
        if (flags.length > 0) text += ` [${flags.join(', ')}]`;
        text += '\n';
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

export function getSerializerDenormalizationStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: SerializerDenormalizationInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseDenormalizationFile(file);
      if (info) results.push(info);
    }

    let text = `Serializer Denormalization Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total files with denormalization:  ${results.length}\n`;
    text += `  Using OBJECT_TO_POPULATE:        ${results.filter((r) => r.usesObjectToPopulate).length}\n`;
    text += `  Using ALLOW_EXTRA_ATTRIBUTES:    ${results.filter((r) => r.usesAllowExtra).length}\n`;
    text += `  Using DISABLE_TYPE_ENFORCEMENT:  ${results.filter((r) => r.usesDisableTypeEnforcement).length}\n`;
    text += `  Implements DenormalizableInterface: ${results.filter((r) => r.hasDenormalizableInterface).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSerializerDenormalizationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_serializer_denormalization',
      description: 'Show serializer denormalization patterns: OBJECT_TO_POPULATE usage, ALLOW_EXTRA_ATTRIBUTES, DISABLE_TYPE_ENFORCEMENT, DenormalizableInterface implementations; warns on N+1 risk with entity fetch in denormalizer, missing ALLOW_EXTRA_ATTRIBUTES:false, type enforcement bypass, entity injection risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_serializer_denormalization_stats',
      description: 'Show serializer denormalization statistics: total files, OBJECT_TO_POPULATE usage count, ALLOW_EXTRA_ATTRIBUTES count, DISABLE_TYPE_ENFORCEMENT count, DenormalizableInterface count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
