// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Second Level Cache (SLC) Inspector
 *
 * Reads doctrine ORM second level cache configuration:
 *   - config/packages/doctrine.yaml — orm.second_level_cache settings
 *   - Cache regions: name, lifetime, maxEntries
 *   - Cache implementation (pool name)
 *
 * Scans entities for #[Cache] attribute (Doctrine ORM SLC):
 *   - usage: region, usage (READ_ONLY, NONSTRICT_READ_WRITE, READ_WRITE)
 *
 * Scans repositories for DQL/QueryBuilder cache hints:
 *   - enableResultCache(), setCacheable(true), setCacheRegion()
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

type CacheUsage = 'READ_ONLY' | 'NONSTRICT_READ_WRITE' | 'READ_WRITE' | 'unknown';

interface SlcRegion {
  name: string;
  lifetime?: number;
  maxEntries?: number;
}

interface SlcConfig {
  enabled: boolean;
  defaultLifetime?: number;
  defaultRegion?: string;
  cachePool?: string;
  regions: SlcRegion[];
}

interface CachedEntity {
  class: string;
  file: string;
  usage: CacheUsage;
  region?: string;
}

interface CachedQuery {
  class: string;
  file: string;
  method: string;
  cacheType: 'result' | 'query' | 'region';
  region?: string;
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadSlcConfig(appPath: string): SlcConfig {
  const doctrineFile = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  const raw = parseYamlFile(doctrineFile) as Record<string, unknown> | null;

  if (!raw) return { enabled: false, regions: [] };

  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const orm = doctrine['orm'] as Record<string, unknown> | undefined;
  if (!orm) return { enabled: false, regions: [] };

  const slc = orm['second_level_cache'] as Record<string, unknown> | undefined;
  if (!slc) return { enabled: false, regions: [] };

  const enabled = slc['enabled'] !== false;
  const regionsRaw = slc['regions'] as Record<string, unknown> | undefined;
  const regions: SlcRegion[] = [];

  if (regionsRaw) {
    for (const [name, def] of Object.entries(regionsRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      regions.push({
        name,
        lifetime: d['lifetime'] ? Number(d['lifetime']) : undefined,
        maxEntries: d['max_entries'] ? Number(d['max_entries']) : undefined,
      });
    }
  }

  return {
    enabled,
    defaultLifetime: slc['default_lifetime'] ? Number(slc['default_lifetime']) : undefined,
    defaultRegion: slc['region_lifetime_resolver'] ? String(slc['region_lifetime_resolver']) : undefined,
    cachePool: slc['pool'] ? String(slc['pool']) : undefined,
    regions,
  };
}

// ─── Entity scanning ────────────────────────────────────────────────────────


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

function detectUsage(options: string): CacheUsage {
  if (options.includes('READ_ONLY'))           return 'READ_ONLY';
  if (options.includes('NONSTRICT_READ_WRITE')) return 'NONSTRICT_READ_WRITE';
  if (options.includes('READ_WRITE'))          return 'READ_WRITE';
  return 'unknown';
}

function scanCachedEntities(appPath: string): CachedEntity[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const entities: CachedEntity[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // Doctrine SLC #[Cache] — different from Symfony HTTP #[Cache]
    // It's under ORM\Mapping namespace
    if (!content.includes('#[ORM\\Cache') && !content.includes('#[Cache(') && !content.includes('@ORM\\Cache')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    for (const m of content.matchAll(/#\[(?:ORM\\)?Cache\s*\(([^)]*)\)\]/g)) {
      const options = m[1];
      const regionM = /region\s*:\s*['"]([^'"]+)['"]/.exec(options);
      entities.push({
        class: classM[1],
        file: path.basename(file),
        usage: detectUsage(options),
        region: regionM?.[1],
      });
    }
  }

  return entities.sort((a, b) => a.class.localeCompare(b.class));
}

function scanCachedQueries(appPath: string): CachedQuery[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const queries: CachedQuery[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('enableResultCache') &&
        !content.includes('setCacheable') &&
        !content.includes('setCacheRegion')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    for (const m of content.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{]*\{[^}]*enableResultCache\s*\(/g)) {
      queries.push({ class: classM[1], file: path.basename(file), method: m[1], cacheType: 'result' });
    }
    for (const m of content.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{]*\{[^}]*->setCacheable\s*\(\s*true\s*\)/g)) {
      queries.push({ class: classM[1], file: path.basename(file), method: m[1], cacheType: 'query' });
    }
    for (const m of content.matchAll(/function\s+(\w+)\s*\([^)]*\)[^{]*\{[^}]*->setCacheRegion\s*\(\s*['"]([^'"]+)['"]/g)) {
      queries.push({ class: classM[1], file: path.basename(file), method: m[1], cacheType: 'region', region: m[2] });
    }
  }

  return queries;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listDoctrineSlc(appPath: string): McpToolResult {
  try {
    const config = loadSlcConfig(appPath);
    const entities = scanCachedEntities(appPath);
    const queries = scanCachedQueries(appPath);

    if (!config.enabled && entities.length === 0 && queries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Doctrine Second Level Cache not configured.\n\nEnable in config/packages/doctrine.yaml:\n  doctrine:\n    orm:\n      second_level_cache:\n        enabled: true\n        default_lifetime: 3600\n\nMark entities as cacheable:\n  #[ORM\\Cache(usage: \'READ_ONLY\', region: \'my_region\')]\n  class Product { ... }',
        }],
      };
    }

    let text = `Doctrine Second Level Cache\n${'='.repeat(55)}\n`;
    text += `\nSLC enabled: ${config.enabled ? 'yes' : 'no'}\n`;
    if (config.cachePool)      text += `Cache pool:  ${config.cachePool}\n`;
    if (config.defaultLifetime)text += `Default TTL: ${config.defaultLifetime}s\n`;

    if (config.regions.length > 0) {
      text += `\nConfigured regions (${config.regions.length}):\n`;
      for (const r of config.regions) {
        const ttl = r.lifetime ? `  TTL: ${r.lifetime}s` : '';
        const max = r.maxEntries ? `  maxEntries: ${r.maxEntries}` : '';
        text += `  ${r.name}${ttl}${max}\n`;
      }
    }

    if (entities.length > 0) {
      text += `\nCached entities (${entities.length}):\n`;
      const usagePad = 22;
      for (const e of entities) {
        const region = e.region ? `  region: ${e.region}` : '';
        text += `  ${e.class.padEnd(35)} ${e.usage.padEnd(usagePad)}${region}\n`;
      }
    }

    if (queries.length > 0) {
      text += `\nQuery-level caching (${queries.length}):\n`;
      for (const q of queries) {
        const region = q.region ? `  region: ${q.region}` : '';
        text += `  ${q.class}::${q.method}  [${q.cacheType}]${region}\n`;
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

export function getDoctrineSlcStats(appPath: string): McpToolResult {
  try {
    const config = loadSlcConfig(appPath);
    const entities = scanCachedEntities(appPath);
    const queries = scanCachedQueries(appPath);

    let text = `Doctrine SLC Statistics\n${'='.repeat(40)}\n\n`;
    text += `SLC enabled:       ${config.enabled ? 'yes' : 'no'}\n`;
    text += `Cached entities:   ${entities.length}\n`;
    text += `Cached queries:    ${queries.length}\n`;
    text += `Regions defined:   ${config.regions.length}\n`;

    const usageCounts: Partial<Record<CacheUsage, number>> = {};
    for (const e of entities) {
      usageCounts[e.usage] = (usageCounts[e.usage] ?? 0) + 1;
    }
    if (Object.keys(usageCounts).length > 0) {
      text += `\nCache usage modes:\n`;
      for (const [usage, count] of Object.entries(usageCounts)) {
        text += `  ${usage.padEnd(25)} ${count} entities\n`;
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

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getDoctrineSlcTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_doctrine_slc',
      description: 'Show Doctrine Second Level Cache config: enabled status, cache regions, entities with #[ORM\\Cache], query-level result caching',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_slc_stats',
      description: 'Show Doctrine SLC statistics: entity count by cache usage mode (READ_ONLY/READ_WRITE/NONSTRICT), region count, query cache usage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
