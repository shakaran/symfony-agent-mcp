/**
 * Doctrine DQL Walker Inspector
 *
 * Detects custom Doctrine DQL SQL walkers (TreeWalker, OutputWalker, SqlWalker).
 * Pure static analysis — reads PHP source files only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DqlWalkerInfo {
  file: string;
  className: string;
  walkerType: 'tree' | 'output' | 'sql';
  hasCacheIssue: boolean;
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

function parseWalkerFile(filePath: string): DqlWalkerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isTreeWalker = content.includes('implements TreeWalkerInterface') ||
    content.includes('addCustomTreeWalker') ||
    content.includes('HINT_CUSTOM_TREE_WALKERS');
  const isOutputWalker = content.includes('extends OutputWalker') ||
    content.includes('HINT_CUSTOM_OUTPUT_WALKER');
  const isSqlWalker = content.includes('extends SqlWalker');

  if (!isTreeWalker && !isOutputWalker && !isSqlWalker) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const walkerType: 'tree' | 'output' | 'sql' = isOutputWalker ? 'output' : isSqlWalker ? 'sql' : 'tree';

  const issues: string[] = [];

  if (isTreeWalker && !content.includes('walkSelectStatement')) {
    issues.push('Tree walker does not implement walkSelectStatement — most SELECT queries will skip this walker');
  }

  if (content.includes('addCustomTreeWalker') && !content.includes('HINT_CUSTOM_TREE_WALKERS')) {
    issues.push('addCustomTreeWalker() accumulates walkers on every createQuery() call — walker list grows unbounded');
  }

  if (content.includes('HINT_CUSTOM_OUTPUT_WALKER') && content.includes('HINT_CUSTOM_TREE_WALKERS')) {
    issues.push('Both HINT_CUSTOM_OUTPUT_WALKER and HINT_CUSTOM_TREE_WALKERS set — output walker takes precedence, tree walker is silently ignored');
  }

  const hasClone = content.includes('clone ');
  const mutatesAst = content.includes('->selectClause') || content.includes('->fromClause') ||
    content.includes('->whereClause') || content.includes('->orderByClause');
  const hasCacheIssue = mutatesAst && !hasClone;

  if (hasCacheIssue) {
    issues.push('Walker modifies query AST nodes without cloning — AST mutation corrupts the query result cache');
  }

  return {
    file: path.basename(filePath),
    className: classM[1],
    walkerType,
    hasCacheIssue,
    issues,
  };
}

export function listDoctrineDqlWalkers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DqlWalkerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseWalkerFile(file);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.className.localeCompare(b.className));

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No custom DQL walkers found in src/.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Doctrine DQL Walker Analysis\n${'='.repeat(55)}\n`;
    text += `\nWalkers: ${results.length}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const cache = r.hasCacheIssue ? ' [cache-risk]' : '';
      text += `\n  ${r.className.padEnd(45)} [${r.walkerType}]${cache}\n`;
      text += `    file: ${r.file}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineDqlWalkerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: DqlWalkerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseWalkerFile(file);
      if (info) results.push(info);
    }

    let text = `Doctrine DQL Walker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total walkers:     ${results.length}\n`;
    text += `  Tree walkers:    ${results.filter((r) => r.walkerType === 'tree').length}\n`;
    text += `  Output walkers:  ${results.filter((r) => r.walkerType === 'output').length}\n`;
    text += `  SQL walkers:     ${results.filter((r) => r.walkerType === 'sql').length}\n`;
    text += `  Cache issues:    ${results.filter((r) => r.hasCacheIssue).length}\n`;
    text += `Total issues:      ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineDqlWalkerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_dql_walkers',
      description: 'Detect custom Doctrine DQL SQL walkers (TreeWalker, OutputWalker, SqlWalker): implements TreeWalkerInterface, extends SqlWalker/OutputWalker, addCustomTreeWalker(), HINT_CUSTOM_TREE_WALKERS/HINT_CUSTOM_OUTPUT_WALKER; warns on missing walkSelectStatement, unbounded accumulation, both walker hints set, AST mutation without cloning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_dql_walker_stats',
      description: 'Statistics for Doctrine DQL walkers: total count, tree/output/sql breakdown, cache issue count, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
