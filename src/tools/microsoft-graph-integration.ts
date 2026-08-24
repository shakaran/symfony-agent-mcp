// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MicrosoftGraphIntegrationInfo {
  source: string;
  type: 'env' | 'php' | 'composer';
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
        const content = safeRead(full, base);
        if (content === null) continue;
        callback(full, content);
      }
    }
  } catch { /* skip */ }
}

// Over-privileged Microsoft Graph permission scopes
const OVERPRIVILEGED_SCOPES: Array<[string, string]> = [
  ['Mail.ReadWrite', 'Mail.ReadWrite grants full read/write to all mailbox items — use Mail.Send (send only) or Mail.Read (read only) unless write access is required'],
  ['Mail.ReadWrite.All', 'Mail.ReadWrite.All grants full access to all users\' mailboxes — use Mail.Send.All or scope to specific users with delegated permissions'],
  ['User.ReadWrite.All', 'User.ReadWrite.All grants write access to all user profiles in the tenant — use User.Read.All (read-only) or User.Read (single user delegated) unless profile updates are required'],
  ['Directory.ReadWrite.All', 'Directory.ReadWrite.All grants full directory read/write — extremely over-privileged; use Directory.Read.All or specific resource permissions'],
  ['Sites.ReadWrite.All', 'Sites.ReadWrite.All grants read/write to all SharePoint sites — use Sites.Read.All (read-only) or Sites.Selected for specific site access'],
  ['Files.ReadWrite.All', 'Files.ReadWrite.All grants read/write to all files in OneDrive/SharePoint — use Files.Read.All or Files.Selected'],
  ['Calendars.ReadWrite', 'Calendars.ReadWrite grants read/write to all calendar events — use Calendars.Read if only reading events'],
];

