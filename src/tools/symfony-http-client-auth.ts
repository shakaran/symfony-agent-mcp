/**
 * Symfony HTTP Client Auth Inspector
 *
 * Scans src/ PHP for: withOptions(['auth_bearer' => , withOptions(['auth_basic' => ,
 * withOptions(['headers' => ['Authorization', withOptions(['headers' => ['X-Api-Key',
 * HttpClientInterface::withOptions(, ScopingHttpClient::forBaseUri(.
 * Reads config/packages/http_client.yaml: scoped clients with auth config.
 *
 * Warns about:
 *   - Auth credentials hardcoded in withOptions() instead of env vars
 *   - Basic auth without HTTPS (plaintext credential exposure)
 *   - Bearer token without expiry handling (expired token causes 401 cascade)
 *   - API key in URL query string (not in header — leaks in logs)
 *   - Authorization header value in config file (committed credentials)
 *   - withOptions() called in loop (creates new client per request — inefficient)
 *   - Auth strategy in controller instead of service (auth logic in wrong layer)
 *
 * Pure static analysis — no execution.
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

interface HttpClientAuthInfo {
  file: string;
  class: string;
  authType: 'bearer' | 'basic' | 'api-key' | 'custom' | 'none';
  isHardcoded: boolean;
  isHttps: boolean;
  isInConfig: boolean;
  issues: string[];
}

const SENSITIVE_HEADER_RE = /^(authorization|x-api-key|x-auth-token|cookie|proxy-authorization|x-secret|x-token|set-cookie)$/i;

function maskSensitiveHeaderValue(name: string, value: string): string {
  return SENSITIVE_HEADER_RE.test(name) ? '***' : value;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractClassName(content: string): string {
  const m = content.match(/class\s+([A-Za-z0-9_]{1,120})/);
  return m ? m[1] : '(unknown)';
}

function isInController(filePath: string): boolean {
  return /[Cc]ontroller/.test(path.basename(filePath));
}

function hasHardcodedCredential(content: string): boolean {
  // Check for literal string values that aren't env vars like %env(...)% or $_ENV
  return (
    /auth_bearer['"]\s*=>\s*['"][A-Za-z0-9._\-+/]{8,200}['"]/i.test(content) ||
    /auth_basic['"]\s*=>\s*\[['"][^%$][^'"]{1,100}['"],\s*['"][^%$][^'"]{0,100}['"]/i.test(content) ||
    /['"]{0,1}Authorization['"]{0,1}\s*=>\s*['"](?:Bearer|Basic)\s+[A-Za-z0-9._\-+/]{8,200}['"]/i.test(content)
  );
}

function buildHttpClientAuthInfos(appPath: string): HttpClientAuthInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: HttpClientAuthInfo[] = [];

  // Scan PHP files in src/
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath); if (content === null) continue;

      const hasHttpClient =
        content.includes('HttpClientInterface') ||
        content.includes('withOptions(') ||
        content.includes('ScopingHttpClient') ||
        content.includes('HttpClient::');

      if (!hasHttpClient) continue;

      const className = extractClassName(content);
      const issues: string[] = [];

      let authType: 'bearer' | 'basic' | 'api-key' | 'custom' | 'none' = 'none';

      if (/['"]auth_bearer['"]\s*=>/.test(content)) {
        authType = 'bearer';
      } else if (/['"]auth_basic['"]\s*=>/.test(content)) {
        authType = 'basic';
      } else if (/['"]{0,1}X-Api-Key['"]{0,1}\s*=>/.test(content)) {
        authType = 'api-key';
      } else if (/['"]{0,1}Authorization['"]{0,1}\s*=>/.test(content)) {
        authType = 'custom';
      }

      if (authType === 'none') continue;

      const isHardcoded = hasHardcodedCredential(content);
      const isHttps = ((): boolean => {
        // Look for base_uri or URL patterns
        const urlMatch = content.match(/base_uri['"]\s*=>\s*['"]([^'"]{1,200})['"]/i);
        if (urlMatch) return urlMatch[1].startsWith('https://');
        return true; // Assume HTTPS if can't determine
      })();

      if (isHardcoded) {
        issues.push(`"${className}" has hardcoded auth credentials in withOptions() — use env vars (%env(API_TOKEN)%) instead of literals`);
      }

      if (authType === 'basic' && !isHttps) {
        issues.push(`"${className}" uses Basic auth without HTTPS — credentials are transmitted in plaintext (base64 is not encryption)`);
      }

      if (authType === 'bearer' && !content.includes('refresh') && !content.includes('expire') && !content.includes('Unauthorized')) {
        issues.push(`"${className}" uses Bearer token without token expiry/refresh handling — expired tokens will cause 401 cascade failures`);
      }

      if (/api[_-]?key[=?&][A-Za-z0-9._-]{4,100}/i.test(content)) {
        issues.push(`"${className}" appears to include API key in URL query string — keys in URLs leak to logs, referrer headers, and access logs`);
      }

      // Check if withOptions is called in a loop
      if (
        /for(?:each)?\s*\(/.test(content) &&
        /->withOptions\s*\(/.test(content)
      ) {
        issues.push(`"${className}" calls withOptions() inside a loop — this creates a new client instance per iteration; configure auth once outside the loop`);
      }

      if (isInController(file)) {
        issues.push(`"${className}" contains auth configuration in a controller — auth setup belongs in a dedicated service/client factory, not in controllers`);
      }

      results.push({
        file,
        class: className,
        authType,
        isHardcoded,
        isHttps,
        isInConfig: false,
        issues,
      });
    }
  }

  // Scan http_client.yaml config
  const cfgPath = path.join(appPath, 'config', 'packages', 'http_client.yaml');
  const raw = parseYamlFile(cfgPath) as Record<string, unknown> | null;
  if (raw) {
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const httpClient = (framework['http_client'] ?? {}) as Record<string, unknown>;
    const scopedClients = (httpClient['scoped_clients'] ?? {}) as Record<string, unknown>;

    for (const [clientName, clientData] of Object.entries(scopedClients)) {
      const client = (clientData ?? {}) as Record<string, unknown>;
      const authBearer = client['auth_bearer'];
      const authBasic = client['auth_basic'];
      const headers = (client['headers'] ?? {}) as Record<string, unknown>;
      const hasAuthHeader = Object.keys(headers).some((k) => SENSITIVE_HEADER_RE.test(k));

      let authType: 'bearer' | 'basic' | 'api-key' | 'custom' | 'none' = 'none';
      if (authBearer) authType = 'bearer';
      else if (authBasic) authType = 'basic';
      else if (hasAuthHeader) authType = 'custom';

      if (authType === 'none') continue;

      const issues: string[] = [];

      // Check if value is a literal (not env var) — covers auth_bearer and sensitive header values
      const bearerVal = String(authBearer ?? '');
      const hardcodedBearer = !!bearerVal && !bearerVal.startsWith('%env') && !bearerVal.startsWith('$');
      const hardcodedHeader = Object.entries(headers).some(([k, v]) => {
        const val = String(v ?? '');
        return SENSITIVE_HEADER_RE.test(k) && !!val && !val.startsWith('%env') && !val.startsWith('$');
      });
      const isHardcoded = hardcodedBearer || hardcodedHeader;
      if (isHardcoded) {
        issues.push(`Scoped HTTP client "${clientName}" has auth credentials in config file — committed credentials risk; use environment variables (%env(TOKEN)%)`);
      }

      const baseUri = String(client['base_uri'] ?? '');
      const isHttps = !baseUri || baseUri.startsWith('https://');
      if (authType === 'basic' && !isHttps) {
        issues.push(`Scoped HTTP client "${clientName}" uses Basic auth with non-HTTPS base_uri — credentials exposed in plaintext`);
      }

      results.push({
        file: cfgPath,
        class: clientName,
        authType,
        isHardcoded,
        isHttps,
        isInConfig: true,
        issues,
      });
    }
  }

  return results;
}

export function listHttpClientAuth(appPath: string): McpToolResult {
  try {
    const infos = buildHttpClientAuthInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No HTTP client authentication configuration found in src/ or http_client.yaml.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `HTTP Client Auth Analysis\n${'='.repeat(55)}\n\n`;
    text += `Auth configurations: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}\n`;
      text += `    authType:    ${info.authType}\n`;
      text += `    hardcoded:   ${info.isHardcoded ? 'yes' : 'no'}\n`;
      text += `    https:       ${info.isHttps ? 'yes' : 'no'}\n`;
      text += `    inConfig:    ${info.isInConfig ? 'yes' : 'no'}\n`;
      if (!info.isInConfig) text += `    file:        ${info.file}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientAuthStats(appPath: string): McpToolResult {
  try {
    const infos = buildHttpClientAuthInfos(appPath);

    let text = `HTTP Client Auth Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total auth configurations:   ${infos.length}\n`;
    text += `  Bearer token:              ${infos.filter((i) => i.authType === 'bearer').length}\n`;
    text += `  Basic auth:                ${infos.filter((i) => i.authType === 'basic').length}\n`;
    text += `  API key:                   ${infos.filter((i) => i.authType === 'api-key').length}\n`;
    text += `  Custom header:             ${infos.filter((i) => i.authType === 'custom').length}\n`;
    text += `  Hardcoded credentials:     ${infos.filter((i) => i.isHardcoded).length}\n`;
    text += `  Non-HTTPS:                 ${infos.filter((i) => !i.isHttps).length}\n`;
    text += `  In config file:            ${infos.filter((i) => i.isInConfig).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientAuthTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_http_client_auth',
      description: 'Inspect HTTP client authentication: auth_bearer/auth_basic/api-key patterns in src/ and http_client.yaml scoped clients; warns on hardcoded credentials, Basic auth without HTTPS, expired token handling, API key in URL, auth in controller layer',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_http_client_auth_stats',
      description: 'Statistics for HTTP client authentication: bearer/basic/api-key/custom counts, hardcoded credentials, non-HTTPS count, config file auth count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
