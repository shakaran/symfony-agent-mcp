// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Search Integration Inspector
 *
 * Detects search engine integrations:
 *
 * Elasticsearch / OpenSearch:
 *   - FOSElasticaBundle: config/packages/fos_elastica.yaml
 *     indexes, types, persistence drivers, properties mapping
 *   - elastica.yaml / elasticsearch.yaml DSN
 *
 * MeiliSearch:
 *   - meilisearch-symfony bundle: config/packages/meilisearch.yaml
 *   - MEILISEARCH_URL / MEILISEARCH_API_KEY env usage
 *
 * Algolia:
 *   - algolia-search-bundle / SearchBox config
 *   - ALGOLIA_APP_ID / ALGOLIA_SECRET env usage
 *
 * Typesense:
 *   - php-typesense / typesense-bundle config
 *
 * Scans src/ for:
 *   - #[Searchable], #[SearchProperty] attributes (MeiliSearch / custom)
 *   - ElasticSearch client injection (Finder, TransformerInterface)
 *   - Custom search services
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


function maskDsn(value: string): string {
  return value
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

interface SearchEngine {
  name: string;
  driver: string;
  indexes: string[];
  host?: string;
  configFile?: string;
}

interface SearchableClass {
  class: string;
  file: string;
  engine: string;
  indexName?: string;
  searchableProps: string[];
}

// ─── Engine detection ────────────────────────────────────────────────────────

function detectFromEnv(appPath: string): string[] {
  const detected: string[] = [];
  const envFiles = ['.env', '.env.local', '.env.dist', '.env.example'];
  for (const fname of envFiles) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      if (content.match(/ELASTICSEARCH_URL|ELASTIC_HOST/i)) detected.push('elasticsearch-env');
      if (content.match(/MEILISEARCH_URL|MEILI_HOST/i))     detected.push('meilisearch-env');
      if (content.match(/ALGOLIA_APP_ID|ALGOLIA_APPLICATION/i)) detected.push('algolia-env');
      if (content.match(/TYPESENSE_HOST|TYPESENSE_API/i))   detected.push('typesense-env');
    } catch { /* skip */ }
  }
  return [...new Set(detected)];
}

function detectFromComposer(appPath: string): string[] {
  const detected: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8')) as
      Record<string, Record<string, string>>;
    const deps = { ...raw['require'], ...raw['require-dev'] };
    if (deps['friendsofsymfony/elastica-bundle'] || deps['ruflin/elastica'] || deps['elastic/elasticsearch']) {
      detected.push('elasticsearch');
    }
    if (deps['meilisearch/meilisearch-symfony'] || deps['meilisearch/meilisearch-php']) {
      detected.push('meilisearch');
    }
    if (deps['algolia/search-bundle'] || deps['algolia/algoliasearch-client-php']) {
      detected.push('algolia');
    }
    if (deps['typesense/typesense-bundle'] || deps['php-http/typesense']) {
      detected.push('typesense');
    }
  } catch { /* skip */ }
  return detected;
}

function loadFosElasticaConfig(appPath: string): SearchEngine | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'fos_elastica.yaml'),
    path.join(appPath, 'config', 'packages', 'fos_elastica.yml'),
    path.join(appPath, 'config', 'packages', 'elasticsearch.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const fos   = (raw['fos_elastica'] ?? raw) as Record<string, unknown>;
    const clientRaw = fos['clients'] as Record<string, unknown> | undefined;
    const indexesRaw = fos['indexes'] as Record<string, unknown> | undefined;
    const indexes = indexesRaw ? Object.keys(indexesRaw) : [];
    const firstClient = clientRaw ? Object.values(clientRaw)[0] as Record<string, unknown> : {};
    const hostRaw = firstClient?.['host'] ? String(firstClient['host']) : undefined;
    const host = hostRaw ? maskDsn(hostRaw) : undefined;

    return { name: 'Elasticsearch (FOSElasticaBundle)', driver: 'elasticsearch', indexes, host, configFile: path.basename(filePath) };
  }
  return null;
}

function loadMeiliSearchConfig(appPath: string): SearchEngine | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'meilisearch.yaml'),
    path.join(appPath, 'config', 'packages', 'meilisearch.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const ms = (raw['meilisearch'] ?? raw) as Record<string, unknown>;
    const host = ms['host'] ? maskDsn(String(ms['host'])) : undefined;
    const indexesRaw = ms['indices'] as Record<string, unknown> | undefined;
    const indexes = indexesRaw ? Object.keys(indexesRaw) : [];

    return { name: 'MeiliSearch', driver: 'meilisearch', indexes, host, configFile: path.basename(filePath) };
  }
  return null;
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

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

