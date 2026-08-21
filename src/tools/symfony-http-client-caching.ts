import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface HttpClientCachingInfo {
  file: string;
  type: 'caching-client' | 'cache-directive' | 'stale-while-revalidate' | 'config' | 'no-cache';
  pattern: string;
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

function buildHttpClientCachingInfos(appPath: string): HttpClientCachingInfo[] {
  const results: HttpClientCachingInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    let content = '';
    try { content = fs.readFileSync(frameworkYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('caching_client') || content.includes('CachingHttpClient')) {
      const hasCacheTtl = /max_age\s*:|ttl\s*:/.test(content);
      const issues: string[] = [];
      if (!hasCacheTtl) {
        issues.push('CachingHttpClient configured without explicit max_age/ttl — relies on upstream Cache-Control headers; if upstream does not set them, responses are never cached');
      }
      results.push({ file: 'config/packages/framework.yaml', type: 'caching-client', pattern: 'CachingHttpClient', issues });
    }

    if (content.includes('http_client:') && !content.includes('caching')) {
      results.push({ file: 'config/packages/framework.yaml', type: 'config', pattern: 'http_client without caching', issues: ['HTTP client configured but no CachingHttpClient — consider wrapping with CachingHttpClient for repeated GET requests to external APIs'] });
    }
  }

  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;

    if (!content.includes('HttpClientInterface') && !content.includes('CachingHttpClient') && !content.includes('$this->client->request')) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('CachingHttpClient')) {
      const hasCachePool = content.includes('CacheInterface') || content.includes('CacheItemPoolInterface') || content.includes('FilesystemAdapter') || content.includes('RedisAdapter');
      const issues: string[] = [];
      if (!hasCachePool) {
        issues.push('CachingHttpClient instantiated without explicit cache pool — defaults to in-memory cache (lost on restart); wire a persistent pool like RedisAdapter');
      }

      const hasMaxAge = /max_age\s*[=:]\s*\d{1,10}/.test(content);
      if (!hasMaxAge) {
        issues.push('CachingHttpClient without explicit max_age — if upstream API omits Cache-Control headers, responses are not cached');
      }

      results.push({ file: relFile, type: 'caching-client', pattern: 'CachingHttpClient', issues });
    }

    if (content.includes("'no-cache'") || content.includes('"no-cache"') || content.includes("'Cache-Control'")) {
      const noStoreMatch = content.includes('no-store') || content.includes('no_store');
      if (noStoreMatch) {
        results.push({ file: relFile, type: 'no-cache', pattern: 'Cache-Control: no-store on request', issues: ['Cache-Control: no-store on outgoing request — correct for sensitive requests; verify this is intentional and not accidentally added to all requests'] });
      }
    }

    if (content.includes('stale-while-revalidate') || content.includes('staleWhileRevalidate')) {
      results.push({ file: relFile, type: 'stale-while-revalidate', pattern: 'stale-while-revalidate', issues: [] });
    }

    const hasParallelRequests = (content.match(/->request\(/g) ?? []).length >= 3;
    const hasCachingClient = content.includes('CachingHttpClient');
    if (hasParallelRequests && !hasCachingClient) {
      results.push({ file: relFile, type: 'config', pattern: 'multiple concurrent requests without caching', issues: ['File makes 3+ HTTP requests without CachingHttpClient — repeated calls to same endpoints waste latency; add CachingHttpClient for idempotent GET requests'] });
    }
  }

  return results;
}

export function listSymfonyHttpClientCaching(appPath: string): McpToolResult {
  try {
    const infos = buildHttpClientCachingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HTTP client caching patterns found (no CachingHttpClient or Cache-Control directives).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `HTTP Client Caching Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpClientCachingStats(appPath: string): McpToolResult {
  try {
    const infos = buildHttpClientCachingInfos(appPath);
    let text = `HTTP Client Caching Statistics\n${'='.repeat(40)}\n\n`;
    text += `Caching clients:  ${infos.filter((i) => i.type === 'caching-client').length}\n`;
    text += `SWR:              ${infos.filter((i) => i.type === 'stale-while-revalidate').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpClientCachingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_http_client_caching', description: 'Analyze Symfony HTTP client caching (CachingHttpClient); warns on missing cache pool (ephemeral in-memory), no explicit max_age, multiple requests without caching, Stale-While-Revalidate usage', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_http_client_caching_stats', description: 'Statistics for HTTP client caching: caching-client/SWR count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
