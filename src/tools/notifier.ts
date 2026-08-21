/**
 * Symfony Notifier Inspector
 *
 * Reads config/packages/notifier.yaml to discover:
 *   - Configured channels (email, SMS, chat, push)
 *   - Transport DSNs per channel (credentials masked)
 *   - Channel policies (which channel handles which severity)
 *   - Notification classes in src/Notification/ and their channels
 *
 * Pure static analysis — no messages sent.
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

interface NotifierTransport {
  name: string;
  dsn: string;
  maskedDsn: string;
  channelType: string;
}

interface NotifierChannel {
  name: string;
  transports: string[];
}

interface ChannelPolicy {
  channel: string;
  cases: string[];
}

interface NotificationClass {
  class: string;
  file: string;
  channels: string[];
  isUrgent: boolean;
}

// ─── Transport categorisation ──────────────────────────────────────────────

const TRANSPORT_CHANNEL_MAP: Record<string, string> = {
  // Email
  smtp: 'email', smtps: 'email', sendgrid: 'email', mailgun: 'email',
  ses: 'email', postmark: 'email', gmail: 'email',
  // SMS
  twilio: 'sms', vonage: 'sms', nexmo: 'sms', sinch: 'sms', messagebird: 'sms',
  sns: 'sms', infobip: 'sms', esendex: 'sms', 'ovh-sms': 'sms',
  // Chat
  slack: 'chat', telegram: 'chat', discord: 'chat', mattermost: 'chat',
  rocketchat: 'chat', microsoftteams: 'chat', googlechat: 'chat',
  // Push
  firebase: 'push', expo: 'push', onesignal: 'push',
  // Desktop / other
  null: 'null',
};

function detectChannelType(dsn: string): string {
  try {
    const proto = new URL(dsn).protocol.replace(':', '');
    return TRANSPORT_CHANNEL_MAP[proto] ?? 'other';
  } catch {
    const protoM = /^([\w-]+):\/\//.exec(dsn);
    if (protoM) return TRANSPORT_CHANNEL_MAP[protoM[1]] ?? 'other';
    return 'other';
  }
}

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

// ─── Config loading ────────────────────────────────────────────────────────

function loadNotifierConfig(appPath: string): {
  transports: NotifierTransport[];
  channels: NotifierChannel[];
  channelPolicies: ChannelPolicy[];
} {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'notifier.yaml'),
    path.join(appPath, 'config', 'notifier.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const notifier = framework['notifier'] as Record<string, unknown> | undefined;
    if (!notifier) continue;

    // Transports
    const transportsRaw = notifier['chatter_transports'] ??
                          notifier['texter_transports'] ??
                          notifier['transports'] as Record<string, unknown> | undefined;

    const allTransportDsns: Record<string, string> = {};

    for (const key of ['chatter_transports', 'texter_transports', 'email_transports'] as const) {
      const section = notifier[key] as Record<string, unknown> | undefined;
      if (section) {
        for (const [name, dsn] of Object.entries(section)) {
          allTransportDsns[name] = String(dsn);
        }
      }
    }
    if (transportsRaw && typeof transportsRaw === 'object') {
      for (const [name, dsn] of Object.entries(transportsRaw as Record<string, unknown>)) {
        allTransportDsns[name] = String(dsn);
      }
    }

    const transports: NotifierTransport[] = Object.entries(allTransportDsns).map(([name, dsn]) => ({
      name,
      dsn,
      maskedDsn: maskDsn(dsn),
      channelType: detectChannelType(dsn),
    }));

    // Channels
    const channelPoliciesRaw = notifier['channel_policy'] as Record<string, unknown> | undefined;
    const channelPolicies: ChannelPolicy[] = channelPoliciesRaw
      ? Object.entries(channelPoliciesRaw).map(([channel, cases]) => ({
          channel,
          cases: Array.isArray(cases) ? cases.map(String) : [String(cases)],
        }))
      : [];

    // Channels grouping transports
    const channels: NotifierChannel[] = [];
    const byType: Record<string, string[]> = {};
    for (const t of transports) {
      (byType[t.channelType] ??= []).push(t.name);
    }
    for (const [type, names] of Object.entries(byType)) {
      channels.push({ name: type, transports: names });
    }

    return { transports, channels, channelPolicies };
  }

  return { transports: [], channels: [], channelPolicies: [] };
}

// ─── Notification class scanning ───────────────────────────────────────────

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

function scanNotificationClasses(appPath: string): NotificationClass[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Notification'),
    path.join(appPath, 'src', 'Notifier'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const classes: NotificationClass[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes('Notification') &&
          !content.includes('extends Notification')) continue;

      if (!/class\s+\w+.*extends\s+\w*Notification/.test(content) &&
          !content.includes('implements NotificationInterface')) continue;

      const classM = /class\s+(\w+)/.exec(content);
      if (!classM) continue;

      // Extract getChannels() return value
      const channelsM = /getChannels\s*\([^)]*\)\s*:\s*(?:array|\?array)\s*\{([^}]+)\}/s.exec(content);
      const channels: string[] = [];
      if (channelsM) {
        for (const cm of channelsM[1].matchAll(/['"](\w+)['"]/g)) {
          channels.push(cm[1]);
        }
      }

      const isUrgent = content.includes('URGENCY_URGENT') || content.includes('urgency_urgent');

      classes.push({
        class: classM[1],
        file: path.basename(file),
        channels,
        isUrgent,
      });
    }
  }

  return classes.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listNotifierTransports(appPath: string): McpToolResult {
  try {
    const { transports, channels, channelPolicies } = loadNotifierConfig(appPath);

    if (transports.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Notifier not configured.\n\nInstall: composer require symfony/notifier\nAdd transport: composer require symfony/slack-notifier\n\nConfigure in config/packages/notifier.yaml:\n  framework:\n    notifier:\n      chatter_transports:\n        slack: \'%env(SLACK_DSN)%\'',
        }],
      };
    }

    let text = `Notifier Transports (${transports.length})\n${'='.repeat(50)}\n`;

    const byType: Record<string, NotifierTransport[]> = {};
    for (const t of transports) {
      (byType[t.channelType] ??= []).push(t);
    }

    for (const [type, group] of Object.entries(byType).sort()) {
      text += `\n  ${type.toUpperCase()} (${group.length})\n`;
      for (const t of group) {
        text += `    ${t.name.padEnd(25)} ${t.maskedDsn}\n`;
      }
    }

    if (channelPolicies.length > 0) {
      text += `\nChannel Policies:\n`;
      for (const cp of channelPolicies) {
        text += `  ${cp.channel.padEnd(20)} ${cp.cases.join(', ')}\n`;
      }
    }

    void channels;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listNotifications(appPath: string): McpToolResult {
  try {
    const classes = scanNotificationClasses(appPath);

    if (classes.length === 0) {
      return {
        content: [{ type: 'text', text: 'No custom Notification classes found in src/.' }],
      };
    }

    let text = `Notification Classes (${classes.length})\n${'='.repeat(50)}\n\n`;

    for (const n of classes) {
      text += `  ${n.class}  (${n.file})\n`;
      if (n.channels.length > 0) text += `    channels: ${n.channels.join(', ')}\n`;
      if (n.isUrgent) text += `    urgency: URGENT\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNotifierStats(appPath: string): McpToolResult {
  try {
    const { transports, channelPolicies } = loadNotifierConfig(appPath);
    const classes = scanNotificationClasses(appPath);

    let text = `Notifier Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:          ${transports.length}\n`;
    text += `Channel policies:    ${channelPolicies.length}\n`;
    text += `Notification classes:${classes.length}\n`;

    const byType: Record<string, number> = {};
    for (const t of transports) {
      byType[t.channelType] = (byType[t.channelType] ?? 0) + 1;
    }

    if (Object.keys(byType).length > 0) {
      text += `\nBy channel type:\n`;
      for (const [type, count] of Object.entries(byType).sort()) {
        text += `  ${type.padEnd(20)} ${count}\n`;
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getNotifierTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_notifier_transports',
      description: 'List Symfony Notifier transports (Slack, SMS, email, etc.) with channel type and masked DSN, plus channel policies',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_notifications',
      description: 'List custom Notification classes in src/ with their channels and urgency level',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_notifier_stats',
      description: 'Show notifier statistics: transport count by channel type, channel policies, notification class count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