function buildMicrosoftGraphIntegrationInfos(appPath: string): MicrosoftGraphIntegrationInfo[] {
  const results: MicrosoftGraphIntegrationInfo[] = [];

  // composer.json — Microsoft Graph packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  const msPackages = [
    'microsoft/microsoft-graph',
    'microsoft/kiota-abstractions',
    'microsoft/kiota-authentication-phpleague',
    'microsoft/kiota-http-guzzle',
    'microsoft/kiota-serialization-json',
    'thenetworg/oauth2-azure',
    'league/oauth2-client',
  ];

  let hasMsGraph = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    for (const pkg of msPackages) {
      if (req[pkg]) {
        hasMsGraph = true;
        results.push({ source: 'composer.json', type: 'composer', detail: `${pkg}: ${req[pkg]}`, issue: null });
      }
    }
  } catch { /* skip */ }

  if (!hasMsGraph) return results;

  // .env* files — Microsoft/Azure credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const msVars: Array<[string, boolean]> = [
      ['MICROSOFT_CLIENT_ID', true],
      ['MICROSOFT_CLIENT_SECRET', true],
      ['MICROSOFT_TENANT_ID', true],
      ['AZURE_CLIENT_ID', true],
      ['AZURE_CLIENT_SECRET', true],
      ['AZURE_TENANT_ID', true],
      ['GRAPH_CLIENT_ID', true],
      ['GRAPH_CLIENT_SECRET', true],
    ];

    for (const [varName, isSensitive] of msVars) {
      const regex = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,300})`);
      const m = regex.exec(content);
      if (!m) continue;

      const rawValue = m[1].trim();
      let displayValue = rawValue;
      if (isSensitive) {
        displayValue = maskSecrets(`${varName}=${rawValue}`).replace(`${varName}=`, '');
      }

      let issue: string | null = null;
      if (isSensitive && rawValue.length > 8 && !rawValue.startsWith('$') && !rawValue.startsWith('%') && !rawValue.includes('your_') && !rawValue.includes('xxx') && !rawValue.includes('change_me')) {
        issue = `${varName} appears to be a real credential in "${fname}" — rotate this Azure app registration secret immediately and use CI/CD secret injection; consider using Managed Identity instead of client secrets`;
      }

      results.push({ source: fname, type: 'env', detail: `${varName}=${displayValue}`, issue });
    }
  }

  // src/**/*.php — Microsoft Graph client usage
  const srcDir = path.join(appPath, 'src');

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasMsCode = content.includes('Microsoft\\Graph') || content.includes('new Graph(') || content.includes('->setAccessToken(') || content.includes('GraphServiceClient') || content.includes("'microsoft'") || content.includes('oauth2-azure');
    if (!hasMsCode) return;

    const relFile = path.relative(appPath, filePath);

    // Graph client instantiation
    if (content.includes('new Graph(') || content.includes('new \\Microsoft\\Graph\\Graph(')) {
      results.push({ source: relFile, type: 'php', detail: 'Microsoft Graph client instantiated', issue: null });
    }

    // GraphServiceClient (Kiota-based v2)
    if (content.includes('GraphServiceClient(') || content.includes('new GraphServiceClient')) {
      results.push({ source: relFile, type: 'php', detail: 'GraphServiceClient (Kiota) instantiated', issue: null });
    }

    // setAccessToken
    if (content.includes('->setAccessToken(')) {
      results.push({ source: relFile, type: 'php', detail: '->setAccessToken() — manual token injection', issue: null });

      // Check for token logging
      const hasTokenLogging = content.includes('logger') && (content.includes('getAccessToken') || content.includes('access_token'));
      if (hasTokenLogging) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Possible access token logging',
          issue: `Access token may be logged in "${relFile}" — never log access tokens; they grant full API access for their lifetime and logging them creates a persistent exposure in log files`,
        });
      }
    }

    // createRequest
    if (content.includes('->createRequest(')) {
      results.push({ source: relFile, type: 'php', detail: '->createRequest() — Graph API request', issue: null });
    }

    // users()->get() — reading users
    if (content.includes('->users()->get(') || content.includes('->users()->') ) {
      results.push({ source: relFile, type: 'php', detail: 'Users API accessed', issue: null });
    }

    // mail API
    if (content.includes('->mail()->') || content.includes('->messages()->')) {
      results.push({ source: relFile, type: 'php', detail: 'Mail API accessed', issue: null });
    }

    // Token caching check
    const hasTokenCache = content.includes('cache') || content.includes('Cache') || content.includes('getAccessToken') || content.includes('token_cache') || content.includes('TokenCache');
    if (!hasTokenCache && (content.includes('->setAccessToken(') || content.includes('client_credentials'))) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'No token caching detected',
        issue: `Microsoft Graph client in "${relFile}" without token caching — requesting a new access token on every request adds ~300ms latency and risks rate limiting on the token endpoint; cache tokens until their exp claim minus a 5-minute buffer`,
      });
    }

    // client_credentials grant — application permissions (no user context)
    if (content.includes('client_credentials') || content.includes('ClientCredentials')) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'client_credentials grant — application permissions (no user context)',
        issue: null,
      });
    }

    // Over-privileged scopes
    for (const [scope, message] of OVERPRIVILEGED_SCOPES) {
      if (content.includes(scope)) {
        results.push({
          source: relFile,
          type: 'php',
          detail: `Over-privileged scope: ${scope}`,
          issue: `${scope} permission in "${relFile}" — ${message}`,
        });
      }
    }

    // Hardcoded client secret in PHP
    const hasHardcodedSecret = /(?:client_secret|clientSecret|CLIENT_SECRET)\s*[=:>]+\s*['"][A-Za-z0-9~._-]{20,}['"]/.test(content);
    if (hasHardcodedSecret) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Hardcoded Azure client secret',
        issue: `Azure client secret appears hardcoded in "${relFile}" — use getenv('MICROSOFT_CLIENT_SECRET') or Symfony env parameter; rotate the secret immediately`,
      });
    }
  });

  return results;
}

export function listMicrosoftGraphIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildMicrosoftGraphIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Microsoft Graph API integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Microsoft Graph API Integration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
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
    return { content: [{ type: 'text', text: `Error scanning Microsoft Graph integration: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getMicrosoftGraphIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildMicrosoftGraphIntegrationInfos(appPath);
    const byType = { env: 0, php: 0, composer: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `Microsoft Graph Integration Stats`,
      `==================================`,
      `Total entries   : ${infos.length}`,
      `  Composer      : ${byType.composer}`,
      `  Env vars      : ${byType.env}`,
      `  PHP code      : ${byType.php}`,
      `Issues          : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getMicrosoftGraphIntegrationTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_microsoft_graph_integration',
      description: 'Scan for Microsoft Graph API patterns: composer packages (microsoft/microsoft-graph, microsoft/kiota-*, thenetworg/oauth2-azure), env vars (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID, AZURE_CLIENT_SECRET), PHP usage (new Graph, setAccessToken, GraphServiceClient, users/mail API). Flags hardcoded client secrets, over-privileged permissions (Mail.ReadWrite, User.ReadWrite.All, Directory.ReadWrite.All), missing token caching, and access token logging.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_microsoft_graph_integration_stats',
      description: 'Return summary statistics for Microsoft Graph integration: entry counts by type (composer, env, php) and total issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
