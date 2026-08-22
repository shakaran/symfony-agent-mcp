import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PaypalIntegrationInfo {
  source: string;
  type: 'credentials' | 'webhook' | 'order' | 'sandbox' | 'validation';
  pattern: string;
  issues: string[];
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...scanDirRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function readEnvFiles(appPath: string): string {
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  let combined = '';
  for (const fname of envFiles) {
    const fpath = path.join(appPath, fname);
    if (fs.existsSync(fpath)) {
      combined += fs.readFileSync(fpath, 'utf8') + '\n';
    }
  }
  return combined;
}

function buildPaypalIntegrationInfos(appPath: string): PaypalIntegrationInfo[] {
  const results: PaypalIntegrationInfo[] = [];

  // Check .env files for PayPal config
  const envContent = readEnvFiles(appPath);
  if (envContent) {
    const clientIdMatch = envContent.match(/PAYPAL_CLIENT_ID\s*=\s*(.+)/);
    const clientSecretMatch = envContent.match(/PAYPAL_CLIENT_SECRET\s*=\s*(.+)/);
    const modeMatch = envContent.match(/PAYPAL_MODE\s*=\s*(.+)/);

    if (clientIdMatch) {
      results.push({
        source: '.env',
        type: 'credentials',
        pattern: 'PAYPAL_CLIENT_ID',
        issues: [],
      });
    }

    if (clientSecretMatch) {
      const secretValue = clientSecretMatch[1].trim();
      const issues: string[] = [];
      if (secretValue && !secretValue.startsWith('%env(') && !secretValue.startsWith('${')) {
        issues.push(
          'PayPal client secret in .env — ensure this is not committed to version control; use environment-specific .env.local or CI secrets',
        );
      }
      results.push({
        source: '.env',
        type: 'credentials',
        pattern: 'PAYPAL_CLIENT_SECRET',
        issues,
      });
    }

    if (modeMatch) {
      const mode = modeMatch[1].trim();
      if (mode === 'sandbox') {
        results.push({
          source: '.env',
          type: 'sandbox',
          pattern: 'PAYPAL_MODE=sandbox',
          issues: [],
        });
      }
    }
  }

  // Check composer.json for PayPal SDK
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    const composerContent = fs.readFileSync(composerPath, 'utf8');
    const sdkPackages = [
      'paypal/paypal-server-sdk',
      'paypal/rest-api-sdk-php',
      'srmklive/paypal',
    ];
    for (const pkg of sdkPackages) {
      if (composerContent.includes(pkg)) {
        results.push({
          source: 'composer.json',
          type: 'credentials',
          pattern: `sdk:${pkg}`,
          issues: [],
        });
        break;
      }
    }
  }

  // Scan PHP files for PayPal patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');

  for (const filePath of phpFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(appPath, filePath);

    if (
      !content.includes('PayPal') &&
      !content.includes('paypal') &&
      !content.includes('OrdersCreate') &&
      !content.includes('captureOrder') &&
      !content.includes('WebhookEvent')
    ) {
      continue;
    }

    // Order creation
    if (/OrdersCreateRequest|createOrder\s*\(/.test(content)) {
      results.push({
        source: relPath,
        type: 'order',
        pattern: 'order-creation',
        issues: [],
      });
    }

    // Order verification + capture flow check
    if (/captureOrder\s*\(|capturePayment\s*\(/.test(content)) {
      const hasVerification = /getOrder\s*\(/.test(content);
      results.push({
        source: relPath,
        type: 'order',
        pattern: 'order-capture',
        issues: hasVerification
          ? []
          : [
              'PayPal order capture without verification — always verify order status with getOrder() before calling capturePayment() to prevent replay attacks',
            ],
      });
    }

    // Webhook processing
    if (/WebhookEvent|webhook.*paypal|paypal.*webhook/i.test(content)) {
      const hasSignatureVerification =
        /validateWebhook|verifyWebhook|PAYPAL-TRANSMISSION-SIG|verifySignature/i.test(content);
      results.push({
        source: relPath,
        type: 'webhook',
        pattern: 'webhook-handler',
        issues: hasSignatureVerification
          ? []
          : [
              "PayPal webhook handler without signature verification — verify webhook authenticity using PayPal SDK's WebhookEvent::validateWebhook() to prevent forged events",
            ],
      });
    }

    // Return URL from user request
    if (/return_url|PAYPAL_RETURN_URL/i.test(content)) {
      const hasRequestInput =
        /\$request->get\s*\(|Request\s*\$request|\$_GET|\$_POST|\$_REQUEST/.test(content);
      if (hasRequestInput) {
        results.push({
          source: relPath,
          type: 'validation',
          pattern: 'return-url-from-request',
          issues: [
            'PayPal return_url from user request — validate return/cancel URLs against an allowlist to prevent open redirect attacks',
          ],
        });
      } else {
        results.push({
          source: relPath,
          type: 'validation',
          pattern: 'return-url-defined',
          issues: [],
        });
      }
    }
  }

  return results;
}

export function listPaypalIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildPaypalIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PayPal integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PayPal Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
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

export function getPaypalIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildPaypalIntegrationInfos(appPath);
    let text = `PayPal Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Credentials: ${infos.filter((i) => i.type === 'credentials').length}\n`;
    text += `Webhook: ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `Order: ${infos.filter((i) => i.type === 'order').length}\n`;
    text += `Sandbox: ${infos.filter((i) => i.type === 'sandbox').length}\n`;
    text += `Validation: ${infos.filter((i) => i.type === 'validation').length}\n`;
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPaypalIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_paypal_integration',
      description: 'Analyze PayPal payment integration configuration and detect security issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_paypal_integration_stats',
      description: 'Statistics for PayPal integration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
