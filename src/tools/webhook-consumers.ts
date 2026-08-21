import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface WebhookConsumerInfo {
  file: string;
  class: string;
  isConsumer: boolean;
  hasSignatureVerification: boolean;
  hasHmacVerification: boolean;
  hasTimingSafeCompare: boolean;
  hasReplayProtection: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseWebhookConsumer(filePath: string, appPath: string): WebhookConsumerInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  const isConsumer = content.includes('AbstractRequestParser') || content.includes('RequestParserInterface') || (content.includes('webhook') && content.includes('Request') && (content.includes('getContent') || content.includes('getPayload')));
  const hasWebhookAnnotation = content.includes('#[AsWebhookConsumer') || content.includes('AsMessageHandler') && content.includes('webhook');
  if (!isConsumer && !hasWebhookAnnotation) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const hasSignatureVerification = content.includes('signature') || content.includes('X-Signature') || content.includes('X-Hub-Signature') || content.includes('checkSignature');
  const hasHmacVerification = content.includes('hash_hmac') || content.includes('HMAC') || content.includes('sha256');
  const hasTimingSafeCompare = content.includes('hash_equals') || content.includes('timingSafeCompare') || content.includes('timing_safe');
  const hasReplayProtection = content.includes('timestamp') || content.includes('nonce') || content.includes('X-Timestamp') || content.includes('replayProtection');
  const issues: string[] = [];
  if (!hasSignatureVerification) issues.push('No signature verification detected — webhook payloads are not authenticated');
  if (hasSignatureVerification && !hasHmacVerification) issues.push('Signature check without HMAC/SHA — ensure using hash_hmac() for cryptographically secure verification');
  if (hasHmacVerification && !hasTimingSafeCompare) issues.push('HMAC verification without hash_equals() — timing attack vulnerability; use hash_equals() for comparison');
  if (!hasReplayProtection) issues.push('No replay protection (timestamp/nonce check) — old webhook requests may be replayed');
  return { file: path.relative(appPath, filePath), class: classM[1], isConsumer: true, hasSignatureVerification, hasHmacVerification, hasTimingSafeCompare, hasReplayProtection, issues };
}

export function listWebhookConsumers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const consumers: WebhookConsumerInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const c = parseWebhookConsumer(f, appPath);
      if (c) consumers.push(c);
    }
    if (consumers.length === 0) return { content: [{ type: 'text', text: 'No webhook consumer patterns found.' }] };
    const totalIssues = consumers.reduce((s, c) => s + c.issues.length, 0);
    let text = `Webhook Consumers\n${'='.repeat(55)}\n\nConsumers: ${consumers.length}  Issues: ${totalIssues}\n`;
    for (const c of consumers.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        c.hasSignatureVerification ? '✓sig' : '✗sig',
        c.hasHmacVerification ? '✓HMAC' : '',
        c.hasTimingSafeCompare ? '✓hash_equals' : '',
        c.hasReplayProtection ? '✓replay' : '✗replay',
      ].filter(Boolean).join('  ');
      text += `\n  ${c.class}  ${flags}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebhookConsumerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const consumers: WebhookConsumerInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const c = parseWebhookConsumer(f, appPath);
        if (c) consumers.push(c);
      }
    }
    let text = `Webhook Consumer Statistics\n${'='.repeat(40)}\n\n`;
    text += `Consumers: ${consumers.length}\n  Signature verification: ${consumers.filter(c => c.hasSignatureVerification).length}\n  HMAC verification: ${consumers.filter(c => c.hasHmacVerification).length}\n  hash_equals (timing-safe): ${consumers.filter(c => c.hasTimingSafeCompare).length}\n  Replay protection: ${consumers.filter(c => c.hasReplayProtection).length}\nIssues: ${consumers.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebhookConsumerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_webhook_consumers', description: 'Detect webhook consumer patterns: HMAC/SHA signature verification, hash_equals() timing-safe comparison, replay protection (timestamp/nonce), missing signature/replay-protection security warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_webhook_consumer_stats', description: 'Webhook consumer statistics: consumer count, signature/HMAC/hash_equals/replay coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
