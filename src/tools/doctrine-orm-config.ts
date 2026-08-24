// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine ORM Deep Configuration Inspector
 *
 * Reads doctrine.orm from config/packages/doctrine.yaml:
 *   - Mapping driver (attribute, annotation, xml, yaml, staticphp)
 *   - Entity managers: name, connection, paths, naming strategy
 *   - auto_mapping and auto_generate_proxy_classes
 *   - Doctrine Filters registered (global SQL filters)
 *   - DQL functions registered (custom DQL functions)
 *   - Second entity managers (multi-tenancy / multiple DBs)
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface EntityManagerConfig {
  name: string;
  connection?: string;
  mappingPaths: string[];
  mappingDriver: string;
  namingStrategy?: string;
  autoMapping: boolean;
  filters: Array<{ name: string; class: string; enabled: boolean }>;
  dqlFunctions: Array<{ type: string; name: string; class: string }>;
}

interface OrmConfig {
  autoGenerateProxies: boolean | string;
  proxyDir?: string;
  defaultEntityManager?: string;
  entityManagers: EntityManagerConfig[];
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

function detectMappingDriver(mappingsRaw: Record<string, unknown>): string {
  for (const def of Object.values(mappingsRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const type = String(d['type'] ?? '');
    if (type) return type;
  }
  return 'attribute';
}

function parseMappingPaths(mappingsRaw: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [, def] of Object.entries(mappingsRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    if (d['dir']) paths.push(String(d['dir']));
    else if (d['prefix']) paths.push(String(d['prefix']));
  }
  return paths;
}

function parseFilters(filtersRaw: unknown): EntityManagerConfig['filters'] {
  if (!filtersRaw || typeof filtersRaw !== 'object') return [];
  const filters: EntityManagerConfig['filters'] = [];
  for (const [name, def] of Object.entries(filtersRaw as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    filters.push({
      name,
      class: String(d['class'] ?? ''),
      enabled: Boolean(d['enabled'] ?? false),
    });
  }
  return filters;
}

function parseDqlFunctions(dqlRaw: unknown): EntityManagerConfig['dqlFunctions'] {
  if (!dqlRaw || typeof dqlRaw !== 'object') return [];
  const fns: EntityManagerConfig['dqlFunctions'] = [];
  const dql = dqlRaw as Record<string, unknown>;

  for (const fnType of ['string_functions', 'numeric_functions', 'datetime_functions'] as const) {
    const group = dql[fnType] as Record<string, unknown> | undefined;
    if (!group) continue;
    for (const [name, cls] of Object.entries(group)) {
      fns.push({ type: fnType.replace('_functions', ''), name, class: String(cls) });
    }
  }
  return fns;
}

function parseEntityManager(name: string, emRaw: Record<string, unknown>): EntityManagerConfig {
  const mappingsRaw = (emRaw['mappings'] ?? {}) as Record<string, unknown>;

  return {
    name,
    connection: emRaw['connection'] ? String(emRaw['connection']) : undefined,
    mappingPaths: parseMappingPaths(mappingsRaw),
    mappingDriver: detectMappingDriver(mappingsRaw),
    namingStrategy: emRaw['naming_strategy'] ? String(emRaw['naming_strategy']) : undefined,
    autoMapping: Boolean(emRaw['auto_mapping'] ?? false),
    filters: parseFilters(emRaw['filters']),
    dqlFunctions: parseDqlFunctions(emRaw['dql']),
  };
}

function loadOrmConfig(appPath: string): OrmConfig | null {
  const doctrineFile = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  const raw = parseYamlFile(doctrineFile) as Record<string, unknown> | null;
  if (!raw) return null;

  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const orm = doctrine['orm'] as Record<string, unknown> | undefined;
  if (!orm) return null;

  const entityManagers: EntityManagerConfig[] = [];
  const emsRaw = orm['entity_managers'] as Record<string, unknown> | undefined;

  if (emsRaw) {
    for (const [name, emDef] of Object.entries(emsRaw)) {
      if (!emDef || typeof emDef !== 'object') continue;
      entityManagers.push(parseEntityManager(name, emDef as Record<string, unknown>));
    }
  } else {
    // Single default EM
    entityManagers.push(parseEntityManager('default', orm));
  }

  return {
    autoGenerateProxies: (orm['auto_generate_proxy_classes'] ?? 'eval') as boolean | string,
    proxyDir: orm['proxy_dir'] ? String(orm['proxy_dir']) : undefined,
    defaultEntityManager: orm['default_entity_manager']
      ? String(orm['default_entity_manager'])
      : undefined,
    entityManagers,
  };
}

// ─── Tool functions ────────────────────────────────────────────────────────

const DRIVER_LABELS: Record<string, string> = {
  attribute:  'PHP 8 attributes (#[ORM\\Entity])',
  annotation: 'Doctrine annotations (@ORM\\Entity)',
  xml:        'XML mapping files',
  yaml:       'YAML mapping files',
  staticphp:  'Static PHP (loadMetadata)',
};

export function listDoctrineOrmConfig(appPath: string): McpToolResult {
  try {
    const config = loadOrmConfig(appPath);

    if (!config) {
      return {
        content: [{ type: 'text', text: 'doctrine.orm config not found in config/packages/doctrine.yaml.' }],
      };
    }

    let text = `Doctrine ORM Configuration\n${'='.repeat(55)}\n`;
    text += `\nProxy generation: ${config.autoGenerateProxies}\n`;
    if (config.proxyDir) text += `Proxy directory:  ${config.proxyDir}\n`;
    if (config.defaultEntityManager) text += `Default EM:       ${config.defaultEntityManager}\n`;

    for (const em of config.entityManagers) {
      text += `\nEntity Manager: ${em.name}${config.defaultEntityManager === em.name ? ' [default]' : ''}\n`;
      if (em.connection) text += `  Connection:        ${em.connection}\n`;
      text += `  Mapping driver:    ${DRIVER_LABELS[em.mappingDriver] ?? em.mappingDriver}\n`;
      if (em.autoMapping)    text += `  Auto-mapping:      yes\n`;
      if (em.namingStrategy) text += `  Naming strategy:   ${em.namingStrategy}\n`;
      if (em.mappingPaths.length > 0) text += `  Entity paths:      ${em.mappingPaths.join(', ')}\n`;

      if (em.filters.length > 0) {
        text += `  Doctrine filters (${em.filters.length}):\n`;
        for (const f of em.filters) {
          const enabled = f.enabled ? ' [enabled by default]' : ' [disabled by default]';
          text += `    ${f.name.padEnd(25)} ${f.class.split('\\').pop()}${enabled}\n`;
        }
      }

      if (em.dqlFunctions.length > 0) {
        text += `  Custom DQL functions (${em.dqlFunctions.length}):\n`;
        for (const fn of em.dqlFunctions) {
          text += `    ${fn.type.padEnd(12)} ${fn.name.padEnd(20)} → ${fn.class.split('\\').pop()}\n`;
        }
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

export function getDoctrineOrmStats(appPath: string): McpToolResult {
  try {
    const config = loadOrmConfig(appPath);

    let text = `Doctrine ORM Statistics\n${'='.repeat(40)}\n\n`;

    if (!config) {
      text += 'doctrine.orm: not configured\n';
      return { content: [{ type: 'text', text }] };
    }

    const totalFilters = config.entityManagers.reduce((s, em) => s + em.filters.length, 0);
    const totalDql = config.entityManagers.reduce((s, em) => s + em.dqlFunctions.length, 0);
    const enabledFilters = config.entityManagers.reduce(
      (s, em) => s + em.filters.filter((f) => f.enabled).length, 0
    );

    text += `Entity managers:       ${config.entityManagers.length}\n`;
    text += `Mapping driver:        ${config.entityManagers[0]?.mappingDriver ?? 'unknown'}\n`;
    text += `Doctrine filters:      ${totalFilters} (${enabledFilters} enabled by default)\n`;
    text += `Custom DQL functions:  ${totalDql}\n`;
    text += `Proxy generation:      ${config.autoGenerateProxies}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getDoctrineOrmConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_doctrine_orm_config',
      description: 'Show Doctrine ORM configuration: mapping driver, entity managers, naming strategy, Doctrine Filters (SQL-level), custom DQL functions, proxy generation',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_orm_stats',
      description: 'Show Doctrine ORM statistics: EM count, mapping driver, filter count (enabled/disabled), custom DQL function count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
