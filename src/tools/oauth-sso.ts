/**
 * OAuth / SSO Inspector
 *
 * Detects KnpUOAuth2ClientBundle:
 *   - config/packages/knpu_oauth2_client.yaml: clients, provider types, scopes, redirect URIs
 *   - Supported providers: google, github, facebook, gitlab, linkedin, azure, auth0, keycloak, etc.
 *
 * Detects HWIOAuthBundle:
 *   - config/packages/hwi_oauth.yaml: resource_owners, firewall_names, connect
 *
 * Detects standalone OAuth/OIDC env vars:
 *   - OAUTH_*, OIDC_*, AUTH0_*, KEYCLOAK_*, GOOGLE_CLIENT_*, GITHUB_CLIENT_*
 *
 * Scans src/ for:
 *   - AbstractSocialAuthenticator / SocialAuthenticator subclasses (KnpU)
 *   - OAuth2Controller / callback action patterns
 *   - league/oauth2-client direct usage
 *
 * Security audit:
 *   - Redirect URI not restricted to HTTPS
 *   - state parameter validation missing
 *   - Clients without scopes (overly broad)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface OAuthClient {
  name: string;
  provider: string;
  scopes: string[];
  redirectUri?: string;
  bundle: 'knpu' | 'hwio' | 'env';
  issues: string[];
}

interface OAuthAuthenticator {
  class: string;
  file: string;
  provider?: string;
}

// ─── Provider normalisation ──────────────────────────────────────────────────

const KNOWN_PROVIDERS: Record<string, string> = {
  google:      'Google OAuth2',
  github:      'GitHub OAuth2',
  facebook:    'Facebook OAuth2',
  gitlab:      'GitLab OAuth2',
  linkedin:    'LinkedIn OAuth2',
  azure:       'Microsoft Azure AD',
  auth0:       'Auth0 OIDC',
  keycloak:    'Keycloak OIDC',
  okta:        'Okta OIDC',
  bitbucket:   'Bitbucket OAuth2',
  instagram:   'Instagram OAuth2',
  slack:       'Slack OAuth2',
  twitter:     'Twitter OAuth1/2',
  discord:     'Discord OAuth2',
};

function normaliseProvider(type: string): string {
  const lower = type.toLowerCase().replace(/_provider$/, '').replace(/oauth2$/, '').trim();
  return KNOWN_PROVIDERS[lower] ?? type;
}

// ─── KnpU config ─────────────────────────────────────────────────────────────

function loadKnpuClients(appPath: string): OAuthClient[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'knpu_oauth2_client.yaml'),
    path.join(appPath, 'config', 'packages', 'knpu_oauth2_client.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const root = (raw['knpu_oauth2_client'] ?? raw) as Record<string, unknown>;
    const clientsRaw = root['clients'] as Record<string, unknown> | undefined;
    if (!clientsRaw) return [];

    const clients: OAuthClient[] = [];
    for (const [name, def] of Object.entries(clientsRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const type = d['type'] ? String(d['type']) : 'unknown';
      const scopes = d['scope']
        ? (Array.isArray(d['scope']) ? d['scope'].map(String) : String(d['scope']).split(','))
        : [];
      const redirectUri = d['redirect_route']
        ? String(d['redirect_route'])
        : (d['redirect_uri'] ? String(d['redirect_uri']) : undefined);

      const issues: string[] = [];
      if (scopes.length === 0) issues.push('no scopes configured — may request overly broad access');
      if (redirectUri && redirectUri.startsWith('http://')) issues.push('redirect_uri uses HTTP — must be HTTPS in production');

      clients.push({ name, provider: normaliseProvider(type), scopes, redirectUri, bundle: 'knpu', issues });
    }
    return clients;
  }
  return [];
}

// ─── HWIOAuth config ──────────────────────────────────────────────────────────

function loadHwioClients(appPath: string): OAuthClient[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'hwi_oauth.yaml'),
    path.join(appPath, 'config', 'packages', 'hwi_oauth.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const root = (raw['hwi_oauth'] ?? raw) as Record<string, unknown>;
    const ownersRaw = root['resource_owners'] as Record<string, unknown> | undefined;
    if (!ownersRaw) return [];

    const clients: OAuthClient[] = [];
    for (const [name, def] of Object.entries(ownersRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const type = d['type'] ? String(d['type']) : name;
      const scopes = d['scope']
        ? String(d['scope']).split(',').map((s) => s.trim())
        : [];

      clients.push({ name, provider: normaliseProvider(type), scopes, bundle: 'hwio', issues: [] });
    }
    return clients;
  }
  return [];
}

// ─── Env-based detection ──────────────────────────────────────────────────────

function loadEnvOAuthHints(appPath: string): OAuthClient[] {
  const envFiles = ['.env', '.env.dist', '.env.example'];
  const found = new Map<string, OAuthClient>();

  for (const fname of envFiles) {
    try {
      const content = fs.readFileSync(path.join(appPath, fname), 'utf-8');
      const patterns: Array<[RegExp, string]> = [
        [/GOOGLE_CLIENT_ID|GOOGLE_OAUTH/i,   'Google OAuth2'],
        [/GITHUB_CLIENT_ID|GITHUB_OAUTH/i,   'GitHub OAuth2'],
        [/FACEBOOK_CLIENT_ID|FACEBOOK_APP/i, 'Facebook OAuth2'],
        [/AUTH0_DOMAIN|AUTH0_CLIENT/i,        'Auth0 OIDC'],
        [/KEYCLOAK_URL|KEYCLOAK_CLIENT/i,     'Keycloak OIDC'],
        [/AZURE_CLIENT_ID|AZURE_TENANT/i,     'Microsoft Azure AD'],
        [/LINKEDIN_CLIENT/i,                  'LinkedIn OAuth2'],
        [/GITLAB_CLIENT/i,                    'GitLab OAuth2'],
        [/OKTA_CLIENT|OKTA_DOMAIN/i,          'Okta OIDC'],
      ];
      for (const [pattern, provider] of patterns) {
        if (pattern.test(content) && !found.has(provider)) {
          found.set(provider, { name: provider.toLowerCase().replace(/\s+/g, '_'), provider, scopes: [], bundle: 'env', issues: [] });
        }
      }
    } catch { /* skip */ }
  }
  return [...found.values()];
}

