// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface MailerDsnInfo {
  transport: string;
  isFailover: boolean;
  isRoundRobin: boolean;
  isNull: boolean;
  isApi: boolean;
  hasCredentials: boolean;
  isCommittedToEnv: boolean;
  issues: string[];
}

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function detectTransportType(dsn: string): {
  transport: string;
  isFailover: boolean;
  isRoundRobin: boolean;
  isNull: boolean;
  isApi: boolean;
} {
  const lower = dsn.toLowerCase();
  if (lower.startsWith('failover(') || lower.includes('failover://')) {
    return { transport: 'failover', isFailover: true, isRoundRobin: false, isNull: false, isApi: false };
  }
  if (lower.startsWith('roundrobin(') || lower.includes('roundrobin://')) {
    return { transport: 'roundrobin', isFailover: false, isRoundRobin: true, isNull: false, isApi: false };
  }
  if (lower.startsWith('null://')) {
    return { transport: 'null', isFailover: false, isRoundRobin: false, isNull: true, isApi: false };
  }
  if (lower.startsWith('smtp://') || lower.startsWith('smtps://') || lower.startsWith('native://')) {
    return { transport: 'smtp', isFailover: false, isRoundRobin: false, isNull: false, isApi: false };
  }
  if (lower.startsWith('sendmail://')) {
    return { transport: 'sendmail', isFailover: false, isRoundRobin: false, isNull: false, isApi: false };
  }

  const apiTransports = ['ses', 'mailgun', 'postmark', 'sendgrid', 'mailtrap', 'brevo', 'mailjet', 'infobip', 'vonage'];
  for (const api of apiTransports) {
    if (lower.startsWith(`${api}+`)) {
      return { transport: api, isFailover: false, isRoundRobin: false, isNull: false, isApi: true };
    }
  }

  return { transport: dsn.split('://')[0] ?? 'unknown', isFailover: false, isRoundRobin: false, isNull: false, isApi: false };
}

function hasHardcodedCredentials(dsn: string): boolean {
  // Detect user:pass@host pattern (not env var)
  // smtp://user:pass@host — has literal credentials
  if (dsn.includes('%env(') || dsn.startsWith('null://')) return false;
  // Check for user:password@ pattern
  const credM = /^[\w+.-]+:\/\/[^@%]{1,100}:[^@%]{1,100}@/.exec(dsn);
  return credM !== null;
}

function extractDsnFromEnv(envContent: string, key: string): string | null {
  const regex = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm');
  const m = regex.exec(envContent);
  return m ? m[1].trim() : null;
}

