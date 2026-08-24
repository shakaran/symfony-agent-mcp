// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Serializer Groups Inspector
 *
 * Distinct from serializer.ts (serializer configuration / normalizer stack).
 * Focuses on #[Groups] attribute usage for normalization/denormalization context:
 *
 * PHP-level analysis:
 *   - #[Groups(['read', 'write'])] on class or property
 *   - normalizationContext: ['groups' => ['read']] in API Platform or controller
 *   - denormalizationContext: ['groups' => ['write']]
 *   - #[SerializedName('custom_name')]
 *
 * Group coverage:
 *   - Groups defined on properties but never referenced in normalizationContext
 *   - normalizationContext group referenced but no property has that group
 *
 * Security-sensitive field analysis:
 *   - Fields named: password, token, secret, apiKey, privateKey, salt, hash, ssn, credit_card, card_number
 *   - If such field has a public-facing group (e.g. 'api', 'public', 'read') → warn
 *
 * Analysis:
 *   - Groups never used in normalization contexts (orphaned group definition)
 *   - Missing Groups on entity used as API Platform resource
 *   - Sensitive field in public-facing serialization group
 *   - Very large group count per class (> 5 groups → complex serialization)
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

const SENSITIVE_FIELD_NAMES = [
  'password', 'plainPassword', 'token', 'accessToken', 'refreshToken',
  'secret', 'apiKey', 'privateKey', 'salt', 'hash', 'ssn',
  'creditCard', 'cardNumber', 'cvv', 'pin',
];

const PUBLIC_GROUP_PATTERNS = ['public', 'api', 'read', 'list', 'show', 'output', 'external'];

interface SerializerGroupInfo {
  class: string;
  file: string;
  groups: string[];
  sensitiveInPublicGroup: string[];
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

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some((s) => lower.includes(s.toLowerCase()));
}

function isPublicGroup(group: string): boolean {
  const lower = group.toLowerCase();
  return PUBLIC_GROUP_PATTERNS.some((p) => lower.includes(p));
}

function parseGroupInfo(filePath: string, appPath: string): SerializerGroupInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  if (!content.includes('#[Groups(') && !content.includes('@Groups(')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const allGroups = new Set<string>();
  for (const m of content.matchAll(/#\[Groups\s*\(\s*\[([^\]]+)\]/g)) {
    for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) allGroups.add(gm[1]);
  }

  if (allGroups.size === 0) return null;

  // Scan per-property sensitive fields in public groups
  const sensitiveInPublicGroup: string[] = [];
  const propRegex = /(?:#\[Groups\s*\(\s*\[([^\]]+)\]\s*\)\s*\]|\*\s*@Groups\s*\(\s*\{([^}]+)\}\s*\))[^$]*\$(\w+)/g;

  for (const m of content.matchAll(propRegex)) {
    const groupsStr = m[1] ?? m[2] ?? '';
    const propName  = m[3] ?? '';
    const propGroups: string[] = [];
    for (const gm of groupsStr.matchAll(/['"]([^'"]+)['"]/g)) propGroups.push(gm[1]);

    if (isSensitiveName(propName) && propGroups.some(isPublicGroup)) {
      sensitiveInPublicGroup.push(`$${propName} in group(s): ${propGroups.filter(isPublicGroup).join(', ')}`);
    }
  }

  const issues: string[] = [];
  if (allGroups.size > 5) {
    issues.push(`${allGroups.size} serialization groups on one class — consider simplifying`);
  }
  for (const sf of sensitiveInPublicGroup) {
    issues.push(`Sensitive field exposed in public group: ${sf}`);
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    groups: [...allGroups],
    sensitiveInPublicGroup,
    issues,
  };
}

function collectContextGroups(appPath: string): Set<string> {
  const used = new Set<string>();
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return used;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('normalizationContext') && !content.includes('groups')) continue;

    for (const m of content.matchAll(/['"]groups['"]\s*=>\s*\[([^\]]+)\]/g)) {
      for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(gm[1]);
    }
    // API Platform #[ApiResource(normalizationContext: [...])]
    for (const m of content.matchAll(/normalizationContext\s*:\s*\[([^\]]+)\]/g)) {
      for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(gm[1]);
    }
  }
  return used;
}

export function listSerializerGroupAttrs(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: SerializerGroupInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseGroupInfo(file, appPath);
      if (info) classes.push(info);
    }

    if (classes.length === 0) {
      return { content: [{ type: 'text', text: 'No #[Groups] attributes found in src/.' }] };
    }

    const contextGroups = collectContextGroups(appPath);
    const allDefinedGroups = new Set(classes.flatMap((c) => c.groups));
    const orphanedGroups   = [...allDefinedGroups].filter((g) => !contextGroups.has(g) && contextGroups.size > 0);

    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0) + orphanedGroups.length;

    let text = `Serializer Groups\n${'='.repeat(55)}\n`;
    text += `\nClasses with groups:   ${classes.length}  Total issues: ${totalIssues}\n`;
    text += `Unique group names:    ${allDefinedGroups.size}\n`;
    if (orphanedGroups.length > 0 && contextGroups.size > 0) {
      text += `Orphaned groups:       ${orphanedGroups.length} (defined but not in any normalizationContext)\n`;
    }

    const withIssues = classes.filter((c) => c.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nClasses with issues:\n`;
      for (const c of withIssues) {
        text += `  ${c.class}  groups: ${c.groups.join(', ')}  (${c.file})\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (orphanedGroups.length > 0) {
      text += `\nOrphaned group names (defined on classes but not referenced in normalizationContext):\n`;
      for (const g of orphanedGroups.slice(0, 10)) text += `  "${g}"\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSerializerGroupStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: SerializerGroupInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseGroupInfo(file, appPath);
        if (info) classes.push(info);
      }
    }

    const allGroups = new Set(classes.flatMap((c) => c.groups));

    let text = `Serializer Group Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with groups:     ${classes.length}\n`;
    text += `Unique groups:           ${allGroups.size}\n`;
    text += `Sensitive in public grp: ${classes.filter((c) => c.sensitiveInPublicGroup.length > 0).length}\n`;
    text += `Large group count (>5):  ${classes.filter((c) => c.groups.length > 5).length}\n`;
    text += `Issues:                  ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSerializerGroupTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_serializer_group_attrs',
      description: 'Show serializer #[Groups] analysis: per-class group definitions, orphaned group detection (defined but not in normalizationContext), sensitive field in public group warning (password/token/secret in api/read/public groups), large group count warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_serializer_group_stats',
      description: 'Show serializer group statistics: class count, unique group count, sensitive-in-public count, large-group count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
