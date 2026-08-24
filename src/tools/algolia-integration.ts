// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface AlgoliaIntegrationInfo {
  file: string;
  type: 'index' | 'search' | 'facet' | 'synonym';
  indexName: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildAlgoliaIntegrationInfos(appPath: string): AlgoliaIntegrationInfo[] {
  const results: AlgoliaIntegrationInfo[] = [];

  // Check composer.json for algolia packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('algolia/algoliasearch-client-php')) {
      results.push({ file: 'composer.json', type: 'index', indexName: '', issues: [] });
    }
    if (composerContent.includes('algolia/search-bundle')) {
      results.push({ file: 'composer.json', type: 'index', indexName: '', issues: [] });
    }
  }

  // Scan .env* for Algolia credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  let detectedAdminKey = false;
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const appIdMatch = /ALGOLIA_APP_ID\s*=\s*([^\n]+)/.exec(content);
    const apiKeyMatch = /ALGOLIA_API_KEY\s*=\s*([^\n]+)/.exec(content);
    const searchKeyMatch = /ALGOLIA_SEARCH_KEY\s*=\s*([^\n]+)/.exec(content);

    if (appIdMatch) {
      results.push({ file: fname, type: 'index', indexName: '', issues: [] });
    }
    if (apiKeyMatch) {
      const rawKey = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (rawKey && !rawKey.startsWith('%env(') && !rawKey.startsWith('${')) {
        issues.push(`ALGOLIA_API_KEY present in ${fname} — inject via CI secrets; never commit Algolia admin keys to version control`);
        detectedAdminKey = true;
      }
      results.push({ file: fname, type: 'index', indexName: '', issues });
      // Masked config is used internally only, no direct exposure
    }
    if (searchKeyMatch) {
      results.push({ file: fname, type: 'search', indexName: '', issues: [] });
    } else if (apiKeyMatch && !searchKeyMatch) {
      // Admin key present but no separate search key
      results.push({ file: fname, type: 'search', indexName: '', issues: ['ALGOLIA_SEARCH_KEY not set — use a dedicated search-only API key (restricted to search operations) for frontend; admin key should never be exposed to clients'] });
    }
  }

  // Check config/packages/algolia*.yaml
  const configDir = path.join(appPath, 'config', 'packages');
  if (fs.existsSync(configDir)) {
    try {
      for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('algolia')) continue;
        const fpath = path.join(configDir, entry.name);
        const content = safeRead(fpath, appPath);
        if (!content) continue;
        const relFile = path.relative(appPath, fpath);
        const issues: string[] = [];
        if (!content.includes('attributesForFaceting') && !content.includes('faceting')) {
          issues.push(`Algolia config in ${relFile} has no attributesForFaceting — define facet attributes to enable filtering and improve search relevance`);
        }
        results.push({ file: relFile, type: 'facet', indexName: '', issues });
      }
    } catch { /* skip */ }
  }

  // Scan src/**/*.php for Algolia usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('SearchClient') &&
      !content.includes('algolia_client') &&
      !content.includes('->search(') &&
      !content.includes('->saveObject(') &&
      !content.includes('->setSettings(')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Admin API key used for search (security risk)
    if ((content.includes('SearchClient::create(') || content.includes('algolia_client')) && detectedAdminKey) {
      if (!content.includes('searchKey') && !content.includes('SEARCH_KEY')) {
        issues.push(`Algolia client in ${relFile} may be using admin API key for search — use a search-only API key for public-facing search; admin keys allow index modification`);
      }
    }

    // Hardcoded index names
    if (/->search\s*\(\s*['"][a-zA-Z0-9_-]{3,}['"]/.test(content) || /->saveObject\s*\(/.test(content)) {
      if (!content.includes('getenv') && !content.includes('$_ENV') && !content.includes('%env(')) {
        issues.push(`Possible hardcoded Algolia index name in ${relFile} — use env variable for index name to support environment-specific indices (dev/staging/prod)`);
      }
    }

    const indexNameM = /['"]([a-zA-Z0-9_-]{3,50})['"]\s*(?:=>|,)/.exec(content);
    const indexName = indexNameM ? indexNameM[1] : '';

    const type: AlgoliaIntegrationInfo['type'] = content.includes('->setSettings(') ? 'facet'
      : content.includes('synonym') || content.includes('Synonym') ? 'synonym'
      : content.includes('->search(') ? 'search'
      : 'index';

    results.push({ file: relFile, type, indexName, issues });
  }

  return results;
}

export function listAlgoliaIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildAlgoliaIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Algolia integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Algolia Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const idxStr = info.indexName ? `  index:${info.indexName}` : '';
      text += `\n  [${info.type.toUpperCase()}]${idxStr}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAlgoliaIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildAlgoliaIntegrationInfos(appPath);
    let text = `Algolia Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Index patterns:   ${infos.filter((i) => i.type === 'index').length}\n`;
    text += `Search patterns:  ${infos.filter((i) => i.type === 'search').length}\n`;
    text += `Facet patterns:   ${infos.filter((i) => i.type === 'facet').length}\n`;
    text += `Synonym patterns: ${infos.filter((i) => i.type === 'synonym').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAlgoliaIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_algolia_integration',
      description: 'Analyze Algolia integration: detect composer packages, env credentials (ALGOLIA_APP_ID/API_KEY/SEARCH_KEY), config/packages/algolia*.yaml, PHP SearchClient/search/saveObject/setSettings usage, flag admin key for search, no attributesForFaceting, hardcoded index names',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_algolia_integration_stats',
      description: 'Statistics for Algolia integration: index/search/facet/synonym pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