function loadMailerDsnConfig(appPath: string): MailerDsnInfo | null {
  // Try to find MAILER_DSN from various sources
  let dsn = '';
  let isCommittedToEnv = false;

  // Check mailer.yaml
  const mailerYamlPath = path.join(appPath, 'config', 'packages', 'mailer.yaml');
  const mailerRaw = parseYamlFile(mailerYamlPath) as Record<string, unknown> | null;
  if (mailerRaw) {
    const mailer = (mailerRaw['framework'] as Record<string, unknown> | undefined)?.['mailer'] ??
      mailerRaw['mailer'] as Record<string, unknown> | undefined ?? {};
    const dsnVal = (mailer as Record<string, unknown>)['dsn'];
    if (typeof dsnVal === 'string') dsn = dsnVal;
  }

  // Read .env for MAILER_DSN
  const envPath = path.join(appPath, '.env');
  const envContent = readFileSafe(envPath);
  const envDsn = extractDsnFromEnv(envContent, 'MAILER_DSN');
  if (envDsn && !envDsn.startsWith('null://') && !envDsn.includes('%env(')) {
    isCommittedToEnv = true;
    if (!dsn) dsn = envDsn;
  }

  // .env.local overrides .env
  const envLocalPath = path.join(appPath, '.env.local');
  const envLocalContent = readFileSafe(envLocalPath);
  const localDsn = extractDsnFromEnv(envLocalContent, 'MAILER_DSN');
  if (localDsn) {
    dsn = localDsn;
    isCommittedToEnv = false; // .env.local is not committed
  }

  if (!dsn) {
    // Try DSN from env placeholder reference — %env(MAILER_DSN)%
    if (mailerRaw) {
      const raw = JSON.stringify(mailerRaw);
      if (raw.includes('MAILER_DSN')) dsn = '%env(MAILER_DSN)%';
    }
    if (!dsn) return null;
  }

  // Resolve env placeholder if still placeholder
  if (dsn === '%env(MAILER_DSN)%' || dsn.includes('%env(')) {
    if (envDsn) dsn = envDsn;
    else if (localDsn) dsn = localDsn;
    else {
      // No resolved DSN available — report as unknown
      return {
        transport: 'env-placeholder',
        isFailover: false,
        isRoundRobin: false,
        isNull: false,
        isApi: false,
        hasCredentials: false,
        isCommittedToEnv: false,
        issues: ['MAILER_DSN uses env placeholder but value not found in .env or .env.local'],
      };
    }
  }

  const { transport, isFailover, isRoundRobin, isNull, isApi } = detectTransportType(dsn);
  const hasCredentials = hasHardcodedCredentials(dsn);

  const issues: string[] = [];

  if (isCommittedToEnv && hasCredentials) {
    issues.push('MAILER_DSN with credentials committed to .env — potential credential exposure; use .env.local instead');
  }
  if (isCommittedToEnv && !dsn.startsWith('null://')) {
    issues.push('MAILER_DSN committed to .env (not .env.local) — may expose transport credentials in version control');
  }

  if (transport === 'smtp' && !dsn.startsWith('smtps://') && !dsn.includes('ssl') && !dsn.includes('tls')) {
    issues.push('smtp:// without TLS/SSL — email transmitted in plaintext (use smtps:// or configure encryption)');
  }

  if (isNull) {
    // Check if we're in non-dev env
    const appEnvPath = path.join(appPath, '.env');
    const appEnvContent = readFileSafe(appEnvPath);
    const appEnv = (extractDsnFromEnv(appEnvContent, 'APP_ENV') ?? 'dev').replace(/['"]/g, '');
    if (appEnv !== 'dev' && appEnv !== 'test') {
      issues.push(`null:// transport configured in "${appEnv}" environment — emails are silently dropped`);
    }
  }

  if (!isFailover && !isNull && isApi) {
    issues.push('Single API transport without failover — single point of failure for email delivery');
  }

  if (transport === 'sendmail') {
    // Check for Docker/container
    const dockerComposePath = path.join(appPath, 'docker-compose.yml');
    const dockerComposePathAlt = path.join(appPath, 'docker-compose.yaml');
    if (fs.existsSync(dockerComposePath) || fs.existsSync(dockerComposePathAlt)) {
      issues.push('sendmail:// in containerized environment — sendmail binary may not be available in container');
    }
  }

  if (hasCredentials) {
    issues.push('Credentials embedded in DSN instead of env vars — rotate credentials and use MAILER_DSN=scheme://user:$PASS@host pattern');
  }

  return { transport, isFailover, isRoundRobin, isNull, isApi, hasCredentials, isCommittedToEnv, issues };
}

export function listMailerDsnConfig(appPath: string): McpToolResult {
  try {
    const info = loadMailerDsnConfig(appPath);
    if (!info) {
      return {
        content: [{
          type: 'text',
          text: 'No MAILER_DSN configuration found.\n\nExample (.env.local):\n  MAILER_DSN=smtp://user:pass@smtp.example.com:587\n\nOr mailer.yaml:\n  framework:\n    mailer:\n      dsn: \'%env(MAILER_DSN)%\'',
        }],
      };
    }

    let text = `Mailer DSN Analysis\n${'='.repeat(55)}\n\n`;
    text += `Transport:          ${info.transport}\n`;
    text += `Is failover:        ${info.isFailover ? 'yes' : 'no'}\n`;
    text += `Is round-robin:     ${info.isRoundRobin ? 'yes' : 'no'}\n`;
    text += `Is null (dev):      ${info.isNull ? 'yes' : 'no'}\n`;
    text += `Is API transport:   ${info.isApi ? 'yes' : 'no'}\n`;
    text += `Has credentials:    ${info.hasCredentials ? 'yes (embedded in DSN)' : 'no'}\n`;
    text += `Committed to .env:  ${info.isCommittedToEnv ? 'yes (warning)' : 'no'}\n`;
    text += `Issues:             ${info.issues.length}\n`;

    for (const issue of info.issues) text += `\n⚠ ${issue}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailerDsnConfigStats(appPath: string): McpToolResult {
  try {
    const info = loadMailerDsnConfig(appPath);
    let text = `Mailer DSN Statistics\n${'='.repeat(40)}\n\n`;

    if (!info) {
      text += 'No MAILER_DSN found.\n';
    } else {
      text += `Transport type:     ${info.transport}\n`;
      text += `Failover:           ${info.isFailover ? 'yes' : 'no'}\n`;
      text += `Round-robin:        ${info.isRoundRobin ? 'yes' : 'no'}\n`;
      text += `Null transport:     ${info.isNull ? 'yes' : 'no'}\n`;
      text += `API transport:      ${info.isApi ? 'yes' : 'no'}\n`;
      text += `Embedded creds:     ${info.hasCredentials ? 'yes' : 'no'}\n`;
      text += `Committed to .env:  ${info.isCommittedToEnv ? 'yes' : 'no'}\n`;
      text += `Issues:             ${info.issues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailerDsnConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mailer_dsn_config',
      description: 'Show MAILER_DSN analysis: transport type (smtp/sendmail/ses/mailgun/null/failover/roundrobin), failover/roundrobin detection, credentials; warns on committed .env credentials, plaintext SMTP, null in non-dev, missing failover, sendmail in container, embedded credentials',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mailer_dsn_config_stats',
      description: 'Show mailer DSN statistics: transport type, failover/roundrobin/null/API flags, credential embedding status, .env commit status, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
