/**
 * Symfony Notifier Admin Channel Inspector
 *
 * Distinct from notifier.ts (transport/channel config) and mailer.ts (email notifications).
 * Focuses specifically on the admin notification channel and AdminNotifier usage:
 *
 * - Scans src/ PHP for AdminNotifier, NotificationInterface with getChannels() returning 'admin'
 * - Reads notifier.yaml for admin_recipients configuration
 * - Detects Notification classes implementing getChannels with 'admin' channel
 *
 * Warnings:
 *   - AdminNotifier used but no admin_recipients configured (notifications silently dropped)
 *   - Notification without getImportance() (all same importance — no prioritization)
 *   - Admin notifications without channel fallback (if admin down, notification lost)
 *   - NotificationInterface::getChannels() not including 'admin'
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

interface NotifierAdminInfo {
  file: string;
  class: string;
  hasAdminChannel: boolean;
  hasImportance: boolean;
  adminRecipientsCount: number;
  hasFallbackChannel: boolean;
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

function loadAdminRecipientsCount(appPath: string): number {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'notifier.yaml'),
    path.join(appPath, 'config', 'packages', 'notifier.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const frameworkBlock = raw['framework'] as Record<string, unknown> | undefined;
    const notifier = (frameworkBlock?.['notifier'] ?? raw['notifier'] ?? raw) as Record<string, unknown>;
    const adminRecipients = notifier['admin_recipients'];
    if (Array.isArray(adminRecipients)) return adminRecipients.length;
    if (adminRecipients && typeof adminRecipients === 'object') return 1;
  }
  return 0;
}

function parseNotificationFile(filePath: string, adminRecipientsCount: number): NotifierAdminInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isNotification = content.includes('AdminNotifier') ||
    content.includes('NotificationInterface') ||
    content.includes('Notification') && content.includes('getChannels');

  if (!isNotification) return null;
  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasAdminNotifier = content.includes('AdminNotifier');
  const hasGetChannels = content.includes('getChannels()') || content.includes('getChannels ():');
  const hasAdminChannel = content.includes("'admin'") || content.includes('"admin"') ||
    content.includes("Channels::ADMIN") || content.includes('admin');

  const isAdminRelated = hasAdminNotifier || (hasGetChannels && hasAdminChannel);
  if (!isAdminRelated) return null;

  const hasImportance = content.includes('getImportance()') || content.includes('getImportance ():') ||
    content.includes('Importance::') || content.includes('->setImportance(');

  const channelsMatches: string[] = [];
  const channelArrayM = /getChannels[^{]{0,50}\{[^}]{0,300}\}/.exec(content);
  if (channelArrayM) {
    const channelBlock = channelArrayM[0];
    const channelNames = channelBlock.matchAll(/['"](\w{1,50})['"]/g);
    for (const m of channelNames) {
      channelsMatches.push(m[1]);
    }
  }

  const hasFallbackChannel = channelsMatches.length > 1 ||
    content.includes('email') || content.includes('sms') || content.includes('slack');

  const issues: string[] = [];

  if (hasAdminNotifier && adminRecipientsCount === 0) {
    issues.push('AdminNotifier used but no admin_recipients configured in notifier.yaml — notifications silently dropped');
  }

  if (!hasImportance && (hasAdminNotifier || hasGetChannels)) {
    issues.push('No getImportance() method — all admin notifications have same importance, no prioritization possible');
  }

  if (!hasFallbackChannel && hasAdminChannel) {
    issues.push('Admin channel without fallback channel — if admin channel fails, notification is lost');
  }

  if (hasGetChannels && !hasAdminChannel && content.includes('NotificationInterface')) {
    issues.push("getChannels() does not include 'admin' channel — won't show in profiler admin bar");
  }

  return {
    file: path.basename(filePath),
    class: classM[1],
    hasAdminChannel: hasAdminChannel && hasGetChannels,
    hasImportance,
    adminRecipientsCount,
    hasFallbackChannel,
    issues,
  };
}

export function listNotifierAdmin(appPath: string): McpToolResult {
  try {
    const adminRecipientsCount = loadAdminRecipientsCount(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: NotifierAdminInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseNotificationFile(file, adminRecipientsCount);
      if (info) results.push(info);
    }

    results.sort((a, b) => a.class.localeCompare(b.class));

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No admin notifier classes found in src/.\n\nadmin_recipients configured: ${adminRecipientsCount}`,
        }],
      };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);

    let text = `Notifier Admin Channel Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses: ${results.length}  Admin recipients: ${adminRecipientsCount}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const adminCh = r.hasAdminChannel ? ' [admin-channel]' : '';
      const imp = r.hasImportance ? ' [importance]' : '';
      const fallback = r.hasFallbackChannel ? ' [fallback]' : '';
      text += `\n  ${r.class.padEnd(45)} (${r.file})\n`;
      text += `    flags:${adminCh}${imp}${fallback}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNotifierAdminStats(appPath: string): McpToolResult {
  try {
    const adminRecipientsCount = loadAdminRecipientsCount(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: NotifierAdminInfo[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseNotificationFile(file, adminRecipientsCount);
      if (info) results.push(info);
    }

    let text = `Notifier Admin Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total admin notification classes: ${results.length}\n`;
    text += `  With admin channel:             ${results.filter((r) => r.hasAdminChannel).length}\n`;
    text += `  With importance:                ${results.filter((r) => r.hasImportance).length}\n`;
    text += `  With fallback channel:          ${results.filter((r) => r.hasFallbackChannel).length}\n`;
    text += `Admin recipients configured:      ${adminRecipientsCount}\n`;
    text += `Issues:                           ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getNotifierAdminTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_notifier_admin',
      description: "Show Symfony admin notifier analysis: AdminNotifier usage, Notification classes with 'admin' getChannels(), admin_recipients config count; warns on AdminNotifier without admin_recipients (silent drop), missing getImportance(), no fallback channel, missing 'admin' in getChannels()",
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_notifier_admin_stats',
      description: 'Show admin notifier statistics: total classes, admin channel count, importance method count, fallback channel count, admin recipients configured, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
