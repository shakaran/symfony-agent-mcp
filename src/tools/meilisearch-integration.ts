import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MeilisearchIntegrationInfo {
  source: string;
  type: 'config' | 'index' | 'auth' | 'attributes' | 'bundle';
  pattern: string;
  issues: string[];
}

function readEnvFile(appPath: string): string {
  const envFiles = ['.env', '.env.local'];
  let combined = '';
  for (const fname of envFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      combined += fs.readFileSync(fpath, 'utf8') + '\n';
    }
  }
  return combined;
}

function buildMeilisearchIntegrationInfos(appPath: string): MeilisearchIntegrationInfo[] {
  const results: MeilisearchIntegrationInfo[] = [];

  // Check composer.json for meilisearch packages
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');

    if (composerContent.includes('meilisearch/meilisearch-php')) {
      results.push({
        source: 'composer.json',
        type: 'bundle',
        pattern: 'meilisearch/meilisearch-php',
        issues: [],
      });
    }
    if (composerContent.includes('loupe/loupe')) {
      results.push({
        source: 'composer.json',
        type: 'bundle',
        pattern: 'loupe/loupe',
        issues: [],
      });
    }
    if (composerContent.includes('meilisearch/symfony-meilisearch-bundle')) {
      results.push({
        source: 'composer.json',
        type: 'bundle',
        pattern: 'meilisearch/symfony-meilisearch-bundle',
        issues: [],
      });
    }
    if (composerContent.includes('monsieurbiz/search-bundle')) {
      results.push({
        source: 'composer.json',
        type: 'bundle',
        pattern: 'monsieurbiz/search-bundle',
        issues: [],
      });
    }
  }

  // Check .env for MEILISEARCH_URL and MEILISEARCH_API_KEY
  const envContent = readEnvFile(appPath);
  if (envContent) {
    const urlMatch = envContent.match(/MEILISEARCH_URL\s*=\s*(.+)/);
    if (urlMatch) {
      const url = urlMatch[1].trim();
      results.push({
        source: '.env',
        type: 'auth',
        pattern: 'MEILISEARCH_URL',
        issues: url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')
          ? ['Meilisearch URL without HTTPS — API key transmitted in plaintext; use https:// for remote Meilisearch instances']
          : [],
      });
    }

    const apiKeyMatch = envContent.match(/MEILISEARCH_API_KEY\s*=\s*(.+)/);
    if (apiKeyMatch) {
      const apiKey = apiKeyMatch[1].trim();
      // Short master-key-looking values (not a reference like %env(...)%)
      if (apiKey && !apiKey.startsWith('%env(') && !apiKey.startsWith('${') && apiKey.length > 0) {
        results.push({
          source: '.env',
          type: 'auth',
          pattern: 'MEILISEARCH_API_KEY',
          issues: [
            'Meilisearch master key in .env — the master key grants full admin access; create separate search/admin API keys and use those in application config',
          ],
        });
      }
    }
  }

  // Check config/packages for meilisearch config
  const configDirs = [
    path.join(appPath, 'config', 'packages', 'meilisearch.yaml'),
    path.join(appPath, 'config', 'packages', 'meilisearch.yml'),
    path.join(appPath, 'config', 'packages', 'meili.yaml'),
    path.join(appPath, 'config', 'packages', 'meili.yml'),
  ];

  for (const configFile of configDirs) {
    if (fs.existsSync(configFile)) {
      const configContent = fs.readFileSync(configFile, 'utf8');
      const relPath = path.relative(appPath, configFile);

      // Index configuration
      if (/index/i.test(configContent)) {
        results.push({
          source: relPath,
          type: 'index',
          pattern: 'index-configuration',
          issues: [],
        });
      }

      // searchable_attributes
      if (/searchable_attributes:/i.test(configContent)) {
        results.push({
          source: relPath,
          type: 'attributes',
          pattern: 'searchable-attributes-configured',
          issues: [],
        });
      } else {
        results.push({
          source: relPath,
          type: 'attributes',
          pattern: 'missing-searchable-attributes',
          issues: [
            'Meilisearch without configured searchableAttributes — all fields searchable by default; configure searchableAttributes to improve search precision and performance',
          ],
        });
      }

      // filterable_attributes
      if (/filterable_attributes:/i.test(configContent)) {
        results.push({
          source: relPath,
          type: 'attributes',
          pattern: 'filterable-attributes-configured',
          issues: [],
        });
      }
    }
  }

  // Check docker-compose.yml for Meilisearch service
  const dockerComposeFiles = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
  ];
  for (const dcFile of dockerComposeFiles) {
    if (fs.existsSync(dcFile)) {
      const dcContent = fs.readFileSync(dcFile, 'utf8');
      if (dcContent.includes('getmeili/meilisearch') || dcContent.includes('gettyimages/meilisearch')) {
        results.push({
          source: path.relative(appPath, dcFile),
          type: 'config',
          pattern: 'docker-meilisearch-service',
          issues: [],
        });
      }
    }
  }

  return results;
}

export function listMeilisearchIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildMeilisearchIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Meilisearch integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Meilisearch Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
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

export function getMeilisearchIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildMeilisearchIntegrationInfos(appPath);
    let text = `Meilisearch Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Index: ${infos.filter((i) => i.type === 'index').length}\n`;
    text += `Auth: ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Attributes: ${infos.filter((i) => i.type === 'attributes').length}\n`;
    text += `Bundle: ${infos.filter((i) => i.type === 'bundle').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMeilisearchIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_meilisearch_integration',
      description: 'Analyze Meilisearch search engine integration configuration and detect issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_meilisearch_integration_stats',
      description: 'Statistics for Meilisearch integration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
