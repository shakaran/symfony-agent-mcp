// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface LeagueOauth2ClientInfo {
  source: string;
  type: 'composer' | 'env' | 'php';
  provider: string | null;
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
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

const KNOWN_PROVIDERS: Array<{ package: string; className: string; name: string }> = [
  { package: 'league/oauth2-client', className: 'GenericProvider', name: 'generic' },
  { package: 'league/oauth2-google', className: 'Google', name: 'google' },
  { package: 'league/oauth2-github', className: 'Github', name: 'github' },
  { package: 'league/oauth2-facebook', className: 'Facebook', name: 'facebook' },
  { package: 'league/oauth2-linkedin', className: 'LinkedIn', name: 'linkedin' },
  { package: 'thenetworg/oauth2-azure', className: 'Azure', name: 'azure' },
];

function buildLeagueOauth2ClientInfos(appPath: string): LeagueOauth2ClientInfo[] {
  const results: LeagueOauth2ClientInfo[] = [];

  // composer.json
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    for (const provider of KNOWN_PROVIDERS) {
      if (composerContent.includes(provider.package)) {
        results.push({
          source: 'composer.json',
          type: 'composer',
          provider: provider.name,
          detail: `${provider.package} detected`,
          issue: null,
        });
      }
    }
  }

  // .env* files
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const oauthVars: Array<{ pattern: RegExp; name: string; sensitive: boolean }> = [
      { pattern: /OAUTH2_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'OAUTH2_CLIENT_ID', sensitive: false },
      { pattern: /OAUTH2_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'OAUTH2_CLIENT_SECRET', sensitive: true },
      { pattern: /GOOGLE_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'GOOGLE_CLIENT_ID', sensitive: false },
      { pattern: /GOOGLE_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'GOOGLE_CLIENT_SECRET', sensitive: true },
      { pattern: /GITHUB_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'GITHUB_CLIENT_ID', sensitive: false },
      { pattern: /GITHUB_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'GITHUB_CLIENT_SECRET', sensitive: true },
      { pattern: /FACEBOOK_APP_ID\s*=\s*([^\n]{1,200})/, name: 'FACEBOOK_APP_ID', sensitive: false },
      { pattern: /FACEBOOK_APP_SECRET\s*=\s*([^\n]{1,200})/, name: 'FACEBOOK_APP_SECRET', sensitive: true },
      { pattern: /LINKEDIN_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'LINKEDIN_CLIENT_ID', sensitive: false },
      { pattern: /LINKEDIN_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'LINKEDIN_CLIENT_SECRET', sensitive: true },
      { pattern: /AZURE_CLIENT_ID\s*=\s*([^\n]{1,200})/, name: 'AZURE_CLIENT_ID', sensitive: false },
      { pattern: /AZURE_CLIENT_SECRET\s*=\s*([^\n]{1,200})/, name: 'AZURE_CLIENT_SECRET', sensitive: true },
    ];

    for (const varDef of oauthVars) {
      const m = varDef.pattern.exec(content);
      if (!m) continue;
      const raw = m[1].trim();
      // M-10: sensitive vars are fully redacted regardless of length. Partial
      // masking was dropped because it needed {8,} and so leaked short secrets.
      const display = varDef.sensitive ? `${varDef.name}=***` : `${varDef.name}=${raw}`;
      // Derive provider from variable name
      const providerName = varDef.name.toLowerCase().includes('google') ? 'google'
        : varDef.name.toLowerCase().includes('github') ? 'github'
        : varDef.name.toLowerCase().includes('facebook') ? 'facebook'
        : varDef.name.toLowerCase().includes('linkedin') ? 'linkedin'
        : varDef.name.toLowerCase().includes('azure') ? 'azure'
        : 'generic';
      results.push({ source: fname, type: 'env', provider: providerName, detail: display, issue: null });
    }
  }

  // src/**/*.php
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasOauth =
      content.includes('GenericProvider') ||
      content.includes('->getAuthorizationUrl(') ||
      content.includes('->getAccessToken(') ||
      content.includes('->getResourceOwner(') ||
      KNOWN_PROVIDERS.some((p) => content.includes(`new ${p.className}(`));

    if (!hasOauth) continue;

    const relFile = path.relative(appPath, filePath);
    const lines = content.split('\n');

    // Detect which providers are used
    const usedProviders = new Set<string>();
    for (const provider of KNOWN_PROVIDERS) {
      if (content.includes(`new ${provider.className}(`)) usedProviders.add(provider.name);
    }
    if (content.includes('GenericProvider')) usedProviders.add('generic');

    const providerLabel = usedProviders.size > 0 ? [...usedProviders].join(',') : 'generic';

    // State validation check — look for $_SESSION['oauth2state'] usage
    const hasStateSet = content.includes('oauth2state') || content.includes('oauth2_state');
    const hasStateCheck = /oauth2state.*!==/.test(content) || /isset\s*\(\s*\$_SESSION\s*\[/.test(content);

    if (content.includes('->getAuthorizationUrl(')) {
      results.push({
        source: relFile,
        type: 'php',
        provider: providerLabel,
        detail: '->getAuthorizationUrl() call',
        issue: !hasStateSet
          ? 'OAuth2 authorization URL generated without state parameter — missing $_SESSION[\'oauth2state\'] check exposes the flow to CSRF attacks; always set and verify the state parameter'
          : null,
      });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('->getAccessToken(')) {
        // Check if client_secret appears in URL (it should be POST body)
        const contextStart = Math.max(0, i - 5);
        const contextEnd = Math.min(lines.length - 1, i + 5);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const secretInUrl = context.includes('client_secret') && context.includes('?');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          provider: providerLabel,
          detail: '->getAccessToken() call',
          issue: secretInUrl
            ? 'client_secret may be included in URL query string — OAuth2 credentials must be sent in POST body (application/x-www-form-urlencoded), not URL parameters to avoid secret leakage in server logs'
            : null,
        });
      }

      if (line.includes('->getResourceOwner(')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', provider: providerLabel, detail: '->getResourceOwner() call', issue: null });
      }

      // PKCE usage — good practice
      if (line.includes("'pkce_method'") && line.includes('S256')) {
        results.push({ source: `${relFile}:${lineNum}`, type: 'php', provider: providerLabel, detail: 'PKCE S256 method used (good practice for public clients)', issue: null });
      }

      // Access token stored in session without expiry check
      if (line.includes('$_SESSION') && line.includes('access_token')) {
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length - 1, i + 10);
        const context = lines.slice(contextStart, contextEnd + 1).join('\n');
        const hasExpiryCheck = context.includes('getExpires') || context.includes('hasExpired') || context.includes('expires') || context.includes('isExpired');
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          provider: providerLabel,
          detail: 'Access token stored in $_SESSION',
          issue: !hasExpiryCheck
            ? 'Access token stored in $_SESSION without expiry check — always verify token expiry with $token->hasExpired() and refresh before use to prevent using stale tokens'
            : null,
        });
      }

      // Hardcoded redirect_uri
      if (line.includes('redirect_uri') && /['"]https?:[/][/][a-z0-9./-]{5,100}['"]/.test(line)) {
        results.push({
          source: `${relFile}:${lineNum}`,
          type: 'php',
          provider: providerLabel,
          detail: 'redirect_uri in OAuth2 configuration',
          issue: 'redirect_uri appears hardcoded with a literal URL — use an env var or Symfony router to generate the URI, enabling environment-specific callback URLs without code changes',
        });
      }
    }

    // State validation check result
    if (content.includes('->getAuthorizationUrl(') && hasStateSet && !hasStateCheck) {
      results.push({
        source: relFile,
        type: 'php',
        provider: providerLabel,
        detail: 'oauth2state set but not validated',
        issue: 'oauth2state is stored in session but state validation (comparing received state to stored state) was not detected — ensure you verify $_GET[\'state\'] === $_SESSION[\'oauth2state\'] before calling getAccessToken()',
      });
    }
  }

  return results;
}

