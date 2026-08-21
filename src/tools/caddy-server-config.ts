import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CaddyConfigInfo {
  file: string;
  directive: string;
  value: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadDir(dir: string, base: string): string[] {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return [];
  try { return fs.readdirSync(resolved); } catch { return []; }
}

function parseCaddyfile(content: string, relPath: string): CaddyConfigInfo[] {
  const results: CaddyConfigInfo[] = [];

  // Site address
  const siteMatch = content.match(/^([^\s{][^\n{]{0,120})\s*\{/m);
  if (siteMatch) {
    results.push({ file: relPath, directive: 'site_address', value: siteMatch[1].trim(), issues: [] });
  }

  // TLS
  if (/\btls\b/.test(content)) {
    results.push({ file: relPath, directive: 'tls', value: 'configured', issues: [] });
  } else {
    results.push({
      file: relPath,
      directive: 'tls',
      value: 'missing',
      issues: ['No TLS directive found in Caddyfile — add "tls" block or use automatic HTTPS (site address with domain)'],
    });
  }

  // reverse_proxy
  const reverseProxyMatch = content.match(/reverse_proxy\s+([^\n]{1,200})/);
  if (reverseProxyMatch) {
    const target = reverseProxyMatch[1].trim();
    const info: CaddyConfigInfo = { file: relPath, directive: 'reverse_proxy', value: target, issues: [] };
    if (!/health_uri|health_interval|lb_policy/.test(content)) {
      info.issues.push('reverse_proxy configured without health checks — add health_uri and health_interval inside reverse_proxy block');
    }
    results.push(info);
  }

  // encode (gzip/zstd)
  if (/\bencode\b/.test(content)) {
    const encodeMatch = content.match(/encode\s+([^\n{]{1,100})/);
    results.push({ file: relPath, directive: 'encode', value: encodeMatch ? encodeMatch[1].trim() : 'configured', issues: [] });
  } else {
    results.push({
      file: relPath,
      directive: 'encode',
      value: 'missing',
      issues: ['No gzip/zstd encoding configured — add "encode gzip zstd" to improve transfer performance'],
    });
  }

  // root directive
  const rootMatch = content.match(/\broot\s+([^\n]{1,200})/);
  if (rootMatch) {
    results.push({ file: relPath, directive: 'root', value: rootMatch[1].trim(), issues: [] });
  }

  return results;
}

function parseCaddyJson(content: string, relPath: string): CaddyConfigInfo[] {
  const results: CaddyConfigInfo[] = [];
  let json: Record<string, unknown>;
  try { json = JSON.parse(content) as Record<string, unknown>; } catch { return results; }

  results.push({ file: relPath, directive: 'format', value: 'caddy.json', issues: [] });

  // Check for TLS in apps.http.servers
  const apps = json['apps'] as Record<string, unknown> | undefined;
  if (apps) {
    const httpApp = apps['http'] as Record<string, unknown> | undefined;
    if (httpApp) {
      const servers = httpApp['servers'] as Record<string, unknown> | undefined;
      if (servers) {
        let hasTls = false;
        for (const srv of Object.values(servers)) {
          const s = srv as Record<string, unknown>;
          if (s['tls_connection_policies'] || (s['listen'] as string[] | undefined)?.some((l) => l.includes(':443'))) {
            hasTls = true;
          }
        }
        if (!hasTls) {
          results.push({
            file: relPath,
            directive: 'tls',
            value: 'missing',
            issues: ['caddy.json has no TLS connection policies — configure tls_connection_policies for HTTPS servers'],
          });
        }
      }
    }
  }

  return results;
}

function buildCaddyConfigInfos(appPath: string): CaddyConfigInfo[] {
  const results: CaddyConfigInfo[] = [];
  const candidates = [
    'Caddyfile',
    'caddy.json',
    path.join('docker', 'Caddyfile'),
    path.join('.docker', 'Caddyfile'),
  ];

  for (const rel of candidates) {
    const fullPath = path.join(appPath, rel);
    const content = safeReadFile(fullPath, appPath);
    if (content === null) continue;

    if (rel.endsWith('.json')) {
      results.push(...parseCaddyJson(content, rel));
    } else {
      results.push(...parseCaddyfile(content, rel));
    }
  }

  // Also scan docker/ and .docker/ for any Caddyfile variants
  for (const dockerDir of ['docker', '.docker']) {
    const dirPath = path.join(appPath, dockerDir);
    for (const entry of safeReadDir(dirPath, appPath)) {
      if (entry === 'Caddyfile' || entry.startsWith('Caddyfile.')) {
        const fullPath = path.join(dirPath, entry);
        const relPath = path.join(dockerDir, entry);
        // skip already processed
        if (candidates.includes(relPath)) continue;
        const content = safeReadFile(fullPath, appPath);
        if (content !== null) results.push(...parseCaddyfile(content, relPath));
      }
    }
  }

  return results;
}

export function listCaddyServerConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCaddyConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Caddy configuration files found (Caddyfile, caddy.json, docker/Caddyfile, .docker/Caddyfile).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Caddy Server Configuration Analysis\n${'='.repeat(55)}\n\nDirectives: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.directive.toUpperCase()}] ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCaddyServerConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCaddyConfigInfos(appPath);
    const files = [...new Set(infos.map((i) => i.file))];
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Caddy Server Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config files found:   ${files.length}\n`;
    text += `Directives analyzed:  ${infos.length}\n`;
    text += `TLS directives:       ${infos.filter((i) => i.directive === 'tls').length}\n`;
    text += `reverse_proxy:        ${infos.filter((i) => i.directive === 'reverse_proxy').length}\n`;
    text += `encode:               ${infos.filter((i) => i.directive === 'encode').length}\n`;
    text += `Total issues:         ${totalIssues}\n`;
    if (files.length > 0) text += `\nFiles:\n${files.map((f) => `  ${f}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCaddyServerConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_caddy_server_config',
      description: 'Analyse Caddy server configuration files (Caddyfile, caddy.json, docker/Caddyfile) for missing TLS, missing gzip/zstd encoding, reverse_proxy without health checks, and root directive settings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_caddy_server_config_stats',
      description: 'Statistics for Caddy server configuration: count of config files, directives analyzed, TLS/reverse_proxy/encode entries, and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
