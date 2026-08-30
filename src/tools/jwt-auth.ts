// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * JWT / Authentication Inspector
 *
 * Reads authentication configuration from:
 *   - config/packages/lexik_jwt_authentication.yaml (LexikJWT)
 *   - config/packages/security.yaml (firewalls, authenticators)
 *   - config/packages/league_oauth2_server.yaml (OAuth2, if installed)
 *
 * Reports:
 *   - JWT algorithm, token TTL, key paths (no key content)
 *   - Firewalls using JWT authenticator vs session vs other
 *   - OAuth2 grant types and scopes (if configured)
 *   - API key patterns in firewall config
 *
 * Pure static analysis — no tokens generated or validated.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface JwtConfig {
  secretKey?: string;
  publicKey?: string;
  passphrase?: boolean;
  algorithm?: string;
  tokenTtl?: number;
  refreshTokenTtl?: number;
  clockSkew?: number;
}

interface FirewallAuth {
  name: string;
  pattern?: string;
  authType: string;
  stateless?: boolean;
  provider?: string;
}

interface OAuth2Config {
  grantTypes: string[];
  scopes: string[];
  accessTokenTtl?: string;
  refreshTokenTtl?: string;
}

// ─── JWT config loading ────────────────────────────────────────────────────

function loadJwtConfig(appPath: string): JwtConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'lexik_jwt_authentication.yaml'),
    path.join(appPath, 'config', 'packages', 'lexik_jwt_authentication.yml'),
    path.join(appPath, 'config', 'packages', 'lexik_jwt.yaml'),
    path.join(appPath, 'config', 'packages', 'lexik_jwt.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const jwt = (raw['lexik_jwt_authentication'] ?? raw) as Record<string, unknown>;

    const secretKey = jwt['secret_key'] ? String(jwt['secret_key']) : undefined;
    const publicKey = jwt['public_key'] ? String(jwt['public_key']) : undefined;

    return {
      secretKey,
      publicKey,
      passphrase: Boolean(jwt['pass_phrase'] ?? jwt['passphrase']),
      algorithm: jwt['encoder']
        ? String((jwt['encoder'] as Record<string, unknown>)['signature_algorithm'] ?? 'RS256')
        : String(jwt['algorithm'] ?? 'RS256'),
      tokenTtl: jwt['token_ttl'] ? Number(jwt['token_ttl']) : undefined,
      refreshTokenTtl: jwt['refresh_token_ttl'] ? Number(jwt['refresh_token_ttl']) : undefined,
      clockSkew: jwt['clock_skew'] ? Number(jwt['clock_skew']) : undefined,
    };
  }

  return null;
}

// ─── Security firewall parsing ─────────────────────────────────────────────

function detectAuthType(fw: Record<string, unknown>): string {
  if (fw['jwt']) return 'JWT (LexikJWT)';
  if (fw['oauth2']) return 'OAuth2';
  if (fw['http_basic']) return 'HTTP Basic';
  if (fw['form_login']) return 'Form Login (session)';
  if (fw['login_throttling']) return 'Login Throttling';
  if (fw['remember_me']) return 'Remember Me';
  if (fw['custom_authenticators'] || fw['guard']) return 'Custom Authenticator';
  if (fw['access_denied_handler']) return 'Custom';
  if (fw['stateless'] === true) return 'Stateless (token-based)';
  return 'Session';
}

