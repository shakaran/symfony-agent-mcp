import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface Oauth2ServerConfigInfo {
  source: string;
  type: 'grant' | 'server' | 'config' | 'key';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanPhpFiles(dir: string, callback: (filePath: string, content: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanPhpFiles(full, callback);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        const content = safeRead(full, dir);
        if (content === null) continue;
        callback(full, content);
      }
    }
  } catch { /* skip */ }
}

function safeKeyPath(p: string): string {
  return p.replace(/\S+\.(key|p12|pfx|der|crt|pem)$/i, '[KEY-PATH]');
}

function parseTtlSeconds(ttlExpr: string): number | null {
  // Matches new DateInterval('PT1H'), new \DateInterval('PT3600S'), etc.
  const intervalMatch = /PT(\d+)([HMS])/.exec(ttlExpr);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (unit === 'S') return val;
    if (unit === 'M') return val * 60;
    if (unit === 'H') return val * 3600;
  }
  // Matches new DateInterval('P1D')
  const dayMatch = /P(\d+)D/.exec(ttlExpr);
  if (dayMatch) return parseInt(dayMatch[1], 10) * 86400;
  return null;
}

function buildOauth2ServerConfigInfos(appPath: string): Oauth2ServerConfigInfo[] {
  const results: Oauth2ServerConfigInfo[] = [];

  // composer.json — check for league/oauth2-server
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  let hasOauth2Server = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    if (req['league/oauth2-server']) {
      hasOauth2Server = true;
      results.push({ source: 'composer.json', type: 'config', detail: `league/oauth2-server: ${req['league/oauth2-server']}`, issue: null });
    }
    if (req['trikoder/oauth2-bundle']) {
      results.push({ source: 'composer.json', type: 'config', detail: `trikoder/oauth2-bundle: ${req['trikoder/oauth2-bundle']}`, issue: null });
    }
    if (req['league/oauth2-server'] === undefined) return results;
  } catch { return results; }

  if (!hasOauth2Server) return results;

  const srcDir = path.join(appPath, 'src');

  scanPhpFiles(srcDir, (filePath, content) => {
    const relFile = path.relative(appPath, filePath);

    // AuthorizationServer / ResourceServer instantiation
    if (content.includes('AuthorizationServer(') || content.includes('ResourceServer(')) {
      const type = content.includes('AuthorizationServer(') ? 'AuthorizationServer' : 'ResourceServer';
      results.push({ source: relFile, type: 'server', detail: `${type} instantiated`, issue: null });
    }

    // Grant types
    const grantPatterns: Array<[string, string | null]> = [
      ['AuthCodeGrant(', null],
      ['ClientCredentialsGrant(', null],
      ['ImplicitGrant(', 'ImplicitGrant is deprecated and insecure — use AuthCode + PKCE (Proof Key for Code Exchange) instead; ImplicitGrant exposes tokens in URL fragments and does not support refresh tokens'],
      ['PasswordGrant(', 'PasswordGrant (Resource Owner Password Credentials) is deprecated in OAuth 2.1 — it requires apps to handle user credentials directly; migrate to AuthCode + PKCE for public clients or ClientCredentials for machine-to-machine'],
      ['RefreshTokenGrant(', null],
    ];

    for (const [pattern, issue] of grantPatterns) {
      if (content.includes(pattern)) {
        const grantName = pattern.replace('(', '');
        results.push({ source: relFile, type: 'grant', detail: `${grantName} used`, issue });
      }
    }

    // enableGrantType calls
    const enableMatches = content.matchAll(/enableGrantType\(\s*new\s+([A-Za-z\\]+Grant)[^)]{0,200}\)/g);
    for (const m of enableMatches) {
      results.push({ source: relFile, type: 'grant', detail: `enableGrantType: ${m[1]}`, issue: null });
    }

    // Private key handling — CryptKey
    if (content.includes('new CryptKey(') || content.includes('new \\League\\OAuth2\\Server\\CryptKey(')) {
      const cryptKeyMatch = /new\s+(?:\\League\\OAuth2\\Server\\)?CryptKey\s*\(\s*([^,)]{1,200})/.exec(content);
      const keyArg = cryptKeyMatch ? cryptKeyMatch[1].trim().replace(/['"]/, '') : 'unknown';
      const isHardcoded = !keyArg.includes('$') && !keyArg.includes('%') && !keyArg.toLowerCase().includes('getenv') && !keyArg.toLowerCase().includes('env(');
      results.push({
        source: relFile,
        type: 'key',
        detail: `CryptKey path: ${safeKeyPath(keyArg.slice(0, 100))}`,
        issue: isHardcoded && keyArg.length > 3
          ? `CryptKey path appears hardcoded in "${relFile}" — use environment variable or parameter for the key path to allow environment-specific configuration`
          : null,
      });
    }

    // Access token TTL
    const ttlMatches = content.matchAll(/setAccessTokenTTL\s*\(\s*new\s+\\?DateInterval\s*\(\s*'([^']{1,30})'\s*\)\s*\)/g);
    for (const m of ttlMatches) {
      const ttlStr = m[1];
      const seconds = parseTtlSeconds(ttlStr);
      let issue: string | null = null;
      if (seconds !== null) {
        if (seconds > 3600) {
          issue = `Access token TTL "${ttlStr}" (${Math.round(seconds / 60)} min) exceeds 1 hour — long-lived access tokens increase exposure window if stolen; use short TTLs (15–60 min) with refresh tokens`;
        } else if (seconds < 300) {
          issue = `Access token TTL "${ttlStr}" (${seconds}s) is shorter than 5 minutes — very short TTLs increase token refresh load and may cause race conditions in distributed systems`;
        }
      }
      results.push({ source: relFile, type: 'config', detail: `Access token TTL: ${ttlStr}`, issue });
    }

    // Refresh token TTL / rotation
    if (content.includes('setRefreshTokenTTL(')) {
      const rotationEnabled = content.includes('RefreshTokenGrant') && content.includes('setRefreshTokenTTL');
      results.push({
        source: relFile,
        type: 'config',
        detail: 'setRefreshTokenTTL configured',
        issue: !rotationEnabled
          ? 'setRefreshTokenTTL found without RefreshTokenGrant — ensure refresh token rotation is enabled so each use of a refresh token issues a new one and invalidates the old (prevents token theft replay)'
          : null,
      });
    }
  });

  return results;
}

export function listOauth2ServerConfig(appPath: string): McpToolResult {
  try {
    const infos = buildOauth2ServerConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No league/oauth2-server configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `OAuth2 Authorization Server Configuration\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.type.toUpperCase()}] ${info.source}\n`;
      text += `  Detail: ${info.detail}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.detail}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning OAuth2 server config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getOauth2ServerConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildOauth2ServerConfigInfos(appPath);
    const byType = { grant: 0, server: 0, config: 0, key: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const grants = infos.filter((i) => i.type === 'grant').map((i) => i.detail);
    const text = [
      `OAuth2 Server Config Stats`,
      `==========================`,
      `Total entries   : ${infos.length}`,
      `  Grants        : ${byType.grant}`,
      `  Server        : ${byType.server}`,
      `  Config        : ${byType.config}`,
      `  Keys          : ${byType.key}`,
      `Issues          : ${issues.length}`,
      grants.length > 0 ? `Grant types     : ${[...new Set(grants)].join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getOauth2ServerConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_oauth2_server_config',
      description: 'Scan for league/oauth2-server authorization server patterns: grant types in use (AuthCode, ClientCredentials, Implicit, Password, RefreshToken), CryptKey handling, access token TTL, and refresh token rotation. Flags deprecated grants (Implicit, Password), insecure key handling, and unsafe TTL values.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_oauth2_server_config_stats',
      description: 'Return summary statistics for OAuth2 server configuration: grant types found, issues count, and entry breakdown.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
