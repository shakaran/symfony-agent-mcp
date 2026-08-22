/**
 * Symfony Mailer SMTP Fallback Inspector
 *
 * Scans config/**\/*.yaml and .env* files for SMTP transport fallback patterns:
 *   - MAILER_DSN without failover:// or roundrobin:// in production
 *   - Old failover+smtp:// DSN syntax vs new failover(...) format
 *   - Missing second transport in failover DSN
 *   - roundrobin:// without at least 2 transports
 *   - async transport (messenger://) without fallback
 *   - Credentials masked before output
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MailerDsnInfo {
  source: string;
  rawDsn: string;
  maskedDsn: string;
  transportType: string;
  isFailover: boolean;
  isRoundrobin: boolean;
  isAsync: boolean;
  isSingleTransport: boolean;
  transportCount: number;
  usesOldSyntax: boolean;
  issues: string[];
}

function maskCredentials(dsn: string): string {
  // Mask user:password@ in DSN
  return dsn.replace(/(:\/\/)([^:@]+):([^@]+)@/g, '$1$2:***@');
}

function countTransports(dsn: string): number {
  // New format: failover(smtp://... smtp://...)
  const newFormatMatch = /(?:failover|roundrobin)\(([^)]+)\)/i.exec(dsn);
  if (newFormatMatch) {
    // Split by whitespace-separated smtp:// entries
    return newFormatMatch[1].trim().split(/\s+/).filter((s) => s.includes('://')).length;
  }

  // Old format: failover+smtp://host1:port smtp://host2:port
  const oldFormatMatch = /failover\+\w+:\/\/(.+)/i.exec(dsn);
  if (oldFormatMatch) {
    return oldFormatMatch[1].trim().split(/\s+/).filter((s) => s.length > 0).length;
  }

  return 1;
}

function analyzeDsn(dsn: string, source: string): MailerDsnInfo {
  const maskedDsn = maskCredentials(dsn);
  const isFailover = /failover/i.test(dsn);
  const isRoundrobin = /roundrobin/i.test(dsn);
  const isAsync = dsn.includes('messenger://') || dsn.includes('async');
  const usesOldSyntax = /failover\+\w+:\/\//.test(dsn) || /roundrobin\+\w+:\/\//.test(dsn);

  const transportCount = countTransports(dsn);
  const isSingleTransport = !isFailover && !isRoundrobin && !isAsync;

  let transportType = 'smtp';
  if (dsn.startsWith('null://')) transportType = 'null';
  else if (dsn.startsWith('sendmail://')) transportType = 'sendmail';
  else if (dsn.startsWith('ses://') || dsn.startsWith('ses+smtp://')) transportType = 'ses';
  else if (dsn.startsWith('mailchimp://') || dsn.startsWith('mandrill://')) transportType = 'mandrill';
  else if (dsn.startsWith('sendgrid://')) transportType = 'sendgrid';
  else if (isAsync) transportType = 'messenger/async';
  else if (isFailover) transportType = 'failover';
  else if (isRoundrobin) transportType = 'roundrobin';

  const issues: string[] = [];

  if (usesOldSyntax) {
    issues.push(`Old DSN syntax "${dsn.split('://')[0]}://" — use the new format: failover(smtp://host1 smtp://host2)`);
  }

  if (isFailover && transportCount < 2) {
    issues.push('failover DSN has fewer than 2 transports — failover requires at least 2 SMTP servers to be useful');
  }

  if (isRoundrobin && transportCount < 2) {
    issues.push('roundrobin DSN has fewer than 2 transports — roundrobin requires at least 2 SMTP servers');
  }

  if (isSingleTransport && transportType !== 'null') {
    issues.push(`Single-transport DSN without failover — if "${source}" is used in production, consider wrapping with failover(${maskedDsn} smtp://backup-host) for resilience`);
  }

  if (isAsync) {
    issues.push('messenger:// (async) transport — ensure a fallback sync transport is configured if Messenger workers are down');
  }

  return {
    source,
    rawDsn: dsn,
    maskedDsn,
    transportType,
    isFailover,
    isRoundrobin,
    isAsync,
    isSingleTransport,
    transportCount,
    usesOldSyntax,
    issues,
  };
}

function readEnvFiles(appPath: string): Array<{ source: string; content: string }> {
  const resolvedBase = path.resolve(appPath);
  const envFiles = ['.env', '.env.local', '.env.prod', '.env.production', '.env.staging'];
  const result: Array<{ source: string; content: string }> = [];

  for (const envFile of envFiles) {
    const filePath = path.join(resolvedBase, envFile);
    if (!path.resolve(filePath).startsWith(resolvedBase + path.sep) && filePath !== path.join(resolvedBase, envFile)) continue;
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    result.push({ source: envFile, content });
  }

  return result;
}

function readYamlMailerConfig(appPath: string): Array<{ source: string; dsn: string }> {
  const resolvedBase = path.resolve(appPath);
  const configDir = path.join(resolvedBase, 'config');
  const results: Array<{ source: string; dsn: string }> = [];

  if (!fs.existsSync(configDir)) return results;

  function scanDir(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (!path.resolve(full).startsWith(resolvedBase + path.sep)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
          if (!content.includes('mailer') && !content.includes('MAILER')) return;

          const dsnRegex = /dsn:\s*['"]?(%env[^%\s]+%|[a-z][\w+.:-]{2,}:\/\/[^\s'"]+)['"]?/gi;
          let m: RegExpExecArray | null;
          while ((m = dsnRegex.exec(content)) !== null) {
            results.push({ source: path.relative(appPath, full), dsn: m[1] });
          }
        }
      }
    } catch { /* skip */ }
  }

  scanDir(configDir);
  return results;
}

