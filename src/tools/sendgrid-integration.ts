// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SendgridIntegrationInfo {
  file: string;
  type: 'transactional' | 'template' | 'webhook' | 'suppression';
  config: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(val: string): string {
  return val.replace(/(?<=[=:]\s*)[a-zA-Z0-9_-]{4,}/g, '***');
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildSendgridIntegrationInfos(appPath: string): SendgridIntegrationInfo[] {
  const results: SendgridIntegrationInfo[] = [];

  // Check composer.json for sendgrid/sendgrid
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent && composerContent.includes('sendgrid/sendgrid')) {
    results.push({ file: 'composer.json', type: 'transactional', config: 'sdk:sendgrid/sendgrid', issues: [] });
  }

  // Scan .env* files
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const apiKeyMatch = /SENDGRID_API_KEY\s*=\s*([^\n]+)/.exec(content);
    if (apiKeyMatch) {
      const rawKey = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (rawKey && !rawKey.startsWith('%env(') && !rawKey.startsWith('${') && rawKey !== '') {
        issues.push(`SENDGRID_API_KEY present in ${fname} — inject via CI secrets; never commit API keys to version control`);
      }
      results.push({ file: fname, type: 'transactional', config: maskSecrets(`SENDGRID_API_KEY=${rawKey}`), issues });
    }

    const mailerDsnMatch = /MAILER_DSN\s*=\s*([^\n]+)/.exec(content);
    if (mailerDsnMatch && mailerDsnMatch[1].toLowerCase().includes('sendgrid')) {
      results.push({ file: fname, type: 'transactional', config: maskSecrets(`MAILER_DSN=${mailerDsnMatch[1].trim()}`), issues: [] });
    }
  }

  // Scan src/**/*.php for SendGrid usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('SendGrid') &&
      !content.includes('TemplateEmail') &&
      !content.includes('sendgrid')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Hardcoded API key check
    if (/new\s+\\?SendGrid\s*\(\s*['"][a-zA-Z0-9._-]{20,}/.test(content)) {
      issues.push(`Hardcoded SendGrid API key in ${relFile} — use SENDGRID_API_KEY env variable instead`);
    }

    // No sandbox mode check in dev context
    if (content.includes('->send(') && !content.includes('sandbox_mode') && !content.includes('sandboxMode')) {
      issues.push(`SendGrid send() in ${relFile} without sandbox mode — enable sandbox_mode in dev/test environments to prevent accidental email delivery`);
    }

    // Missing unsubscribe headers
    const hasSend = content.includes('->send(') || content.includes('new Mail(');
    if (hasSend) {
      const hasUnsubscribe = content.includes('List-Unsubscribe') || content.includes('unsubscribe') || content.includes('Unsubscribe');
      if (!hasUnsubscribe) {
        issues.push(`SendGrid email in ${relFile} missing unsubscribe headers — add List-Unsubscribe header to comply with CAN-SPAM/GDPR and reduce spam reports`);
      }
    }

    const type: SendgridIntegrationInfo['type'] = content.includes('TemplateEmail') || content.includes('setTemplateId') ? 'template'
      : content.includes('webhook') || content.includes('Webhook') ? 'webhook'
      : content.includes('suppression') || content.includes('Suppression') ? 'suppression'
      : 'transactional';

    results.push({ file: relFile, type, config: 'sendgrid-usage', issues });
  }

  return results;
}

export function listSendgridIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildSendgridIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SendGrid integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SendGrid Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.config}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSendgridIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildSendgridIntegrationInfos(appPath);
    let text = `SendGrid Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transactional: ${infos.filter((i) => i.type === 'transactional').length}\n`;
    text += `Template:      ${infos.filter((i) => i.type === 'template').length}\n`;
    text += `Webhook:       ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `Suppression:   ${infos.filter((i) => i.type === 'suppression').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSendgridIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_sendgrid_integration',
      description: 'Analyze SendGrid integration: detect composer SDK, env credentials (SENDGRID_API_KEY, MAILER_DSN), PHP usage of Mail/send/TemplateEmail, and flag hardcoded API key, no sandbox mode in dev, missing unsubscribe headers',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_sendgrid_integration_stats',
      description: 'Statistics for SendGrid integration: transactional/template/webhook/suppression pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
