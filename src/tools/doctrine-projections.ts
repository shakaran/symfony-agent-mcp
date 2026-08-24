// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DQL Projection and DTO Inspector
 *
 * Distinct from repository-analyzer.ts (query method patterns) and entities.ts (entity structure).
 * Focuses on read-model projections — querying data into DTO objects rather than entities:
 *
 * SELECT NEW pattern:
 *   SELECT NEW App\Dto\ArticleSummary(a.title, a.slug, COUNT(c.id))
 *   FROM App\Entity\Article a LEFT JOIN a.comments c
 *   GROUP BY a.id
 *
 * SqlResultSetMapping:
 *   #[SqlResultSetMapping(name: 'ArticleSummary', entities: [...], columns: [...])]
 *
 * DTO class analysis:
 *   - DTOs used in SELECT NEW: constructor argument count vs SELECT field count
 *   - DTOs with public properties vs constructor-injected (Symfony Serializer compatibility)
 *   - DTOs implementing interfaces (Serializable, JsonSerializable)
 *
 * Query Builder projections:
 *   - ->select('partial a.{id, title, slug}') — partial object loading
 *   - ->addSelect('NEW App\Dto\...') chained selects
 *   - ->getArrayResult() vs ->getResult() vs ->getSingleScalarResult()
 *
 * Analysis:
 *   - SELECT NEW DTO class that does not exist in src/
 *   - Projection DTO with no #[Column] (safe — not an entity)
 *   - Very wide SELECT NEW (> 8 arguments) — consider splitting
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DqlProjection {
  dtoClass: string;
  shortName: string;
  foundInFile: string;
  argCount: number;
  dtoExists: boolean;
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

function checkClassExists(appPath: string, shortName: string): boolean {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return false;

  const gather = (dir: string): boolean => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (gather(full)) return true; }
        else if (e.name === shortName + '.php') return true;
      }
    } catch { /* skip */ }
    return false;
  };
  return gather(srcDir);
}

function scanProjections(appPath: string): DqlProjection[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const projections: DqlProjection[] = [];
  const seen = new Set<string>();

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('SELECT NEW') && !content.includes('select new')) continue;

    for (const m of content.matchAll(/SELECT\s+NEW\s+([\w\\]+)\s*\(([^)]*)\)/gi)) {
      const dtoClass = m[1].replace(/^\\/, '');
      const args     = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      const shortName = dtoClass.split('\\').pop() ?? dtoClass;

      if (seen.has(dtoClass)) continue;
      seen.add(dtoClass);

      const dtoExists = checkClassExists(appPath, shortName);
      const issues: string[] = [];
      if (!dtoExists) issues.push(`DTO class "${shortName}" not found in src/`);
      if (args.length > 8) issues.push(`${args.length} constructor arguments — consider splitting projection`);

      projections.push({
        dtoClass,
        shortName,
        foundInFile: path.relative(appPath, file),
        argCount: args.length,
        dtoExists,
        issues,
      });
    }
  }
  return projections;
}

function scanPartialObjects(appPath: string): number {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.includes('partial ')) {
      const matches = content.match(/->select\s*\(\s*['"]partial /g);
      if (matches) count += matches.length;
    }
  }
  return count;
}

export function listDqlProjections(appPath: string): McpToolResult {
  try {
    const projections   = scanProjections(appPath);
    const partialCount  = scanPartialObjects(appPath);

    if (projections.length === 0 && partialCount === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No DQL projections found.\n\nExample SELECT NEW projection:\n  $qb->select(\'NEW App\\\\Dto\\\\ArticleSummary(a.title, a.slug, COUNT(c.id))\')\n     ->from(Article::class, \'a\')\n     ->leftJoin(\'a.comments\', \'c\')\n     ->groupBy(\'a.id\');\n\nDTO class:\n  readonly class ArticleSummary {\n    public function __construct(\n      public string $title,\n      public string $slug,\n      public int $commentCount,\n    ) {}\n  }',
        }],
      };
    }

    const totalIssues = projections.reduce((s, p) => s + p.issues.length, 0);

    let text = `Doctrine DQL Projections\n${'='.repeat(55)}\n`;
    text += `\nSELECT NEW projections: ${projections.length}  Issues: ${totalIssues}\n`;
    text += `Partial object loads:   ${partialCount}\n`;

    for (const p of projections.sort((a, b) => b.issues.length - a.issues.length || a.shortName.localeCompare(b.shortName))) {
      const exists = p.dtoExists ? '✓' : '⚠';
      text += `\n  ${exists} ${p.shortName.padEnd(35)} (${p.argCount} args)  ${p.foundInFile}\n`;
      for (const issue of p.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProjectionStats(appPath: string): McpToolResult {
  try {
    const projections  = scanProjections(appPath);
    const partialCount = scanPartialObjects(appPath);

    let text = `Projection Statistics\n${'='.repeat(40)}\n\n`;
    text += `SELECT NEW projections: ${projections.length}\n`;
    text += `  DTO class found:      ${projections.filter((p) => p.dtoExists).length}\n`;
    text += `  Missing DTO class:    ${projections.filter((p) => !p.dtoExists).length}\n`;
    text += `Partial object loads:   ${partialCount}\n`;
    text += `Issues:                 ${projections.reduce((s, p) => s + p.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineProjectionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_dql_projections',
      description: 'Show Doctrine DQL projection analysis: SELECT NEW DTO patterns, DTO class existence check, constructor argument count, partial object loading, missing DTO class warning, wide projection warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_projection_stats',
      description: 'Show projection statistics: SELECT NEW count, existing/missing DTO count, partial object load count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
