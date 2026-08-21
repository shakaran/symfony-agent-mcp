import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MemcachedIntegrationInfo {
  source: string;
  type: 'adapter' | 'auth' | 'protocol' | 'session' | 'key';
  pattern: string;
  issues: string[];
}

function buildMemcachedIntegrationInfos(appPath: string): MemcachedIntegrationInfo[] {
  const results: MemcachedIntegrationInfo[] = [];

  const composerJson = path.join(appPath, 'composer.json');
  let hasSymfonyCache = false;
  if (fs.existsSync(composerJson)) {
    let content = '';
    try { content = fs.readFileSync(composerJson, 'utf-8'); } catch { /* skip */ }
    hasSymfonyCache = content.includes('symfony/cache');
  }

  if (!hasSymfonyCache) return results;

  const cacheYamlPaths = [
    path.join(appPath, 'config', 'packages', 'cache.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const cacheYamlPath of cacheYamlPaths) {
    if (!fs.existsSync(cacheYamlPath)) continue;
    let content = '';
    try { content = fs.readFileSync(cacheYamlPath, 'utf-8'); } catch { continue; }

    if (!content.includes('MemcachedAdapter') && !content.includes('memcached://')) continue;

    const relFile = path.relative(appPath, cacheYamlPath);

    const dsnMatches = content.matchAll(/memcached:\/\/([^\s'"]+)/g);
    for (const dsnMatch of dsnMatches) {
      const dsn = dsnMatch[1];
      const hasAuth = dsn.includes('@') && dsn.split('@')[0].includes(':');

      results.push({
        source: relFile,
        type: 'adapter',
        pattern: `MemcachedAdapter DSN: memcached://${dsn}`,
        issues: [],
      });

      if (!hasAuth) {
        results.push({
          source: relFile,
          type: 'auth',
          pattern: 'Memcached without SASL authentication',
          issues: [
            'Memcached without SASL authentication — all traffic readable if network is compromised; use memcached://user:password@host for SASL auth',
          ],
        });
      }
    }

    if (content.includes('MemcachedAdapter') && (content.match(/memcached:\/\//g) || []).length > 1) {
      const hasConsistentHashing = content.includes('consistent') || content.includes('hash');
      if (!hasConsistentHashing) {
        results.push({
          source: relFile,
          type: 'adapter',
          pattern: 'multiple Memcached servers without consistent hashing note',
          issues: [],
        });
      }
    }

    const hasNamespace = content.includes('namespace:') || content.includes('namespace =') || content.includes('prefix');
    if (!hasNamespace && content.includes('MemcachedAdapter')) {
      results.push({
        source: relFile,
        type: 'key',
        pattern: 'Memcached cache pool without namespace',
        issues: [
          'Memcached cache pool without namespace — multiple apps sharing Memcached will have key collisions; set a unique prefix in cache pool configuration',
        ],
      });
    }

    if (content.includes('binary') || content.includes('OPT_BINARY_PROTOCOL')) {
      results.push({
        source: relFile,
        type: 'protocol',
        pattern: 'Memcached binary protocol configured',
        issues: [],
      });
    }
  }

  const phpIniPaths = [
    path.join(appPath, 'php.ini'),
    path.join(appPath, 'docker', 'php.ini'),
    path.join(appPath, '.docker', 'php', 'php.ini'),
    path.join(appPath, 'config', 'php.ini'),
  ];

  for (const phpIniPath of phpIniPaths) {
    if (!fs.existsSync(phpIniPath)) continue;
    let content = '';
    try { content = fs.readFileSync(phpIniPath, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, phpIniPath);

    if (content.includes('session.save_handler') && content.includes('memcached')) {
      results.push({
        source: relFile,
        type: 'session',
        pattern: 'PHP session handler using Memcached',
        issues: [
          'PHP session handler using Memcached — sessions will be lost if Memcached restarts; ensure session.gc_probability is set and consider using Redis with persistence',
        ],
      });
    }
  }

  return results;
}

export function listMemcachedIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildMemcachedIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Memcached integration patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Memcached Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMemcachedIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildMemcachedIntegrationInfos(appPath);
    let text = `Memcached Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Adapter:  ${infos.filter((i) => i.type === 'adapter').length}\n`;
    text += `Auth:     ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Protocol: ${infos.filter((i) => i.type === 'protocol').length}\n`;
    text += `Session:  ${infos.filter((i) => i.type === 'session').length}\n`;
    text += `Key:      ${infos.filter((i) => i.type === 'key').length}\n`;
    text += `Issues:   ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMemcachedIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_memcached_integration', description: 'Analyze Memcached integration; warns on missing SASL auth, session handler volatility, missing namespace prefix causing key collisions', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_memcached_integration_stats', description: 'Statistics for Memcached integration: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
