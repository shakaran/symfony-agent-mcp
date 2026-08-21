/**
 * Doctrine Association Fetch Mode Inspector
 *
 * Distinct from doctrine-query-builder.ts (query construction) and entities.ts (entity structure).
 * Focuses on fetch mode configuration on Doctrine ORM associations:
 *
 * Fetch modes on associations:
 *   - fetch: 'LAZY'       — default; proxy loaded on first access (N+1 risk)
 *   - fetch: 'EAGER'      — loaded immediately with JOIN on entity load
 *   - fetch: 'EXTRA_LAZY' — count/contains/slice without loading whole collection
 *
 * PHP attribute syntax:
 *   #[ORM\OneToMany(targetEntity: Comment::class, fetch: 'EXTRA_LAZY')]
 *   #[ORM\ManyToOne(fetch: 'EAGER')]
 *   #[ORM\ManyToMany(fetch: 'LAZY')]
 *
 * OrderBy on collections:
 *   #[ORM\OrderBy(['createdAt' => 'DESC'])]
 *
 * Analysis:
 *   - EAGER on OneToMany/ManyToMany with large collections (loads all rows)
 *   - EXTRA_LAZY on ManyToOne/OneToOne (single object, EXTRA_LAZY has no benefit)
 *   - LAZY without any join hint in queries (N+1 if iterated)
 *   - #[OrderBy] on collection without index on that column (sort without index)
 *   - ManyToMany with EAGER (both sides loaded = cartesian product risk)
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

interface AssociationFetch {
  property: string;
  type: 'OneToMany' | 'ManyToOne' | 'ManyToMany' | 'OneToOne';
  fetch: string;
  orderBy?: string;
  issues: string[];
}

interface EntityFetchInfo {
  class: string;
  file: string;
  associations: AssociationFetch[];
  issues: string[];
}

const COLLECTION_TYPES = new Set(['OneToMany', 'ManyToMany']);

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

const PROP_REGEX = /(?:private|protected|public)\s+(?:\??\S+\s+)?\$(\w+)/;

function parseEntityFetch(filePath: string, appPath: string): EntityFetchInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isEntity = content.includes('#[ORM\\Entity') || content.includes('#[Entity') ||
                   content.includes('@ORM\\Entity');
  if (!isEntity) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const associations: AssociationFetch[] = [];

  // Split content into lines to find property name after attribute
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const assocM = /#\[(?:ORM\\)?(OneToMany|ManyToOne|ManyToMany|OneToOne)/.exec(line);
    if (!assocM) continue;

    const assocType = assocM[1] as AssociationFetch['type'];

    // Collect the full attribute block (may span multiple lines)
    let block = '';
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      block += lines[j] + '\n';
      if (block.includes(')') && block.includes('(')) break;
    }

    const fetchM   = /fetch\s*:\s*['"](\w+)['"]/.exec(block);
    const fetchMode = fetchM?.[1]?.toUpperCase() ?? 'LAZY';

    // Look ahead for property name
    let propName = 'unknown';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const propM = PROP_REGEX.exec(lines[j]);
      if (propM) { propName = propM[1]; break; }
    }

    // Check for OrderBy
    let orderBy: string | undefined;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j < 0 || j >= lines.length) continue;
      if (lines[j].includes('#[ORM\\OrderBy') || lines[j].includes('#[OrderBy')) {
        orderBy = lines[j].trim();
        break;
      }
    }

    const issues: string[] = [];
    if (fetchMode === 'EAGER' && COLLECTION_TYPES.has(assocType)) {
      issues.push(`${assocType} with EAGER fetch — loads entire collection on entity load (performance risk for large collections)`);
    }
    if (fetchMode === 'EAGER' && assocType === 'ManyToMany') {
      issues.push('ManyToMany with EAGER — may produce cartesian product JOIN');
    }
    if (fetchMode === 'EXTRA_LAZY' && !COLLECTION_TYPES.has(assocType)) {
      issues.push(`${assocType} with EXTRA_LAZY — extra lazy has no benefit on to-one associations`);
    }

    if (fetchMode !== 'LAZY' || orderBy || issues.length > 0) {
      associations.push({ property: propName, type: assocType, fetch: fetchMode, orderBy, issues });
    }
  }

  const entityIssues = associations.flatMap((a) => a.issues);
  if (associations.length === 0) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    associations,
    issues: entityIssues,
  };
}

export function listFetchModes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const entities: EntityFetchInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityFetch(file, appPath);
      if (info) entities.push(info);
    }

    if (entities.length === 0) {
      return { content: [{ type: 'text', text: 'No non-default fetch modes found. All associations use fetch: LAZY (default).' }] };
    }

    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);
    const totalAssocs = entities.reduce((s, e) => s + e.associations.length, 0);

    let text = `Doctrine Association Fetch Modes\n${'='.repeat(55)}\n`;
    text += `\nEntities with non-default fetch: ${entities.length}  Associations: ${totalAssocs}  Issues: ${totalIssues}\n`;

    // Summary table
    const allAssocs = entities.flatMap((e) => e.associations);
    const extraLazy = allAssocs.filter((a) => a.fetch === 'EXTRA_LAZY').length;
    const eager     = allAssocs.filter((a) => a.fetch === 'EAGER').length;
    text += `  EXTRA_LAZY: ${extraLazy}  EAGER: ${eager}\n`;

    for (const e of entities.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
      text += `\n  ${e.class}  (${e.file})\n`;
      for (const a of e.associations) {
        const orderStr = a.orderBy ? '  [OrderBy]' : '';
        text += `    ${a.type.padEnd(12)} $${a.property.padEnd(20)} fetch: ${a.fetch}${orderStr}\n`;
        for (const issue of a.issues) text += `      ⚠ ${issue}\n`;
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

export function getFetchModeStats(appPath: string): McpToolResult {
  try {
    const srcDir  = path.join(appPath, 'src');
    const entities: EntityFetchInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseEntityFetch(file, appPath);
        if (info) entities.push(info);
      }
    }

    const allAssocs = entities.flatMap((e) => e.associations);

    let text = `Fetch Mode Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities with custom fetch: ${entities.length}\n`;
    text += `Non-default associations:   ${allAssocs.length}\n`;
    text += `  EXTRA_LAZY:               ${allAssocs.filter((a) => a.fetch === 'EXTRA_LAZY').length}\n`;
    text += `  EAGER:                    ${allAssocs.filter((a) => a.fetch === 'EAGER').length}\n`;
    text += `  With OrderBy:             ${allAssocs.filter((a) => a.orderBy).length}\n`;
    text += `Issues:                     ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineAssocFetchTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_fetch_modes',
      description: 'Show Doctrine association non-default fetch modes: EXTRA_LAZY/EAGER on OneToMany/ManyToMany/ManyToOne/OneToOne, #[OrderBy] on collections, EAGER-on-collection performance warning, EXTRA_LAZY-on-to-one no-benefit warning, ManyToMany EAGER cartesian product warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_fetch_mode_stats',
      description: 'Show fetch mode statistics: entities with custom fetch, EXTRA_LAZY/EAGER/OrderBy counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