function scanSearchableClasses(appPath: string, detectedEngines: string[]): SearchableClass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir) || detectedEngines.length === 0) return [];

  const classes: SearchableClass[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isSearchable =
      content.includes('#[Searchable') ||
      content.includes('SearchableInterface') ||
      content.includes('TransformerInterface') ||
      content.includes('ElasticaProxyQuery') ||
      content.includes('FinderInterface') ||
      (detectedEngines.includes('elasticsearch') && content.includes('Finder'));

    if (!isSearchable) return [];

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const indexM = /#\[Searchable\s*\(\s*(?:index\s*:\s*)?['"]([^'"]+)['"]/.exec(content);

    const searchableProps: string[] = [];
    for (const m of content.matchAll(/#\[SearchProperty[^\]]*\]\s*(?:public|protected|private)?\s+\S+\s+\$(\w+)/g)) {
      searchableProps.push(m[1]);
    }

    let engine = 'unknown';
    if (content.includes('Finder') || content.includes('fos_elastica') || content.includes('Elastica')) engine = 'elasticsearch';
    else if (content.includes('MeiliSearch') || content.includes('Meilisearch')) engine = 'meilisearch';

    classes.push({
      class: classM[1],
      file: path.basename(file),
      engine,
      indexName: indexM?.[1],
      searchableProps,
    });
  }

  return classes.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listSearchIntegration(appPath: string): McpToolResult {
  try {
    const composerEngines = detectFromComposer(appPath);
    const envEngines      = detectFromEnv(appPath);
    const fosConfig       = loadFosElasticaConfig(appPath);
    const msConfig        = loadMeiliSearchConfig(appPath);

    const allEngines = [...new Set([...composerEngines, ...envEngines.map((e) => e.replace('-env', ''))])];
    const searchables = scanSearchableClasses(appPath, allEngines);

    if (allEngines.length === 0 && !fosConfig && !msConfig) {
      return {
        content: [{
          type: 'text',
          text: 'No search engine integration detected.\n\nCommon options:\n  composer require friendsofsymfony/elastica-bundle  # Elasticsearch\n  composer require meilisearch/meilisearch-symfony   # MeiliSearch\n  composer require algolia/search-bundle             # Algolia',
        }],
      };
    }

    let text = `Search Integration\n${'='.repeat(55)}\n`;
    text += `\nDetected engines: ${allEngines.join(', ')}\n`;

    const configs: SearchEngine[] = [];
    if (fosConfig) configs.push(fosConfig);
    if (msConfig)  configs.push(msConfig);

    if (configs.length > 0) {
      text += `\nConfiguration:\n`;
      for (const cfg of configs) {
        text += `\n  ${cfg.name}  (${cfg.configFile})\n`;
        if (cfg.host)              text += `    Host:    ${cfg.host}\n`;
        if (cfg.indexes.length > 0) text += `    Indexes: ${cfg.indexes.join(', ')}\n`;
      }
    }

    if (searchables.length > 0) {
      text += `\nSearchable classes (${searchables.length}):\n`;
      for (const s of searchables) {
        const idx   = s.indexName ? `  index: ${s.indexName}` : '';
        const props = s.searchableProps.length > 0 ? `  props: ${s.searchableProps.join(', ')}` : '';
        text += `  ${s.class.padEnd(40)} [${s.engine}]${idx}${props}\n`;
      }
    }

    const envHints = envEngines.filter((e) => !composerEngines.includes(e.replace('-env', '')));
    if (envHints.length > 0) {
      text += `\n⚠ Env vars suggest additional engine(s) not in composer.json: ${envHints.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSearchIntegrationStats(appPath: string): McpToolResult {
  try {
    const composerEngines = detectFromComposer(appPath);
    const fosConfig       = loadFosElasticaConfig(appPath);
    const msConfig        = loadMeiliSearchConfig(appPath);
    const searchables     = scanSearchableClasses(appPath, composerEngines);

    let text = `Search Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Engines detected:  ${composerEngines.join(', ') || 'none'}\n`;
    text += `ES indexes:        ${fosConfig?.indexes.length ?? 0}\n`;
    text += `Meili indexes:     ${msConfig?.indexes.length ?? 0}\n`;
    text += `Searchable classes: ${searchables.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getSearchIntegrationTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_search_integration',
      description: 'List search engine integrations: Elasticsearch/FOSElastica (indexes, host), MeiliSearch, Algolia, Typesense — detected from composer.json, config files, and env vars',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_search_integration_stats',
      description: 'Show search integration statistics: detected engines, index counts, searchable class count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
