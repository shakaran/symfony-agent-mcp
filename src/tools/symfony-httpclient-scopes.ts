// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTTP Client Scoped Clients Inspector
 *
 * Distinct from http-client.ts (general HttpClient config).
 * Focuses on scoped HTTP client configuration for named services:
 *
 *   framework:
 *     http_client:
 *       scoped_clients:
 *         github.client:
 *           base_uri: 'https://api.github.com'
 *           auth_bearer: '%env(GITHUB_TOKEN)%'
 *           headers: { Accept: 'application/vnd.github.v3+json' }
 *           max_redirects: 3
 *         payment.client:
 *           base_uri: 'https://api.stripe.com/v1/'
 *           auth_basic: ['%env(STRIPE_KEY)%', '']
 *         internal.client:
 *           base_uri: 'http://internal-service/'
 *           verify_peer: false
 *           verify_host: false
 *
 * retry_failed configuration:
 *   - max_retries, delay, multiplier, max_delay
 *   - http_codes that trigger retry
 *
 * Analysis:
 *   - verify_peer: false or verify_host: false (disables TLS verification — insecure)
 *   - auth credentials hardcoded (not from %env(...)%)
 *   - base_uri using http:// instead of https://
 *   - Scoped client not injected anywhere in src/ (dead config)
 *   - retry_failed with max_retries: 0 (retry disabled)
 *
 * Pure static analysis — credential values never displayed.
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

interface ScopedClient {
  name: string;
  baseUri?: string;
  authType?: string;
  hasEnvAuth: boolean;
  verifyPeer: boolean;
  verifyHost: boolean;
  maxRetries?: number;
  issues: string[];
}

function loadScopedClients(appPath: string): ScopedClient[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw      = (raw['framework'] ?? raw) as Record<string, unknown>;
    const hcRaw   = (fw['http_client'] ?? {}) as Record<string, unknown>;
    const scoped  = (hcRaw['scoped_clients'] ?? {}) as Record<string, unknown>;

    const clients: ScopedClient[] = [];
    for (const [name, clientData] of Object.entries(scoped)) {
      const client = (clientData ?? {}) as Record<string, unknown>;

      const baseUri    = client['base_uri'] ? String(client['base_uri']) : undefined;
      const verifyPeer = client['verify_peer'] !== false;
      const verifyHost = client['verify_host'] !== false;

      let authType: string | undefined;
      let hasEnvAuth = false;
      if (client['auth_bearer']) {
        authType = 'bearer';
        hasEnvAuth = String(client['auth_bearer']).includes('%env(');
      } else if (client['auth_basic']) {
        authType = 'basic';
        const basicVal = Array.isArray(client['auth_basic']) ? String(client['auth_basic'][0]) : String(client['auth_basic']);
        hasEnvAuth = basicVal.includes('%env(');
      } else if (client['auth_ntlm']) {
        authType = 'ntlm';
        hasEnvAuth = String(client['auth_ntlm']).includes('%env(');
      }

      const retryRaw   = (client['retry_failed'] ?? {}) as Record<string, unknown>;
      const maxRetries = retryRaw['max_retries'] !== undefined ? parseInt(String(retryRaw['max_retries']), 10) : undefined;

      const issues: string[] = [];
      if (!verifyPeer) issues.push('verify_peer: false — TLS certificate validation disabled (insecure)');
      if (!verifyHost) issues.push('verify_host: false — hostname verification disabled (MITM risk)');
      if (authType && !hasEnvAuth) issues.push(`${authType} credentials hardcoded — use %env(VAR)% reference`);
      if (baseUri?.startsWith('http://') && !baseUri.includes('localhost') && !baseUri.includes('127.0.0.1')) {
        issues.push(`base_uri uses http:// — plaintext transport (use https://)`);
      }

      clients.push({ name, baseUri, authType, hasEnvAuth, verifyPeer, verifyHost, maxRetries, issues });
    }
    return clients;
  }
  return [];
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

function findUnusedClients(appPath: string, clients: ScopedClient[]): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir) || clients.length === 0) return [];

  const injected = new Set<string>();
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;
    for (const client of clients) {
      if (content.includes(client.name) || content.includes(client.name.replace('.', '_'))) {
        injected.add(client.name);
      }
    }
  }
  return clients.map((c) => c.name).filter((n) => !injected.has(n));
}

export function listHttpClientScopes(appPath: string): McpToolResult {
  try {
    const clients = loadScopedClients(appPath);

    if (clients.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No scoped HTTP clients configured.\n\nExample configuration:\n  framework:\n    http_client:\n      scoped_clients:\n        github.client:\n          base_uri: \'https://api.github.com\'\n          auth_bearer: \'%env(GITHUB_TOKEN)%\'\n          headers:\n            Accept: \'application/vnd.github.v3+json\'',
        }],
      };
    }

    const unused      = findUnusedClients(appPath, clients);
    const totalIssues = clients.reduce((s, c) => s + c.issues.length, 0) + unused.length;

    let text = `HTTP Client Scoped Clients\n${'='.repeat(55)}\n`;
    text += `\nScoped clients: ${clients.length}  Issues: ${totalIssues}\n`;

    for (const c of clients.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name))) {
      const authStr = c.authType ? `  auth: ${c.authType}${c.hasEnvAuth ? ' (env)' : ' ⚠ hardcoded'}` : '';
      const tlsStr  = (!c.verifyPeer || !c.verifyHost) ? '  ⚠ TLS disabled' : '';
      const retryStr = c.maxRetries !== undefined ? `  retry: ${c.maxRetries}` : '';
      const unusedStr = unused.includes(c.name) ? '  ⚠ unused' : '';

      text += `\n  ${c.name}\n`;
      if (c.baseUri) text += `    base_uri: ${c.baseUri}\n`;
      text += `    ${authStr}${tlsStr}${retryStr}${unusedStr}\n`.trimStart();
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    if (unused.length > 0) {
      text += `\n⚠ Scoped clients not found in src/ (possibly unused): ${unused.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientScopeStats(appPath: string): McpToolResult {
  try {
    const clients = loadScopedClients(appPath);

    let text = `HTTP Client Scope Statistics\n${'='.repeat(40)}\n\n`;
    text += `Scoped clients:      ${clients.length}\n`;
    text += `  With bearer auth:  ${clients.filter((c) => c.authType === 'bearer').length}\n`;
    text += `  With basic auth:   ${clients.filter((c) => c.authType === 'basic').length}\n`;
    text += `  Using env creds:   ${clients.filter((c) => c.hasEnvAuth).length}\n`;
    text += `  TLS disabled:      ${clients.filter((c) => !c.verifyPeer || !c.verifyHost).length}\n`;
    text += `  With retry:        ${clients.filter((c) => c.maxRetries !== undefined && c.maxRetries > 0).length}\n`;
    text += `Issues:              ${clients.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientScopeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_httpclient_scopes',
      description: 'Show scoped HTTP client configuration: base_uri, auth type (bearer/basic/ntlm), env vs hardcoded credentials, verify_peer/verify_host TLS settings, retry_failed config, unused scoped client detection, http:// insecure base_uri warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_httpclient_scope_stats',
      description: 'Show HTTP client scope statistics: client count, auth type counts, env credentials count, TLS disabled count, retry count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
