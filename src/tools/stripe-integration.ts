import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface StripeIntegrationInfo {
  file: string;
  type: 'webhook' | 'key' | 'idempotency' | 'pci' | 'error-handling';
  pattern: string;
  issues: string[];
}

function buildStripeIntegrationInfos(appPath: string): StripeIntegrationInfo[] {
  const results: StripeIntegrationInfo[] = [];

  const envFiles = [path.join(appPath, '.env'), path.join(appPath, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, envFile);

    const skMatch = /STRIPE_SECRET_KEY\s*=\s*([^\n]+)/.exec(content);
    if (skMatch) {
      const key = skMatch[1].trim();
      if (key.startsWith('sk_live_')) {
        results.push({ file: relFile, type: 'key', pattern: 'Stripe live key in .env', issues: [`Stripe live key in "${relFile}" — live keys must never be committed; use sk_test_ for development and inject sk_live_ via CI secrets only`] });
      } else if (key.startsWith('sk_test_') || key.startsWith('sk_')) {
        results.push({ file: relFile, type: 'key', pattern: 'Stripe test key', issues: [] });
      }
    }

    const webhookMatch = /STRIPE_WEBHOOK_SECRET\s*=\s*([^\n]+)/.exec(content);
    if (!webhookMatch) {
      const hasStripeKey = /STRIPE/.test(content);
      if (hasStripeKey) {
        results.push({ file: relFile, type: 'webhook', pattern: 'STRIPE_WEBHOOK_SECRET missing', issues: ['STRIPE_WEBHOOK_SECRET not configured — webhook endpoint must validate Stripe-Signature header to prevent replay attacks and forged events; add Webhook::constructEvent() validation'] });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('Stripe') && !content.includes('stripe') && !content.includes('PaymentIntent') && !content.includes('PaymentMethod')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasWebhookEndpoint = content.includes('constructEvent(') || content.includes('Webhook::') || content.includes('stripe_webhook');
            if (hasWebhookEndpoint) {
              const hasSignatureCheck = content.includes('Stripe-Signature') || content.includes('constructEvent') || content.includes('signature');
              if (!hasSignatureCheck) {
                issues.push(`Stripe webhook handler "${relFile}" without signature verification — add Stripe\\Webhook::constructEvent($payload, $sig, $secret) to prevent forged webhook events`);
              }
              const hasIdempotency = content.includes('idempotency_key') || content.includes('metadata') || content.includes('processed');
              if (!hasIdempotency) {
                issues.push(`Stripe webhook handler "${relFile}" without idempotency check — Stripe can deliver the same event multiple times; check event ID against processed events to prevent double-fulfillment`);
              }
            }

            const hasCardData = content.includes('card_number') || content.includes('cvv') || content.includes('cvc') || content.includes('expiry');
            if (hasCardData) {
              issues.push(`Card data fields in "${relFile}" — never handle raw card data on the server; use Stripe.js Elements on the frontend to tokenize card data before it reaches your server (PCI DSS requirement)`);
            }

            const hasChargeCreate = content.includes('Charge::create') || content.includes("'source' =>") || content.includes("'source'=>");
            if (hasChargeCreate) {
              issues.push(`Deprecated Charges API in "${relFile}" — Stripe recommends PaymentIntents API for new integrations; Charges API does not support 3D Secure and SCA requirements`);
            }

            const hasErrorHandling = content.includes('catch') && (content.includes('CardException') || content.includes('ApiErrorException') || content.includes('StripeException'));
            const hasStripeCall = content.includes('PaymentIntent::create') || content.includes('Customer::create') || content.includes('Subscription::create');
            if (hasStripeCall && !hasErrorHandling) {
              issues.push(`Stripe API call in "${relFile}" without exception handling — API calls can fail with network errors, rate limits, and card declines; catch \\Stripe\\Exception\\CardException and \\Stripe\\Exception\\ApiErrorException`);
            }

            if (issues.length > 0) {
              results.push({ file: relFile, type: 'webhook', pattern: 'Stripe integration', issues });
            }
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listStripeIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildStripeIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Stripe integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Stripe Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getStripeIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildStripeIntegrationInfos(appPath);
    let text = `Stripe Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Webhooks:  ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `Key issues: ${infos.filter((i) => i.type === 'key').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getStripeIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_stripe_integration', description: 'Analyze Stripe payment integration security; warns on live key in .env, missing STRIPE_WEBHOOK_SECRET, webhook without signature verification, no idempotency for double-delivery, raw card data on server (PCI), deprecated Charges API, missing exception handling', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_stripe_integration_stats', description: 'Statistics for Stripe integration: webhook/key issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
