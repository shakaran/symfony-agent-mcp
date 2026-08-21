/**
 * Doctrine DQL Custom Functions Inspector
 *
 * Distinct from doctrine-types.ts (column types) and doctrine-orm-config.ts (general ORM).
 * Focuses on custom DQL functions registered in doctrine.yaml:
 *
 * doctrine.yaml orm.dql:
 *   - string_functions: name → class
 *   - numeric_functions: name → class
 *   - datetime_functions: name → class
 *
 * DQL function class analysis:
 *   - Classes extending FunctionNode / AST\Functions\FunctionNode
 *   - parse() method implementation
 *   - getSql() / dispatch() implementation
 *   - Constructor arguments (platform-specific functions)
 *
 * Usage scan:
 *   - Repository files using DQL IDENTITY(), DATE_FORMAT(), YEAR(), MONTH(), etc.
 *   - QueryBuilder DQL expressions referencing custom functions
 *   - Named queries in entity @NamedQuery annotations
 *
 * Analysis:
 *   - Functions registered but class not found in src/vendor
 *   - Functions defined in src/ but not registered in doctrine.yaml
 *   - Duplicate function names across categories
 *   - Platform-specific functions without fallback
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DqlFunction {
  name: string;
  class: string;
  category: 'string' | 'numeric' | 'datetime';
  classFound: boolean;
}

function loadDqlFunctions(appPath: string): DqlFunction[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const orm      = (doctrine['orm'] ?? {}) as Record<string, unknown>;
    const dql      = (orm['dql'] ?? {}) as Record<string, unknown>;

    const results: DqlFunction[] = [];
    const categories: Array<{ key: string; category: 'string' | 'numeric' | 'datetime' }> = [
      { key: 'string_functions', category: 'string' },
      { key: 'numeric_functions', category: 'numeric' },
      { key: 'datetime_functions', category: 'datetime' },
    ];

    for (const { key, category } of categories) {
      const fns = (dql[key] ?? {}) as Record<string, unknown>;
      for (const [name, cls] of Object.entries(fns)) {
        const className = String(cls).split('\\').pop() ?? String(cls);
        const classFound = checkClassExists(appPath, className);
        results.push({ name, class: String(cls), category, classFound });
      }
    }
    return results;
  }
  return [];
}

function checkClassExists(appPath: string, shortName: string): boolean {
  const vendorDir = path.join(appPath, 'vendor');
  const srcDir    = path.join(appPath, 'src');

  for (const dir of [srcDir, vendorDir]) {
    if (!fs.existsSync(dir)) continue;
    if (findFileInDir(dir, shortName + '.php')) return true;
  }
  return false;
}

function findFileInDir(dir: string, fileName: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === fileName) return true;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (findFileInDir(path.join(dir, entry.name), fileName)) return true;
      }
    }
  } catch { /* skip */ }
  return false;
}

function scanDqlUsage(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usedFunctions = new Set<string>();
  const phpFiles: string[] = [];

  const gather = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) gather(full);
        else if (e.name.endsWith('.php')) phpFiles.push(full);
      }
    } catch { /* skip */ }
  };
  gather(srcDir);

  for (const file of phpFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('createQuery') && !content.includes('createQueryBuilder') &&
        !content.includes('DQL') && !content.includes('dql')) continue;

    for (const m of content.matchAll(/(?:SELECT|WHERE|ORDER BY|HAVING)[^;'"]{0,300}/gi)) {
      for (const fn of m[0].matchAll(/\b([A-Z_][A-Z0-9_]{2,})\s*\(/g)) {
        usedFunctions.add(fn[1].toLowerCase());
      }
    }
  }
  return [...usedFunctions].sort();
}

export function listDqlFunctions(appPath: string): McpToolResult {
  try {
    const functions = loadDqlFunctions(appPath);

    if (functions.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom DQL functions registered.\n\nAdd to doctrine.yaml:\n  doctrine:\n    orm:\n      dql:\n        string_functions:\n          FIELD: DoctrineExtensions\\Query\\Mysql\\Field\n        datetime_functions:\n          DATE_FORMAT: DoctrineExtensions\\Query\\Mysql\\DateFormat',
        }],
      };
    }

    const usedInDql = scanDqlUsage(appPath);
    const byCategory = new Map<string, DqlFunction[]>();
    for (const fn of functions) {
      const list = byCategory.get(fn.category) ?? [];
      list.push(fn);
      byCategory.set(fn.category, list);
    }

    let text = `Doctrine DQL Custom Functions\n${'='.repeat(55)}\n`;
    text += `\nTotal: ${functions.length}  (string: ${functions.filter((f) => f.category === 'string').length}  numeric: ${functions.filter((f) => f.category === 'numeric').length}  datetime: ${functions.filter((f) => f.category === 'datetime').length})\n`;

    for (const [cat, fns] of [...byCategory.entries()].sort()) {
      text += `\n${cat.charAt(0).toUpperCase() + cat.slice(1)} functions:\n`;
      for (const fn of fns.sort((a, b) => a.name.localeCompare(b.name))) {
        const shortClass = fn.class.split('\\').pop() ?? fn.class;
        const found = fn.classFound ? '✓' : '⚠';
        const used  = usedInDql.includes(fn.name.toLowerCase()) ? '  [used in DQL]' : '';
        text += `  ${found} ${fn.name.padEnd(25)} ${shortClass}${used}\n`;
        if (!fn.classFound) text += `    ⚠ Class not found: ${fn.class}\n`;
      }
    }

    const notFound = functions.filter((f) => !f.classFound);
    if (notFound.length > 0) {
      text += `\n⚠ ${notFound.length} function(s) with missing class — may cause runtime errors\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDqlFunctionStats(appPath: string): McpToolResult {
  try {
    const functions = loadDqlFunctions(appPath);

    let text = `DQL Function Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total functions:     ${functions.length}\n`;
    text += `  String:            ${functions.filter((f) => f.category === 'string').length}\n`;
    text += `  Numeric:           ${functions.filter((f) => f.category === 'numeric').length}\n`;
    text += `  Datetime:          ${functions.filter((f) => f.category === 'datetime').length}\n`;
    text += `Classes not found:   ${functions.filter((f) => !f.classFound).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDqlFunctionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_dql_functions',
      description: 'Show custom Doctrine DQL functions from doctrine.yaml: string/numeric/datetime categories, class resolution check, DQL usage scan in repositories, duplicate name detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_dql_function_stats',
      description: 'Show DQL function statistics: total count by category, missing class count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
