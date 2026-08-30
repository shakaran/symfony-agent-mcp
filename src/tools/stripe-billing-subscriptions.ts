// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface StripeBillingSubscriptionsInfo {
  source: string;
  type: 'env' | 'php' | 'webhook';
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
        try {
          const content = fs.readFileSync(full, 'utf-8');
          callback(full, content);
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

const BILLING_WEBHOOK_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.trial_will_end',
  'invoice.upcoming',
];

function buildStripeBillingSubscriptionsInfos(appPath: string): StripeBillingSubscriptionsInfo[] {
  const results: StripeBillingSubscriptionsInfo[] = [];

  // composer.json — stripe/stripe-php
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  let hasStripe = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    if (req['stripe/stripe-php']) {
      hasStripe = true;
      results.push({ source: 'composer.json', type: 'php', detail: `stripe/stripe-php: ${req['stripe/stripe-php']}`, issue: null });
    }
  } catch { /* skip */ }

  if (!hasStripe) return results;

  // .env* files — Stripe keys
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];

  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const stripeVars: Array<[string, boolean]> = [
      ['STRIPE_SECRET_KEY', true],
      ['STRIPE_PUBLISHABLE_KEY', false],
      ['STRIPE_WEBHOOK_SECRET', true],
      ['STRIPE_PRICE_ID', false],
      ['STRIPE_PRODUCT_ID', false],
    ];

    for (const [varName, isSensitive] of stripeVars) {
      const regex = new RegExp(`${varName}\\s*=\\s*([^\\n]{1,200})`);
      const m = regex.exec(content);
      if (m) {
        const rawValue = m[1].trim();
        let maskedValue = rawValue;
        if (isSensitive) {
          maskedValue = maskSecrets(`${varName}=${rawValue}`).replace(`${varName}=`, '');
        }

        let issue: string | null = null;
        if (varName === 'STRIPE_SECRET_KEY' && rawValue.startsWith('sk_live_')) {
          issue = `Stripe live secret key in "${fname}" — live keys must never be committed to version control; inject sk_live_ keys via CI/CD secrets only`;
        }

        results.push({ source: fname, type: 'env', detail: `${varName}=${maskedValue}`, issue });
      }
    }

    // Check for missing STRIPE_WEBHOOK_SECRET
    const hasStripeConfig = content.includes('STRIPE_SECRET_KEY') || content.includes('STRIPE_PUBLISHABLE_KEY');
    if (hasStripeConfig && !content.includes('STRIPE_WEBHOOK_SECRET')) {
      results.push({
        source: fname,
        type: 'env',
        detail: 'STRIPE_WEBHOOK_SECRET missing',
        issue: `STRIPE_WEBHOOK_SECRET not configured in "${fname}" — without webhook secret validation, anyone can send forged webhook events to your endpoint; add Stripe::constructEvent() with the webhook secret`,
      });
    }
  }

  // src/**/*.php — billing/subscription patterns
  const srcDir = path.join(appPath, 'src');
  const detectedWebhookEvents: Set<string> = new Set();

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasStripeCode = content.includes('\\Stripe\\') || content.includes('Stripe::') || content.includes("use Stripe\\");
    if (!hasStripeCode) return;

    const relFile = path.relative(appPath, filePath);

    // Subscription API usage
    if (content.includes('\\Stripe\\Subscription::create(') || content.includes('Subscription::create(')) {
      results.push({ source: relFile, type: 'php', detail: 'Stripe\\Subscription::create() used', issue: null });
    }

    // Invoice API
    if (content.includes('\\Stripe\\Invoice::') || content.includes('Invoice::')) {
      results.push({ source: relFile, type: 'php', detail: 'Stripe\\Invoice API used', issue: null });
    }

    // Plan API (deprecated)
    if (content.includes('\\Stripe\\Plan::') || content.includes('Plan::create(') || content.includes("'plan' =>")) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Stripe\\Plan API used (deprecated)',
        issue: `Stripe Plan API used in "${relFile}" — Plan API is deprecated; migrate to the Prices API (\\Stripe\\Price::create()) which supports more flexible billing models and is required for new Stripe integrations`,
      });
    }

    // Price API (correct)
    if (content.includes('\\Stripe\\Price::') || content.includes('Price::create(')) {
      results.push({ source: relFile, type: 'php', detail: 'Stripe\\Price API used', issue: null });
    }

    // Customer API
    if (content.includes('\\Stripe\\Customer::') || content.includes('Customer::create(')) {
      results.push({ source: relFile, type: 'php', detail: 'Stripe\\Customer API used', issue: null });
    }

    // BillingPortal
    if (content.includes('\\Stripe\\BillingPortal::') || content.includes('BillingPortal\\Session')) {
      results.push({ source: relFile, type: 'php', detail: 'Stripe BillingPortal used', issue: null });
    }

    // Webhook event handling
    for (const event of BILLING_WEBHOOK_EVENTS) {
      if (content.includes(`'${event}'`) || content.includes(`"${event}"`)) {
        detectedWebhookEvents.add(event);
        results.push({ source: relFile, type: 'webhook', detail: `Handles: ${event}`, issue: null });
      }
    }

    // Webhook signature validation
    const isWebhookHandler = content.includes('constructEvent(') || content.includes('webhook') || detectedWebhookEvents.size > 0;
    if (isWebhookHandler) {
      const hasSignatureCheck = content.includes('constructEvent(') || content.includes('Stripe-Signature') || content.includes('webhook_secret');
      if (!hasSignatureCheck && content.includes("'type'") || content.includes('"type"')) {
        results.push({
          source: relFile,
          type: 'webhook',
          detail: 'Webhook handler without signature validation',
          issue: `Webhook event handling in "${relFile}" without \\Stripe\\Webhook::constructEvent() — validate Stripe-Signature header to prevent forged events; replay attacks can trigger fraudulent subscription state changes`,
        });
      }
    }

    // Hardcoded secret key
    const hasHardcodedSecret = /Stripe::setApiKey\s*\(\s*['"]sk_/.test(content);
    if (hasHardcodedSecret) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Stripe API key hardcoded',
        issue: `Stripe::setApiKey() called with hardcoded sk_ key in "${relFile}" — never hardcode API keys; use getenv('STRIPE_SECRET_KEY') or Symfony parameter %env(STRIPE_SECRET_KEY)%`,
      });
    }
  });

  // Check for missing critical webhook event handlers
  // hasStripe is guaranteed above: the scan returns early without it.
  const criticalEvents: Array<[string, string]> = [
    ['invoice.payment_failed', 'invoice.payment_failed not handled — payment failures go unnoticed causing silent subscription churn; handle this event to notify customers and trigger dunning logic'],
    ['customer.subscription.deleted', 'customer.subscription.deleted not handled — subscription cancellation not detected; handle this event to revoke access and update user entitlements immediately'],
  ];

  for (const [event, message] of criticalEvents) {
    if (!detectedWebhookEvents.has(event)) {
      results.push({ source: 'src/', type: 'webhook', detail: `Missing webhook: ${event}`, issue: message });
    }
  }

  return results;
}

