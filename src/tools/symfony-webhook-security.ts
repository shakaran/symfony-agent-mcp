import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WebhookSecurityInfo {
  file: string;
  type: 'hmac' | 'signature' | 'timing' | 'replay' | 'ip-filter' | 'event-type';
  pattern: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildWebhookSecurityInfos(appPath: string): WebhookSecurityInfo[] {
  const results: WebhookSecurityInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, srcDir);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    const isWebhookHandler =
      content.includes('webhook') || content.includes('Webhook') ||
      content.includes('#[AsWebhook') || content.includes('WebhookController') ||
      (content.includes('X-Hub-Signature') || content.includes('X-Stripe-Signature') || content.includes('X-Shopify-Hmac')) ||
      (content.includes('AbstractRequestParser') || content.includes('WebhookParserInterface'));

    if (!isWebhookHandler) continue;

    const hasHmacVerify = content.includes('hash_hmac') || content.includes('HMAC') ||
      content.includes('X-Hub-Signature') || content.includes('X-Stripe-Signature') ||
      content.includes('X-Shopify-Hmac') || content.includes('->verify(') || content.includes('->isValid(');

    const usesTimingSafe = content.includes('hash_equals') || content.includes('HashHelper') || content.includes('timing_safe');
    const usesDirectCompare = content.includes('=== $sig') || content.includes('=== $signature') || content.includes('== $signature');

    if (!hasHmacVerify) {
      results.push({
        file: relFile, type: 'hmac', pattern: 'webhook handler without signature verification',
        issues: ['Webhook handler found without HMAC signature verification — any HTTP client can forge webhook events; use hash_hmac() to verify the shared secret'],
      });
    }

    if (hasHmacVerify && !usesTimingSafe && usesDirectCompare) {
      results.push({
        file: relFile, type: 'timing', pattern: 'direct string compare on HMAC',
        issues: ['HMAC compared with === instead of hash_equals() — timing-side-channel attack can brute-force the signature byte by byte; always use hash_equals() for HMAC comparison'],
      });
    }

    const hasTimestampCheck = content.includes('timestamp') || content.includes('Timestamp') ||
      content.includes('X-Timestamp') || content.includes('created_at');
    const hasReplayProtection = hasTimestampCheck && (content.includes('time()') || content.includes('new \\DateTimeImmutable'));

    if (hasHmacVerify && !hasReplayProtection) {
      results.push({
        file: relFile, type: 'replay', pattern: 'HMAC without replay protection',
        issues: ['Webhook signature verified but no timestamp/nonce check — a captured valid request can be replayed indefinitely; reject requests older than 5 minutes'],
      });
    }

    const hasRawBody = content.includes('getContent()') || content.includes('getRawContent()') || content.includes('file_get_contents("php://input")');
    if (hasHmacVerify && !hasRawBody) {
      results.push({
        file: relFile, type: 'signature', pattern: 'HMAC may use parsed body not raw bytes',
        issues: ['HMAC verification found but raw request body not read explicitly — signing must happen over the raw bytes; using $request->request->all() or parsed data gives a different hash'],
      });
    }

    const hasEventTypeValidation = content.includes('getType()') || content.includes("'type'") || content.includes('"type"') ||
      content.includes('switch (') || content.includes('match (');
    if (hasHmacVerify && !hasEventTypeValidation) {
      results.push({
        file: relFile, type: 'event-type', pattern: 'webhook without event type validation',
        issues: ['Webhook handler accepts any event type without validation — subscribe to only expected event types and reject unknown types explicitly'],
      });
    }
  }

  const configDir = path.join(appPath, 'config', 'packages');
  const webhookYaml = path.join(configDir, 'webhook.yaml');
  if (fs.existsSync(webhookYaml)) {
    let content = '';
    try { content = fs.readFileSync(webhookYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('secret:') && (content.includes('null') || content.includes("''"))) {
      results.push({ file: 'config/packages/webhook.yaml', type: 'hmac', pattern: 'webhook secret null or empty', issues: ['Webhook secret is null or empty in webhook.yaml — without a secret, all incoming webhooks are accepted as legitimate'] });
    }
  }

  return results;
}

export function listSymfonyWebhookSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildWebhookSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No webhook handler patterns found (no #[AsWebhook], WebhookController, or HMAC signature headers detected).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Webhook Security Analysis\n${'='.repeat(55)}\n\nHandlers: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWebhookSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildWebhookSecurityInfos(appPath);
    let text = `Webhook Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `HMAC handlers: ${infos.filter((i) => i.type === 'hmac').length}\n`;
    text += `Timing issues: ${infos.filter((i) => i.type === 'timing').length}\n`;
    text += `Replay risks:  ${infos.filter((i) => i.type === 'replay').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyWebhookSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_webhook_security', description: 'Audit Symfony webhook handlers for security: missing HMAC verification, === comparison (timing attack), no replay protection, raw body not read for signing, no event type validation, null webhook secret', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_webhook_security_stats', description: 'Statistics for webhook security: hmac/timing/replay issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
