// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface RemoteEventInfo {
  file: string;
  type: 'consumer' | 'parser' | 'payload';
  name: string;
  provider: string;
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

function detectProvider(content: string, name: string): string {
  if (content.includes('Stripe') || name.includes('Stripe')) return 'stripe';
  if (content.includes('GitHub') || name.includes('GitHub') || name.includes('Github')) return 'github';
  if (content.includes('Shopify') || name.includes('Shopify')) return 'shopify';
  if (content.includes('Twilio') || name.includes('Twilio')) return 'twilio';
  return 'custom';
}

function buildRemoteEventInfos(appPath: string): RemoteEventInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: RemoteEventInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const name = classMatch ? classMatch[1] : path.basename(file, '.php');
    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const isConsumer = content.includes('#[AsRemoteEventConsumer]') ||
      content.includes('RemoteEventConsumerInterface') ||
      (content.includes('consume(RemoteEvent') || content.includes('consume(\\Symfony\\Component\\RemoteEvent\\RemoteEvent'));

    const isParser = content.includes('RequestParserInterface') &&
      content.includes('parse(');

    const isPayload = content.includes('AbstractRemoteEvent') ||
      (content.includes('extends RemoteEvent') && !isConsumer);

    if (isConsumer) {
      const provider = detectProvider(content, name);
      if (!content.includes('getName()') && !content.includes('getType()')) {
        issues.push(`Consumer "${name}" may not check event type/name — single consume() handles all event types without discrimination`);
      }
      results.push({ file: relFile, type: 'consumer', name, provider, issues });
    }

    if (isParser) {
      const provider = detectProvider(content, name);
      if (!content.includes('Content-Type') && !content.includes('getHeaderLine(') && !content.includes('headers->get(')) {
        issues.push(`Request parser "${name}" does not validate Content-Type header — any content type accepted`);
      }
      const hasSecretCheck = content.includes('secret') || content.includes('signature') || content.includes('hmac');
      if (!hasSecretCheck) {
        issues.push(`Request parser "${name}" has no HMAC/signature validation — webhook authenticity not verified`);
      }
      results.push({ file: relFile, type: 'parser', name, provider, issues });
    }

    if (isPayload && !isConsumer) {
      const provider = detectProvider(content, name);
      const hasPublicNonReadonly = /public\s+(?!readonly)(?!function)(?!static)(?!const)\w{1,60}\s+\$/.test(content);
      if (hasPublicNonReadonly) {
        issues.push(`RemoteEvent payload "${name}" has mutable public properties — event payloads should be immutable`);
      }
      results.push({ file: relFile, type: 'payload', name, provider, issues });
    }
  }

  return results;
}

export function listSymfonyRemoteEvents(appPath: string): McpToolResult {
  try {
    const infos = buildRemoteEventInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony RemoteEvent patterns found (no #[AsRemoteEventConsumer], RequestParserInterface, or RemoteEvent payload classes).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony RemoteEvent Analysis\n${'='.repeat(50)}\n\nClasses: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  provider: ${info.provider}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRemoteEventStats(appPath: string): McpToolResult {
  try {
    const infos = buildRemoteEventInfos(appPath);
    let text = `RemoteEvent Statistics\n${'='.repeat(40)}\n\n`;
    text += `Consumers:  ${infos.filter((i) => i.type === 'consumer').length}\n`;
    text += `Parsers:    ${infos.filter((i) => i.type === 'parser').length}\n`;
    text += `Payloads:   ${infos.filter((i) => i.type === 'payload').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRemoteEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_remote_events', description: 'Detect Symfony 6.3+ RemoteEvent consumers and parsers; warns on missing event type check, no HMAC validation in parser, mutable payload properties', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_remote_event_stats', description: 'Statistics for RemoteEvent: consumer/parser/payload count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
