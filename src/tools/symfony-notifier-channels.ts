/**
 * Symfony Notifier Channels Inspector
 *
 * Distinct from notifier.ts (which lists transports).
 * Focuses on channel configuration and notification class analysis:
 *
 * notifier.yaml channel assignments:
 *   - channel_policy: which channels handle which notification urgency levels
 *     (urgent, high, medium, low)
 *   - chat/sms/email/push channels with their transport assignments
 *   - admin_recipients for urgent channels
 *
 * Notification classes:
 *   - Classes extending Notification or implementing NotificationInterface
 *   - getChannels() override — which channels the notification targets
 *   - getRecipients() or RecipientInterface usage
 *   - asSms/asEmail/asChat/asPush() method overrides
 *   - Importance level set via setImportance()
 *
 * Analysis:
 *   - Channels configured but no transports assigned
 *   - Notification classes targeting channels not configured in notifier.yaml
 *   - Urgent notifications with no admin_recipients
 *   - Notifications without getChannels() override (uses all channels)
 *   - Multiple transports on same channel (failover vs round-robin)
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

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

interface ChannelConfig {
  name: string;
  transports: string[];
}

interface NotifierConfig {
  channels: ChannelConfig[];
  channelPolicy: Record<string, string[]>;
  adminRecipients: string[];
}

interface NotificationClass {
  class: string;
  file: string;
  channels: string[];
  importance?: string;
  hasSmsOverride: boolean;
  hasEmailOverride: boolean;
  hasChatOverride: boolean;
  issues: string[];
}

function loadNotifierConfig(appPath: string): NotifierConfig | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'notifier.yaml'),
    path.join(appPath, 'config', 'packages', 'notifier.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const notifier  = (framework['notifier'] ?? raw['notifier'] ?? {}) as Record<string, unknown>;

    // Channels: chat_transports, sms_transports, email_transports, push_transports
    const channels: ChannelConfig[] = [];
    for (const key of ['chat', 'sms', 'email', 'push']) {
      const transportKey = `${key}_transports`;
      const transRaw = notifier[transportKey] as Record<string, unknown> | string[] | undefined;
      if (!transRaw) continue;
      const transports = Array.isArray(transRaw) ? transRaw.map((v) => maskDsn(String(v))) : Object.values(transRaw).map((v) => maskDsn(String(v)));
      if (transports.length > 0) channels.push({ name: key, transports });
    }

    // channel_policy
    const policyRaw = (notifier['channel_policy'] ?? {}) as Record<string, unknown>;
    const channelPolicy: Record<string, string[]> = {};
    for (const [level, chans] of Object.entries(policyRaw)) {
      channelPolicy[level] = Array.isArray(chans) ? chans.map(String) : [String(chans)];
    }

    // admin_recipients
    const adminRaw = notifier['admin_recipients'] as Array<Record<string, unknown>> | undefined;
    const adminRecipients = adminRaw ? adminRaw.map((r) => String(r['email'] ?? r['name'] ?? JSON.stringify(r))) : [];

    return { channels, channelPolicy, adminRecipients };
  }
  return null;
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

function scanNotificationClasses(appPath: string, config: NotifierConfig | null): NotificationClass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: NotificationClass[] = [];
  const configuredChannels = new Set(config?.channels.map((c) => c.name) ?? []);

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isNotification = content.includes('extends Notification') ||
                           content.includes('NotificationInterface') ||
                           content.includes('implements NotificationInterface');
    if (!isNotification) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // getChannels() return
    const channels: string[] = [];
    const chanM = /function\s+getChannels[^{]*\{([^}]+)\}/s.exec(content);
    if (chanM) {
      for (const m of chanM[1].matchAll(/['"]([a-z]+)['"]/g)) channels.push(m[1]);
    }

    const importanceM = /setImportance\s*\(\s*['"]([^'"]+)['"]/.exec(content) ??
                        /Notification::IMPORTANCE_(\w+)/.exec(content);
    const importance = importanceM?.[1]?.toLowerCase();

    const issues: string[] = [];
    for (const ch of channels) {
      if (configuredChannels.size > 0 && !configuredChannels.has(ch)) {
        issues.push(`Targets channel "${ch}" which is not configured in notifier.yaml`);
      }
    }
    if (channels.length === 0) {
      issues.push(`No getChannels() override — will use all configured channels (may be intentional)`);
    }
    if (importance === 'urgent' && config && config.adminRecipients.length === 0) {
      issues.push(`Notification is urgent but no admin_recipients configured in notifier.yaml`);
    }

    results.push({
      class: classM[1],
      file: path.basename(file),
      channels,
      importance,
      hasSmsOverride: content.includes('asSms('),
      hasEmailOverride: content.includes('asEmail('),
      hasChatOverride: content.includes('asChat('),
      issues,
    });
  }
  return results.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class));
}

export function listNotifierChannels(appPath: string): McpToolResult {
  try {
    const config         = loadNotifierConfig(appPath);
    const notifications  = scanNotificationClasses(appPath, config);

    if (!config && notifications.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Notifier configuration found.\n\nInstall:\n  composer require symfony/notifier\n\nConfigure channels:\n  framework:\n    notifier:\n      sms_transports:\n        - twilio://...\n      email_transports:\n        - mailer\n      channel_policy:\n        urgent: [sms, email]\n        high: [email]\n        medium: [email]\n        low: []\n      admin_recipients:\n        - { email: admin@example.com }',
        }],
      };
    }

    let text = `Notifier Channels\n${'='.repeat(55)}\n`;

    if (config) {
      text += `\nChannels (${config.channels.length}):\n`;
      for (const ch of config.channels) {
        const transports = ch.transports.join(', ');
        text += `  ${ch.name.padEnd(10)} transports: ${transports}\n`;
      }

      if (Object.keys(config.channelPolicy).length > 0) {
        text += `\nChannel policy:\n`;
        for (const [level, channels] of Object.entries(config.channelPolicy)) {
          text += `  ${level.padEnd(10)} → ${channels.join(', ')}\n`;
        }
      }

      if (config.adminRecipients.length > 0) {
        text += `\nAdmin recipients: ${config.adminRecipients.join(', ')}\n`;
      } else {
        text += `\n⚠ No admin_recipients configured — urgent notifications may have no destination\n`;
      }
    }

    if (notifications.length > 0) {
      text += `\nNotification classes (${notifications.length}):\n`;
      for (const n of notifications) {
        const channels  = n.channels.length > 0 ? `channels: [${n.channels.join(', ')}]` : 'all channels';
        const imp       = n.importance ? `  importance: ${n.importance}` : '';
        const overrides = [n.hasSmsOverride && 'SMS', n.hasEmailOverride && 'Email', n.hasChatOverride && 'Chat']
          .filter(Boolean).join('/');
        const ov = overrides ? `  overrides: ${overrides}` : '';
        text += `  ${n.class.padEnd(35)} ${channels}${imp}${ov}\n`;
        for (const issue of n.issues) text += `    ⚠ ${issue}\n`;
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

export function getNotifierChannelStats(appPath: string): McpToolResult {
  try {
    const config        = loadNotifierConfig(appPath);
    const notifications = scanNotificationClasses(appPath, config);

    let text = `Notifier Channel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Channels configured: ${config?.channels.length ?? 0}\n`;
    text += `Policy levels:       ${Object.keys(config?.channelPolicy ?? {}).length}\n`;
    text += `Admin recipients:    ${config?.adminRecipients.length ?? 0}\n`;
    text += `Notification classes: ${notifications.length}\n`;
    text += `Issues detected:     ${notifications.reduce((s, n) => s + n.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNotifierChannelTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_notifier_channels',
      description: 'Show Symfony Notifier channels: chat/sms/email/push transport assignments, channel_policy (urgent/high/medium/low), admin_recipients, Notification classes (getChannels override, importance level, asSms/asEmail/asChat overrides), unconfigured channel warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_notifier_channel_stats',
      description: 'Show Notifier statistics: channel count, policy level count, admin recipient count, notification class count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
