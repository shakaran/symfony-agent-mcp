// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

interface SmsNotifierInfo {
  transport: string;
  dsn: string;
  type: 'twilio' | 'vonage' | 'bandwidth' | 'ovh' | 'smsapi' | 'generic';
  issues: string[];
}

const SMS_TRANSPORTS: Record<string, string> = {
  'twilio': 'twilio',
  'vonage': 'vonage',
  'nexmo': 'vonage (now Vonage)',
  'bandwidth': 'bandwidth',
  'ovh': 'ovh',
  'smsapi': 'smsapi',
  'smsbao': 'smsbao',
  'sinch': 'sinch',
  'telnyx': 'telnyx',
  'infobip': 'infobip',
};

function buildSmsNotifierInfos(appPath: string): SmsNotifierInfo[] {
  const results: SmsNotifierInfo[] = [];

  const composerPath = path.join(appPath, 'composer.json');
  let installedTransports: string[] = [];
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      installedTransports = Object.keys(req)
        .filter((k) => k.startsWith('symfony/') && Object.keys(SMS_TRANSPORTS).some((t) => k.includes(t)));
    } catch { /* ignore */ }
  }

  const envFiles = ['.env', '.env.local', '.env.production'];
  const dsnMap = new Map<string, string>();
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n').filter((l) => l.includes('DSN') && l.includes('twilio') || l.includes('vonage') || l.includes('nexmo') || l.includes('bandwidth') || l.includes('sms'));
    for (const line of lines) {
      const [k, ...vparts] = line.split('=');
      if (k && vparts.length > 0) dsnMap.set(k.trim(), vparts.join('=').trim());
    }
  }

  const notifierYaml = path.join(appPath, 'config', 'packages', 'notifier.yaml');
  if (fs.existsSync(notifierYaml)) {
    let content = '';
    try { content = fs.readFileSync(notifierYaml, 'utf-8'); } catch { /* skip */ }

    const smsTransportMatch = /texter_transports\s*:/;
    if (smsTransportMatch.test(content)) {
      const lines = content.split('\n');
      for (const line of lines) {
        const dsnLine = /^\s+\w[\w.]*\s*:\s*(.+)$/.exec(line.trim());
        if (!dsnLine) continue;
        const dsn = dsnLine[1].trim();
        const issues: string[] = [];
        let type: SmsNotifierInfo['type'] = 'generic';

        if (dsn.includes('twilio')) {
          type = 'twilio';
          if (dsn.includes('AC') && !dsn.startsWith('%env(')) {
            issues.push('Twilio Account SID/auth token hardcoded in notifier.yaml — use %env(TWILIO_DSN)% to avoid credentials in YAML');
          }
        } else if (dsn.includes('vonage') || dsn.includes('nexmo')) {
          type = 'vonage';
          if (!dsn.startsWith('%env(')) {
            issues.push('Vonage credentials hardcoded — use %env(VONAGE_DSN)%');
          }
        }

        if (dsn && !dsn.includes('null://') && !dsn.includes('log://')) {
          if (!content.includes('from:') && !content.includes('sender_id')) {
            issues.push('SMS transport configured without default sender ID — many carriers require a registered sender number or alphanumeric ID');
          }
        }

        results.push({ transport: dsn.split('://')[0] ?? 'unknown', dsn: dsn.startsWith('%env') ? '(env)' : maskDsn(dsn).substring(0, 40), type, issues });
      }
    }
  }

  if (results.length === 0 && installedTransports.length > 0) {
    for (const transport of installedTransports) {
      const transportName = Object.keys(SMS_TRANSPORTS).find((t) => transport.includes(t)) ?? 'generic';
      results.push({ transport, dsn: '(not configured)', type: transportName as SmsNotifierInfo['type'], issues: [`${transport} package installed but no texter_transports configured in notifier.yaml`] });
    }
  }

  if (results.length === 0) {
    results.push({ transport: 'none', dsn: 'none', type: 'generic', issues: ['No SMS notifier transport configured — install a transport: composer require symfony/twilio-notifier OR symfony/vonage-notifier'] });
  }

  return results;
}

export function listSymfonyNotifierSms(appPath: string): McpToolResult {
  try {
    const infos = buildSmsNotifierInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SMS Notifier Analysis\n${'='.repeat(50)}\n\nTransports: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.transport}  DSN: ${info.dsn}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierSmsStats(appPath: string): McpToolResult {
  try {
    const infos = buildSmsNotifierInfos(appPath);
    let text = `SMS Notifier Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports: ${infos.filter((i) => i.transport !== 'none').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyNotifierSmsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_notifier_sms', description: 'Analyze Symfony SMS notifier transports (Twilio, Vonage, Bandwidth); warns on hardcoded credentials in YAML, missing sender ID, installed transport without texter_transports configuration', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_notifier_sms_stats', description: 'Statistics for SMS notifier: transport count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
