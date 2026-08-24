// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTTP Cache Store Inspector
 *
 * Scans src/**\/*.php and config/ for HTTP cache store usage:
 * - new HttpCache($kernel, new Store(...))
 * - framework.http_cache: enabled: true
 * - Custom cache store implementations (implements StoreInterface)
 * - Flags default filesystem Store in load-balanced environments
 * - Flags Store(sys_get_temp_dir()) in non-dev
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HttpCacheStoreInfo {
  file: string;
  storeClass: string;
  options: string[];
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function collectConfigFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectConfigFiles(full, base));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full);
  }
  return results;
}

function analysePhpFileForHttpCache(content: string, relFile: string): HttpCacheStoreInfo[] {
  const infos: HttpCacheStoreInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect HttpCache instantiation
    if (/new\s+HttpCache\s*\(/.test(line)) {
      // Look ahead for Store class
      const block = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
      const storeMatch = /new\s+([\w\\]+Store)\s*\(([^)]{0,200})/.exec(block);
      const storeClass = storeMatch ? storeMatch[1] : 'Store';
      const storeArgs = storeMatch ? storeMatch[2] : '';

      const options: string[] = [];
      const issues: string[] = [];

      if (/sys_get_temp_dir/.test(storeArgs)) {
        options.push('path: sys_get_temp_dir()');
        issues.push('Store(sys_get_temp_dir()) — temp directory is not shared across servers; use a shared path in production');
      } else if (storeArgs.trim()) {
        options.push(`args: ${storeArgs.trim().slice(0, 80)}`);
      }

      if (storeClass === 'Store' || storeClass.endsWith('\\Store')) {
        issues.push('Default filesystem Store — not suitable for load-balanced environments; implement shared StoreInterface');
      }

      infos.push({ file: relFile, storeClass, options, issues });
    }

    // Detect custom StoreInterface implementations
    if (/implements\s+StoreInterface/.test(line) || /implements\s+.*StoreInterface/.test(line)) {
      const classMatch = /class\s+(\w+)/.exec(content);
      const cls = classMatch ? classMatch[1] : 'UnknownClass';
      infos.push({
        file: relFile,
        storeClass: `Custom: ${cls}`,
        options: ['implements StoreInterface'],
        issues: [],
      });
    }
  }

  return infos;
}

function analyseConfigForHttpCache(content: string, relFile: string): HttpCacheStoreInfo[] {
  const infos: HttpCacheStoreInfo[] = [];
  if (!/http_cache/.test(content)) return infos;

  const lines = content.split('\n');
  let enabled = false;
  const options: string[] = [];
  const issues: string[] = [];

  for (const line of lines) {
    if (/http_cache:/.test(line)) { enabled = true; continue; }
    if (!enabled) continue;

    if (/enabled:\s*true/.test(line)) {
      options.push('enabled: true');
    }
    if (/max_age:|s_maxage:|public:/.test(line)) {
      options.push(line.trim());
    }
    if (/store_options:/.test(line)) {
      options.push('custom store_options configured');
    }
  }

  if (enabled) {
    if (!options.some((o) => o.includes('store_options'))) {
      issues.push('http_cache enabled without custom store_options — using default filesystem store');
    }
    infos.push({ file: relFile, storeClass: 'framework.http_cache', options, issues });
  }

  return infos;
}

function buildHttpCacheStoreInfos(appPath: string): HttpCacheStoreInfo[] {
  const results: HttpCacheStoreInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  for (const file of collectPhpFiles(srcDir, appPath)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/HttpCache|StoreInterface/.test(content)) continue;
    results.push(...analysePhpFileForHttpCache(content, path.relative(appPath, file)));
  }

  const configDir = path.join(appPath, 'config');
  for (const file of collectConfigFiles(configDir, appPath)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    results.push(...analyseConfigForHttpCache(content, path.relative(appPath, file)));
  }

  return results;
}

export function listSymfonyHttpCacheStore(appPath: string): McpToolResult {
  try {
    const infos = buildHttpCacheStoreInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony HTTP cache store configuration found in src/ or config/.' }] };
    }

    let text = `Symfony HTTP Cache Store Analysis\n${'='.repeat(55)}\n\n`;
    text += `Cache store entries found: ${infos.length}\n\n`;

    for (const info of infos) {
      text += `File:        ${info.file}\n`;
      text += `Store class: ${info.storeClass}\n`;
      if (info.options.length > 0) {
        text += `Options:\n`;
        for (const opt of info.options) text += `  - ${opt}\n`;
      }
      if (info.issues.length > 0) {
        text += `Issues:\n`;
        for (const issue of info.issues) text += `  - ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpCacheStoreStats(appPath: string): McpToolResult {
  try {
    const infos = buildHttpCacheStoreInfos(appPath);

    const withIssues = infos.filter((i) => i.issues.length > 0).length;
    const customStores = infos.filter((i) => i.storeClass.startsWith('Custom:')).length;
    const defaultStores = infos.filter((i) => i.storeClass === 'Store' || i.storeClass.endsWith('\\Store')).length;
    const configEntries = infos.filter((i) => i.storeClass === 'framework.http_cache').length;

    let text = `Symfony HTTP Cache Store Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total cache store entries: ${infos.length}\n`;
    text += `  Entries with issues:     ${withIssues}\n`;
    text += `  Default filesystem:      ${defaultStores}\n`;
    text += `  Custom StoreInterface:   ${customStores}\n`;
    text += `  Framework config:        ${configEntries}\n`;

    if (defaultStores > 0) {
      text += `\nWARNING: Default Store found — not suitable for load-balanced environments\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpCacheStoreTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_http_cache_store',
      description: 'List Symfony HTTP cache store usage: HttpCache Store class, custom StoreInterface implementations, framework.http_cache config, issues with default/temp-dir stores in load-balanced setups',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_http_cache_store_stats',
      description: 'Get Symfony HTTP cache store statistics: counts by type (default/custom/config), entries with issues, load-balancer safety warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
