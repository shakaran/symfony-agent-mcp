import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface NotifierTransportDetail {
  name: string;
  scheme: string;
  dsn: string;
  type: 'sms' | 'chat' | 'push' | 'email' | 'unknown';
  hasSensitiveCredentials: boolean;
  usesEnvVar: boolean;
  issues: string[];
}

function detectType(scheme: string): NotifierTransportDetail['type'] {
  const smsSchemes = ['twilio', 'vonage', 'sinch', 'messagebird', 'esendex', 'octopush', 'ovhcloud-sms', 'nexmo', 'infobip-sms'];
  const chatSchemes = ['slack', 'telegram', 'rocketchat', 'mattermost', 'discord', 'microsoftteams', 'googlechat'];
  const pushSchemes = ['firebase', 'expo', 'apns', 'onesignal'];
  if (smsSchemes.some(s => scheme.includes(s))) return 'sms';
  if (chatSchemes.some(s => scheme.includes(s))) return 'chat';
  if (pushSchemes.some(s => scheme.includes(s))) return 'push';
  if (scheme.includes('smtp') || scheme.includes('mailer') || scheme.includes('sendgrid')) return 'email';
  return 'unknown';
}

function maskDsn(dsn: string): string {
  return dsn.replace(/:([^:@\s%]{1,200})@/, ':***@');
}

function loadNotifierTransports(appPath: string): NotifierTransportDetail[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'notifier.yaml'),
    path.join(appPath, 'config', 'notifier.yaml'),
  ];
  const transports: NotifierTransportDetail[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const frameworkConf = raw['framework'] as Record<string, unknown> | undefined;
    const notifier = (frameworkConf?.['notifier'] ?? raw['notifier'] ?? raw) as Record<string, unknown>;
    const channelPolicy = (notifier['channel_policy'] ?? {}) as Record<string, unknown>;
    const texter = notifier['texter_transports'] ?? notifier['sms_transports'];
    const chatter = notifier['chatter_transports'] ?? notifier['chat_transports'];
    const allTransports: Record<string, string> = {};
    if (texter && typeof texter === 'object') {
      for (const [n, v] of Object.entries(texter as Record<string, unknown>)) allTransports[n] = String(v);
    }
    if (chatter && typeof chatter === 'object') {
      for (const [n, v] of Object.entries(chatter as Record<string, unknown>)) allTransports[n] = String(v);
    }
    for (const fallback of Object.values(channelPolicy)) {
      if (Array.isArray(fallback)) for (const ch of fallback) if (typeof ch === 'string') allTransports[ch] = allTransports[ch] ?? '';
    }
    for (const [name, dsn] of Object.entries(allTransports)) {
      const scheme = dsn.split('://')[0] ?? name;
      const type = detectType(scheme.toLowerCase());
      const usesEnvVar = dsn.includes('%env(') || dsn.includes('${');
      const hasSensitiveCredentials = !usesEnvVar && dsn.includes('://') && dsn.includes(':');
      const issues: string[] = [];
      if (hasSensitiveCredentials) issues.push(`Transport "${name}" has hardcoded credentials in DSN — use environment variable: %env(NOTIFIER_DSN)%`);
      if (!usesEnvVar && dsn && !dsn.includes('null://')) issues.push(`Transport "${name}" DSN not using env var — credentials may be committed to source control`);
      transports.push({ name, scheme, dsn: maskDsn(dsn), type, hasSensitiveCredentials, usesEnvVar, issues });
    }
  }
  return transports;
}

export function listNotifierTransportConfig(appPath: string): McpToolResult {
  try {
    const transports = loadNotifierTransports(appPath);
    if (transports.length === 0) return { content: [{ type: 'text', text: 'No Symfony Notifier transport configuration found.\n\nConfigure in config/packages/notifier.yaml:\n  framework:\n    notifier:\n      chatter_transports:\n        slack: \'%env(SLACK_DSN)%\'' }] };
    const totalIssues = transports.reduce((s, t) => s + t.issues.length, 0);
    let text = `Notifier Transport Configuration\n${'='.repeat(55)}\n\nTransports: ${transports.length}  Issues: ${totalIssues}\n`;
    for (const t of transports.sort((a, b) => b.issues.length - a.issues.length)) {
      const credFlag = t.hasSensitiveCredentials ? '⚠HARDCODED' : (t.usesEnvVar ? '✓env' : '?');
      text += `\n  ${t.name}  [${t.type}]  ${credFlag}\n    scheme: ${t.scheme}  DSN: ${t.dsn}\n`;
      for (const i of t.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNotifierTransportStats(appPath: string): McpToolResult {
  try {
    const transports = loadNotifierTransports(appPath);
    const byType = new Map<string, number>();
    for (const t of transports) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
    let text = `Notifier Transport Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports: ${transports.length}\n`;
    for (const [type, count] of byType.entries()) text += `  ${type}: ${count}\n`;
    text += `Using env vars: ${transports.filter(t => t.usesEnvVar).length}\nHardcoded credentials: ${transports.filter(t => t.hasSensitiveCredentials).length}\nIssues: ${transports.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNotifierTransportTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_notifier_transport_config', description: 'Show Symfony Notifier transport DSNs: SMS/chat/push/email type detection, env var vs hardcoded credentials, credential exposure warning for Slack/Telegram/Vonage/Twilio transports', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_notifier_transport_stats', description: 'Notifier transport statistics: total count, by type, env var coverage, hardcoded credential count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
