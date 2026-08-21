/**
 * Symfony Mailer Transport DSN Inspector
 *
 * Distinct from mailer.ts (mailer config/envelopes) and symfony-mailer-events.ts (events).
 * Focuses on Mailer transport DSN parsing and analysis:
 *
 * Transport types:
 *   - smtp://user:pass@smtp.example.com:587
 *   - smtps://user:pass@smtp.example.com:465
 *   - sendmail://default
 *   - amazon-ses+smtp://ACCESS_KEY:SECRET@default
 *   - amazon-ses+api://ACCESS_KEY:SECRET@default
 *   - mailgun+api://KEY:DOMAIN@default
 *   - mailgun+smtp://KEY:DOMAIN@default
 *   - postmark+api://TOKEN@default
 *   - sendgrid+api://KEY@default
 *   - mailchimp+api://KEY@default
 *   - brevo+smtp://LOGIN:KEY@default
 *   - null://null    — discards all messages (test/dev)
 *   - test://null    — collects for assertions (test)
 *
 * Failover and round-robin:
 *   - failover(smtp://primary postmark+api://key@default)
 *   - roundrobin(smtp://a mailgun+api://b@default)
 *
 * Security analysis:
 *   - Credentials hardcoded in DSN (not using %env(...)%)
 *   - smtp:// without TLS (port 25/587 without encryption flag)
 *   - null:// transport in non-dev/test environment
 *
 * Pure static analysis — credential values masked in output.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TransportInfo {
  dsn: string;
  scheme: string;
  isEnvRef: boolean;
  isNullTransport: boolean;
  isTestTransport: boolean;
  isFailover: boolean;
  isRoundRobin: boolean;
  hasHardcodedCreds: boolean;
  environment: string;
  issues: string[];
}

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***')
    .replace(/%env\([^)]+\)%/g, '%env(...)%');
}

function parseDsn(dsn: string, env: string): TransportInfo {
  const isEnvRef      = dsn.startsWith('%env(') || dsn.includes('%env(');
  const isFailover    = dsn.startsWith('failover(');
  const isRoundRobin  = dsn.startsWith('roundrobin(');
  const normalDsn     = dsn.replace(/^(failover|roundrobin)\(/, '').replace(/\)$/, '').split(' ')[0];

  const schemeM  = /^([a-z0-9_+-]+):\/\//.exec(normalDsn);
  const scheme   = schemeM?.[1] ?? 'unknown';

  const isNullTransport = scheme === 'null';
  const isTestTransport = scheme === 'test';

  // Detect hardcoded credentials: scheme://something:something@host (not env refs)
  const credM = /^[a-z0-9_+-]+:\/\/([^@\s%]+):([^@\s%]+)@/.exec(normalDsn);
  const hasHardcodedCreds = !isEnvRef && !!credM &&
    !credM[1].startsWith('%') && !credM[2].startsWith('%') &&
    credM[1] !== 'default' && credM[2] !== 'default';

  const issues: string[] = [];
  if (hasHardcodedCreds) {
    issues.push(`Credentials hardcoded in DSN — use MAILER_DSN=%env(MAILER_DSN)% reference`);
  }
  if (isNullTransport && env === 'prod') {
    issues.push('null:// transport in production — all emails silently discarded');
  }
  if (scheme === 'smtp' && (normalDsn.includes(':25') || (!normalDsn.includes(':587') && !normalDsn.includes(':465') && !normalDsn.includes('ssl')))) {
    issues.push('smtp:// without explicit TLS port (465/587) — verify encryption is configured');
  }

  return {
    dsn: maskDsn(dsn),
    scheme,
    isEnvRef,
    isNullTransport,
    isTestTransport,
    isFailover,
    isRoundRobin,
    hasHardcodedCreds,
    environment: env,
    issues,
  };
}

function loadTransports(appPath: string): TransportInfo[] {
  const envDirs = ['', 'dev', 'prod', 'test', 'staging'];
  const transports: TransportInfo[] = [];

  for (const envDir of envDirs) {
    const candidates = [
      path.join(appPath, 'config', 'packages', ...(envDir ? [envDir] : []), 'mailer.yaml'),
      path.join(appPath, 'config', 'packages', ...(envDir ? [envDir] : []), 'framework.yaml'),
    ];
    for (const filePath of candidates) {
      const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
      if (!raw) continue;

      const mailerRaw = (raw['framework'] ?? raw) as Record<string, unknown>;
      const mailer    = (mailerRaw['mailer'] ?? mailerRaw) as Record<string, unknown>;

      const dsn = mailer['dsn'] ? String(mailer['dsn']) : null;
      if (dsn) {
        const env = envDir || 'all';
        transports.push(parseDsn(dsn, env));
      }

      // Multiple transports
      const txs = (mailer['transports'] ?? {}) as Record<string, unknown>;
      for (const [, val] of Object.entries(txs)) {
        if (typeof val === 'string') {
          transports.push(parseDsn(val, envDir || 'all'));
        }
      }
    }
  }

  // Also check .env files
  for (const envFile of ['.env', '.env.local', '.env.prod']) {
    const envPath = path.join(appPath, envFile);
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const m of content.matchAll(/MAILER_DSN\s*=\s*(.+)/g)) {
        const dsn = m[1].trim().replace(/^["']|["']$/g, '');
        if (dsn && !dsn.startsWith('#')) {
          transports.push(parseDsn(dsn, envFile.replace('.env', '') || 'all'));
        }
      }
    } catch { /* skip */ }
  }

  return transports;
}

