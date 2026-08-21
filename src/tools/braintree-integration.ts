import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface BraintreeIntegrationInfo {
  file: string;
  type: 'gateway' | 'transaction' | 'subscription' | 'webhook' | 'vault';
  environment: 'sandbox' | 'production' | 'unknown';
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

function maskPrivateKey(value: string): string {
  if (!value || value.startsWith('${') || value.startsWith('%')) return value;
  return '***';
}

function detectBraintreeEnvironment(content: string): BraintreeIntegrationInfo['environment'] {
  if (/braintree[._-]?environment\s*=\s*['"]?production/i.test(content) ||
      /Environment::Production/i.test(content) ||
      /BRAINTREE_ENVIRONMENT\s*=\s*production/i.test(content)) return 'production';
  if (/braintree[._-]?environment\s*=\s*['"]?sandbox/i.test(content) ||
      /Environment::Sandbox/i.test(content) ||
      /BRAINTREE_ENVIRONMENT\s*=\s*sandbox/i.test(content)) return 'sandbox';
  return 'unknown';
}

function buildBraintreeIntegrationInfos(appPath: string): BraintreeIntegrationInfo[] {
  const results: BraintreeIntegrationInfo[] = [];

  // Check composer.json
  const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath);
  if (composerContent) {
    if (composerContent.includes('braintree/braintree_php')) {
      results.push({ file: 'composer.json', type: 'gateway', environment: 'unknown', issues: [] });
    }
  }

  // Scan .env* files
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  let globalEnvironment: BraintreeIntegrationInfo['environment'] = 'unknown';

  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;

    const merchantIdMatch = /BRAINTREE_MERCHANT_ID\s*=\s*([^\n]+)/.exec(content);
    const publicKeyMatch = /BRAINTREE_PUBLIC_KEY\s*=\s*([^\n]+)/.exec(content);
    const privateKeyMatch = /BRAINTREE_PRIVATE_KEY\s*=\s*([^\n]+)/.exec(content);
    const envMatch = /BRAINTREE_ENVIRONMENT\s*=\s*([^\n]+)/.exec(content);

    const env = detectBraintreeEnvironment(content);
    if (env !== 'unknown') globalEnvironment = env;

    const issues: string[] = [];

    if (privateKeyMatch) {
      const val = privateKeyMatch[1].trim();
      if (val && !val.startsWith('%') && !val.startsWith('${')) {
        issues.push(`BRAINTREE_PRIVATE_KEY in ${fname} appears hardcoded ("${maskPrivateKey(val)}") — inject via CI secrets; never commit payment gateway private keys`);
      }
    }

    if (publicKeyMatch) {
      const val = publicKeyMatch[1].trim();
      if (val && !val.startsWith('%') && !val.startsWith('${') && val.length > 10) {
        issues.push(`BRAINTREE_PUBLIC_KEY in ${fname} appears hardcoded — use CI/CD environment variables for Braintree credentials`);
      }
    }

    // Production environment with sandbox-pattern credentials
    if (env === 'production' && content.includes('sandbox')) {
      issues.push(`BRAINTREE_ENVIRONMENT=production in ${fname} but sandbox credentials pattern detected — verify production keys are used, not sandbox keys`);
    }

    if (merchantIdMatch || publicKeyMatch || privateKeyMatch || envMatch) {
      results.push({ file: fname, type: 'gateway', environment: env, issues });
    }
  }

  // Scan src/**/*.php for Braintree usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      const hasBraintree = content.includes('Braintree\\Gateway') ||
        content.includes('Braintree_Gateway') ||
        content.includes('->transaction()->sale(') ||
        content.includes('->subscription()->create(') ||
        content.includes('->webHookNotification()->parse(') ||
        content.includes('->paymentMethod()->');

      if (!hasBraintree) continue;

      const relFile = path.relative(appPath, filePath);
      const fileEnv = detectBraintreeEnvironment(content);
      const environment = fileEnv !== 'unknown' ? fileEnv : globalEnvironment;
      const issues: string[] = [];

      // Check for hardcoded credentials in gateway instantiation
      if (/new\s+Braintree[\\]?Gateway\s*\(\s*\[/.test(content)) {
        if (content.includes("'merchantId'") && !/env\(|getenv\(/.test(content)) {
          issues.push(`Braintree Gateway in ${relFile} may have hardcoded credentials — use env vars ($_ENV or getenv()) for merchantId, publicKey, privateKey`);
        }
      }

      // Webhook signature verification
      if (content.includes('->webHookNotification()->parse(') && !content.includes('->webHookNotification()->verify(')) {
        issues.push(`Braintree webhook parsing in ${relFile} without verify() call — always verify webhook signature before processing to prevent spoofed events`);
      }

      // 3D Secure enforcement
      if (content.includes('->transaction()->sale(') && !content.includes('threeDSecure') && !content.includes('3d_secure') && !content.includes('threeD')) {
        issues.push(`Braintree transaction sale in ${relFile} without 3D Secure parameters — enforce 3DS for card transactions to reduce fraud and liability`);
      }

      const type: BraintreeIntegrationInfo['type'] = content.includes('->webHookNotification()') ? 'webhook'
        : content.includes('->subscription()') ? 'subscription'
        : content.includes('->paymentMethod()') ? 'vault'
        : content.includes('->transaction()') ? 'transaction'
        : 'gateway';

      results.push({ file: relFile, type, environment, issues });
    }
  }

  return results;
}

export function listBraintreeIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildBraintreeIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Braintree integration found (braintree/braintree_php, BRAINTREE_* env vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Braintree Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  env:${info.environment}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBraintreeIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildBraintreeIntegrationInfos(appPath);
    let text = `Braintree Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns:   ${infos.length}\n`;
    text += `  gateway:        ${infos.filter((i) => i.type === 'gateway').length}\n`;
    text += `  transaction:    ${infos.filter((i) => i.type === 'transaction').length}\n`;
    text += `  subscription:   ${infos.filter((i) => i.type === 'subscription').length}\n`;
    text += `  webhook:        ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `  vault:          ${infos.filter((i) => i.type === 'vault').length}\n`;
    text += `Environments:     sandbox:${infos.filter((i) => i.environment === 'sandbox').length}  production:${infos.filter((i) => i.environment === 'production').length}  unknown:${infos.filter((i) => i.environment === 'unknown').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBraintreeIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_braintree_integration',
      description: 'Analyze Braintree integration: detect braintree/braintree_php in composer.json; scan .env* for BRAINTREE_MERCHANT_ID/PUBLIC_KEY/PRIVATE_KEY/ENVIRONMENT; scan src/**/*.php for Braintree\\Gateway/transaction()->sale/subscription()->create/webHookNotification()->parse; flag production env with sandbox credentials, missing webhook signature verification, no 3D Secure enforcement, hardcoded credentials; masks BRAINTREE_PRIVATE_KEY values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_braintree_integration_stats',
      description: 'Statistics for Braintree integration: pattern counts by type (gateway/transaction/subscription/webhook/vault), environment breakdown (sandbox/production/unknown), and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
