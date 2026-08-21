import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EsMappingInfo {
  file: string;
  type: 'mapping' | 'index' | 'query' | 'security' | 'config';
  directive: string;
  value: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function buildEsMappingInfos(appPath: string): EsMappingInfo[] {
  const results: EsMappingInfo[] = [];

  const mappingDirs = [
    path.join(appPath, 'config', 'elasticsearch'),
    path.join(appPath, 'config', 'search', 'elasticsearch'),
    path.join(appPath, 'elasticsearch'),
  ];

  for (const mappingDir of mappingDirs) {
    if (!fs.existsSync(mappingDir)) continue;
    try {
      for (const entry of fs.readdirSync(mappingDir)) {
        if (!entry.endsWith('.json') && !entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        let content = '';
        try { content = fs.readFileSync(path.join(mappingDir, entry), 'utf-8'); } catch { continue; }
        const relFile = path.relative(appPath, path.join(mappingDir, entry));
        const issues: string[] = [];

        const hasDynamicTrue = content.includes('"dynamic": true') || content.includes('"dynamic":true') || content.includes('dynamic: true');
        if (hasDynamicTrue) {
          issues.push(`Elasticsearch mapping "${relFile}" has dynamic: true — dynamic mapping auto-creates fields on ingest, leading to "mapping explosion" with nested objects; use dynamic: strict or dynamic: false`);
        }

        const hasTextField = content.includes('"type": "text"') || content.includes('"type":"text"') || content.includes('type: text');
        const hasKeywordField = content.includes('"type": "keyword"') || content.includes('"type":"keyword"') || content.includes('type: keyword');

        if (hasTextField && !hasKeywordField) {
          issues.push(`Elasticsearch mapping "${relFile}" has text fields without keyword sub-field — text fields are analyzed (not sortable/aggregatable); add keyword sub-field (fields.keyword) for sort/aggregation use cases`);
        }

        const hasNoStoreSource = content.includes('"_source"') && content.includes('"enabled": false');
        if (hasNoStoreSource) {
          issues.push(`Elasticsearch mapping "${relFile}" disables _source — _source is needed for partial updates (update API) and reindexing; only disable if storage cost is critical and those features are not needed`);
        }

        results.push({ file: relFile, type: 'mapping', directive: 'mapping file', value: entry, issues });
      }
    } catch { /* skip */ }
  }

  const envFiles = [path.join(appPath, '.env'), path.join(appPath, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, envFile);

    const esMatch = /ELASTICSEARCH_URL\s*=\s*([^\n]+)/.exec(content) ?? /ES_URL\s*=\s*([^\n]+)/.exec(content);
    if (esMatch) {
      const dsn = esMatch[1].trim();
      const issues: string[] = [];
      if (dsn.includes('http://') && !dsn.includes('localhost') && !dsn.includes('127.0.0.1')) {
        issues.push(`Elasticsearch URL in "${relFile}" uses HTTP for non-localhost connection — use HTTPS (https://) for remote Elasticsearch clusters to encrypt data and credentials in transit`);
      }
      if (!dsn.includes('@') && !dsn.includes('apiKey') && !dsn.includes('password')) {
        issues.push(`Elasticsearch URL in "${relFile}" without authentication credentials — Elasticsearch without X-Pack security is unauthenticated; add username:password or API key to the URL`);
      }
      results.push({ file: relFile, type: 'security', directive: 'ELASTICSEARCH_URL', value: dsn.substring(0, 30), issues });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('Elastica') && !content.includes('Elasticsearch') && !content.includes('ElasticSearch') && !content.includes('search(')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasUserInputInQuery = /query_string[\s\S]{0,100}\$(?:request|query|search|term)/.test(content);
            if (hasUserInputInQuery) {
              issues.push(`Elasticsearch query_string with user input in "${relFile}" — query_string syntax allows field injection (e.g., _exists_:password); use multi_match or match query with specific fields instead`);
            }

            const hasUnboundedSize = /size[\s\S]{0,30}10000|'size'\s*=>\s*\d{5,}/.test(content);
            if (hasUnboundedSize) {
              issues.push(`Elasticsearch query with size >= 10000 in "${relFile}" — queries with size > index.max_result_window (default 10000) fail; use search_after or scroll API for deep pagination`);
            }

            results.push({ file: relFile, type: 'query', directive: 'Elasticsearch query', value: 'PHP code', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listElasticsearchMappingConfig(appPath: string): McpToolResult {
  try {
    const infos = buildEsMappingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Elasticsearch mapping configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Elasticsearch Mapping Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticsearchMappingConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildEsMappingInfos(appPath);
    let text = `Elasticsearch Mapping Statistics\n${'='.repeat(40)}\n\n`;
    text += `Mappings:  ${infos.filter((i) => i.type === 'mapping').length}\n`;
    text += `Queries:   ${infos.filter((i) => i.type === 'query').length}\n`;
    text += `Security:  ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getElasticsearchMappingConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_elasticsearch_mapping_config', description: 'Analyze Elasticsearch index mapping configuration; warns on dynamic: true mapping explosion, text without keyword sub-field, _source disabled, HTTP for remote cluster, no auth credentials, query_string with user input injection risk, size > 10000', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_elasticsearch_mapping_config_stats', description: 'Statistics for Elasticsearch mapping: mapping/query/security count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
