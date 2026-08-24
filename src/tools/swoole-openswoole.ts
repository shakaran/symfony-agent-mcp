// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SwooleConfigInfo {
  source: string;
  type: 'server' | 'coroutine' | 'shared-state' | 'runtime' | 'config';
  pattern: string;
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

function buildSwooleOpenSwooleInfos(appPath: string): SwooleConfigInfo[] {
  const results: SwooleConfigInfo[] = [];

  // 1. Check composer.json for swoole-related packages
  const composerPath = path.join(appPath, 'composer.json');
  let hasRuntime = false;
  if (fs.existsSync(composerPath)) {
    let content = '';
    try { content = fs.readFileSync(composerPath, 'utf-8'); } catch { /* skip */ }

    const swoolePkgs = ['ext-swoole', 'openswoole/core', 'swoole/ide-helper', 'runtime/swoole'];
    for (const pkg of swoolePkgs) {
      if (content.includes(pkg)) {
        results.push({ source: 'composer.json', type: 'runtime', pattern: `Package: ${pkg}`, issues: [] });
      }
    }

    if (content.includes('symfony/runtime')) {
      hasRuntime = true;
    }
  }

  // Symfony Runtime + Swoole
  if (hasRuntime) {
    const runtimeEnv = process.env['SYMFONY_RUNTIME'] ?? '';
    if (/swoole/i.test(runtimeEnv)) {
      results.push({ source: 'env:SYMFONY_RUNTIME', type: 'runtime', pattern: 'Symfony Runtime with Swoole', issues: [] });
    }
  }

  // 2. Scan PHP files for Swoole server creation
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const relPath = path.relative(appPath, file);

      // Swoole server instantiation
      if (/new\s+Swoole\\Http\\Server|new\s+OpenSwoole\\Http\\Server/.test(content)) {
        results.push({ source: relPath, type: 'server', pattern: 'Swoole/OpenSwoole HTTP server instantiation', issues: [] });
      }

      // Worker_num configuration
      if (/worker_num/.test(content)) {
        results.push({ source: relPath, type: 'config', pattern: 'worker_num configuration', issues: [] });
      }

      // Static properties that could be shared between workers (non-readonly)
      const staticPropPattern = /static\s+\$(?!readonly)/g;
      if (staticPropPattern.test(content) && /class\s+\w+/.test(content)) {
        results.push({
          source: relPath,
          type: 'shared-state',
          pattern: 'Static properties in class',
          issues: ['Static properties in Swoole worker — static state is shared between requests within the same worker process; ensure static properties are reset between requests or use coroutine-local storage'],
        });
      }

      // PDO without Swoole coroutine PDO
      if (/new\s+PDO\s*\(/.test(content) && !/Swoole\\Coroutine\\PDO|OpenSwoole\\Coroutine\\PDO/.test(content)) {
        if (/Swoole|OpenSwoole/.test(content)) {
          results.push({
            source: relPath,
            type: 'coroutine',
            pattern: 'Standard PDO in Swoole context',
            issues: ["Standard PDO in Swoole coroutine context — use Swoole's coroutine MySQL/PDO client for non-blocking database access; regular PDO blocks the event loop"],
          });
        }
      }
    }
  }

  return results;
}

export function listSwooleOpenSwoole(appPath: string): McpToolResult {
  try {
    const infos = buildSwooleOpenSwooleInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Swoole/OpenSwoole configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Swoole/OpenSwoole Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSwooleOpenSwooleStats(appPath: string): McpToolResult {
  try {
    const infos = buildSwooleOpenSwooleInfos(appPath);
    let text = `Swoole/OpenSwoole Statistics\n${'='.repeat(40)}\n\n`;
    text += `Server:       ${infos.filter((i) => i.type === 'server').length}\n`;
    text += `Coroutine:    ${infos.filter((i) => i.type === 'coroutine').length}\n`;
    text += `Shared-state: ${infos.filter((i) => i.type === 'shared-state').length}\n`;
    text += `Runtime:      ${infos.filter((i) => i.type === 'runtime').length}\n`;
    text += `Config:       ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSwooleOpenSwooleTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_swoole_openswoole',
      description: 'Analyse Swoole/OpenSwoole integration: server setup, coroutine-unsafe PDO usage, shared static state between workers, runtime configuration, and Symfony Runtime compatibility',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_swoole_openswoole_stats',
      description: 'Statistics for Swoole/OpenSwoole integration: counts by type (server/coroutine/shared-state/runtime/config) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
