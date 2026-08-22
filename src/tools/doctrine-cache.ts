/**
 * Doctrine Cache Configuration Inspector
 *
 * Distinct from cache-pools.ts (generic Symfony cache pools) and
 * cache-warmers.ts (warmers). Focuses on Doctrine-specific caching:
 *
 * doctrine.yaml second_level_cache:
 *   - enabled flag, default_lifetime, regions (name, lifetime, max_entries)
 *   - driver: pool / array / none
 *
 * Query / result / metadata cache drivers:
 *   - orm.metadata_cache_driver, orm.query_cache_driver, orm.result_cache_driver
 *   - pool references (links to Symfony cache pools)
 *
 * Entity-level cache annotations:
 *   - #[Cache] attribute: region, usage (READ_ONLY / NONSTRICT_READ_WRITE / READ_WRITE)
 *   - #[Cache] on associations (ManyToOne, OneToMany, ManyToMany)
 *
 * Analysis:
 *   - SLC disabled in production with many entities (performance warning)
 *   - READ_WRITE usage without proper locking strategy (data consistency risk)
 *   - Entities using SLC region that is not defined in config
 *   - No query/result cache configured (every request hits DB)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface SlcRegion {
  name: string;
  lifetime?: number;
  maxEntries?: number;
}

interface DoctrineSlcConfig {
  enabled: boolean;
  driver?: string;
  regions: SlcRegion[];
}

interface CachedEntity {
  class: string;
  file: string;
  region?: string;
  usage: string;
  hasCachedAssociations: boolean;
}

function loadDoctrineYaml(appPath: string): Record<string, unknown> | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine.yml'),
  ];
  for (const f of candidates) {
    const raw = parseYamlFile(f) as Record<string, unknown> | null;
    if (raw) return raw;
  }
  return null;
}

function parseSlcConfig(raw: Record<string, unknown>): DoctrineSlcConfig {
  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const orm      = (doctrine['orm'] ?? {}) as Record<string, unknown>;
  const slc      = (orm['second_level_cache'] ?? {}) as Record<string, unknown>;

  const enabled = slc['enabled'] === true || slc['enabled'] === 'true';
  const driverRaw = (slc['region_cache_driver'] ?? slc['driver']) as Record<string, unknown> | undefined;
  const driver  = driverRaw ? String(driverRaw['type'] ?? driverRaw['name'] ?? 'pool') : undefined;

  const regionsRaw = (slc['regions'] ?? {}) as Record<string, unknown>;
  const regions: SlcRegion[] = Object.entries(regionsRaw).map(([name, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    return {
      name,
      lifetime: d['lifetime'] ? parseInt(String(d['lifetime']), 10) : undefined,
      maxEntries: d['max_entries'] ? parseInt(String(d['max_entries']), 10) : undefined,
    };
  });

  return { enabled, driver, regions };
}

function parseCacheDrivers(raw: Record<string, unknown>): Record<string, string> {
  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const orm      = (doctrine['orm'] ?? {}) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ['metadata_cache_driver', 'query_cache_driver', 'result_cache_driver']) {
    const val = orm[key];
    if (val) result[key] = typeof val === 'object' ? String((val as Record<string, unknown>)['type'] ?? JSON.stringify(val)) : String(val);
  }
  return result;
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

function scanCachedEntities(appPath: string): CachedEntity[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: CachedEntity[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[Cache') && !content.includes('@Cache')) continue;
    if (!content.includes('Entity')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const regionM = /#\[Cache[^)]*region\s*:\s*['"]([^'"]+)['"]/.exec(content);
    const usageM  = /#\[Cache[^)]*usage\s*:\s*['"]?([A-Z_]+)/.exec(content) ??
                    /#\[Cache[^)]*CacheUsage::(\w+)/.exec(content);

    const hasCachedAssociations =
      /#\[Cache[^)]*\)\s*#\[(?:ManyToOne|OneToMany|ManyToMany|OneToOne)/.test(content);

    results.push({
      class: classM[1],
      file: path.basename(file),
      region: regionM?.[1],
      usage: usageM?.[1] ?? 'READ_ONLY',
      hasCachedAssociations,
    });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listDoctrineCache(appPath: string): McpToolResult {
  try {
    const raw     = loadDoctrineYaml(appPath);
    const slc     = raw ? parseSlcConfig(raw) : null;
    const drivers = raw ? parseCacheDrivers(raw) : {};
    const entities = scanCachedEntities(appPath);

    if (!slc && Object.keys(drivers).length === 0 && entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine cache configuration found.\n\nEnable second-level cache in doctrine.yaml:\n  doctrine:\n    orm:\n      second_level_cache:\n        enabled: true\n        region_cache_driver:\n          type: pool\n          pool: cache.app\n\nMark entities:\n  #[Cache(usage: "READ_ONLY")]\n  class Product { ... }',
        }],
      };
    }

    let text = `Doctrine Cache Configuration\n${'='.repeat(55)}\n`;

    if (slc) {
      text += `\nSecond Level Cache (SLC):\n`;
      text += `  Enabled: ${slc.enabled ? 'yes' : '⚠ no'}\n`;
      if (slc.driver) text += `  Driver:  ${slc.driver}\n`;
      if (slc.regions.length > 0) {
        text += `  Regions (${slc.regions.length}):\n`;
        for (const r of slc.regions) {
          const lt = r.lifetime ? `  lifetime: ${r.lifetime}s` : '';
          const me = r.maxEntries ? `  max: ${r.maxEntries}` : '';
          text += `    ${r.name}${lt}${me}\n`;
        }
      }
    }

    if (Object.keys(drivers).length > 0) {
      text += `\nCache drivers:\n`;
      for (const [key, val] of Object.entries(drivers)) {
        text += `  ${key.replace(/_/g, ' ').padEnd(28)} ${val}\n`;
      }
    } else if (raw) {
      text += `\n⚠ No query/result/metadata cache drivers configured — all requests hit the DB\n`;
    }

    if (entities.length > 0) {
      text += `\nCached entities (${entities.length}):\n`;
      for (const e of entities) {
        const region = e.region ? `  region: ${e.region}` : '';
        const assoc  = e.hasCachedAssociations ? '  ✓ cached associations' : '';
        text += `  ${e.class.padEnd(35)} ${e.usage}${region}${assoc}\n`;
        if (e.usage === 'READ_WRITE') {
          text += `    ⚠ READ_WRITE requires pessimistic locking strategy — verify concurrency handling\n`;
        }
        if (slc && e.region && !slc.regions.some((r) => r.name === e.region)) {
          text += `    ⚠ region "${e.region}" not defined in SLC config\n`;
        }
      }
    }

    if (slc && !slc.enabled && entities.length > 10) {
      text += `\n⚠ SLC disabled but ${entities.length} entities have #[Cache] — enable SLC to benefit from them\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineCacheStats(appPath: string): McpToolResult {
  try {
    const raw      = loadDoctrineYaml(appPath);
    const slc      = raw ? parseSlcConfig(raw) : null;
    const drivers  = raw ? parseCacheDrivers(raw) : {};
    const entities = scanCachedEntities(appPath);

    let text = `Doctrine Cache Statistics\n${'='.repeat(40)}\n\n`;
    text += `SLC enabled:         ${slc ? (slc.enabled ? 'yes' : 'no') : 'not configured'}\n`;
    text += `SLC regions:         ${slc?.regions.length ?? 0}\n`;
    text += `Cache drivers:       ${Object.keys(drivers).length}/3\n`;
    text += `Cached entities:     ${entities.length}\n`;
    text += `  READ_ONLY:         ${entities.filter((e) => e.usage === 'READ_ONLY').length}\n`;
    text += `  NONSTRICT_RW:      ${entities.filter((e) => e.usage.includes('NONSTRICT')).length}\n`;
    text += `  READ_WRITE:        ${entities.filter((e) => e.usage === 'READ_WRITE').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineCacheTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_cache',
      description: 'Show Doctrine cache configuration: second_level_cache (enabled, driver, regions), query/result/metadata cache drivers, entities with #[Cache] (region, usage mode), orphan region detection, READ_WRITE concurrency warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_cache_stats',
      description: 'Show Doctrine cache statistics: SLC enabled flag, region count, configured driver count, cached entity count by usage mode',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
