// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Cache Early Expiry Inspector
 *
 * Scans src/ PHP for CacheInterface::get() with beta parameter, ItemInterface::expiresAfter(),
 * ItemInterface::tag(), probabilistic early expiry patterns (beta=INF, beta=1.0).
 * Reads cache.yaml for default_lifetime, early_expiration_message_bus.
 *
 * Warns on:
 *   - beta=INF in production (always recomputes — defeats cache)
 *   - beta not set on high-traffic items (stampede risk)
 *   - early expiration configured without message_bus (async recompute not possible)
 *   - ItemInterface::tag() without TagAwareCacheInterface (tags ignored)
 *   - negative TTL (item expires immediately)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface CacheEarlyExpiryInfo {
  file: string;
  className: string;
  hasBeta: boolean;
  betaValue: string;
  hasTagging: boolean;
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

interface CacheConfig {
  defaultLifetime: number | null;
  hasMessageBus: boolean;
}

function loadCacheConfig(appPath: string): CacheConfig {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'cache.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const cache = (framework['cache'] ?? {}) as Record<string, unknown>;
    const defaultLifetime = cache['default_lifetime'] !== undefined
      ? parseInt(String(cache['default_lifetime']), 10)
      : null;
    const hasMessageBus = cache['early_expiration_message_bus'] !== undefined ||
      cache['prefix_seed'] !== undefined;

    return { defaultLifetime, hasMessageBus };
  }

  return { defaultLifetime: null, hasMessageBus: false };
}

function extractBetaValue(content: string): string {
  const patterns = [
    /beta\s*:\s*(INF|[\d.]{1,20})/,
    /['"]beta['"]\s*=>\s*(INF|[\d.]{1,20})/,
    /,\s*(INF|[\d.]{1,6})\s*\)/,
  ];
  for (const p of patterns) {
    const m = p.exec(content);
    if (m) return m[1];
  }
  return '';
}

function scanCacheEarlyExpiry(appPath: string): CacheEarlyExpiryInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const config = loadCacheConfig(appPath);
  const results: CacheEarlyExpiryInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasCacheInterface = content.includes('CacheInterface') ||
      content.includes('ItemInterface') ||
      content.includes('use Symfony\\Contracts\\Cache');

    if (!hasCacheInterface) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasBeta = content.includes('beta') &&
      (content.includes('INF') || /beta\s*[=>:\s]+[\d.]{1,10}/.test(content));
    const betaValue = hasBeta ? extractBetaValue(content) : '';

    const hasTagging = content.includes('->tag(') ||
      content.includes('ItemInterface::tag') ||
      content.includes('$item->tag');

    const hasTagAwareInterface = content.includes('TagAwareCacheInterface') ||
      content.includes('TagAwareAdapter');

    const hasNegativeTtl = /expiresAfter\s*\(\s*-\d{1,6}/.test(content);

    const issues: string[] = [];

    if (betaValue === 'INF') {
      issues.push(`beta=INF in ${path.basename(file)} — cache item always recomputed, defeating cache purpose`);
    }

    if (hasCacheInterface && content.includes('->get(') && !hasBeta) {
      issues.push(`CacheInterface::get() without beta parameter — stampede risk on high-traffic items`);
    }

    if (hasTagging && !hasTagAwareInterface) {
      issues.push(`ItemInterface::tag() called but TagAwareCacheInterface not used — tags will be silently ignored`);
    }

    if (hasNegativeTtl) {
      issues.push(`Negative TTL detected in expiresAfter() — cache item expires immediately`);
    }

    if (!config.hasMessageBus && content.includes('early_expiration') && hasBeta) {
      issues.push(`Early expiry beta configured but no early_expiration_message_bus set — async recompute not possible`);
    }

    if (issues.length > 0 || hasBeta || hasTagging) {
      results.push({ file, className, hasBeta, betaValue, hasTagging, issues });
    }
  }

  return results;
}

export function listCacheEarlyExpiry(appPath: string): McpToolResult {
  try {
    const infos = scanCacheEarlyExpiry(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Cache early expiry (beta/tag) patterns found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Cache Early Expiry Analysis\n${'='.repeat(55)}\n\n`;
    text += `Files with cache early-expiry patterns: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.className}  (${path.relative(appPath, info.file)})\n`;
      text += `    hasBeta: ${info.hasBeta ? 'yes' : 'no'}`;
      if (info.betaValue) text += `  betaValue: ${info.betaValue}`;
      text += `\n`;
      text += `    hasTagging: ${info.hasTagging ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCacheEarlyExpiryStats(appPath: string): McpToolResult {
  try {
    const infos = scanCacheEarlyExpiry(appPath);

    let text = `Cache Early Expiry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with early-expiry patterns:  ${infos.length}\n`;
    text += `  With beta factor:                ${infos.filter((i) => i.hasBeta).length}\n`;
    text += `  With beta=INF:                   ${infos.filter((i) => i.betaValue === 'INF').length}\n`;
    text += `  With tag() calls:                ${infos.filter((i) => i.hasTagging).length}\n`;
    text += `Total issues:                      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// Spec-required export aliases
export const listSymfonyCacheEarlyExpiry = listCacheEarlyExpiry;
export const getSymfonyCacheEarlyExpiryStats = getCacheEarlyExpiryStats;

export function getCacheEarlyExpiryTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_cache_early_expiry',
      description: 'Scan src/ PHP for Symfony Cache early expiry patterns: beta factor, beta=INF misuse, ItemInterface::tag() without TagAwareCacheInterface, negative TTL, stampede risk without beta, missing early_expiration_message_bus',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_cache_early_expiry_stats',
      description: 'Statistics for Symfony Cache early expiry patterns: file count, beta usage, beta=INF count, tag usage, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}

export const getSymfonyCacheEarlyExpiryTools = getCacheEarlyExpiryTools;
