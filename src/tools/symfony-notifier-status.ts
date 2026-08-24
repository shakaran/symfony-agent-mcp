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

interface NotifierStatusInfo {
  source: string;
  type: 'transport' | 'php' | 'event';
  detail: string;
  issue: string | null;
}

const RECEIPT_CAPABLE_TRANSPORTS = ['vonage', 'twilio', 'sinch', 'mailer'];

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret)=[^&\s]*/gi, '$1$2=***');
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

function buildNotifierStatusInfos(appPath: string): NotifierStatusInfo[] {
  const results: NotifierStatusInfo[] = [];

  const notifierYaml = path.join(appPath, 'config', 'packages', 'notifier.yaml');
  if (fs.existsSync(notifierYaml)) {
    let content = '';
    try { content = fs.readFileSync(notifierYaml, 'utf-8'); } catch { /* skip */ }

    const dsnRe = /^\s+\w[\w.]*\s*:\s*(.{4,300})$/gm;
    let dm: RegExpExecArray | null;
    while ((dm = dsnRe.exec(content)) !== null) {
      const raw = dm[1].trim();
      if (!raw.includes('://')) continue;
      const masked = raw.startsWith('%env(') ? raw : maskDsn(raw);
      const transportScheme = raw.split('://')[0].replace('%env(', '').toLowerCase();
      const supportsReceipt = RECEIPT_CAPABLE_TRANSPORTS.some((t) => transportScheme.includes(t));
      let issue: string | null = null;
      if (!raw.startsWith('%env(') && !raw.startsWith('%') && raw.includes('://')) {
        issue = `Transport DSN appears hardcoded in notifier.yaml — use %env(NOTIFIER_DSN)% to keep credentials out of config files`;
      }
      results.push({
        source: 'config/packages/notifier.yaml',
        type: 'transport',
        detail: `${masked}${supportsReceipt ? ' [receipt-capable]' : ''}`,
        issue,
      });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  let hasFailedEventSubscriber = false;
  let hasSentMessageHandler = false;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    if (content.includes('SentMessageInterface') || content.includes('MessageEvent')) {
      hasSentMessageHandler = true;
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Implements SentMessageInterface or handles MessageEvent — delivery receipt tracking present',
        issue: null,
      });
    }

    if (content.includes('FailedMessageEvent')) {
      hasFailedEventSubscriber = true;
      const implementsSubscriber = content.includes('EventSubscriberInterface');
      results.push({
        source: relFile,
        type: 'event',
        detail: 'Handles FailedMessageEvent' + (implementsSubscriber ? ' via EventSubscriberInterface' : ''),
        issue: null,
      });
    }

    const sendRe = /->send\([^)]{0,200}\)/g;
    let sm: RegExpExecArray | null;
    while ((sm = sendRe.exec(content)) !== null) {
      const lineStart = content.lastIndexOf('\n', sm.index) + 1;
      const lineEnd = content.indexOf('\n', sm.index + sm[0].length);
      const surroundingBlock = content.substring(Math.max(0, lineStart - 200), lineEnd > 0 ? lineEnd + 50 : lineStart + 300);
      const hasTryCatch = surroundingBlock.includes('try {') || surroundingBlock.includes('try{');
      const hasTransportException = surroundingBlock.includes('TransportExceptionInterface') || surroundingBlock.includes('TransportException');
      if (!hasTryCatch || !hasTransportException) {
        results.push({
          source: relFile,
          type: 'php',
          detail: `->send() call near line`,
          issue: `->send() call in "${relFile}" without try/catch on TransportExceptionInterface — uncaught transport errors will bubble as 500 errors; wrap in try/catch`,
        });
      }
    }

    if (content.includes('use Symfony\\Component\\Notifier\\') && content.includes('getChannels(')) {
      const hasChain = content.includes('chained') || content.includes('fallback') || content.includes('channels') && content.includes('[');
      if (!hasChain) {
        results.push({
          source: relFile,
          type: 'php',
          detail: 'Notification with getChannels()',
          issue: `Notification in "${relFile}" defines channels but no fallback chain detected — configure chained_texter/chained_mailer for reliability`,
        });
      }
    }
  }

  if (!hasFailedEventSubscriber) {
    results.push({
      source: 'src/',
      type: 'event',
      detail: 'No FailedMessageEvent subscriber found',
      issue: 'No FailedMessageEvent subscriber found in src/ — failed notifications (e.g. SMS delivery failure) will be silently ignored; add an EventSubscriber for FailedMessageEvent',
    });
  }

  if (!hasSentMessageHandler) {
    results.push({
      source: 'src/',
      type: 'event',
      detail: 'No SentMessage/MessageEvent handler found',
      issue: null,
    });
  }

  return results;
}

export function listSymfonyNotifierStatus(appPath: string): McpToolResult {
  try {
    const infos = buildNotifierStatusInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony Notifier configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Symfony Notifier Status Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.detail}  (${info.source})\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierStatusStats(appPath: string): McpToolResult {
  try {
    const infos = buildNotifierStatusInfos(appPath);
    let text = `Symfony Notifier Status Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `PHP classes: ${infos.filter((i) => i.type === 'php').length}\n`;
    text += `Events:      ${infos.filter((i) => i.type === 'event').length}\n`;
    text += `Issues:      ${infos.filter((i) => i.issue !== null).length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierStatusTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_notifier_status',
      description: 'Scan Symfony Notifier config and PHP code for delivery status patterns; detects hardcoded DSN credentials, missing FailedMessageEvent subscriber, ->send() without TransportExceptionInterface catch, receipt-capable transports, missing notification fallback chain',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_notifier_status_stats',
      description: 'Statistics for Symfony Notifier: transport count, PHP handler count, event count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
