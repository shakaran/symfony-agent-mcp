import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MemoryManagementInfo {
  file: string;
  type: 'generator' | 'large-array' | 'leak' | 'limit' | 'chunk';
  pattern: string;
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

function buildMemoryManagementInfos(appPath: string): MemoryManagementInfo[] {
  const results: MemoryManagementInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('yield ') || content.includes('yield;')) {
      const issues: string[] = [];
      if (content.includes('->toArray()') || content.includes('iterator_to_array(')) {
        issues.push('Generator immediately converted with toArray()/iterator_to_array() — negates memory benefits of lazy evaluation; consume the generator directly in a foreach loop');
      }
      results.push({ file: relFile, type: 'generator', pattern: 'generator (yield)', issues });
    }

    if (content.includes('array_map(') || content.includes('array_filter(') || content.includes('array_values(')) {
      const hasChained = /array_\w+\(\s*array_\w+\(\s*array_\w+/.test(content);
      if (hasChained) {
        const hasLargeDataset = content.includes('findAll()') || content.includes('->getResult()') || content.includes('->toArray()');
        if (hasLargeDataset) {
          results.push({ file: relFile, type: 'large-array', pattern: 'chained array functions on dataset', issues: ['Chained array_map/filter on ORM result — each step creates a full copy; use generators, array_walk, or process records in a foreach loop without intermediate arrays'] });
        }
      }
    }

    if (content.includes('range(') && content.includes('foreach')) {
      const rangeMatch = /range\(\s*\d{1,10}\s*,\s*(\d{5,15})/.exec(content);
      if (rangeMatch) {
        const max = parseInt(rangeMatch[1], 10);
        if (max > 100000) {
          results.push({ file: relFile, type: 'large-array', pattern: `range(0, ${max})`, issues: [`range(0, ${max}) creates an array of ${max} elements in memory — use a for/while loop or generator instead`] });
        }
      }
    }

    if (content.includes('memory_get_usage(')) {
      results.push({ file: relFile, type: 'limit', pattern: 'memory_get_usage check', issues: [] });
    }

    if (content.includes('ini_set') && content.includes('memory_limit')) {
      const m = /ini_set\s*\(\s*['"]memory_limit['"]\s*,\s*['"](-?\d{1,4}[MG]?)['"]/.exec(content);
      if (m) {
        const limit = m[1];
        if (limit === '-1') {
          results.push({ file: relFile, type: 'limit', pattern: 'memory_limit=-1', issues: ['memory_limit=-1 disables the memory limit — runaway allocations will OOM-kill the PHP-FPM process, affecting all concurrent requests'] });
        }
        const mb = limit.endsWith('G') ? parseInt(limit, 10) * 1024 : parseInt(limit, 10);
        if (!isNaN(mb) && mb > 2048) {
          results.push({ file: relFile, type: 'limit', pattern: `memory_limit=${limit}`, issues: [`memory_limit=${limit} is very high — investigate the root cause of high memory usage instead of raising the limit`] });
        }
      }
    }

    const hasCircularRef = content.includes('->parent') && content.includes('->children') && !content.includes('gc_collect_cycles');
    if (hasCircularRef && (content.includes('private $parent') || content.includes('private ?'))) {
      results.push({ file: relFile, type: 'leak', pattern: 'bidirectional parent-children reference', issues: ['Bidirectional object reference (parent↔children) without gc_collect_cycles() — PHP GC handles circular refs but delays collection; unset parent reference or call gc_collect_cycles() in long batches'] });
    }

    if (content.includes('array_chunk(') || content.includes('->setMaxResults(') || content.includes('LIMIT')) {
      const hasLoop = content.includes('while (') || content.includes('foreach (');
      if (hasLoop) {
        results.push({ file: relFile, type: 'chunk', pattern: 'batched processing', issues: [] });
      }
    }

    if ((content.includes('->findAll()') || content.includes('->getResult()')) && !content.includes('->setMaxResults(') && !content.includes('toIterable()') && !content.includes('->iterate(')) {
      const hasLoop = content.includes('foreach');
      if (hasLoop) {
        results.push({ file: relFile, type: 'large-array', pattern: 'findAll() in foreach without limit', issues: ['findAll() without setMaxResults() loads all records into memory — for large tables use toIterable() with iterate() or paginate with setFirstResult/setMaxResults'] });
      }
    }
  }

  return results;
}

export function listPhpMemoryManagement(appPath: string): McpToolResult {
  try {
    const infos = buildMemoryManagementInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP memory management patterns detected.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP Memory Management Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMemoryManagementStats(appPath: string): McpToolResult {
  try {
    const infos = buildMemoryManagementInfos(appPath);
    let text = `PHP Memory Statistics\n${'='.repeat(40)}\n\n`;
    text += `Generators:   ${infos.filter((i) => i.type === 'generator').length}\n`;
    text += `Large arrays: ${infos.filter((i) => i.type === 'large-array').length}\n`;
    text += `Leaks:        ${infos.filter((i) => i.type === 'leak').length}\n`;
    text += `Chunked:      ${infos.filter((i) => i.type === 'chunk').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpMemoryManagementTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_memory_management', description: 'Detect PHP memory management issues: generator negated with toArray(), chained array functions on large datasets, large range() arrays, memory_limit=-1, circular reference leaks, findAll() without setMaxResults()', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_memory_management_stats', description: 'Statistics for memory management: generator/large-array/leak/chunk count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
