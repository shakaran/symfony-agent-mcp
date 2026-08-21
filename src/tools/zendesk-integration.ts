import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ZendeskIntegrationInfo {
  file: string;
  type: 'auth' | 'webhook' | 'ratelimit' | 'config';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
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

function maskSecret(value: string): string {
  if (value.trim() === '') return value;
  return '***';
}

function buildZendeskIntegrationInfos(appPath: string): ZendeskIntegrationInfo[] {
  const results: ZendeskIntegrationInfo[] = [];

  // Check composer.json for Zendesk client package
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('zendesk/zendesk_api_client_php')) {
    results.push({ file: 'composer.json', type: 'config', issues: ['zendesk/zendesk_api_client_php detected in composer.json'] });
  }

  // Scan .env* for Zendesk tokens/credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    const issues: string[] = [];

    const tokenPatterns: Array<{ re: RegExp; label: string }> = [
      { re: /ZENDESK_TOKEN\s*=\s*([^\n]+)/, label: 'ZENDESK_TOKEN' },
      { re: /ZENDESK_API_TOKEN\s*=\s*([^\n]+)/, label: 'ZENDESK_API_TOKEN' },
      { re: /ZENDESK_OAUTH_TOKEN\s*=\s*([^\n]+)/, label: 'ZENDESK_OAUTH_TOKEN' },
    ];
    for (const { re, label } of tokenPatterns) {
      const m = re.exec(content);
      if (m) {
        const raw = m[1].trim();
        if (raw && !raw.startsWith('%env(') && !raw.startsWith('${')) {
          issues.push(`${label} set to non-env-var value in ${fname} (value masked: ${maskSecret(raw)}) — inject via CI secrets; never commit Zendesk tokens`);
        }
      }
    }
    if (issues.length > 0) {
      results.push({ file: fname, type: 'auth', issues });
    }
  }

  // Scan src/**/*.php for Zendesk patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    const lc = content.toLowerCase();
    const hasZendesk = lc.includes('zendesk');
    if (!hasZendesk) continue;

    const relFile = path.relative(appPath, filePath);

    // Webhook signature verification missing
    const isWebhookHandler = (lc.includes('webhook') || content.includes('X-Zendesk')) && hasZendesk;
    if (isWebhookHandler && !content.includes('hash_hmac')) {
      results.push({
        file: relFile,
        type: 'webhook',
        issues: [
          `Zendesk webhook handler in ${relFile} missing HMAC signature check — verify X-Zendesk-Webhook-Signature header using hash_hmac('sha256', $payload, $secret) to prevent spoofed webhooks`,
        ],
      });
    }

    // Subdomain hardcoded in source
    if (content.includes('.zendesk.com') && !content.includes('getenv') && !content.includes('$_ENV') && !content.includes('%env(')) {
      results.push({
        file: relFile,
        type: 'config',
        issues: [
          `Hardcoded .zendesk.com subdomain in ${relFile} without getenv/$_ENV/%%env( — move subdomain to an environment variable to support multi-tenant/environment switching`,
        ],
      });
    }

    // setAuth with basic auth using password instead of token
    if (content.includes('setAuth') && content.includes('basic') && content.includes('password')) {
      results.push({
        file: relFile,
        type: 'auth',
        issues: [
          `setAuth with 'basic' type and 'password' key found in ${relFile} — use email/token authentication (type: 'basic', username: 'email/token', password: '<api-token>') instead of plain password`,
        ],
      });
    }

    // Rate limit handling absent
    const hasZendeskApiUsage =
      content.includes('ZendeskAPI') ||
      content.includes('zendesk_client') ||
      content.includes('->tickets()') ||
      content.includes('->users()') ||
      content.includes('->organizations()');
    if (hasZendeskApiUsage && !content.includes('Retry-After') && !content.includes('429')) {
      results.push({
        file: relFile,
        type: 'ratelimit',
        issues: [
          `Zendesk API client used in ${relFile} without Retry-After/429 rate-limit handling — catch HTTP 429 and respect the Retry-After header to avoid request storms`,
        ],
      });
    }
  }

  // Scan config/**/*.yaml for Zendesk patterns
  const configPhpFiles = scanDirRecursive(path.join(appPath, 'config'), '.yaml');
  for (const filePath of configPhpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.toLowerCase().includes('zendesk')) continue;
    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    if (/ZENDESK_TOKEN\s*:/.test(content) || /ZENDESK_API_TOKEN\s*:/.test(content)) {
      issues.push(`Zendesk token key referenced in ${relFile} — ensure value resolves through %%env() or secrets manager, not hardcoded`);
    }
    if (issues.length > 0) {
      results.push({ file: relFile, type: 'config', issues });
    }
  }

  return results;
}

export function listZendeskIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildZendeskIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Zendesk integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Zendesk Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getZendeskIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildZendeskIntegrationInfos(appPath);
    let text = `Zendesk Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Auth patterns:     ${infos.filter((i) => i.type === 'auth').length}\n`;
    text += `Webhook patterns:  ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `Ratelimit patterns:${infos.filter((i) => i.type === 'ratelimit').length}\n`;
    text += `Config patterns:   ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getZendeskIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_zendesk_integration',
      description: 'Scan the Symfony application for Zendesk integration patterns: missing webhook HMAC verification, hardcoded credentials, subdomain literals, weak auth, and absent rate-limit handling.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_zendesk_integration_stats',
      description: 'Return aggregated counts of Zendesk auth/webhook/ratelimit/config patterns and total issues found.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
