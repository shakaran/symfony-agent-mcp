/**
 * Doctrine ResultSetMapping Inspector
 *
 * Distinct from doctrine-query-builder.ts (QueryBuilder), repository-analyzer.ts (N+1),
 * and doctrine-dbal-schema-manager.ts (schema). Focuses on native query and RSM patterns:
 *
 * - Scans src/ PHP for: ResultSetMapping, ResultSetMappingBuilder, new ResultSetMapping(),
 *   $em->createNativeQuery(), $rsm->addEntityResult(), $rsm->addFieldResult(), $rsm->addScalarResult()
 * - Detects: native queries with RSM, RSM builders, native queries without RSM (raw result arrays)
 *
 * Warnings:
 *   - ResultSetMapping with field names not matching entity column names (silent wrong mapping)
 *   - createNativeQuery() without RSM (returns array, loses type safety)
 *   - RSM::addJoinedEntityResult() without discriminator column (polymorphic query fails)
 *   - Native query string with user input concatenation (SQL injection risk)
 *   - ResultSetMappingBuilder::generateSelectClause() with excluded columns (incomplete mapping)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DoctrineResultSetMappingInfo {
  file: string;
  class: string;
  hasRsm: boolean;
  hasRsmBuilder: boolean;
  hasNativeQuery: boolean;
  hasUserInputConcatenation: boolean;
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

function parseRsmFile(filePath: string): DoctrineResultSetMappingInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasRsmCode = content.includes('ResultSetMapping') ||
    content.includes('createNativeQuery') ||
    content.includes('NativeQuery');

  if (!hasRsmCode) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasRsm = content.includes('ResultSetMapping') && !content.includes('ResultSetMappingBuilder');
  const hasRsmBuilder = content.includes('ResultSetMappingBuilder');
  const hasNativeQuery = content.includes('createNativeQuery(') || content.includes('NativeQuery');

  const hasAddEntityResult = content.includes('addEntityResult(');
  const hasAddFieldResult = content.includes('addFieldResult(');
  const hasAddScalarResult = content.includes('addScalarResult(');
  const hasAddJoinedEntity = content.includes('addJoinedEntityResult(');
  const hasDiscriminator = content.includes('setDiscriminatorColumn') || content.includes('discriminatorColumn');
  const hasGenerateSelect = content.includes('generateSelectClause(');
  const hasExcludedColumns = content.includes('generateSelectClause') && content.includes('[');

  const issues: string[] = [];

  if (hasNativeQuery && !hasRsm && !hasRsmBuilder) {
    issues.push('createNativeQuery() without ResultSetMapping — query returns raw array, loses type safety and entity hydration');
  }

  if (hasAddJoinedEntity && !hasDiscriminator) {
    issues.push('RSM::addJoinedEntityResult() without discriminator column mapping — polymorphic joined queries may fail to resolve correct entity type');
  }

  if (hasGenerateSelect && hasExcludedColumns) {
    issues.push('ResultSetMappingBuilder::generateSelectClause() with excluded columns — incomplete mapping may silently omit fields from hydrated entities');
  }

  if ((hasRsm || hasRsmBuilder) && !hasAddFieldResult && !hasAddScalarResult && hasAddEntityResult) {
    issues.push('RSM with addEntityResult() but no addFieldResult() — entity fields will not be mapped, resulting in empty/null properties');
  }

  const hasUserInputConcatenation = ((): boolean => {
    const nativeQueryCalls = content.split('createNativeQuery(');
    if (nativeQueryCalls.length < 2) return false;
    for (let i = 1; i < nativeQueryCalls.length && i < 20; i++) {
      const slice = nativeQueryCalls[i] ?? '';
      const queryArgEnd = Math.min(slice.length, 300);
      const queryArg = slice.substring(0, queryArgEnd);
      if (queryArg.includes('$_') || queryArg.includes('$request') ||
        queryArg.includes('$input') || (queryArg.includes('$') && queryArg.includes('.'))) {
        return true;
      }
    }
    return false;
  })();

  if (hasUserInputConcatenation) {
    issues.push('Native SQL query string with possible user input concatenation — SQL injection risk; use parameter binding (:param) instead');
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasRsm,
    hasRsmBuilder,
    hasNativeQuery,
    hasUserInputConcatenation,
    issues,
  };
}

export function listDoctrineResultSetMapping(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineResultSetMappingInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseRsmFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine ResultSetMapping or native query usage found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Doctrine ResultSetMapping Analysis\n${'='.repeat(55)}\n`;
    text += `\nFiles: ${results.length}  Issues: ${totalIssues}\n`;

    const withIssues = results.filter((r) => r.issues.length > 0);
    const clean = results.filter((r) => r.issues.length === 0);

    if (withIssues.length > 0) {
      text += `\nFiles with issues (${withIssues.length}):\n`;
      for (const r of withIssues) {
        const flags: string[] = [];
        if (r.hasRsm) flags.push('RSM');
        if (r.hasRsmBuilder) flags.push('RSMBuilder');
        if (r.hasNativeQuery) flags.push('nativeQuery');
        if (r.hasUserInputConcatenation) flags.push('USER_INPUT_CONCAT');
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
        if (r.hasRsm) flags.push('RSM');
        if (r.hasRsmBuilder) flags.push('RSMBuilder');
        if (r.hasNativeQuery) flags.push('nativeQuery');
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

export function getDoctrineResultSetMappingStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DoctrineResultSetMappingInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseRsmFile(file);
      if (info) results.push(info);
    }

    let text = `Doctrine ResultSetMapping Statistics\n${'='.repeat(42)}\n\n`;
    text += `Total files with RSM/native queries: ${results.length}\n`;
    text += `  Using ResultSetMapping:            ${results.filter((r) => r.hasRsm).length}\n`;
    text += `  Using ResultSetMappingBuilder:     ${results.filter((r) => r.hasRsmBuilder).length}\n`;
    text += `  Using createNativeQuery:           ${results.filter((r) => r.hasNativeQuery).length}\n`;
    text += `  With user input concatenation:     ${results.filter((r) => r.hasUserInputConcatenation).length}\n`;
    text += `Issues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineResultSetMappingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_result_set_mapping',
      description: 'Show Doctrine ResultSetMapping and native query usage: RSM/RSMBuilder/createNativeQuery patterns; warns on native queries without RSM (raw array, no type safety), addJoinedEntityResult without discriminator, generateSelectClause with excluded columns, SQL injection via user input concatenation',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_result_set_mapping_stats',
      description: 'Show Doctrine ResultSetMapping statistics: total files, RSM count, RSMBuilder count, native query count, user input concatenation count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