export function listLeagueOauth2Client(appPath: string): McpToolResult {
  try {
    const infos = buildLeagueOauth2ClientInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No League OAuth2 client integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `League OAuth2 Client Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      const providerStr = info.provider ? ` [${info.provider}]` : '';
      text += `\n  [${info.type.toUpperCase()}]${providerStr}  ${info.source}\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLeagueOauth2ClientStats(appPath: string): McpToolResult {
  try {
    const infos = buildLeagueOauth2ClientInfos(appPath);
    const composerEntries = infos.filter((i) => i.type === 'composer');
    const envEntries = infos.filter((i) => i.type === 'env');
    const phpEntries = infos.filter((i) => i.type === 'php');
    const issues = infos.filter((i) => i.issue !== null);

    const providerCounts: Record<string, number> = {};
    for (const info of infos) {
      if (info.provider) {
        providerCounts[info.provider] = (providerCounts[info.provider] ?? 0) + 1;
      }
    }

    let text = `League OAuth2 Client Statistics\n${'='.repeat(40)}\n\n`;
    text += `Composer packages: ${composerEntries.length}\n`;
    text += `Env entries:       ${envEntries.length}\n`;
    text += `PHP patterns:      ${phpEntries.length}\n`;
    text += `Issues:            ${issues.length}\n`;
    if (Object.keys(providerCounts).length > 0) {
      text += `\nProvider breakdown:\n`;
      for (const [provider, count] of Object.entries(providerCounts)) {
        text += `  ${provider}: ${count}\n`;
      }
    }
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLeagueOauth2ClientTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_league_oauth2_client',
      description: 'Scan for League OAuth2 client provider patterns: composer.json league/oauth2-client/google/github/facebook/linkedin, thenetworg/oauth2-azure, .env* OAuth2 client secrets (masked), PHP GenericProvider/Google/Github/Facebook/LinkedIn/getAuthorizationUrl/getAccessToken/getResourceOwner. Detects PKCE S256 usage. Flags missing state validation (CSRF), client_secret in URL, token stored in session without expiry, hardcoded redirect_uri.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_league_oauth2_client_stats',
      description: 'Statistics for League OAuth2 client: composer/env/PHP entry counts, provider breakdown, and issue count.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
