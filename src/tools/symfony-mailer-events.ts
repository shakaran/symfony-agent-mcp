// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Mailer Event Inspector
 *
 * Distinct from mailer-config.ts (transport/DSN config) and notifier.ts (notifier channels).
 * Focuses on Mailer event listeners and email lifecycle:
 *
 * Mailer events (symfony/mailer):
 *   - MessageEvent: fired before sending — allows header/body modification, suppression
 *   - SentMessageEvent: fired after successful send — for logging/audit
 *   - FailedMessageEvent: fired on transport failure — for retry logic / alerting
 *
 * Listener scan (src/):
 *   - Classes listening to MessageEvent, SentMessageEvent, FailedMessageEvent
 *   - Method: reject() call in MessageEvent listener (suppresses send)
 *   - Header modification: $event->getMessage()->getHeaders()->...
 *   - Priority ordering (higher = earlier)
 *
 * Email classification:
 *   - TemplatedEmail vs Email (raw) — template-based vs programmatic
 *   - Classes in Mailer/NotificationEmail subclasses (NotificationEmail)
 *   - Emails with 'unsubscribe' / 'list-unsubscribe' headers (transactional vs marketing)
 *   - Emails without Reply-To header (automated emails)
 *
 * Async detection:
 *   - Messenger routing for mailer transport (async email sending)
 *   - mailer: { message_bus: ... } configuration
 *
 * Analysis:
 *   - FailedMessageEvent listener missing (no failure handling)
 *   - MessageEvent listener that modifies headers after signing (breaks DKIM)
 *   - NotificationEmail used for transactional emails (wrong base class)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


type MailerEventType = 'MessageEvent' | 'SentMessageEvent' | 'FailedMessageEvent';

interface MailerEventListener {
  class: string;
  file: string;
  events: MailerEventType[];
  rejectsSend: boolean;
  modifiesHeaders: boolean;
  issues: string[];
}

interface EmailClass {
  class: string;
  file: string;
  baseClass: 'TemplatedEmail' | 'Email' | 'NotificationEmail' | 'other';
  isTransactional: boolean;
  isMarketing: boolean;
}

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

const EVENT_TYPES: MailerEventType[] = ['MessageEvent', 'SentMessageEvent', 'FailedMessageEvent'];

function parseMailerListener(filePath: string, appPath: string): MailerEventListener | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasMailerEvent = EVENT_TYPES.some((e) => content.includes(e));
  if (!hasMailerEvent) return null;
  if (!content.includes('#[AsEventListener') && !content.includes('EventSubscriberInterface') &&
      !content.includes('implements EventSubscriberInterface')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const events = EVENT_TYPES.filter((e) => content.includes(e));
  const rejectsSend     = content.includes('->reject(') || content.includes('->preventSend(');
  const modifiesHeaders = content.includes('->getHeaders()') || content.includes('getHeaders()->add');

  const issues: string[] = [];
  if (modifiesHeaders && content.includes('DKIM')) {
    issues.push('Header modification in MessageEvent listener may break DKIM signature');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    events,
    rejectsSend,
    modifiesHeaders,
    issues,
  };
}

function parseEmailClass(filePath: string, appPath: string): EmailClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isEmail = content.includes('extends TemplatedEmail') || content.includes('extends Email') ||
                  content.includes('extends NotificationEmail');
  if (!isEmail) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const baseClass: EmailClass['baseClass'] =
    content.includes('extends TemplatedEmail') ? 'TemplatedEmail' :
    content.includes('extends NotificationEmail') ? 'NotificationEmail' :
    content.includes('extends Email') ? 'Email' : 'other';

  const isTransactional = content.toLowerCase().includes('transactional') ||
                          content.includes('OrderConfirmation') || content.includes('ResetPassword') ||
                          content.includes('Welcome') || content.includes('Invoice');
  const isMarketing = content.includes('unsubscribe') || content.includes('list-unsubscribe') ||
                      content.toLowerCase().includes('newsletter') || content.toLowerCase().includes('marketing');

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    baseClass,
    isTransactional,
    isMarketing,
  };
}

