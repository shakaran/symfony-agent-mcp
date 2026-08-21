import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GoogleOauthIntegrationInfo {
  source: string;
  type: 'env' | 'php' | 'key';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{8,}/g, '$1***');
}

function scanPhpFiles(dir: string, base: string, callback: (filePath: string, content: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanPhpFiles(full, base, callback);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          callback(full, content);
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

function scanForJsonKeyFiles(dir: string, base: string, results: GoogleOauthIntegrationInfo[]): void {
  // Look for service account JSON key files in project (tracked in VCS — security risk)
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === 'var') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanForJsonKeyFiles(full, base, results);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          // Service account JSON has "type": "service_account"
          if (content.includes('"type": "service_account"') || content.includes('"type":"service_account"')) {
            const relFile = path.relative(base, full);
            results.push({
              source: relFile,
              type: 'key',
              detail: 'Google service account JSON key file found',
              issue: `Service account JSON key file "${relFile}" found in project directory — never commit service account keys to version control; use Workload Identity Federation or GOOGLE_APPLICATION_CREDENTIALS pointing to a path outside the repo`,
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

const BROAD_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/admin',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/spreadsheets',
];

const SPECIFIC_SCOPE_ALTERNATIVES: Record<string, string> = {
  'https://www.googleapis.com/auth/drive': 'use drive.file (access only files created by the app) or drive.readonly',
  'https://www.googleapis.com/auth/gmail': 'use gmail.send (send-only) or gmail.readonly instead of full account access',
  'https://www.googleapis.com/auth/calendar': 'use calendar.events.readonly or calendar.events instead of full calendar access',
  'https://www.googleapis.com/auth/cloud-platform': 'use specific GCP resource scopes instead of full cloud-platform access',
  'https://www.googleapis.com/auth/spreadsheets': 'use spreadsheets.readonly if only reading data',
};

function buildGoogleOauthIntegrationInfos(appPath: string): GoogleOauthIntegrationInfo[] {
  const results: GoogleOauthIntegrationInfo[] = [];

  // composer.json — Google API client packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  const googlePackages = [
    'google/apiclient',
    'league/oauth2-google',
    'google/auth',
    'stevenmaguire/oauth2-google',
  ];

  let hasGooglePackage = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    for (const pkg of googlePackages) {
      if (req[pkg]) {
        hasGooglePackage = true;
        results.push({ source: 'composer.json', type: 'php', detail: `${pkg}: ${req[pkg]}`, issue: null });
      }
    }
  } catch { /* skip */ }

  if (!hasGooglePackage) return results;

  // .env* files — Google OAuth credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const googleVars: Array<[string, boolean]> = [
      ['GOOGLE_CLIENT_ID', false],
      ['GOOGLE_CLIENT_SECRET', true],
      ['GOOGLE_REDIRECT_URI', false],
      ['GOOGLE_APPLICATION_CREDENTIALS', true],
    ];

    for (const [varName, isSensitive] of googleVars) {
      const regex = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,300})`);
      const m = regex.exec(content);
      if (!m) continue;

      const rawValue = m[1].trim();
      let displayValue = rawValue;
      if (isSensitive) {
        displayValue = maskSecrets(`${varName}=${rawValue}`).replace(`${varName}=`, '');
      }

      let issue: string | null = null;
      if (varName === 'GOOGLE_CLIENT_SECRET' && rawValue.length > 8 && !rawValue.startsWith('$') && !rawValue.startsWith('%') && !rawValue.includes('your_')) {
        issue = `GOOGLE_CLIENT_SECRET appears to be a real value in "${fname}" — rotate this credential and use CI/CD secret injection only`;
      }

      if (varName === 'GOOGLE_APPLICATION_CREDENTIALS') {
        // Check if path is inside project (relative path or starts with project path)
        const isInProject = !path.isAbsolute(rawValue) || rawValue.startsWith(appPath);
        if (isInProject) {
          issue = `GOOGLE_APPLICATION_CREDENTIALS="${rawValue}" in "${fname}" points inside the project directory — service account key files must be stored outside the repo and never committed to version control`;
        }
      }

      results.push({ source: fname, type: 'env', detail: `${varName}=${displayValue}`, issue });
    }

    // Pattern-based fallback: scan for any GOOGLE_* variable matching sensitive name patterns
    const knownVarNames = new Set(googleVars.map(([name]) => name));
    const sensitiveGoogleVarRe = /^(GOOGLE_[A-Z0-9_]*(KEY|AUTH|TOKEN|CREDENTIAL|SECRET|PASS)[A-Z0-9_]*)\s*=\s*([^\n]{1,300})/gm;
    let patternMatch: RegExpExecArray | null;
    while ((patternMatch = sensitiveGoogleVarRe.exec(content)) !== null) {
      const detectedName = patternMatch[1];
      if (knownVarNames.has(detectedName)) continue;
      const detectedValue = patternMatch[3].trim();
      const maskedValue = maskSecrets(`${detectedName}=${detectedValue}`).replace(`${detectedName}=`, '');
      results.push({ source: fname, type: 'env', detail: `${detectedName}=${maskedValue}`, issue: null });
    }
  }

  // src/**/*.php — Google Client usage
  const srcDir = path.join(appPath, 'src');

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasGoogle = content.includes('Google\\Client') || content.includes('Google_Client') || content.includes("use Google\\") || content.includes('setClientId(') || content.includes('fetchAccessTokenWithAuthCode(');
    if (!hasGoogle) return;

    const relFile = path.relative(appPath, filePath);

    // Google Client instantiation
    if (content.includes('new Google\\Client(') || content.includes('new Google_Client(') || content.includes('new \\Google\\Client(')) {
      results.push({ source: relFile, type: 'php', detail: 'Google\\Client instantiated', issue: null });
    }

    // setClientSecret hardcoded
    const hasHardcodedSecret = /setClientSecret\s*\(\s*['"][A-Za-z0-9_-]{10,}['"]\s*\)/.test(content);
    if (hasHardcodedSecret) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'setClientSecret() with hardcoded value',
        issue: `setClientSecret() called with hardcoded credential in "${relFile}" — use getenv('GOOGLE_CLIENT_SECRET') or Symfony parameter %env(GOOGLE_CLIENT_SECRET)%`,
      });
    }

    // setAccessType offline without token refresh
    if (content.includes("setAccessType('offline')") || content.includes('setAccessType("offline")')) {
      const hasRefresh = content.includes('fetchAccessTokenWithRefreshToken(') || content.includes('refreshToken(') || content.includes('getRefreshToken(');
      results.push({
        source: relFile,
        type: 'php',
        detail: "setAccessType('offline') found",
        issue: !hasRefresh
          ? `setAccessType('offline') in "${relFile}" without refresh token handling — offline access issues a refresh token that must be persisted and used to refresh expired access tokens; implement fetchAccessTokenWithRefreshToken() to avoid forcing re-authorization on every request`
          : null,
      });
    }

    // fetchAccessTokenWithAuthCode
    if (content.includes('fetchAccessTokenWithAuthCode(')) {
      results.push({ source: relFile, type: 'php', detail: 'fetchAccessTokenWithAuthCode() — OAuth2 code exchange', issue: null });
    }

    // createAuthUrl
    if (content.includes('createAuthUrl(')) {
      results.push({ source: relFile, type: 'php', detail: 'createAuthUrl() — OAuth2 authorization URL generated', issue: null });
    }

    // Scope analysis — broad scopes
    for (const scope of BROAD_SCOPES) {
      if (content.includes(scope)) {
        const alternative = SCOPE_ALTERNATIVES_MAP[scope];
        results.push({
          source: relFile,
          type: 'php',
          detail: `Broad scope: ${scope}`,
          issue: `Overly broad Google OAuth scope "${scope}" in "${relFile}" — ${alternative ?? 'use the minimum required scope (principle of least privilege)'}`,
        });
      }
    }

    // useApplicationDefaultCredentials — service account
    if (content.includes('useApplicationDefaultCredentials(')) {
      results.push({
        source: relFile,
        type: 'key',
        detail: 'useApplicationDefaultCredentials() — service account auth',
        issue: null,
      });
    }
  });

  // Scan for service account JSON key files in the project tree
  scanForJsonKeyFiles(appPath, appPath, results);

  return results;
}

const SCOPE_ALTERNATIVES_MAP: Record<string, string> = BROAD_SCOPES.reduce<Record<string, string>>((acc, scope) => {
  if (SPECIFIC_SCOPE_ALTERNATIVES[scope]) acc[scope] = SPECIFIC_SCOPE_ALTERNATIVES[scope];
  return acc;
}, {});

export function listGoogleOauthIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildGoogleOauthIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Google OAuth2 / Google APIs Client integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Google OAuth2 / APIs Client Integration\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
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
    return { content: [{ type: 'text', text: `Error scanning Google OAuth integration: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getGoogleOauthIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildGoogleOauthIntegrationInfos(appPath);
    const byType = { env: 0, php: 0, key: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `Google OAuth Integration Stats`,
      `==============================`,
      `Total entries   : ${infos.length}`,
      `  Env vars      : ${byType.env}`,
      `  PHP code      : ${byType.php}`,
      `  Key files     : ${byType.key}`,
      `Issues          : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getGoogleOauthIntegrationTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_google_oauth_integration',
      description: 'Scan for Google OAuth2 / Google APIs Client Library: composer packages (google/apiclient, league/oauth2-google), env vars (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI), PHP usage (new Google\\Client, setClientSecret, setAccessType, createAuthUrl, fetchAccessTokenWithAuthCode). Flags hardcoded secrets, broad OAuth scopes (drive, gmail, cloud-platform), offline access without refresh token handling, and service account JSON key files in the project tree.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_google_oauth_integration_stats',
      description: 'Return summary statistics for Google OAuth integration: entry counts by type and total issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
