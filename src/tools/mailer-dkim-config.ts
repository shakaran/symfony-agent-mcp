import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface MailerDkimInfo {
  transport: string;
  dsn: string;
  hasDkim: boolean;
  hasReturnPath: boolean;
  hasEnvelopeSender: boolean;
  hasSigningKey: boolean;
  issues: string[];
}

function maskDsn(dsn: string): string {
  return dsn.replace(/:[^:@\s]{1,200}@/, ':***@');
}

function loadMailerDkimConfig(appPath: string): MailerDkimInfo[] {
  const results: MailerDkimInfo[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'mailer.yaml'),
    path.join(appPath, 'config', 'mailer.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const frameworkConf = raw['framework'] as Record<string, unknown> | undefined;
    const mailer = (frameworkConf?.['mailer'] ?? raw['mailer'] ?? raw) as Record<string, unknown>;
    const transportConf = mailer['dsn'] ?? mailer['transports'];
    const transports: Array<[string, string]> = [];
    if (typeof transportConf === 'string') {
      transports.push(['default', transportConf]);
    } else if (transportConf && typeof transportConf === 'object') {
      for (const [name, dsn] of Object.entries(transportConf as Record<string, unknown>)) {
        transports.push([name, String(dsn)]);
      }
    }
    for (const [name, dsn] of transports) {
      const hasDkim = dsn.includes('dkim') || dsn.includes('DKIM');
      const hasReturnPath = dsn.includes('return_path') || dsn.includes('returnPath');
      const hasEnvelopeSender = dsn.includes('local_domain') || dsn.includes('envelope_sender');
      const hasSigningKey = hasDkim || dsn.includes('signing_key') || dsn.includes('private_key');
      const issues: string[] = [];
      if (!hasDkim && !dsn.includes('null://') && !dsn.includes('in-memory://')) {
        issues.push('No DKIM signing configured — emails may fail SPF/DKIM checks and land in spam');
      }
      if (!hasReturnPath && !dsn.includes('null://')) {
        issues.push('No Return-Path / bounce address configured — bounced emails cannot be tracked');
      }
      results.push({ transport: name, dsn: maskDsn(dsn), hasDkim, hasReturnPath, hasEnvelopeSender, hasSigningKey, issues });
    }
  }
  return results;
}

export function listMailerDkimConfig(appPath: string): McpToolResult {
  try {
    const configs = loadMailerDkimConfig(appPath);
    if (configs.length === 0) return { content: [{ type: 'text', text: 'No mailer transport configuration found.\n\nConfigure in config/packages/mailer.yaml:\n  framework:\n    mailer:\n      dsn: \'%env(MAILER_DSN)%\'' }] };
    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `Mailer DKIM / Bounce Configuration\n${'='.repeat(55)}\n\nTransports: ${configs.length}  Issues: ${totalIssues}\n`;
    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [c.hasDkim ? '✓DKIM' : '✗DKIM', c.hasReturnPath ? '✓Return-Path' : '✗Return-Path', c.hasEnvelopeSender ? '✓envelope' : ''].filter(Boolean).join('  ');
      text += `\n  ${c.transport}  ${flags}\n    DSN: ${c.dsn}\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailerDkimStats(appPath: string): McpToolResult {
  try {
    const configs = loadMailerDkimConfig(appPath);
    let text = `Mailer DKIM Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports: ${configs.length}\n  With DKIM: ${configs.filter(c => c.hasDkim).length}\n  With Return-Path: ${configs.filter(c => c.hasReturnPath).length}\n  With signing key: ${configs.filter(c => c.hasSigningKey).length}\nIssues: ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailerDkimTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_mailer_dkim_config', description: 'Check mailer DKIM signing and bounce config from mailer.yaml DSN: DKIM presence, Return-Path/bounce address, envelope-sender, missing DKIM warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_mailer_dkim_stats', description: 'Mailer DKIM statistics: transport count, DKIM/Return-Path/signing-key coverage, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