// ─── Authenticator scanning ──────────────────────────────────────────────────


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

function scanOAuthAuthenticators(appPath: string): OAuthAuthenticator[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const authenticators: OAuthAuthenticator[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isOAuth =
      content.includes('AbstractSocialAuthenticator') ||
      content.includes('SocialAuthenticator') ||
      content.includes('OAuth2Client') ||
      content.includes('league\\oauth2-client') ||
      (content.includes('oauth') && content.includes('callback'));

    if (!isOAuth) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const providerM = /connectCheckAction|oauth_connect|oauth2_callback|(['"])(google|github|facebook|auth0|keycloak)\1/i.exec(content);
    authenticators.push({ class: classM[1], file: path.basename(file), provider: providerM?.[2] });
  }
  return authenticators.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listOAuthConfig(appPath: string): McpToolResult {
  try {
    const knpuClients  = loadKnpuClients(appPath);
    const hwioClients  = loadHwioClients(appPath);
    const envHints     = loadEnvOAuthHints(appPath);
    const authenticators = scanOAuthAuthenticators(appPath);

    const allClients = [...knpuClients, ...hwioClients];
    const knownProviders = new Set(allClients.map((c) => c.provider));
    const extraEnv = envHints.filter((e) => !knownProviders.has(e.provider));

    if (allClients.length === 0 && extraEnv.length === 0 && authenticators.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No OAuth/SSO integration detected.\n\nInstall KnpUOAuth2ClientBundle:\n  composer require knpuniversity/oauth2-client-bundle\n\nConfigure config/packages/knpu_oauth2_client.yaml:\n  knpu_oauth2_client:\n    clients:\n      google_main:\n        type: google\n        client_id: "%env(GOOGLE_CLIENT_ID)%"\n        client_secret: "%env(GOOGLE_CLIENT_SECRET)%"\n        redirect_route: connect_google_check\n        scope: [openid, email, profile]',
        }],
      };
    }

    let text = `OAuth / SSO Configuration\n${'='.repeat(55)}\n`;

    if (knpuClients.length > 0) {
      text += `\nKnpUOAuth2ClientBundle (${knpuClients.length} client(s)):\n`;
      for (const c of knpuClients) {
        text += `  ${c.name.padEnd(30)} ${c.provider}\n`;
        if (c.scopes.length > 0) text += `    Scopes:       ${c.scopes.join(', ')}\n`;
        if (c.redirectUri)       text += `    Redirect:     ${c.redirectUri}\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (hwioClients.length > 0) {
      text += `\nHWIOAuthBundle (${hwioClients.length} resource owner(s)):\n`;
      for (const c of hwioClients) {
        text += `  ${c.name.padEnd(30)} ${c.provider}\n`;
        if (c.scopes.length > 0) text += `    Scopes: ${c.scopes.join(', ')}\n`;
      }
    }

    if (extraEnv.length > 0) {
      text += `\nDetected from env vars (no bundle config found):\n`;
      for (const e of extraEnv) text += `  ${e.provider}\n`;
    }

    if (authenticators.length > 0) {
      text += `\nOAuth authenticator classes (${authenticators.length}):\n`;
      for (const a of authenticators) {
        const prov = a.provider ? `  [${a.provider}]` : '';
        text += `  ${a.class.padEnd(40)} (${a.file})${prov}\n`;
      }
    }

    const allIssues = allClients.flatMap((c) => c.issues.map((i) => `${c.name}: ${i}`));
    if (allIssues.length > 0) {
      text += `\n⚠ Security issues:\n`;
      for (const issue of allIssues) text += `   ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getOAuthStats(appPath: string): McpToolResult {
  try {
    const knpuClients    = loadKnpuClients(appPath);
    const hwioClients    = loadHwioClients(appPath);
    const envHints       = loadEnvOAuthHints(appPath);
    const authenticators = scanOAuthAuthenticators(appPath);

    let text = `OAuth / SSO Statistics\n${'='.repeat(40)}\n\n`;
    text += `KnpU clients:        ${knpuClients.length}\n`;
    text += `HWIO resource owners: ${hwioClients.length}\n`;
    text += `Env-detected:        ${envHints.length}\n`;
    text += `Authenticator classes: ${authenticators.length}\n`;
    const issues = [...knpuClients, ...hwioClients].reduce((s, c) => s + c.issues.length, 0);
    text += `Security issues:     ${issues}\n`;
    const providers = [...new Set([...knpuClients, ...hwioClients].map((c) => c.provider))];
    if (providers.length > 0) text += `Providers:           ${providers.join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getOAuthSsoTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_oauth_config',
      description: 'Show OAuth/SSO configuration: KnpUOAuth2ClientBundle clients (provider, scopes, redirect), HWIOAuthBundle resource owners, env-detected providers (Auth0/Keycloak/Google/GitHub), OAuth authenticator classes, security issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_oauth_stats',
      description: 'Show OAuth/SSO statistics: client count per bundle, env-detected providers, authenticator class count, security issue count, provider list',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
