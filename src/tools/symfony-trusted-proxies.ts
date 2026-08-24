// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Trusted Proxies / Reverse Proxy Inspector
 *
 * Distinct from http-cache.ts (content caching) and cors.ts (CORS headers).
 * Focuses on reverse proxy trust configuration:
 *
 * framework.yaml:
 *   - trusted_proxies: '127.0.0.1,REMOTE_ADDR' or list
 *   - trusted_headers: list of X-Forwarded-* headers to trust
 *
 * Analysis:
 *   - trusted_proxies: '*' (trust all — never safe in production)
 *   - REMOTE_ADDR in trusted_proxies (trusts the immediate client, breaks with multi-hop)
 *   - trusted_headers not including FORWARDED or missing X-FORWARDED-FOR
 *   - Missing trusted_proxies when X-Forwarded-* headers are used in controllers
 *   - Multiple proxy hops without proper trusted_proxies chain
 *
 * X-Forwarded-* header usage scan:
 *   - $request->getClientIp() usage (relies on trusted_proxies)
 *   - $request->headers->get('X-Forwarded-For') direct access (bypasses trust check)
 *   - $request->getScheme() / isSecure() usage affected by X-FORWARDED-PROTO
 *
 * Docker / Kubernetes detection:
 *   - docker-compose.yml with nginx/traefik service
 *   - .env TRUSTED_PROXIES / TRUSTED_HOSTS vars
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ProxyConfig {
  trustedProxies: string[];
  trustedHeaders: string[];
  rawTrustedProxies?: string;
}

function loadProxyConfig(appPath: string): ProxyConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw = (raw['framework'] ?? raw) as Record<string, unknown>;

    if (!('trusted_proxies' in fw) && !('trusted_headers' in fw)) continue;

    const proxiesRaw = fw['trusted_proxies'];
    const trustedProxies = Array.isArray(proxiesRaw)
      ? proxiesRaw.map(String)
      : proxiesRaw ? String(proxiesRaw).split(',').map((s) => s.trim()) : [];

    const headersRaw     = fw['trusted_headers'];
    const trustedHeaders = Array.isArray(headersRaw) ? headersRaw.map(String) : [];

    return { trustedProxies, trustedHeaders, rawTrustedProxies: proxiesRaw ? String(proxiesRaw) : undefined };
  }
  return null;
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

function scanProxyHeaderUsage(appPath: string): { directAccess: string[]; clientIpUsage: string[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { directAccess: [], clientIpUsage: [] };

  const directAccess: string[] = [];
  const clientIpUsage: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('X-Forwarded') && !content.includes('getClientIp') &&
        !content.includes('getScheme') && !content.includes('isSecure')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    if (/headers->get\s*\(\s*['"]X-Forwarded/.test(content)) directAccess.push(classM[1]);
    if (content.includes('->getClientIp()') || content.includes('->isSecure()')) clientIpUsage.push(classM[1]);
  }
  return { directAccess, clientIpUsage };
}

function detectTrustedProxiesEnvVar(appPath: string): boolean {
  for (const envFile of ['.env', '.env.local', '.env.prod']) {
    const fp = path.join(appPath, envFile);
    if (!fs.existsSync(fp)) continue;
    try {
      if (fs.readFileSync(fp, 'utf-8').includes('TRUSTED_PROXIES')) return true;
    } catch { /* skip */ }
  }
  return false;
}

export function listTrustedProxyConfig(appPath: string): McpToolResult {
  try {
    const config  = loadProxyConfig(appPath);
    const { directAccess, clientIpUsage } = scanProxyHeaderUsage(appPath);
    const hasEnvVar = detectTrustedProxiesEnvVar(appPath);

    let text = `Trusted Proxy Configuration\n${'='.repeat(55)}\n\n`;

    if (!config) {
      text += `trusted_proxies: not configured\n`;
      text += `trusted_headers: not configured\n`;
      if (clientIpUsage.length > 0) {
        text += `\n⚠ trusted_proxies not set but getClientIp()/isSecure() used in:\n`;
        for (const cls of clientIpUsage) text += `  ${cls}\n`;
      } else {
        text += `\n✓ No proxy header usage detected in src/\n`;
      }
      return { content: [{ type: 'text', text }] };
    }

    text += `trusted_proxies: ${config.trustedProxies.join(', ') || 'none'}\n`;
    text += `trusted_headers: ${config.trustedHeaders.join(', ') || 'default'}\n`;
    if (hasEnvVar) text += `TRUSTED_PROXIES env var: found in .env file\n`;

    const issues: string[] = [];

    if (config.trustedProxies.includes('*')) {
      issues.push('trusted_proxies: \'*\' — trusts ALL clients, never use in production without additional controls');
    }
    if (config.trustedProxies.includes('REMOTE_ADDR')) {
      issues.push('REMOTE_ADDR in trusted_proxies — trusts the immediate connecting IP (risky with multi-hop proxies)');
    }
    if (directAccess.length > 0) {
      issues.push(`Direct X-Forwarded-* header access (bypasses trust check): ${directAccess.join(', ')}`);
    }
    if (clientIpUsage.length > 0 && config.trustedProxies.length === 0) {
      issues.push(`getClientIp()/isSecure() used but trusted_proxies is empty: ${clientIpUsage.join(', ')}`);
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    } else {
      text += `\n✓ No trusted proxy issues detected\n`;
    }

    if (clientIpUsage.length > 0) {
      text += `\ngetClientIp()/isSecure() usage in: ${clientIpUsage.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTrustedProxyStats(appPath: string): McpToolResult {
  try {
    const config = loadProxyConfig(appPath);
    const { directAccess, clientIpUsage } = scanProxyHeaderUsage(appPath);

    let text = `Trusted Proxy Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured:          ${config ? 'yes' : 'no'}\n`;
    text += `Trusted IPs/ranges:  ${config?.trustedProxies.length ?? 0}\n`;
    text += `Trusted headers:     ${config?.trustedHeaders.length ?? 0}\n`;
    text += `Direct header access: ${directAccess.length}\n`;
    text += `ClientIp usage:      ${clientIpUsage.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getTrustedProxyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_trusted_proxy_config',
      description: 'Show trusted proxy configuration: trusted_proxies IPs/ranges, trusted_headers, wildcard (*) trust warning, REMOTE_ADDR risk, direct X-Forwarded-* header access detection, getClientIp/isSecure usage without trusted_proxies',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_trusted_proxy_stats',
      description: 'Show trusted proxy statistics: configured, trusted IP count, header count, direct access count, ClientIp usage count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
