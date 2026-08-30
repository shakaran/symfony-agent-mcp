// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTTP Client Inspector
 *
 * Discovers HTTP client configuration and usage:
 *   - Scoped clients from config/packages/framework.yaml (http_client.scoped_clients)
 *   - Default HTTP client options (base_uri, headers, auth_basic, timeout, etc.)
 *   - Services injecting HttpClientInterface or named scoped clients
 *   - External base URIs (sanitized — auth stripped)
 *   - Usage patterns: which services make HTTP calls
 *
 * Pure static analysis — no actual HTTP requests.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface HttpClientScope {
  name: string;
  baseUri?: string;
  headers?: Record<string, string>;
  authBasic?: string;
  authBearer?: string;
  timeout?: number;
  maxRedirects?: number;
  verifySsl?: boolean;
}

interface HttpClientDefault {
  baseUri?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRedirects?: number;
}

interface HttpClientUsage {
  class: string;
  file: string;
  usesGenericClient: boolean;
  usesNamedClients: string[];
  makesCalls: boolean;
}

// ─── Config parsing ────────────────────────────────────────────────────────

const CREDENTIAL_HEADER_RE = /^(authorization|x-api-key|x-auth-token|cookie|proxy-authorization|x-secret|x-token|set-cookie|x-access-token)$/i;

function maskHeaderValue(name: string, value: string): string {
  return CREDENTIAL_HEADER_RE.test(name) ? '***' : value;
}

function maskAuthUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username.slice(0, 3) + '***';
    return url.toString();
  } catch {
    return uri;
  }
}

function loadHttpClientConfig(appPath: string): {
  defaults: HttpClientDefault;
  scopes: HttpClientScope[];
  enabled: boolean;
} {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
    path.join(appPath, 'config', 'framework.yaml'),
    path.join(appPath, 'config', 'framework.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const httpClientSection = framework['http_client'] as Record<string, unknown> | undefined;
    if (!httpClientSection) continue;

    const defaultsRaw = httpClientSection as Record<string, unknown>;
    const defaults: HttpClientDefault = {
      baseUri: defaultsRaw['base_uri'] ? maskAuthUri(String(defaultsRaw['base_uri'])) : undefined,
      timeout: defaultsRaw['timeout'] ? Number(defaultsRaw['timeout']) : undefined,
      maxRedirects: defaultsRaw['max_redirects'] ? Number(defaultsRaw['max_redirects']) : undefined,
    };

    const headersRaw = defaultsRaw['headers'] as Record<string, unknown> | undefined;
    if (headersRaw) {
      defaults.headers = Object.fromEntries(
        Object.entries(headersRaw).map(([k, v]) => [k, maskHeaderValue(k, String(v))])
      );
    }

    const scopedRaw = httpClientSection['scoped_clients'] as Record<string, unknown> | undefined;
    const scopes: HttpClientScope[] = [];

    if (scopedRaw) {
      for (const [name, def] of Object.entries(scopedRaw)) {
        if (!def || typeof def !== 'object') continue;
        const s = def as Record<string, unknown>;

        const scope: HttpClientScope = { name };
        if (s['base_uri']) scope.baseUri = maskAuthUri(String(s['base_uri']));
        if (s['timeout']) scope.timeout = Number(s['timeout']);
        if (s['max_redirects']) scope.maxRedirects = Number(s['max_redirects']);
        if (s['verify_peer'] === false || s['verify_host'] === false) scope.verifySsl = false;

        const auth = s['auth_basic'] as string | undefined;
        if (auth) scope.authBasic = auth.includes(':') ? auth.split(':')[0] + ':***' : auth;

        const bearer = s['auth_bearer'] as string | undefined;
        if (bearer) scope.authBearer = '***';

        const headers = s['headers'] as Record<string, unknown> | undefined;
        if (headers) {
          scope.headers = Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k, maskHeaderValue(k, String(v))])
          );
        }

        scopes.push(scope);
      }
    }

    return { defaults, scopes, enabled: true };
  }

  return { defaults: {}, scopes: [], enabled: false };
}

