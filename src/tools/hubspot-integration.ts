import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HubspotIntegrationInfo {
  source: string;
  type: 'env' | 'php' | 'config';
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

function buildHubspotIntegrationInfos(appPath: string): HubspotIntegrationInfo[] {
  const results: HubspotIntegrationInfo[] = [];

  // Check composer.json for hubspot package
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('hubspot/hubspot-php')) {
    const verMatch = /"hubspot\/hubspot-php"\s*:\s*"([^"]{1,30})"/.exec(composerContent);
    const ver = verMatch ? verMatch[1] : 'unknown';
    results.push({ source: 'composer.json', type: 'config', detail: `hubspot/hubspot-php: ${ver}`, issue: null });
  }

  // Scan .env* files for HubSpot credentials
  const envFileNames = ['.env', '.env.local', '.env.prod', '.env.test'];
  let hasApiKey = false;

  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const hubspotVars: Array<{ name: string; deprecated: boolean }> = [
      { name: 'HUBSPOT_API_KEY', deprecated: true },
      { name: 'HUBSPOT_ACCESS_TOKEN', deprecated: false },
      { name: 'HUBSPOT_CLIENT_SECRET', deprecated: false },
    ];

    for (const { name: varName, deprecated } of hubspotVars) {
      const pattern = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,200})`);
      const m = pattern.exec(content);
      if (!m) continue;
      const rawVal = m[1].trim();
      const masked = maskSecrets(`${varName}=${rawVal}`);
      if (varName === 'HUBSPOT_API_KEY') hasApiKey = true;
      const issue = deprecated
        ? `${varName} in ${fname} — HubSpot API Keys were deprecated in November 2022 and will be fully removed; migrate to Private App access tokens (HUBSPOT_ACCESS_TOKEN)`
        : varName === 'HUBSPOT_CLIENT_SECRET'
          ? `${varName} in ${fname} — inject via CI/CD secrets; never commit OAuth client secret to version control`
          : null;
      results.push({ source: fname, type: 'env', detail: masked, issue });
    }
  }

  // Scan src/**/*.php for HubSpot usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('HubSpot') &&
      !content.includes('hubspot') &&
      !content.includes('->contacts()') &&
      !content.includes('->deals()') &&
      !content.includes('->forms()')
    ) continue;

    const relFile = path.relative(appPath, filePath);

    // Deprecated createWithApiKey()
    if (content.includes('Factory::createWithApiKey(') || content.includes('createWithApiKey(')) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'HubSpot::Factory::createWithApiKey() usage',
        issue: `createWithApiKey() in ${relFile} — HubSpot API Keys are deprecated since Nov 2022; replace with Factory::createWithAccessToken() using a Private App token`,
      });
    }

    // Deprecated API key usage
    if (hasApiKey && (content.includes('HUBSPOT_API_KEY') || content.includes('createWithApiKey'))) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Deprecated HUBSPOT_API_KEY auth method in use',
        issue: `${relFile} references deprecated API key authentication — migrate to Private App access tokens before HubSpot removes API key support`,
      });
    }

    // createWithAccessToken informational
    if (content.includes('Factory::createWithAccessToken(')) {
      results.push({ source: relFile, type: 'php', detail: 'HubSpot::Factory::createWithAccessToken() — correct auth method', issue: null });
    }

    // Hardcoded HUBSPOT_CLIENT_SECRET in PHP
    const hardcodedSecret = /client_secret|clientSecret|HUBSPOT_CLIENT_SECRET/.test(content);
    if (hardcodedSecret) {
      const directAssign = /['"](?:client_secret|HUBSPOT_CLIENT_SECRET)['"]\s*=>\s*['"][a-zA-Z0-9_-]{16,}['"]/.test(content);
      if (directAssign) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Possible hardcoded HUBSPOT_CLIENT_SECRET in PHP',
          issue: `HUBSPOT_CLIENT_SECRET appears hardcoded in ${relFile} — use getenv('HUBSPOT_CLIENT_SECRET') or inject via DI container`,
        });
      }
    }

    // Webhook processing without HMAC validation
    const isWebhookHandler = /webhook|hubspot.*event|handle.*hubspot/i.test(relFile) ||
      /hubspot.*webhook|handleHubspot|hubspotWebhook/i.test(content);
    if (isWebhookHandler) {
      const hasHmac = content.includes('hash_hmac') || content.includes('X-HubSpot-Signature') || content.includes('hubspot_signature');
      if (!hasHmac) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'HubSpot webhook handler without HMAC signature validation',
          issue: `HubSpot webhook handler in ${relFile} does not validate X-HubSpot-Signature-v3 — compute HMAC-SHA256 of clientSecret+requestURI+requestBody+timestamp and compare to prevent forged webhook events`,
        });
      }
    }

    // v1/v2 API endpoint strings in code
    const oldApiPattern = /['"]\/(?:contacts\/v[12]|deals\/v[12]|engagements\/v[12])[^'"]{0,100}['"]/.exec(content);
    if (oldApiPattern) {
      results.push({
        source: relFile,
        type: 'php',
        detail: `Legacy API endpoint: ${oldApiPattern[0]}`,
        issue: `Old HubSpot API endpoint (v1/v2) found in ${relFile} — migrate to v3 endpoints; v1/v2 are deprecated and will be removed`,
      });
    }

    // API method usage (informational)
    if (content.includes('->contacts()') || content.includes('->deals()') || content.includes('->forms()')) {
      results.push({ source: relFile, type: 'php', detail: 'HubSpot CRM API usage (contacts/deals/forms)', issue: null });
    }
  }

  return results;
}

export function listHubspotIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildHubspotIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No HubSpot integration found.' }] };
    }
    const totalIssues = infos.filter((i) => i.issue !== null).length;
    let text = `HubSpot Integration Analysis\n${'='.repeat(55)}\n\nFindings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.source})\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHubspotIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildHubspotIntegrationInfos(appPath);
    let text = `HubSpot Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Env findings:    ${infos.filter((i) => i.type === 'env').length}\n`;
    text += `PHP findings:    ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Config findings: ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:    ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHubspotIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_hubspot_integration',
      description: 'Analyze HubSpot CRM integration: detect composer.json hubspot/hubspot-php, scan .env* for HUBSPOT_API_KEY/ACCESS_TOKEN/CLIENT_SECRET (masked), PHP Factory::createWithApiKey/createWithAccessToken/contacts/deals/forms usage. Flags: deprecated API key auth (Nov 2022), hardcoded client secret, missing webhook HMAC validation, v1/v2 legacy API endpoints',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_hubspot_integration_stats',
      description: 'Statistics for HubSpot integration: counts by type (env/php/config) and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