function loadFirewallAuth(appPath: string): FirewallAuth[] {
  const securityFile = path.join(appPath, 'config', 'packages', 'security.yaml');
  const raw = parseYamlFile(securityFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const security = (raw['security'] ?? raw) as Record<string, unknown>;
  const firewalls = security['firewalls'] as Record<string, unknown> | undefined;
  if (!firewalls) return [];

  const auths: FirewallAuth[] = [];
  for (const [name, def] of Object.entries(firewalls)) {
    if (!def || typeof def !== 'object') continue;
    const fw = def as Record<string, unknown>;

    auths.push({
      name,
      pattern: fw['pattern'] ? String(fw['pattern']) : undefined,
      authType: detectAuthType(fw),
      stateless: Boolean(fw['stateless']),
      provider: fw['provider'] ? String(fw['provider']) : undefined,
    });
  }

  return auths;
}

// ─── OAuth2 config ─────────────────────────────────────────────────────────

function loadOAuth2Config(appPath: string): OAuth2Config | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'league_oauth2_server.yaml'),
    path.join(appPath, 'config', 'packages', 'league_oauth2_server.yml'),
    path.join(appPath, 'config', 'packages', 'trikoder_oauth2.yaml'),
    path.join(appPath, 'config', 'packages', 'trikoder_oauth2.yml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const oauth = (raw['league_oauth2_server'] ?? raw['trikoder_oauth2'] ?? raw) as Record<string, unknown>;

    const grantsRaw = oauth['authorization_server'] as Record<string, unknown> | undefined;
    const grantTypes: string[] = [];
    if (grantsRaw) {
      const grantMap: Record<string, string> = {
        enable_auth_code_grant: 'Authorization Code',
        enable_implicit_grant: 'Implicit',
        enable_client_credentials_grant: 'Client Credentials',
        enable_password_grant: 'Password',
        enable_refresh_token_grant: 'Refresh Token',
      };
      for (const [key, label] of Object.entries(grantMap)) {
        if (grantsRaw[key] !== false) grantTypes.push(label);
      }
    }

    const scopesRaw = oauth['scopes'] as string[] | undefined;

    return {
      grantTypes,
      scopes: scopesRaw ?? [],
      accessTokenTtl: oauth['access_token_ttl']
        ? String(oauth['access_token_ttl'])
        : undefined,
      refreshTokenTtl: oauth['refresh_token_ttl']
        ? String(oauth['refresh_token_ttl'])
        : undefined,
    };
  }

  return null;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function maskPath(p: string): string {
  return p
    .replace(/%[^%]+%/g, '%***%')
    .replace(/\S+\.(pem|key|p12|pfx|der|crt)$/i, '[KEY-PATH]');
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function getJwtConfig(appPath: string): McpToolResult {
  try {
    const jwt = loadJwtConfig(appPath);
    const firewalls = loadFirewallAuth(appPath);
    const oauth2 = loadOAuth2Config(appPath);

    if (!jwt && !oauth2) {
      return {
        content: [{
          type: 'text',
          text: 'No JWT or OAuth2 configuration found.\n\nInstall LexikJWT:\n  composer require lexik/jwt-authentication-bundle\n  php bin/console lexik:jwt:generate-keypair',
        }],
      };
    }

    let text = `Authentication Configuration\n${'='.repeat(50)}\n`;

    if (jwt) {
      text += `\nJWT (LexikJWTAuthenticationBundle)\n`;
      text += `  Algorithm:   ${jwt.algorithm ?? 'RS256'}\n`;
      if (jwt.tokenTtl) text += `  Token TTL:   ${formatTtl(jwt.tokenTtl)}\n`;
      if (jwt.refreshTokenTtl) text += `  Refresh TTL: ${formatTtl(jwt.refreshTokenTtl)}\n`;
      if (jwt.clockSkew) text += `  Clock skew:  ${jwt.clockSkew}s\n`;
      if (jwt.secretKey) text += `  Secret key:  ${maskPath(jwt.secretKey)}\n`;
      if (jwt.publicKey) text += `  Public key:  ${maskPath(jwt.publicKey)}\n`;
      if (jwt.passphrase) text += `  Passphrase:  configured\n`;
    }

    if (oauth2) {
      text += `\nOAuth2 Server\n`;
      if (oauth2.grantTypes.length > 0) text += `  Grants: ${oauth2.grantTypes.join(', ')}\n`;
      if (oauth2.scopes.length > 0) text += `  Scopes: ${oauth2.scopes.join(', ')}\n`;
      if (oauth2.accessTokenTtl) text += `  Access token TTL:  ${oauth2.accessTokenTtl}\n`;
      if (oauth2.refreshTokenTtl) text += `  Refresh token TTL: ${oauth2.refreshTokenTtl}\n`;
    }

    if (firewalls.length > 0) {
      text += `\nFirewalls:\n`;
      for (const fw of firewalls) {
        const pattern = fw.pattern ? `  pattern: ${fw.pattern}` : '';
        const stateless = fw.stateless ? '  [stateless]' : '';
        text += `  ${fw.name.padEnd(20)} ${fw.authType}${stateless}${pattern}\n`;
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

export function getAuthStats(appPath: string): McpToolResult {
  try {
    const jwt = loadJwtConfig(appPath);
    const firewalls = loadFirewallAuth(appPath);
    const oauth2 = loadOAuth2Config(appPath);

    let text = `Authentication Statistics\n${'='.repeat(40)}\n\n`;
    text += `JWT configured:    ${jwt ? 'yes' : 'no'}\n`;
    text += `OAuth2 configured: ${oauth2 ? 'yes' : 'no'}\n`;
    text += `Firewalls:         ${firewalls.length}\n`;
    text += `Stateless:         ${firewalls.filter((f) => f.stateless).length}\n`;

    if (jwt?.tokenTtl) {
      text += `\nJWT token TTL: ${formatTtl(jwt.tokenTtl)}`;
      if (jwt.tokenTtl > 86400) text += '  ⚠ Long-lived tokens increase exposure window';
      text += '\n';
    }

    const authTypes: Record<string, number> = {};
    for (const fw of firewalls) {
      authTypes[fw.authType] = (authTypes[fw.authType] ?? 0) + 1;
    }
    if (Object.keys(authTypes).length > 0) {
      text += `\nFirewall auth types:\n`;
      for (const [type, count] of Object.entries(authTypes)) {
        text += `  ${type.padEnd(30)} ${count}\n`;
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getJwtAuthTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'get_jwt_config',
      description: 'Show JWT authentication config (algorithm, token TTL, key paths masked), OAuth2 grant types/scopes, and firewall authenticator types',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_auth_stats',
      description: 'Show authentication statistics: JWT/OAuth2 presence, firewall count, stateless vs stateful, auth type breakdown, TTL warnings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