// ─── Usage scanning ────────────────────────────────────────────────────────

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

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function scanHttpClientUsage(appPath: string, scopes: HttpClientScope[]): HttpClientUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const scopeNames = scopes.map((s) => s.name);
  const usages: HttpClientUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('HttpClient') && !content.includes('HttpClientInterface')) continue;

    const className = extractClassName(content);
    if (!className) continue;

    const usesGenericClient = /HttpClientInterface\s+\$/.test(content) ||
                              /HttpClient::create/.test(content);

    const usesNamedClients = scopeNames.filter((name) =>
      content.includes(`$${name}`) || content.includes(`'${name}'`)
    );

    const makesCalls = content.includes('->request(') || content.includes('->get(') ||
                       content.includes('->post(') || content.includes('->delete(') ||
                       content.includes('->patch(') || content.includes('->put(');

    if (usesGenericClient || usesNamedClients.length > 0 || makesCalls) {
      usages.push({
        class: className,
        file: path.basename(file),
        usesGenericClient,
        usesNamedClients,
        makesCalls,
      });
    }
  }

  return usages.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listHttpClients(appPath: string): McpToolResult {
  try {
    const { defaults, scopes, enabled } = loadHttpClientConfig(appPath);

    if (!enabled && scopes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'HTTP Client not configured in framework.yaml.\n\nInstall: composer require symfony/http-client\nConfigure in config/packages/framework.yaml:\n  framework:\n    http_client:\n      scoped_clients:\n        my_api.client:\n          base_uri: https://api.example.com',
        }],
      };
    }

    let text = `HTTP Client Configuration\n${'='.repeat(50)}\n`;

    if (defaults.baseUri || defaults.timeout || defaults.headers) {
      text += `\nDefaults:\n`;
      if (defaults.baseUri) text += `  Base URI: ${defaults.baseUri}\n`;
      if (defaults.timeout) text += `  Timeout:  ${defaults.timeout}s\n`;
      if (defaults.headers) {
        for (const [k, v] of Object.entries(defaults.headers)) {
          text += `  Header:   ${k}: ${v}\n`;
        }
      }
    }

    if (scopes.length > 0) {
      text += `\nScoped Clients (${scopes.length}):\n`;
      for (const s of scopes) {
        text += `\n  ${s.name}\n`;
        if (s.baseUri) text += `    Base URI:   ${s.baseUri}\n`;
        if (s.timeout) text += `    Timeout:    ${s.timeout}s\n`;
        if (s.maxRedirects !== undefined) text += `    Max redirects: ${s.maxRedirects}\n`;
        if (s.authBasic) text += `    Auth:       Basic ${s.authBasic}\n`;
        if (s.authBearer) text += `    Auth:       Bearer ***\n`;
        if (s.verifySsl === false) text += `    SSL verify: DISABLED ⚠\n`;
        if (s.headers) {
          for (const [k, v] of Object.entries(s.headers)) {
            text += `    Header:     ${k}: ${v}\n`;
          }
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

export function listHttpClientUsage(appPath: string): McpToolResult {
  try {
    const { scopes } = loadHttpClientConfig(appPath);
    const usages = scanHttpClientUsage(appPath, scopes);

    if (usages.length === 0) {
      return {
        content: [{ type: 'text', text: 'No services found using HttpClientInterface or scoped HTTP clients.' }],
      };
    }

    let text = `HTTP Client Usage (${usages.length} services)\n${'='.repeat(50)}\n\n`;

    for (const u of usages) {
      text += `  ${u.class}  (${u.file})\n`;
      const info: string[] = [];
      if (u.usesGenericClient) info.push('HttpClientInterface');
      if (u.usesNamedClients.length > 0) info.push(`named: ${u.usesNamedClients.join(', ')}`);
      if (u.makesCalls) info.push('makes requests');
      text += `    ${info.join(' · ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientStats(appPath: string): McpToolResult {
  try {
    const { defaults, scopes, enabled } = loadHttpClientConfig(appPath);
    const usages = scanHttpClientUsage(appPath, scopes);

    let text = `HTTP Client Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured:          ${enabled ? 'yes' : 'no'}\n`;
    text += `Scoped clients:      ${scopes.length}\n`;
    text += `Services using it:   ${usages.length}\n`;
    text += `With named clients:  ${usages.filter((u) => u.usesNamedClients.length > 0).length}\n`;

    if (scopes.some((s) => s.verifySsl === false)) {
      text += `\n⚠ SSL verification disabled on ${scopes.filter((s) => s.verifySsl === false).length} client(s).\n`;
    }

    const externalUris = scopes.filter((s) => s.baseUri).map((s) => s.baseUri!);
    if (externalUris.length > 0) {
      text += `\nExternal base URIs:\n`;
      for (const uri of externalUris) text += `  ${uri}\n`;
    }

    void defaults;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getHttpClientTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_http_clients',
      description: 'List configured Symfony HTTP clients: default options and all scoped clients with base URIs, headers, auth, and timeout (credentials masked)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_http_client_usage',
      description: 'Find services that inject HttpClientInterface or named scoped clients, and which ones make HTTP requests',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_http_client_stats',
      description: 'Show HTTP client statistics: client count, service usage count, external base URIs, and SSL verification warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
