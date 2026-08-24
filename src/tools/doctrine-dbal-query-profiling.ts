// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DbalQueryProfilingInfo {
  file: string;
  type: 'explain' | 'slowlog' | 'stack' | 'middleware';
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

function buildDbalProfilingInfos(appPath: string): DbalQueryProfilingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: DbalQueryProfilingInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const hasExplain = /executeQuery\s*\(\s*['"]EXPLAIN/.test(content) ||
      /executeStatement\s*\(\s*['"]EXPLAIN/.test(content) ||
      content.includes("'EXPLAIN SELECT") || content.includes('"EXPLAIN SELECT');

    if (hasExplain) {
      const isDevOnly = relFile.includes('/dev/') || relFile.includes('Test') || relFile.includes('Profiler');
      if (!isDevOnly) {
        issues.push('EXPLAIN query found in non-dev/test code — running EXPLAIN on every request causes significant overhead in production');
      }
      results.push({ file: relFile, type: 'explain', pattern: 'EXPLAIN query', issues });
    }

    const hasDebugStack = content.includes('DebugStack') || content.includes('DebugDataHolder');
    if (hasDebugStack) {
      const isNonTest = !relFile.includes('Test') && !relFile.includes('/test') && !relFile.includes('Profiler') && !relFile.includes('DataCollector');
      if (isNonTest) {
        issues.push('DebugStack used outside test/profiler context — accumulates all query strings and parameters in memory (memory leak in production workers)');
      }
      results.push({ file: relFile, type: 'stack', pattern: 'DebugStack', issues });
    }

    const hasOldLogger = content.includes('setSQLLogger(') || content.includes('getSQLLogger(');
    if (hasOldLogger) {
      issues.push('setSQLLogger/getSQLLogger is deprecated since DBAL 3.x — use DBAL MiddlewareInterface for query logging instead');
      results.push({ file: relFile, type: 'slowlog', pattern: 'setSQLLogger (deprecated)', issues });
    }

    const isProfilingMiddleware = content.includes('MiddlewareInterface') &&
      (content.includes('microtime') || content.includes('hrtime') || content.includes('duration') || content.includes('elapsed'));
    if (isProfilingMiddleware) {
      const hasSamplingRate = content.includes('sample') || content.includes('rate') || content.includes('rand(') || content.includes('random');
      if (!hasSamplingRate) {
        issues.push('Profiling middleware without sampling rate — 100% query tracing in production adds significant overhead; add sampling (e.g. 1% of requests)');
      }
      results.push({ file: relFile, type: 'middleware', pattern: 'profiling middleware', issues });
    }
  }

  return results;
}

export function listDoctrineDbalQueryProfiling(appPath: string): McpToolResult {
  try {
    const infos = buildDbalProfilingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No DBAL query profiling patterns found (no EXPLAIN queries, DebugStack, setSQLLogger, or profiling middleware).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `DBAL Query Profiling Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineDbalQueryProfilingStats(appPath: string): McpToolResult {
  try {
    const infos = buildDbalProfilingInfos(appPath);
    let text = `DBAL Query Profiling Statistics\n${'='.repeat(40)}\n\n`;
    text += `EXPLAIN:     ${infos.filter((i) => i.type === 'explain').length}\n`;
    text += `Debug stack: ${infos.filter((i) => i.type === 'stack').length}\n`;
    text += `Slow log:    ${infos.filter((i) => i.type === 'slowlog').length}\n`;
    text += `Middleware:  ${infos.filter((i) => i.type === 'middleware').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineDbalQueryProfilingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_dbal_query_profiling', description: 'Detect DBAL query profiling patterns; warns on EXPLAIN in production, DebugStack outside tests, setSQLLogger deprecated in DBAL 3.x, profiling middleware without sampling', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_dbal_query_profiling_stats', description: 'Statistics for DBAL query profiling: explain/stack/slowlog/middleware count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