export function listMailerTransports(appPath: string): McpToolResult {
  try {
    const transports = loadTransports(appPath);

    if (transports.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No mailer transport DSN found.\n\nConfigure in .env:\n  MAILER_DSN=smtp://user:pass@smtp.example.com:587\n\nOr in config/packages/mailer.yaml:\n  framework:\n    mailer:\n      dsn: \'%env(MAILER_DSN)%\'',
        }],
      };
    }

    const totalIssues = transports.reduce((s, t) => s + t.issues.length, 0);

    let text = `Mailer Transport DSN Analysis\n${'='.repeat(55)}\n`;
    text += `\nTransports found: ${transports.length}  Issues: ${totalIssues}\n`;

    for (const t of transports) {
      const env     = t.environment !== 'all' ? `  [${t.environment}]` : '';
      const flags   = [
        t.isEnvRef ? 'env-ref' : '',
        t.isFailover ? 'failover' : '',
        t.isRoundRobin ? 'round-robin' : '',
        t.isNullTransport ? '⚠ null' : '',
        t.isTestTransport ? 'test' : '',
      ].filter(Boolean).join('  ');

      text += `\n  scheme: ${t.scheme.padEnd(16)} ${flags}${env}\n`;
      text += `  DSN: ${t.dsn}\n`;
      for (const issue of t.issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerTransportStats(appPath: string): McpToolResult {
  try {
    const transports = loadTransports(appPath);

    let text = `Mailer Transport Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports:    ${transports.length}\n`;
    text += `  Using env refs:    ${transports.filter((t) => t.isEnvRef).length}\n`;
    text += `  Hardcoded creds:   ${transports.filter((t) => t.hasHardcodedCreds).length}\n`;
    text += `  Failover:          ${transports.filter((t) => t.isFailover).length}\n`;
    text += `  Null (discard):    ${transports.filter((t) => t.isNullTransport).length}\n`;
    text += `  Test (collect):    ${transports.filter((t) => t.isTestTransport).length}\n`;
    text += `Issues:              ${transports.reduce((s, t) => s + t.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMailerTransportTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mailer_transports',
      description: 'Show Symfony Mailer transport DSN analysis: scheme detection (smtp/amazon-ses/mailgun/postmark/sendgrid/null/test), failover/roundrobin, env-ref vs hardcoded credentials (masked), null:// in prod warning, smtp without TLS warning; reads mailer.yaml and .env files',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mailer_transport_stats',
      description: 'Show mailer transport statistics: transport count, env-ref count, hardcoded credential count, failover count, null/test count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
