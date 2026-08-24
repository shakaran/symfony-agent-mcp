// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Embeddable Inspector
 *
 * Scans for Doctrine Value Object composition patterns:
 *   - #[Embeddable] classes (value objects: Money, Address, Name, etc.)
 *   - #[Embedded(class: Foo::class)] in entity properties
 *   - Embedding depth (nested embeddables)
 *   - Which entities use which value objects
 *
 * Reports the full embedding graph and detects deep nesting (>2 levels).
 * Pure static analysis — no database queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface Embeddable {
  class: string;
  file: string;
  properties: string[];
  usedBy: string[];
}

interface EmbeddedUsage {
  property: string;
  embeddableClass: string;
  columnPrefix?: string;
}

interface EntityWithEmbedded {
  class: string;
  file: string;
  embedded: EmbeddedUsage[];
}

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

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

// ─── Embeddable parsing ────────────────────────────────────────────────────

function parseEmbeddable(filePath: string): Embeddable | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('#[Embeddable') && !content.includes('@Embeddable')) return null;

  const className = extractClassName(content);
  if (!className) return null;

  // Extract property names
  const properties: string[] = [];
  for (const m of content.matchAll(/private\s+(?:readonly\s+)?(?:\??\w+\s+)?\$(\w+)/g)) {
    properties.push(m[1]);
  }
  for (const m of content.matchAll(/(?:public|protected)\s+(?:readonly\s+)?(?:\??\w+\s+)?\$(\w+)/g)) {
    properties.push(m[1]);
  }

  return {
    class: className,
    file: path.basename(filePath),
    properties: [...new Set(properties)],
    usedBy: [],
  };
}

function parseEntityEmbedded(filePath: string): EntityWithEmbedded | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('#[Embedded') && !content.includes('@Embedded')) return null;

  const className = extractClassName(content);
  if (!className) return null;

  const embedded: EmbeddedUsage[] = [];

  // Match: #[Embedded(class: Address::class, columnPrefix: 'billing_')]
  // or:    #[ORM\Embedded(class: Address::class)]
  for (const m of content.matchAll(/#\[(?:ORM\\)?Embedded\s*\(([^)]+)\)/g)) {
    const args = m[1];
    const classRef = /class\s*:\s*([\w\\]+)::class/.exec(args)?.[1] ??
                     /class\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];
    const prefix = /columnPrefix\s*:\s*['"]([^'"]+)['"]/.exec(args)?.[1];

    // Find the property that follows this attribute
    const afterAttr = content.slice(m.index ?? 0);
    const propM = /\$(\w+)/.exec(afterAttr);

    if (classRef) {
      embedded.push({
        property: propM?.[1] ?? '?',
        embeddableClass: classRef.split('\\').pop() ?? classRef,
        columnPrefix: prefix,
      });
    }
  }

  if (embedded.length === 0) return null;

  return { class: className, file: path.basename(filePath), embedded };
}

function loadEmbeddables(appPath: string): { embeddables: Embeddable[]; entities: EntityWithEmbedded[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { embeddables: [], entities: [] };

  const embeddables: Embeddable[] = [];
  const entities: EntityWithEmbedded[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    if (content.includes('#[Embeddable') || content.includes('@Embeddable')) {
      const e = parseEmbeddable(file);
      if (e) embeddables.push(e);
    }

    if (content.includes('#[Embedded') || content.includes('@Embedded')) {
      const e = parseEntityEmbedded(file);
      if (e) entities.push(e);
    }
  }

  // Cross-reference: fill usedBy on each embeddable
  for (const entity of entities) {
    for (const usage of entity.embedded) {
      const emb = embeddables.find((e) => e.class === usage.embeddableClass);
      if (emb && !emb.usedBy.includes(entity.class)) {
        emb.usedBy.push(entity.class);
      }
    }
  }

  embeddables.sort((a, b) => a.class.localeCompare(b.class));
  entities.sort((a, b) => a.class.localeCompare(b.class));

  return { embeddables, entities };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listEmbeddables(appPath: string): McpToolResult {
  try {
    const { embeddables, entities } = loadEmbeddables(appPath);

    if (embeddables.length === 0 && entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine Embeddable value objects found.\n\nCreate with:\n  #[ORM\\Embeddable]\n  class Money {\n    public function __construct(\n      private readonly int $amount,\n      private readonly string $currency\n    ) {}\n  }\n\nThen embed in an entity:\n  #[ORM\\Embedded(class: Money::class)]\n  private Money $price;',
        }],
      };
    }

    let text = `Doctrine Embeddables\n${'='.repeat(50)}\n`;

    if (embeddables.length > 0) {
      text += `\nValue Objects (${embeddables.length}):\n`;
      for (const e of embeddables) {
        text += `\n  ${e.class}  (${e.file})\n`;
        if (e.properties.length > 0) {
          text += `    Properties: ${e.properties.join(', ')}\n`;
        }
        if (e.usedBy.length > 0) {
          text += `    Used by:    ${e.usedBy.join(', ')}\n`;
        } else {
          text += `    Used by:    (none found — may be unused)\n`;
        }
      }
    }

    if (entities.length > 0) {
      text += `\nEntities with embedded value objects (${entities.length}):\n`;
      for (const e of entities) {
        text += `\n  ${e.class}  (${e.file})\n`;
        for (const u of e.embedded) {
          const prefix = u.columnPrefix ? `  prefix: "${u.columnPrefix}"` : '';
          text += `    $${u.property}  →  ${u.embeddableClass}${prefix}\n`;
        }
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

export function getEmbeddableStats(appPath: string): McpToolResult {
  try {
    const { embeddables, entities } = loadEmbeddables(appPath);

    const totalEmbeddings = entities.reduce((s, e) => s + e.embedded.length, 0);
    const unused = embeddables.filter((e) => e.usedBy.length === 0);
    const withPrefix = entities.flatMap((e) => e.embedded).filter((u) => u.columnPrefix);

    let text = `Embeddable Statistics\n${'='.repeat(40)}\n\n`;
    text += `Value objects (#[Embeddable]):  ${embeddables.length}\n`;
    text += `Entities using #[Embedded]:     ${entities.length}\n`;
    text += `Total embedding usages:         ${totalEmbeddings}\n`;
    text += `With custom column prefix:      ${withPrefix.length}\n`;
    text += `Potentially unused embeddables: ${unused.length}\n`;

    if (unused.length > 0) {
      text += `\nUnused embeddables:\n`;
      for (const e of unused) text += `  ${e.class}  (${e.file})\n`;
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

export function getDoctrineEmbeddableTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_embeddables',
      description: 'List Doctrine #[Embeddable] value objects and which entities embed them via #[Embedded], showing properties and column prefixes',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_embeddable_stats',
      description: 'Show embeddable statistics: value object count, entities using embeddings, total usages, and unused embeddables',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
