import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PaypalCheckoutV2Info {
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

function detectAppEnv(appPath: string): string {
  // Try to read APP_ENV from .env files
  const envFiles = ['.env.local', '.env'];
  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;
    const m = /APP_ENV\s*=\s*([^\n]{1,30})/.exec(content);
    if (m) return m[1].trim().toLowerCase();
  }
  return 'unknown';
}

function buildPaypalCheckoutV2Infos(appPath: string): PaypalCheckoutV2Info[] {
  const results: PaypalCheckoutV2Info[] = [];

  // composer.json — PayPal Checkout SDK v2 or paypalhttp
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  let hasPaypalV2 = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    if (req['paypal/paypal-checkout-sdk']) {
      hasPaypalV2 = true;
      results.push({ source: 'composer.json', type: 'config', detail: `paypal/paypal-checkout-sdk: ${req['paypal/paypal-checkout-sdk']}`, issue: null });
    }
    if (req['paypalhttp/paypalhttp']) {
      hasPaypalV2 = true;
      results.push({ source: 'composer.json', type: 'config', detail: `paypalhttp/paypalhttp: ${req['paypalhttp/paypalhttp']}`, issue: null });
    }
  } catch { /* skip */ }

  if (!hasPaypalV2) return results;

  const appEnv = detectAppEnv(appPath);

  // .env* files — PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  let detectedEnvironment: string | null = null;

  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const varNames = [
      ['PAYPAL_CLIENT_ID', false],
      ['PAYPAL_CLIENT_SECRET', true],
      ['PAYPAL_ENVIRONMENT', false],
      ['PAYPAL_MODE', false],
    ] as Array<[string, boolean]>;

    for (const [varName, isSensitive] of varNames) {
      const regex = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,200})`);
      const m = regex.exec(content);
      if (!m) continue;

      const rawValue = m[1].trim();
      let displayValue = rawValue;
      if (isSensitive) {
        // M-13: sensitive vars are fully redacted regardless of length. Partial
        // masking was dropped because it needed {8,} and leaked short or
        // special-character secrets.
        displayValue = '***';
      }

      let issue: string | null = null;

      if (varName === 'PAYPAL_ENVIRONMENT' || varName === 'PAYPAL_MODE') {
        detectedEnvironment = rawValue.toLowerCase();
        const isSandboxInProd = (rawValue.toLowerCase().includes('sandbox') || rawValue.toLowerCase() === 'sandbox') && appEnv === 'prod';
        if (isSandboxInProd) {
          issue = `PAYPAL_ENVIRONMENT=sandbox found in "${fname}" while APP_ENV=prod — sandbox environment processes no real payments; production apps must use PAYPAL_ENVIRONMENT=production with live credentials`;
        }
      }

      if (varName === 'PAYPAL_CLIENT_SECRET' && !rawValue.startsWith('$') && !rawValue.startsWith('%') && rawValue.length > 8 && !rawValue.includes('your_') && !rawValue.includes('xxx')) {
        issue = `PAYPAL_CLIENT_SECRET appears to be a real secret in "${fname}" — rotate this credential immediately and never commit real PayPal secrets to version control`;
      }

      results.push({ source: fname, type: 'env', detail: `${varName}=${displayValue}`, issue });
    }
  }

  // src/**/*.php — PayPal Checkout SDK v2 Orders API
  const srcDir = path.join(appPath, 'src');

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasPaypal = content.includes('PayPalCheckoutSdk') || content.includes('OrdersCreateRequest') || content.includes('OrdersCaptureRequest') || content.includes('SandboxEnvironment') || content.includes('ProductionEnvironment');
    if (!hasPaypal) return;

    const relFile = path.relative(appPath, filePath);

    // OrdersCreateRequest
    if (content.includes('OrdersCreateRequest(')) {
      const hasCapture = content.includes('OrdersCaptureRequest(') || content.includes('capture');
      results.push({
        source: relFile,
        type: 'php',
        detail: 'OrdersCreateRequest() found',
        issue: !hasCapture
          ? `OrdersCreateRequest() in "${relFile}" without visible OrdersCaptureRequest() — creating an order without capturing it means payment is never collected; ensure OrdersCaptureRequest is called after buyer approval`
          : null,
      });
    }

    // OrdersCaptureRequest
    if (content.includes('OrdersCaptureRequest(')) {
      results.push({ source: relFile, type: 'php', detail: 'OrdersCaptureRequest() found', issue: null });
    }

    // OrdersGetRequest
    if (content.includes('OrdersGetRequest(')) {
      results.push({ source: relFile, type: 'php', detail: 'OrdersGetRequest() found', issue: null });
    }

    // Environment check — SandboxEnvironment in production
    if (content.includes('SandboxEnvironment(')) {
      const isProductionApp = appEnv === 'prod' || detectedEnvironment === 'production' || content.includes("APP_ENV') === 'prod'") || content.includes("'prod'");
      const hasDynamicEnvSwitch = content.includes('if') && (content.includes('SandboxEnvironment') && content.includes('ProductionEnvironment'));
      results.push({
        source: relFile,
        type: 'php',
        detail: 'SandboxEnvironment() used',
        issue: isProductionApp && !hasDynamicEnvSwitch
          ? `SandboxEnvironment() hardcoded in "${relFile}" while app appears to be in production — use a dynamic switch based on PAYPAL_ENVIRONMENT env var to avoid processing real orders in sandbox`
          : !hasDynamicEnvSwitch
            ? `SandboxEnvironment() used in "${relFile}" — ensure this switches to ProductionEnvironment() based on PAYPAL_ENVIRONMENT env var; hardcoded sandbox will silently fail in production`
            : null,
      });
    }

    if (content.includes('ProductionEnvironment(')) {
      results.push({ source: relFile, type: 'php', detail: 'ProductionEnvironment() used', issue: null });
    }

    // Webhook validation
    if (content.includes('WebhookEvent::') || content.includes('validateAndGetMessage(') || content.includes('verifyWebhook')) {
      const hasSignatureCheck = content.includes('verifySignature') || content.includes('validateAndGetMessage') || content.includes('PAYPAL-CERT-URL') || content.includes('PAYPAL-TRANSMISSION-SIG');
      results.push({
        source: relFile,
        type: 'php',
        detail: 'PayPal webhook handler found',
        issue: !hasSignatureCheck
          ? `PayPal webhook handler in "${relFile}" without signature verification — verify PAYPAL-TRANSMISSION-SIG header to prevent forged webhook events from triggering order fulfillment`
          : null,
      });
    }

    // Hardcoded client secret
    const hasHardcodedSecret = /(?:new\s+(?:Sandbox|Production)Environment|PayPalHttpClient)\s*\([^)]{0,200}(?:client_secret|secret)[^)]{0,100}\)/i.test(content) ||
      /['"][A-Za-z0-9_-]{20,}['"]\s*,\s*['"][A-Za-z0-9_-]{20,}['"]\s*\)/.test(content);
    if (hasHardcodedSecret) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Potential hardcoded PayPal credentials',
        issue: `PayPal credentials appear hardcoded in "${relFile}" — use getenv('PAYPAL_CLIENT_ID') and getenv('PAYPAL_CLIENT_SECRET') or Symfony env parameters`,
      });
    }
  });

  return results;
}

export function listPaypalCheckoutV2(appPath: string): McpToolResult {
  try {
    const infos = buildPaypalCheckoutV2Infos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PayPal Checkout SDK v2 (Orders API) integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `PayPal Checkout SDK v2 (Orders API) Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
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
    return { content: [{ type: 'text', text: `Error scanning PayPal Checkout v2 config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getPaypalCheckoutV2Stats(appPath: string): McpToolResult {
  try {
    const infos = buildPaypalCheckoutV2Infos(appPath);
    const byType = { env: 0, php: 0, config: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `PayPal Checkout v2 Stats`,
      `========================`,
      `Total entries   : ${infos.length}`,
      `  Env vars      : ${byType.env}`,
      `  PHP code      : ${byType.php}`,
      `  Config        : ${byType.config}`,
      `Issues          : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getPaypalCheckoutV2Tools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_paypal_checkout_v2',
      description: 'Scan for PayPal Checkout SDK v2 (Orders API) patterns distinct from legacy PayPal integration: composer (paypal/paypal-checkout-sdk), env vars (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT), PHP usage (OrdersCreateRequest, OrdersCaptureRequest, SandboxEnvironment/ProductionEnvironment), and webhook validation. Flags sandbox in production, missing capture step, webhook without signature check.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_paypal_checkout_v2_stats',
      description: 'Return summary statistics for PayPal Checkout SDK v2 integration: entry counts by type and total issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
