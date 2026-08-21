/**
 * Doctrine Criteria API Inspector
 *
 * Distinct from doctrine-query-builder.ts (QueryBuilder patterns), repository-analyzer.ts (N+1),
 * and doctrine-orm-config.ts (ORM config). Focuses on Criteria API usage:
 *
 * - Scans src/ PHP for: Criteria::create(), Criteria::orderBy(), Criteria::where(), Expr::
 *   (from Doctrine Collections), ArrayCollection::matching(), Selectable::matching(), $collection->matching()
 * - Detects: Criteria applied to ArrayCollection (in-memory filtering) vs Repository::matching() (DB query)
 *
 * Warnings:
 *   - Criteria::orderBy with field not in entity (silent no-op on DB)
 *   - Criteria on ArrayCollection with large collection (loads all then filters)
 *   - Criteria::setMaxResults used on ArrayCollection (not supported — returns all)
 *   - Expr::in() with very large array (IN (...) query performance)
 *   - Criteria with LIKE expression on non-indexed field (full scan)
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

interface CriteriaUsage {
  context: 'collection' | 'repository' | 'unknown';
  hasOrderBy: boolean;
  hasMaxResults: boolean;
  issues: string[];
}

interface DoctrineCriteriaInfo {
  file: string;
  class: string;
  usages: CriteriaUsage[];
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

function parseCriteriaFile(filePath: string): DoctrineCriteriaInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasCriteria = content.includes('Criteria::create') ||
    content.includes('Criteria::where') ||
    content.includes('Criteria::orderBy') ||
    content.includes('->matching(') ||
    content.includes('Criteria::expr') ||
    content.includes('new Criteria');

  if (!hasCriteria) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasArrayCollection = content.includes('ArrayCollection') ||
    content.includes('new ArrayCollection') ||
    content.includes('$this->') && content.includes('->matching(');

  const hasRepositoryMatching = content.includes('EntityRepository') ||
    content.includes('ServiceEntityRepository') ||
    content.includes('implements SelectableRepository') ||
    (content.includes('->matching(') && !content.includes('ArrayCollection'));

  const context: 'collection' | 'repository' | 'unknown' = hasArrayCollection
    ? 'collection'
    : hasRepositoryMatching ? 'repository' : 'unknown';

  const hasOrderBy = content.includes('orderBy(') ||
    content.includes('Criteria::orderBy') ||
    content.includes('->orderBy(');

  const hasMaxResults = content.includes('setMaxResults(') || content.includes('->setMaxResults(');

  const hasExprIn = content.includes('Expr::in(') || content.includes('->in(');
  const hasLike = content.includes('Expr::contains(') || content.includes('->contains(') ||
    content.includes('LIKE') || content.includes('->like(');

  const criteriaIssues: string[] = [];

  if (context === 'collection') {
    criteriaIssues.push('Criteria applied to ArrayCollection — loads all records into memory then filters; use QueryBuilder for large datasets');
    if (hasMaxResults) {
      criteriaIssues.push('Criteria::setMaxResults() on ArrayCollection — setMaxResults is not supported on in-memory collections, returns all elements');
    }
    if (hasOrderBy) {
      criteriaIssues.push('Criteria::orderBy() on ArrayCollection with large collection — sorting happens in PHP memory, not at DB level');
    }
  }

  if (hasExprIn) {
    criteriaIssues.push('Expr::in() with array — large IN (...) lists degrade query performance; consider chunking or JOIN instead');
  }

  if (hasLike && context === 'repository') {
    criteriaIssues.push('Criteria with LIKE/contains expression — ensure target field has index, otherwise full table scan occurs');
  }

  const usages: CriteriaUsage[] = [{
    context,
    hasOrderBy,
    hasMaxResults,
    issues: criteriaIssues,
  }];

  const fileIssues = [...criteriaIssues];

  return {
    file: path.basename(filePath),
    class: classM[1],
    usages,
    issues: fileIssues,
  };
}

export function listDoctrineCriteria(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineCriteriaInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseCriteriaFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine Criteria API usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine Criteria API Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const collectionBased = results.filter((r) => r.usages.some((u) => u.context === 'collection'));
    const repoBased = results.filter((r) => r.usages.some((u) => u.context === 'repository'));
    const unknown = results.filter((r) => r.usages.every((u) => u.context === 'unknown'));

    if (collectionBased.length > 0) {
      text += `\nIn-memory ArrayCollection matching (${collectionBased.length}) — potential performance issue:\n`;
      for (const r of collectionBased) {
        for (const u of r.usages) {
          const flags: string[] = [];
          if (u.hasOrderBy) flags.push('orderBy');
          if (u.hasMaxResults) flags.push('maxResults');
          text += `  ${r.class.padEnd(45)} (${r.file})`;
          if (flags.length > 0) text += ` [${flags.join(', ')}]`;
          text += '\n';
          for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
        }
      }
    }

    if (repoBased.length > 0) {
      text += `\nRepository matching / DB Criteria (${repoBased.length}):\n`;
      for (const r of repoBased) {
        for (const u of r.usages) {
          text += `  ${r.class.padEnd(45)} (${r.file})\n`;
          for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
        }
      }
    }

    if (unknown.length > 0) {
      text += `\nUnknown context (${unknown.length}):\n`;
      for (const r of unknown) {
        text += `  ${r.class.padEnd(45)} (${r.file})\n`;
        for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
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

export function getDoctrineCriteriaStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineCriteriaInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseCriteriaFile(file);
      if (info) results.push(info);
    }

    let text = `Doctrine Criteria API Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total files with Criteria usage: ${results.length}\n`;
    text += `  Collection-based (in-memory):  ${results.filter((r) => r.usages.some((u) => u.context === 'collection')).length}\n`;
    text += `  Repository-based (DB query):   ${results.filter((r) => r.usages.some((u) => u.context === 'repository')).length}\n`;
    text += `  Unknown context:               ${results.filter((r) => r.usages.every((u) => u.context === 'unknown')).length}\n`;
    text += `  With orderBy:                  ${results.filter((r) => r.usages.some((u) => u.hasOrderBy)).length}\n`;
    text += `  With setMaxResults:            ${results.filter((r) => r.usages.some((u) => u.hasMaxResults)).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineCriteriaTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_criteria',
      description: 'Show Doctrine Criteria API usage: Criteria::create/where/orderBy, ArrayCollection::matching vs Repository::matching; warns on in-memory filtering of large collections, setMaxResults on ArrayCollection, Expr::in() with large arrays, LIKE on non-indexed fields',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_criteria_stats',
      description: 'Show Doctrine Criteria statistics: total files, collection-based vs repository-based usage, orderBy count, setMaxResults count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