function buildAnalysis(appPath: string): MailerDsnInfo[] {
  const findings: MailerDsnInfo[] = [];

  // Scan .env files for MAILER_DSN
  for (const { source, content } of readEnvFiles(appPath)) {
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      const match = /^MAILER_DSN\s*=\s*(.+)$/.exec(line.trim());
      if (match) {
        const dsn = match[1].trim().replace(/^['"]|['"]$/g, '');
        findings.push(analyzeDsn(dsn, source));
      }
    }
  }

  // Scan YAML for framework.mailer.dsn
  for (const { source, dsn } of readYamlMailerConfig(appPath)) {
    if (!dsn.startsWith('%')) {
      // Only analyze literal DSNs (not env vars placeholder — those are already in .env)
      findings.push(analyzeDsn(dsn, source));
    }
  }

  return findings;
}

export function listSymfonyMailerSmtpFallback(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const findings = buildAnalysis(appPath);

    if (findings.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No MAILER_DSN found in .env files or config YAML.\n\nSet MAILER_DSN in .env:\n  MAILER_DSN=smtp://user:password@smtp.example.com:587\n\nFor failover:\n  MAILER_DSN=failover(smtp://primary:587 smtp://backup:587)',
        }],
      };
    }

    let text = `Symfony Mailer SMTP Fallback Audit\n${'='.repeat(55)}\n\n`;

    for (const f of findings) {
      text += `Source: ${f.source}\n`;
      text += `  DSN (masked): ${f.maskedDsn}\n`;
      text += `  Transport:    ${f.transportType}\n`;
      text += `  Failover:     ${f.isFailover}  Roundrobin: ${f.isRoundrobin}  Async: ${f.isAsync}\n`;
      if (f.isFailover || f.isRoundrobin) {
        text += `  Transport count: ${f.transportCount}\n`;
      }
      if (f.issues.length > 0) {
        text += `  Issues:\n`;
        for (const issue of f.issues) {
          text += `    - ${issue}\n`;
        }
      } else {
        text += `  [OK — no issues]\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyMailerSmtpFallbackStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const findings = buildAnalysis(appPath);

    let text = `Symfony Mailer SMTP Fallback Stats\n${'='.repeat(40)}\n\n`;
    text += `DSN configurations found: ${findings.length}\n`;
    text += `With failover:            ${findings.filter((f) => f.isFailover).length}\n`;
    text += `With roundrobin:          ${findings.filter((f) => f.isRoundrobin).length}\n`;
    text += `Async (messenger):        ${findings.filter((f) => f.isAsync).length}\n`;
    text += `Single transport:         ${findings.filter((f) => f.isSingleTransport).length}\n`;
    text += `Using old DSN syntax:     ${findings.filter((f) => f.usesOldSyntax).length}\n`;
    text += `With issues:              ${findings.filter((f) => f.issues.length > 0).length}\n`;
    text += `Total issues:             ${findings.reduce((s, f) => s + f.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyMailerSmtpFallbackTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_mailer_smtp_fallback',
      description: 'Scan .env files and YAML config for Symfony Mailer SMTP fallback issues: single transport without failover, old failover+smtp:// syntax, insufficient transports in failover/roundrobin, async without sync fallback — credentials masked in output',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_mailer_smtp_fallback_stats',
      description: 'Statistics for Symfony Mailer SMTP transport: DSN count, failover/roundrobin/async/single counts, old syntax usage, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
