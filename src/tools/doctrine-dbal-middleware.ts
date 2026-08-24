// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface DbalMiddlewareInfo {
  middlewares: string[];
  hasSqlLogger: boolean;
  sqlLoggerFiles: string[];
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

function loadDbalMiddlewareInfo(appPath: string): DbalMiddlewareInfo {
  const middlewares: string[] = [];
  const issues: string[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
    const mw = dbal['middleware'];
    if (Array.isArray(mw)) middlewares.push(...mw.map(String));
    else if (typeof mw === 'object' && mw) middlewares.push(...Object.keys(mw as Record<string, unknown>));
  }
  const srcDir = path.join(appPath, 'src');
  const sqlLoggerFiles: string[] = [];
  let hasSqlLogger = false;
  if (fs.existsSync(srcDir)) {
    for (const filePath of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (content.includes('SQLLogger') || content.includes('setSQLLogger')) {
        hasSqlLogger = true;
        sqlLoggerFiles.push(path.relative(appPath, filePath));
      }
    }
  }
  if (hasSqlLogger) issues.push('SQLLogger is deprecated since DBAL 3 — migrate to Middleware implementing DriverMiddlewareInterface');
  if (middlewares.length === 0 && !hasSqlLogger) issues.push('No DBAL middleware configured — consider adding logging/profiling middleware for dev environments');
  return { middlewares, hasSqlLogger, sqlLoggerFiles: sqlLoggerFiles.slice(0, 10), issues };
}

export function listDbalMiddleware(appPath: string): McpToolResult {
  try {
    const info = loadDbalMiddlewareInfo(appPath);
    let text = `Doctrine DBAL Middleware\n${'='.repeat(55)}\n\nMiddleware stack: ${info.middlewares.length}  Issues: ${info.issues.length}\n`;
    if (info.middlewares.length > 0) {
      text += '\nConfigured middleware:\n';
      for (const mw of info.middlewares) text += `  - ${mw}\n`;
    }
    if (info.hasSqlLogger) {
      text += `\nDeprecated SQLLogger found in ${info.sqlLoggerFiles.length} file(s):\n`;
      for (const f of info.sqlLoggerFiles) text += `  ${f}\n`;
    }
    for (const i of info.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalMiddlewareStats(appPath: string): McpToolResult {
  try {
    const info = loadDbalMiddlewareInfo(appPath);
    let text = `DBAL Middleware Statistics\n${'='.repeat(40)}\n\n`;
    text += `Middleware count: ${info.middlewares.length}\nSQLLogger (deprecated): ${info.hasSqlLogger ? 'yes' : 'no'}\nFiles with SQLLogger: ${info.sqlLoggerFiles.length}\nIssues: ${info.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalMiddlewareTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_dbal_middleware', description: 'Show DBAL middleware stack from doctrine.yaml, deprecated SQLLogger usage (DBAL 3+), missing middleware warning, files using setSQLLogger', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_dbal_middleware_stats', description: 'DBAL middleware statistics: configured middleware count, SQLLogger usage, file count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
