// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Extensions (Gedmo) Inspector
 *
 * Detects Gedmo/DoctrineExtensions usage in entities:
 *   - #[Gedmo\Timestampable] / @Gedmo\Timestampable
 *   - #[Gedmo\Sluggable] / @Gedmo\Sluggable
 *   - #[Gedmo\SoftDeleteable]
 *   - #[Gedmo\Blameable]
 *   - #[Gedmo\Tree] (Nested Set, Closure, Materialized Path)
 *   - #[Gedmo\Sortable] / #[Gedmo\SortablePosition]
 *   - #[Gedmo\Translatable]
 *   - #[Gedmo\Loggable] / #[Gedmo\Versioned]
 *   - #[Gedmo\IpTraceable]
 *
 * Pure static analysis — no database queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

type GedmoExtension =
  | 'Timestampable' | 'Sluggable' | 'SoftDeleteable' | 'Blameable'
  | 'Tree' | 'Sortable' | 'Translatable' | 'Loggable' | 'IpTraceable';

interface GedmoUsage {
  extension: GedmoExtension;
  property?: string;
  options?: string;
}

interface EntityGedmo {
  class: string;
  file: string;
  extensions: GedmoUsage[];
}

// ─── Detection patterns ────────────────────────────────────────────────────

const EXTENSION_PATTERNS: Array<{ ext: GedmoExtension; re: RegExp; classLevel?: boolean }> = [
  { ext: 'Timestampable', re: /#\[Gedmo\\Timestampable\s*\(([^)]*)\)\]|@Gedmo\\Timestampable\([^)]*\)/g },
  { ext: 'Sluggable',     re: /#\[Gedmo\\Sluggable\s*\(([^)]*)\)\]|@Gedmo\\Sluggable\([^)]*\)/g },
  { ext: 'SoftDeleteable',re: /#\[Gedmo\\SoftDeleteable[^\]]*\]|@Gedmo\\SoftDeleteable/g, classLevel: true },
  { ext: 'Blameable',     re: /#\[Gedmo\\Blameable\s*\(([^)]*)\)\]|@Gedmo\\Blameable\([^)]*\)/g },
  { ext: 'Tree',          re: /#\[Gedmo\\Tree[^\]]*\]|@Gedmo\\Tree/g, classLevel: true },
  { ext: 'Sortable',      re: /#\[Gedmo\\Sortable[^\]]*\]|@Gedmo\\Sortable/g },
  { ext: 'Translatable',  re: /#\[Gedmo\\Translatable[^\]]*\]|@Gedmo\\Translatable/g },
  { ext: 'Loggable',      re: /#\[Gedmo\\Loggable[^\]]*\]|@Gedmo\\Loggable/g, classLevel: true },
  { ext: 'IpTraceable',   re: /#\[Gedmo\\IpTraceable\s*\(([^)]*)\)\]|@Gedmo\\IpTraceable\([^)]*\)/g },
];

const EXTENSION_DESCRIPTIONS: Record<GedmoExtension, string> = {
  Timestampable:  'Auto-sets createdAt/updatedAt on persist/update',
  Sluggable:      'Auto-generates URL slug from specified fields',
  SoftDeleteable: 'Soft-delete: sets deletedAt instead of removing the row',
  Blameable:      'Auto-sets createdBy/updatedBy from security token',
  Tree:           'Hierarchical data (Nested Set / Closure / Materialized Path)',
  Sortable:       'Ordered lists with auto-managed position field',
  Translatable:   'Multi-locale field translations via separate translation table',
  Loggable:       'Change log / audit trail for entity modifications',
  IpTraceable:    'Auto-sets IP address fields on persist/update',
};

// ─── File scanning ──────────────────────────────────────────────────────────


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

function parseEntityGedmo(filePath: string): EntityGedmo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('Gedmo\\')) return null;

  const classM = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const extensions: GedmoUsage[] = [];

  for (const { ext, re } of EXTENSION_PATTERNS) {
    const pattern = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      // Try to find the property name just after the attribute
      const after = content.slice(m.index);
      const propM = /(?:private|protected|public)\s+(?:readonly\s+)?(?:\??\w+\s+)?\$(\w+)/.exec(after);
      extensions.push({
        extension: ext,
        property: propM?.[1],
        options: m[1]?.trim() || undefined,
      });
    }
  }

  if (extensions.length === 0) return null;

  return {
    class: classM[1],
    file: path.basename(filePath),
    extensions,
  };
}

function loadGedmoEntities(appPath: string): EntityGedmo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const entities: EntityGedmo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const e = parseEntityGedmo(file);
    if (e) entities.push(e);
  }
  return entities.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listDoctrineExtensions(appPath: string): McpToolResult {
  try {
    const entities = loadGedmoEntities(appPath);

    if (entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Gedmo Doctrine Extensions found.\n\nInstall: composer require gedmo/doctrine-extensions\nThen annotate entities:\n  #[Gedmo\\Timestampable(on: \'create\')]\n  private ?\\DateTimeImmutable $createdAt = null;',
        }],
      };
    }

    // Aggregate which extensions are used across the project
    const extCount: Partial<Record<GedmoExtension, number>> = {};
    for (const e of entities) {
      for (const u of e.extensions) {
        extCount[u.extension] = (extCount[u.extension] ?? 0) + 1;
      }
    }

    let text = `Doctrine Extensions / Gedmo  (${entities.length} entities)\n${'='.repeat(60)}\n`;

    text += `\nExtensions in use:\n`;
    for (const [ext, count] of Object.entries(extCount) as [GedmoExtension, number][]) {
      text += `  ${ext.padEnd(18)} ${count}x  — ${EXTENSION_DESCRIPTIONS[ext]}\n`;
    }

    text += `\nPer entity:\n`;
    for (const e of entities) {
      text += `\n  ${e.class}  (${e.file})\n`;
      for (const u of e.extensions) {
        const prop = u.property ? `  $${u.property}` : '';
        const opts = u.options ? `  (${u.options})` : '';
        text += `    #[${u.extension}]${prop}${opts}\n`;
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

export function getDoctrineExtensionStats(appPath: string): McpToolResult {
  try {
    const entities = loadGedmoEntities(appPath);

    const extCount: Partial<Record<GedmoExtension, number>> = {};
    for (const e of entities) {
      for (const u of e.extensions) {
        extCount[u.extension] = (extCount[u.extension] ?? 0) + 1;
      }
    }

    let text = `Doctrine Extensions Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities using Gedmo: ${entities.length}\n`;
    text += `Distinct extensions:  ${Object.keys(extCount).length}\n`;

    if (Object.keys(extCount).length > 0) {
      text += `\nUsage by extension:\n`;
      const sorted = (Object.entries(extCount) as [GedmoExtension, number][])
        .sort((a, b) => b[1] - a[1]);
      for (const [ext, count] of sorted) {
        text += `  ${ext.padEnd(18)} ${count} entities\n`;
      }
    }

    const softDeleteable = entities.filter((e) => e.extensions.some((u) => u.extension === 'SoftDeleteable'));
    if (softDeleteable.length > 0) {
      text += `\nSoft-deleteable entities:\n`;
      for (const e of softDeleteable) text += `  ${e.class}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getDoctrineExtensionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_doctrine_extensions',
      description: 'List Gedmo Doctrine Extensions used in entities: Timestampable, Sluggable, SoftDeleteable, Blameable, Tree, Sortable, Translatable, Loggable, IpTraceable',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_extension_stats',
      description: 'Show Gedmo extension statistics: entity count by extension type, list of soft-deleteable entities',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