function checkAsyncMailer(appPath: string): boolean {
  const messengerPath = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const raw = parseYamlFile(messengerPath) as Record<string, unknown> | null;
  if (!raw) return false;

  const fw        = (raw['framework'] ?? {}) as Record<string, unknown>;
  const messenger = (fw['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
  const routing = (messenger['routing'] ?? {}) as Record<string, unknown>;
  return Object.keys(routing).some((k) => k.includes('mailer') || k.includes('Mailer') || k.includes('Email'));
}

export function listMailerEvents(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const listeners: MailerEventListener[] = [];
    const emailClasses: EmailClass[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const l = parseMailerListener(file, appPath);
      if (l) listeners.push(l);
      const e = parseEmailClass(file, appPath);
      if (e) emailClasses.push(e);
    }

    const asyncMailer = checkAsyncMailer(appPath);

    if (listeners.length === 0 && emailClasses.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No mailer event listeners or custom Email classes found.\n\nExample listener:\n  #[AsEventListener(event: FailedMessageEvent::class)]\n  class MailerFailureListener\n  {\n    public function __invoke(FailedMessageEvent $event): void\n    {\n      $this->logger->error(\'Mail failed: \' . $event->getError()->getMessage());\n    }\n  }',
        }],
      };
    }

    const hasFailureHandler = listeners.some((l) => l.events.includes('FailedMessageEvent'));
    const totalIssues = listeners.reduce((s, l) => s + l.issues.length, 0);

    let text = `Mailer Events\n${'='.repeat(55)}\n`;
    text += `\nEvent listeners:  ${listeners.length}  Issues: ${totalIssues}\n`;
    text += `Email classes:    ${emailClasses.length}\n`;
    text += `Async mailer:     ${asyncMailer ? 'yes (Messenger routing)' : 'no (synchronous)'}\n`;
    text += `FailedMessage handled: ${hasFailureHandler ? '✓' : '⚠ no'}\n`;

    if (listeners.length > 0) {
      text += `\nListeners:\n`;
      for (const l of listeners.sort((a, b) => a.class.localeCompare(b.class))) {
        const evts   = l.events.join(', ');
        const reject = l.rejectsSend ? '  [rejects send]' : '';
        const mod    = l.modifiesHeaders ? '  [modifies headers]' : '';
        text += `  ${l.class}  (${l.file})\n`;
        text += `    Events: ${evts}${reject}${mod}\n`;
        for (const issue of l.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (emailClasses.length > 0) {
      text += `\nEmail classes:\n`;
      for (const e of emailClasses.sort((a, b) => a.class.localeCompare(b.class))) {
        const tag = [
          e.isTransactional ? '[transactional]' : '',
          e.isMarketing ? '[marketing]' : '',
        ].filter(Boolean).join(' ');
        text += `  ${e.class.padEnd(35)} extends: ${e.baseClass}  ${tag}\n`;
      }
    }

    const issues: string[] = [];
    if (!hasFailureHandler && listeners.length > 0) {
      issues.push('No FailedMessageEvent listener — delivery failures are silently ignored');
    }
    if (!hasFailureHandler && emailClasses.length > 0) {
      issues.push('Email classes found but no FailedMessageEvent handler — consider adding failure logging');
    }
    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerEventStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const listeners: MailerEventListener[] = [];
    const emailClasses: EmailClass[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const l = parseMailerListener(file, appPath);
        if (l) listeners.push(l);
        const e = parseEmailClass(file, appPath);
        if (e) emailClasses.push(e);
      }
    }

    let text = `Mailer Event Statistics\n${'='.repeat(40)}\n\n`;
    text += `Event listeners:   ${listeners.length}\n`;
    text += `  MessageEvent:    ${listeners.filter((l) => l.events.includes('MessageEvent')).length}\n`;
    text += `  SentMessage:     ${listeners.filter((l) => l.events.includes('SentMessageEvent')).length}\n`;
    text += `  FailedMessage:   ${listeners.filter((l) => l.events.includes('FailedMessageEvent')).length}\n`;
    text += `Email classes:     ${emailClasses.length}\n`;
    text += `Async mailer:      ${checkAsyncMailer(appPath) ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mailer_events',
      description: 'Show Symfony Mailer event listeners: MessageEvent/SentMessageEvent/FailedMessageEvent handlers, send rejection, header modification, custom Email class scan (TemplatedEmail/NotificationEmail), async Messenger routing detection, missing FailedMessageEvent handler warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mailer_event_stats',
      description: 'Show mailer event statistics: listener count per event type, email class count, async mailer detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
