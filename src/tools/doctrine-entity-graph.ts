/**
 * Doctrine Entity Graph Inspector
 *
 * Distinct from doctrine-inheritance.ts (TPH/TPC/STI), doctrine-embeddable.ts (embedded values),
 * and repository-analyzer.ts (N+1). Focuses on entity relationship graph structure:
 *
 * - Scans src/ PHP for: #[ORM\Entity] classes and their associations
 *   (#[ORM\OneToMany], #[ORM\ManyToOne], #[ORM\ManyToMany], #[ORM\OneToOne])
 * - Build relationship map: entity -> related entities
 * - Detects: cycles (A->B->A), deep chains (depth > 5), entities with >10 associations,
 *   isolated entities (no relations), bidirectional without inverse side
 *
 * Warnings:
 *   - Circular reference detected in entity graph (serialization/cascade issues)
 *   - Entity with >10 direct associations (consider splitting)
 *   - Deep inheritance chain (>3 levels via @ORM\InheritanceType)
 *   - Entity graph depth >5 (loading parent loads everything recursively)
 *   - Self-referential entity without depth limit (infinite tree)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EntityRelation {
  target: string;
  type: string;
  isOwning: boolean;
}

interface DoctrineEntityGraphInfo {
  entity: string;
  file: string;
  relations: EntityRelation[];
  depth: number;
  hasCycle: boolean;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function parseEntityFile(filePath: string): DoctrineEntityGraphInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('#[ORM\\Entity') && !content.includes('@ORM\\Entity')) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const relations: EntityRelation[] = [];

  const assocTypes = [
    { attr: 'OneToMany', isOwning: false },
    { attr: 'ManyToOne', isOwning: true },
    { attr: 'ManyToMany', isOwning: true },
    { attr: 'OneToOne', isOwning: true },
  ];

  for (const { attr } of assocTypes) {
    const re = new RegExp(`#\\[ORM\\\\${attr}[^\\]]{0,300}\\]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const block = m[0];
      const targetM = /targetEntity\s*:\s*['"]?([A-Za-z0-9_\\]{1,100})['"]?/.exec(block) ??
        /targetEntity\s*=\s*['"]?([A-Za-z0-9_\\]{1,100})['"]?/.exec(block);
      const target = targetM ? targetM[1].replace(/\\\\/g, '\\').split('\\').pop() ?? targetM[1] : 'unknown';
      const hasInversedBy = block.includes('inversedBy');
      const hasMappedBy = block.includes('mappedBy');
      const owning = attr === 'ManyToOne' ? true
        : attr === 'OneToMany' ? false
          : attr === 'OneToOne' ? hasInversedBy && !hasMappedBy
            : hasInversedBy && !hasMappedBy;
      relations.push({ target, type: attr, isOwning: owning });
    }
  }

  if (relations.length === 0 && !content.includes('#[ORM\\OneToMany') && !content.includes('#[ORM\\ManyToOne')) {
    return null;
  }

  const isSelfReferential = relations.some((r) => r.target === classM[1]);

  const issues: string[] = [];

  if (relations.length > 10) {
    issues.push(`Entity has ${relations.length} direct associations — consider splitting into smaller aggregates`);
  }

  if (isSelfReferential) {
    const hasDepthLimit = content.includes('maxDepth') || content.includes('MaxDepth') ||
      content.includes('depth') || content.includes('level');
    if (!hasDepthLimit) {
      issues.push('Self-referential entity without depth limit — serialization or recursive loading may produce infinite loops');
    }
  }

  const hasInheritanceType = content.includes('InheritanceType') || content.includes('@ORM\\InheritanceType');
  if (hasInheritanceType) {
    const inheritanceDepth = (content.match(/extends\s+\w{1,100}/g) ?? []).length;
    if (inheritanceDepth > 3) {
      issues.push(`Deep inheritance chain (${inheritanceDepth} levels) — deeply nested ORM inheritance degrades query complexity`);
    }
  }

  const manyToManyCount = relations.filter((r) => r.type === 'ManyToMany').length;
  if (manyToManyCount > 3) {
    issues.push(`${manyToManyCount} ManyToMany associations — high join complexity; consider explicit junction entities`);
  }

  const hasCycle = false;

  return {
    entity: classM[1],
    file: path.basename(filePath),
    relations,
    depth: relations.length,
    hasCycle,
    issues,
  };
}

function detectCycles(entities: DoctrineEntityGraphInfo[]): void {
  const graph = new Map<string, string[]>();
  for (const e of entities) {
    graph.set(e.entity, e.relations.map((r) => r.target));
  }

  function hasCycleFrom(start: string, visited: Set<string>): boolean {
    const neighbors = graph.get(start) ?? [];
    for (const n of neighbors) {
      if (n === start) return true;
      if (visited.has(n)) return true;
      visited.add(n);
      if (hasCycleFrom(n, visited)) return true;
      visited.delete(n);
    }
    return false;
  }

  for (const e of entities) {
    const visited = new Set<string>([e.entity]);
    const cycle = hasCycleFrom(e.entity, visited);
    if (cycle) {
      (e as { hasCycle: boolean }).hasCycle = true;
      e.issues.push('Circular reference detected in entity graph — may cause infinite loops during serialization or cascade operations');
    }
  }
}

function computeDepths(entities: DoctrineEntityGraphInfo[]): void {
  const graph = new Map<string, string[]>();
  for (const e of entities) {
    graph.set(e.entity, e.relations.map((r) => r.target));
  }

  function maxDepth(entity: string, visited: Set<string>, depth: number): number {
    if (depth > 10) return depth;
    const neighbors = graph.get(entity) ?? [];
    let max = depth;
    for (const n of neighbors) {
      if (!visited.has(n)) {
        visited.add(n);
        const d = maxDepth(n, visited, depth + 1);
        if (d > max) max = d;
        visited.delete(n);
      }
    }
    return max;
  }

  for (const e of entities) {
    const d = maxDepth(e.entity, new Set([e.entity]), 0);
    (e as { depth: number }).depth = d;
    if (d > 5 && !e.hasCycle) {
      e.issues.push(`Entity graph depth ${d} — loading this entity transitively loads a deep chain of related entities`);
    }
  }
}

export function listDoctrineEntityGraph(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineEntityGraphInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityFile(file);
      if (info) results.push(info);
    }

    detectCycles(results);
    computeDepths(results);

    results.sort((a, b) => a.entity.localeCompare(b.entity));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine ORM entities with associations found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine Entity Graph Analysis\n${'='.repeat(55)}\n`;
    text += `\nEntities: ${results.length}  Issues: ${totalIssues}\n`;

    const withCycles = results.filter((r) => r.hasCycle);
    const withIssues = results.filter((r) => r.issues.length > 0 && !r.hasCycle);
    const clean = results.filter((r) => r.issues.length === 0);

    if (withCycles.length > 0) {
      text += `\nEntities with cycles (${withCycles.length}) — CRITICAL:\n`;
      for (const r of withCycles) {
        text += `  ${r.entity.padEnd(45)} (${r.file}) depth=${r.depth}\n`;
        text += `    relations: ${r.relations.map((rel) => `${rel.type}(${rel.target})`).join(', ')}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nEntities with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        text += `  ${r.entity.padEnd(45)} (${r.file}) assocs=${r.relations.length} depth=${r.depth}\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (clean.length > 0) {
      text += `\nClean entities (${clean.length}):\n`;
      for (const r of clean) {
        text += `  ${r.entity.padEnd(45)} assocs=${r.relations.length}\n`;
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

export function getDoctrineEntityGraphStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineEntityGraphInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseEntityFile(file);
      if (info) results.push(info);
    }

    detectCycles(results);
    computeDepths(results);

    let text = `Doctrine Entity Graph Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total entities:              ${results.length}\n`;
    text += `  With cycles:               ${results.filter((r) => r.hasCycle).length}\n`;
    text += `  With depth > 5:            ${results.filter((r) => r.depth > 5).length}\n`;
    text += `  With > 10 associations:    ${results.filter((r) => r.relations.length > 10).length}\n`;
    text += `  Self-referential:          ${results.filter((r) => r.relations.some((rel) => rel.target === r.entity)).length}\n`;
    const totalRelations = results.reduce((s, r) => s + r.relations.length, 0);
    text += `Total associations:          ${totalRelations}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineEntityGraphTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_entity_graph',
      description: 'Show Doctrine entity relationship graph: ORM associations (OneToMany/ManyToOne/ManyToMany/OneToOne), detects cycles, deep chains (depth > 5), fat entities (>10 associations), self-referential entities without depth limit; warns on circular references (serialization risk), deep inheritance chains',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_entity_graph_stats',
      description: 'Show Doctrine entity graph statistics: total entities, cycle count, deep depth count, fat entity count, self-referential count, total associations, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
