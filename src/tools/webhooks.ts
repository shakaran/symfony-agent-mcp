// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Webhook Inspector (Symfony 6.3+)
 *
 * Reads config/packages/webhook.yaml:
 *   - Configured webhook endpoints (name, parser service, request matcher)
 *   - Routing via webhook_route
 *
 * Scans src/ for:
 *   - Classes implementing RequestParserInterface (custom parsers)
 *   - #[AsWebhookConsumer] attributes (consuming parsed webhook events)
 *   - Common third-party webhook patterns (GitHub, Stripe, Twilio, Mailgun)
 *
 * Pure static analysis.
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

interface WebhookEndpoint {
  name: string;
  parser?: string;
  secret?: boolean;
  requestMatcher?: string;
  provider?: string;
}

interface WebhookConsumer {
  class: string;
  file: string;
  event?: string;
}

interface WebhookParser {
  class: string;
  file: string;
  detectedProvider?: string;
}

// ─── Provider detection ─────────────────────────────────────────────────────

const KNOWN_PROVIDERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /github/i,   name: 'GitHub' },
  { pattern: /stripe/i,   name: 'Stripe' },
  { pattern: /twilio/i,   name: 'Twilio' },
  { pattern: /mailgun/i,  name: 'Mailgun' },
  { pattern: /sendgrid/i, name: 'SendGrid' },
  { pattern: /paypal/i,   name: 'PayPal' },
  { pattern: /shopify/i,  name: 'Shopify' },
  { pattern: /gitlab/i,   name: 'GitLab' },
  { pattern: /bitbucket/i,name: 'Bitbucket' },
  { pattern: /hubspot/i,  name: 'HubSpot' },
];

function detectProvider(text: string): string | undefined {
  for (const { pattern, name } of KNOWN_PROVIDERS) {
    if (pattern.test(text)) return name;
  }
  return undefined;
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadWebhookConfig(appPath: string): WebhookEndpoint[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'webhook.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const fw = raw['framework'] as Record<string, unknown> | undefined;
    const webhookSection = (fw?.['webhook'] ?? raw['webhook']) as Record<string, unknown> | undefined;
    if (!webhookSection) continue;

    const routing = webhookSection['routing'] as Record<string, unknown> | undefined;
    if (!routing) continue;

    const endpoints: WebhookEndpoint[] = [];
    for (const [name, def] of Object.entries(routing)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      endpoints.push({
        name,
        parser: d['parser'] ? String(d['parser']) : undefined,
        secret: Boolean(d['secret']),
        requestMatcher: d['request_matcher'] ? String(d['request_matcher']) : undefined,
        provider: detectProvider(name + ' ' + String(d['parser'] ?? '')),
      });
    }

    return endpoints;
  }

  return [];
}

// ─── PHP scanning ───────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanWebhookConsumers(appPath: string): WebhookConsumer[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const consumers: WebhookConsumer[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (!content.includes('AsWebhookConsumer') && !content.includes('WebhookConsumerInterface')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const attrM = /#\[AsWebhookConsumer\s*\(([^)]*)\)\]/.exec(content);
    const eventM = attrM ? /type\s*:\s*['"]([^'"]+)['"]/.exec(attrM[1]) : null;

    consumers.push({
      class: classM[1],
      file: path.basename(file),
      event: eventM?.[1],
    });
  }

  return consumers.sort((a, b) => a.class.localeCompare(b.class));
}

function scanWebhookParsers(appPath: string): WebhookParser[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const parsers: WebhookParser[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (!content.includes('RequestParserInterface') || !content.includes('implements')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    parsers.push({
      class: classM[1],
      file: path.basename(file),
      detectedProvider: detectProvider(classM[1] + ' ' + content.slice(0, 500)),
    });
  }

  return parsers.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listWebhooks(appPath: string): McpToolResult {
  try {
    const endpoints = loadWebhookConfig(appPath);
    const consumers = scanWebhookConsumers(appPath);
    const parsers = scanWebhookParsers(appPath);

    if (endpoints.length === 0 && consumers.length === 0 && parsers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Webhook configuration found (requires Symfony 6.3+).\n\nInstall:\n  composer require symfony/webhook\n\nConfigure config/packages/webhook.yaml:\n  framework:\n    webhook:\n      routing:\n        github:\n          parser: App\\Webhook\\GithubRequestParser\n          secret: \'%env(GITHUB_WEBHOOK_SECRET)%\'',
        }],
      };
    }

    let text = `Symfony Webhook Inspector\n${'='.repeat(55)}\n`;

    if (endpoints.length > 0) {
      text += `\nConfigured endpoints (${endpoints.length}):\n`;
      for (const e of endpoints) {
        const provider = e.provider ? `  [${e.provider}]` : '';
        const secret = e.secret ? '  [secret configured]' : '  [no secret!]';
        text += `  ${e.name}${provider}${secret}\n`;
        if (e.parser) text += `    parser: ${e.parser}\n`;
        if (e.requestMatcher) text += `    matcher: ${e.requestMatcher}\n`;
      }
    }

    if (parsers.length > 0) {
      text += `\nCustom request parsers (${parsers.length}):\n`;
      for (const p of parsers) {
        const prov = p.detectedProvider ? `  [${p.detectedProvider}]` : '';
        text += `  ${p.class}  (${p.file})${prov}\n`;
      }
    }

    if (consumers.length > 0) {
      text += `\nWebhook consumers (${consumers.length}):\n`;
      for (const c of consumers) {
        const evt = c.event ? `  event: ${c.event}` : '';
        text += `  ${c.class}  (${c.file})${evt}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWebhookStats(appPath: string): McpToolResult {
  try {
    const endpoints = loadWebhookConfig(appPath);
    const consumers = scanWebhookConsumers(appPath);
    const parsers = scanWebhookParsers(appPath);

    let text = `Webhook Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured endpoints: ${endpoints.length}\n`;
    text += `Custom parsers:       ${parsers.length}\n`;
    text += `Webhook consumers:    ${consumers.length}\n`;
    text += `Without secret:       ${endpoints.filter((e) => !e.secret).length}\n`;

    const providers = [...new Set([
      ...endpoints.map((e) => e.provider),
      ...parsers.map((p) => p.detectedProvider),
    ].filter(Boolean))];
    if (providers.length > 0) text += `Detected providers:   ${providers.join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getWebhookTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_webhooks',
      description: 'Show Symfony Webhook (6.3+) configured endpoints, custom RequestParser classes, AsWebhookConsumer classes, detected providers (GitHub/Stripe/etc.)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_webhook_stats',
      description: 'Show webhook statistics: endpoint count, parser/consumer count, endpoints without secret, detected external providers',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