export function listStripeBillingSubscriptions(appPath: string): McpToolResult {
  try {
    const infos = buildStripeBillingSubscriptionsInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Stripe billing/subscription integration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Stripe Billing & Subscriptions Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
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
    return { content: [{ type: 'text', text: `Error scanning Stripe billing config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getStripeBillingSubscriptionsStats(appPath: string): McpToolResult {
  try {
    const infos = buildStripeBillingSubscriptionsInfos(appPath);
    const byType = { env: 0, php: 0, webhook: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const webhookEvents = infos.filter((i) => i.type === 'webhook' && !i.issue).map((i) => i.detail.replace('Handles: ', ''));
    const text = [
      `Stripe Billing Subscriptions Stats`,
      `===================================`,
      `Total entries   : ${infos.length}`,
      `  Env vars      : ${byType.env}`,
      `  PHP code      : ${byType.php}`,
      `  Webhook events: ${byType.webhook}`,
      `Issues          : ${issues.length}`,
      webhookEvents.length > 0 ? `Webhook events  : ${[...new Set(webhookEvents)].join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getStripeBillingSubscriptionsTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_stripe_billing_subscriptions',
      description: 'Scan for Stripe billing/subscription integration (distinct from generic payments): composer dependency, env keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET), Subscription/Invoice/Plan/Price/BillingPortal API usage, and webhook event handlers. Flags deprecated Plan API, missing webhook signature validation, missing invoice.payment_failed and subscription.deleted handlers.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_stripe_billing_subscriptions_stats',
      description: 'Return summary statistics for Stripe billing/subscription integration: entry counts, handled webhook events, and issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
