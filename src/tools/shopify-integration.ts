// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ShopifyIntegrationInfo {
  file: string;
  type: 'rest' | 'graphql' | 'webhook' | 'oauth' | 'storefront' | 'app';
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

function maskSecret(value: string): string {
  if (!value || value.startsWith('${') || value.startsWith('%')) return value;
  return '***';
}

function looksLikeHardcoded(value: string): boolean {
  if (!value || value.startsWith('%') || value.startsWith('${')) return false;
  return value.length >= 16 && /[A-Za-z0-9]/.test(value);
}

function buildShopifyIntegrationInfos(appPath: string): ShopifyIntegrationInfo[] {
  const results: ShopifyIntegrationInfo[] = [];

  // Check composer.json for Shopify packages
  const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath);
  if (composerContent) {
    const packages = ['shopify/shopify-api', 'signifly/laravel-shopify', 'osiset/laravel-shopify', 'slimkit/laravel-shopify'];
    for (const pkg of packages) {
      if (composerContent.includes(pkg)) {
        results.push({ file: 'composer.json', type: 'app', endpoint: 'myshopify.com', issues: [] });
      }
    }
  }

  // Scan .env* files
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  let shopDomain = '';

  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;

    const apiKeyMatch = /SHOPIFY_API_KEY\s*=\s*([^\n]+)/.exec(content);
    const apiSecretMatch = /SHOPIFY_API_SECRET\s*=\s*([^\n]+)/.exec(content);
    const accessTokenMatch = /SHOPIFY_ACCESS_TOKEN\s*=\s*([^\n]+)/.exec(content);
    const domainMatch = /SHOPIFY_SHOP_DOMAIN\s*=\s*([^\n]+)/.exec(content);

    if (domainMatch) {
      shopDomain = domainMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }

    if (apiKeyMatch) {
      const val = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (looksLikeHardcoded(val)) {
        issues.push(`SHOPIFY_API_KEY in ${fname} appears hardcoded ("${maskSecret(val)}") — store in CI/CD secrets; Shopify API keys enable app installation and billing`);
      }
      results.push({ file: fname, type: 'oauth', endpoint: shopDomain || 'myshopify.com', issues });
    }

    if (apiSecretMatch) {
      const val = apiSecretMatch[1].trim();
      const issues: string[] = [];
      if (looksLikeHardcoded(val)) {
        issues.push(`SHOPIFY_API_SECRET in ${fname} appears hardcoded ("${maskSecret(val)}") — API secret is used for HMAC webhook verification; protect with CI secrets`);
      }
      results.push({ file: fname, type: 'oauth', endpoint: shopDomain || 'myshopify.com', issues });
    }

    if (accessTokenMatch) {
      const val = accessTokenMatch[1].trim();
      const issues: string[] = [];
      // Shopify access tokens look like shpat_, shpca_, shpss_, or shpua_
      if (looksLikeHardcoded(val)) {
        issues.push(`SHOPIFY_ACCESS_TOKEN in ${fname} appears hardcoded ("${maskSecret(val)}") — private app token gives persistent access; use OAuth flow for installed apps instead`);
        if (!val.startsWith('shpat_') && !val.startsWith('shpca_')) {
          issues.push(`SHOPIFY_ACCESS_TOKEN in ${fname}: using private app token instead of OAuth — private tokens are less secure; use OAuth app installation for production`);
        }
      }
      results.push({ file: fname, type: 'app', endpoint: shopDomain || 'myshopify.com', issues });
    }
  }

  // Scan src/**/*.php for Shopify usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      const hasShopify = content.includes('ShopifyClient') ||
        content.includes('->graph()->query(') ||
        content.includes('->rest()->get(') ||
        content.includes('->rest()->post(') ||
        content.includes('WebhookHandler') ||
        content.includes('->verifyWebhook(') ||
        content.includes('Shopify\\') ||
        content.includes('shopify_api') ||
        content.includes('StorefrontClient');

      if (!hasShopify) continue;

      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];

      // Check for missing HMAC webhook verification
      if ((content.includes('WebhookHandler') || content.includes('webhook')) &&
          !content.includes('verifyWebhook') && !content.includes('hmac') &&
          !content.includes('HMAC') && !content.includes('hash_hmac')) {
        issues.push(`Shopify webhook handler in ${relFile} without HMAC verification — validate X-Shopify-Hmac-Sha256 header to prevent spoofed webhook delivery`);
      }

      // Check for missing API version pinning
      if ((content.includes('->graph()->query(') || content.includes('->rest()->')) &&
          !content.includes('api_version') && !content.includes('apiVersion') && !content.includes('2024') && !content.includes('2025')) {
        issues.push(`Shopify API calls in ${relFile} without explicit API version — pin to a specific version (e.g. 2025-01) to prevent breaking changes from affecting production`);
      }

      const type: ShopifyIntegrationInfo['type'] = content.includes('->graph()->query(') ? 'graphql'
        : content.includes('WebhookHandler') || content.includes('->verifyWebhook(') ? 'webhook'
        : content.includes('StorefrontClient') ? 'storefront'
        : content.includes('OAuth') || content.includes('oauth') ? 'oauth'
        : content.includes('->rest()->') ? 'rest'
        : 'app';

      const endpointMatch = /['"](https:\/\/[a-zA-Z0-9._-]+\.myshopify\.com)/.exec(content);
      const endpoint = endpointMatch ? endpointMatch[1] : (shopDomain ? `${shopDomain}.myshopify.com` : 'myshopify.com');

      results.push({ file: relFile, type, endpoint, issues });
    }
  }

  return results;
}

export function listShopifyIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildShopifyIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Shopify integration found (shopify/shopify-api, SHOPIFY_* env vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Shopify Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  endpoint:${info.endpoint}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getShopifyIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildShopifyIntegrationInfos(appPath);
    let text = `Shopify Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns:   ${infos.length}\n`;
    text += `  rest:           ${infos.filter((i) => i.type === 'rest').length}\n`;
    text += `  graphql:        ${infos.filter((i) => i.type === 'graphql').length}\n`;
    text += `  webhook:        ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `  oauth:          ${infos.filter((i) => i.type === 'oauth').length}\n`;
    text += `  storefront:     ${infos.filter((i) => i.type === 'storefront').length}\n`;
    text += `  app:            ${infos.filter((i) => i.type === 'app').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getShopifyIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_shopify_integration',
      description: 'Analyze Shopify integration: detect shopify/shopify-api, signifly/laravel-shopify, osiset/laravel-shopify, slimkit/laravel-shopify in composer.json; scan .env* for SHOPIFY_API_KEY/API_SECRET/ACCESS_TOKEN/SHOP_DOMAIN; scan src/**/*.php for ShopifyClient/graph()->query/rest()->get/WebhookHandler/verifyWebhook; flag hardcoded API key/secret, missing HMAC webhook verification, private app token instead of OAuth, no API version pinning; masks secret/token values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_shopify_integration_stats',
      description: 'Statistics for Shopify integration: pattern counts by type (rest/graphql/webhook/oauth/storefront/app) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
