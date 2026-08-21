import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface GithubApiIntegrationInfo {
  file: string;
  type: 'rest' | 'graphql' | 'webhook' | 'oauth' | 'app';
  endpoint: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return files;
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const full = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectPhpFiles(full, base));
      else if (entry.isFile() && entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function maskToken(value: string): string {
  if (!value || value.startsWith('${') || value.startsWith('%')) return value;
  return '***';
}

function buildGithubApiIntegrationInfos(appPath: string): GithubApiIntegrationInfo[] {
  const results: GithubApiIntegrationInfo[] = [];

  // Check composer.json for GitHub API packages
  const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath);
  if (composerContent) {
    const packages = ['knplabs/github-api', 'github/github-api', 'symfony/github-bundle', 'lcobusc/github'];
    for (const pkg of packages) {
      if (composerContent.includes(pkg)) {
        results.push({ file: 'composer.json', type: 'rest', endpoint: 'api.github.com', issues: [] });
      }
    }
  }

  // Scan .env* files
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  let hasPat = false;
  let hasApp = false;

  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;

    const tokenMatch = /GITHUB_TOKEN\s*=\s*([^\n]+)/.exec(content);
    const appIdMatch = /GITHUB_APP_ID\s*=\s*([^\n]+)/.exec(content);
    const privateKeyMatch = /GITHUB_APP_PRIVATE_KEY\s*=\s*([^\n]+)/.exec(content);
    const webhookSecretMatch = /GITHUB_WEBHOOK_SECRET\s*=\s*([^\n]+)/.exec(content);

    if (tokenMatch) {
      hasPat = true;
      const val = tokenMatch[1].trim();
      const issues: string[] = [];
      if (val && !val.startsWith('%') && !val.startsWith('${')) {
        // GitHub PATs start with ghp_, ghs_, gho_, github_pat_
        if (/^(ghp_|ghs_|gho_|github_pat_|[a-f0-9]{40})/.test(val)) {
          issues.push(`GITHUB_TOKEN in ${fname} appears to be a hardcoded PAT ("${maskToken(val)}") — inject via CI secrets; PATs grant broad access and should never be committed`);
        }
      }
      if (!hasApp) {
        issues.push(`Using GITHUB_TOKEN (PAT) in ${fname} — consider GitHub App authentication for better security (fine-grained permissions, short-lived tokens, no user account dependency)`);
      }
      results.push({ file: fname, type: 'oauth', endpoint: 'api.github.com', issues });
    }

    if (appIdMatch) {
      hasApp = true;
    }

    if (privateKeyMatch) {
      const val = privateKeyMatch[1].trim();
      const issues: string[] = [];
      if (val && !val.startsWith('%') && !val.startsWith('${')) {
        issues.push(`GITHUB_APP_PRIVATE_KEY in ${fname} appears hardcoded ("${maskToken(val)}") — use CI secret or secret manager for App private keys`);
      }
      results.push({ file: fname, type: 'app', endpoint: 'api.github.com', issues });
    }

    if (webhookSecretMatch) {
      const val = webhookSecretMatch[1].trim();
      const issues: string[] = [];
      if (val && !val.startsWith('%') && !val.startsWith('${')) {
        issues.push(`GITHUB_WEBHOOK_SECRET in ${fname} appears hardcoded — use CI secrets or Vault for webhook signing secrets`);
      }
      results.push({ file: fname, type: 'webhook', endpoint: 'api.github.com', issues });
    }
  }

  // Scan src/**/*.php for GitHub API usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      const hasGithub = content.includes('GithubClient') ||
        content.includes('->api(\'repos\')') ||
        content.includes('->api("repos")') ||
        content.includes('->graphql()->execute(') ||
        content.includes('WebhookEvent') ||
        content.includes('GitHub\\Client') ||
        content.includes('KnpU\\OAuth2ClientBundle');

      if (!hasGithub) continue;

      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];

      // Check for webhook without signature validation
      if ((content.includes('WebhookEvent') || content.includes('webhook')) &&
          !content.includes('X-Hub-Signature') && !content.includes('x-hub-signature') &&
          !content.includes('sha256=') && !content.includes('hash_hmac')) {
        issues.push(`GitHub webhook handler in ${relFile} without X-Hub-Signature-256 validation — verify HMAC-SHA256 signature to prevent spoofed webhook payloads`);
      }

      // Check for rate limit handling
      if ((content.includes('->api(') || content.includes('->graphql()')) && !content.includes('RateLimit') && !content.includes('rate_limit') && !content.includes('X-RateLimit')) {
        issues.push(`GitHub API calls in ${relFile} without rate limit handling — implement exponential backoff or check X-RateLimit-Remaining headers to avoid 403 rate limit errors`);
      }

      const type: GithubApiIntegrationInfo['type'] = content.includes('->graphql()') ? 'graphql'
        : content.includes('WebhookEvent') || content.includes('webhook') ? 'webhook'
        : content.includes('OAuth') || content.includes('oauth') ? 'oauth'
        : hasPat ? 'rest'
        : 'app';

      const endpoint = content.includes('api.github.com') ? 'api.github.com'
        : content.includes('graphql.github.com') ? 'graphql.github.com'
        : 'api.github.com';

      results.push({ file: relFile, type, endpoint, issues });
    }
  }

  return results;
}

export function listGithubApiIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildGithubApiIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No GitHub API integration found (knplabs/github-api, GITHUB_TOKEN/APP_ID/WEBHOOK_SECRET env vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `GitHub API Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  endpoint:${info.endpoint}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubApiIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildGithubApiIntegrationInfos(appPath);
    let text = `GitHub API Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns:   ${infos.length}\n`;
    text += `  rest:           ${infos.filter((i) => i.type === 'rest').length}\n`;
    text += `  graphql:        ${infos.filter((i) => i.type === 'graphql').length}\n`;
    text += `  webhook:        ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `  oauth:          ${infos.filter((i) => i.type === 'oauth').length}\n`;
    text += `  app:            ${infos.filter((i) => i.type === 'app').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGithubApiIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_github_api_integration',
      description: 'Analyze GitHub API integration: detect knplabs/github-api, github/github-api, symfony/github-bundle, lcobusc/github in composer.json; scan .env* for GITHUB_TOKEN/APP_ID/APP_PRIVATE_KEY/WEBHOOK_SECRET; scan src/**/*.php for GithubClient/api(repos)/graphql()->execute/WebhookEvent; flag hardcoded GITHUB_TOKEN, missing X-Hub-Signature-256 webhook validation, PAT vs GitHub App, no rate limit handling; masks token/key values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_github_api_integration_stats',
      description: 'Statistics for GitHub API integration: pattern counts by type (rest/graphql/webhook/oauth/app) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
