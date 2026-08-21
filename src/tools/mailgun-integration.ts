import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MailgunIntegrationInfo {
  file: string;
  type: 'transactional' | 'batch' | 'webhook' | 'validation' | 'config';
  domain: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return files;
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const full = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectPhpFiles(full, base));
      else if (entry.isFile() && entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function maskApiKey(value: string): string {
  if (!value || value.startsWith('${') || value.startsWith('%')) return value;
  return '***';
}

function isSandboxDomain(domain: string): boolean {
  return domain.includes('sandbox') || domain.endsWith('.mailgun.org');
}

function buildMailgunIntegrationInfos(appPath: string): MailgunIntegrationInfo[] {
  const results: MailgunIntegrationInfo[] = [];

  // Check composer.json
  const composerContent = safeRead(path.join(appPath, 'composer.json'), appPath);
  if (composerContent) {
    if (composerContent.includes('mailgun/mailgun-php')) {
      results.push({ file: 'composer.json', type: 'config', domain: '', issues: [] });
    }
    if (composerContent.includes('symfony/mailgun-mailer')) {
      results.push({ file: 'composer.json', type: 'config', domain: '', issues: [] });
    }
  }

  // Scan .env* files
  const envFiles = ['.env', '.env.local', '.env.test', '.env.prod'];
  let detectedDomain = '';
  let isEuDomain = false;

  for (const fname of envFiles) {
    const content = safeRead(path.join(appPath, fname), appPath);
    if (!content) continue;

    const apiKeyMatch = /MAILGUN_API_KEY\s*=\s*([^\n]+)/.exec(content);
    const domainMatch = /MAILGUN_DOMAIN\s*=\s*([^\n]+)/.exec(content);
    const mailerDsnMatch = /MAILER_DSN\s*=\s*([^\n]+)/.exec(content);

    if (apiKeyMatch) {
      const val = apiKeyMatch[1].trim();
      const issues: string[] = [];
      if (val && !val.startsWith('%') && !val.startsWith('${') && !val.startsWith('key-')) {
        // Looks like a hardcoded key (not a reference)
        if (val.length > 10) {
          issues.push(`MAILGUN_API_KEY in ${fname} appears hardcoded ("${maskApiKey(val)}") — inject via CI secrets; never commit API keys to version control`);
        }
      }
      results.push({ file: fname, type: 'config', domain: detectedDomain, issues });
    }

    if (domainMatch) {
      detectedDomain = domainMatch[1].trim().replace(/^['"]|['"]$/g, '');
      const issues: string[] = [];
      isEuDomain = detectedDomain.includes('.eu.') || detectedDomain.endsWith('.eu');
      if (isSandboxDomain(detectedDomain) && fname === '.env.prod') {
        issues.push(`MAILGUN_DOMAIN "${detectedDomain}" looks like a sandbox domain in prod config — use a real verified sending domain for production`);
      }
      results.push({ file: fname, type: 'config', domain: detectedDomain, issues });
    }

    if (mailerDsnMatch) {
      const dsn = mailerDsnMatch[1].trim();
      if (dsn.includes('mailgun')) {
        const issues: string[] = [];
        // Check for EU endpoint requirement
        if (!isEuDomain && !dsn.includes('eu.api.mailgun.net') && !dsn.includes('endpoint=')) {
          issues.push(`MAILER_DSN in ${fname} uses Mailgun without explicit EU endpoint — if domain is registered in EU region, add endpoint option to comply with GDPR data residency`);
        }
        if (dsn.includes('key-') || /key-[a-f0-9]{32}/.test(dsn)) {
          issues.push(`MAILER_DSN in ${fname} contains what looks like a hardcoded Mailgun API key — use env var reference (key=%env(MAILGUN_API_KEY)%)`);
        }
        results.push({ file: fname, type: 'transactional', domain: detectedDomain, issues });
      }
    }
  }

  // Check config/packages/mailer.yaml
  const mailerConfig = safeRead(path.join(appPath, 'config', 'packages', 'mailer.yaml'), appPath);
  if (mailerConfig && mailerConfig.includes('mailgun')) {
    const issues: string[] = [];
    if (!mailerConfig.includes('eu.api.mailgun.net') && !mailerConfig.includes('endpoint:')) {
      issues.push('mailer.yaml Mailgun DSN without explicit EU endpoint — add endpoint for EU data residency compliance');
    }
    results.push({ file: 'config/packages/mailer.yaml', type: 'config', domain: detectedDomain, issues });
  }

  // Scan src/**/*.php for Mailgun PHP usage
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const filePath of collectPhpFiles(srcDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      const hasMailgun = content.includes('MailgunClient') ||
        content.includes('->messages()->send(') ||
        content.includes('->suppressions()->') ||
        content.includes('Mailgun::create(') ||
        content.includes('MailgunTransport');

      if (!hasMailgun) continue;

      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];

      if (content.includes('->messages()->send(') && !content.includes('->webhooks()') && !content.includes('verifyWebhookSignature')) {
        // Webhook signature check only relevant if webhooks are also used
      }

      if (content.includes('->suppressions()->')) {
        results.push({ file: relFile, type: 'validation', domain: detectedDomain, issues });
      } else if (content.includes('->messages()->send(')) {
        // Check for batch sending without recipient variables
        if (!content.includes('recipient-variables') && !content.includes('recipientVariables')) {
          issues.push(`Mailgun send in ${relFile} without recipient-variables — for batch sends >1 recipient, use recipient variables for personalization and to avoid reply-all exposure`);
        }
        results.push({ file: relFile, type: 'batch', domain: detectedDomain, issues });
      } else {
        results.push({ file: relFile, type: 'transactional', domain: detectedDomain, issues });
      }
    }
  }

  // Scan for webhook handlers without signature validation
  const srcDir2 = path.join(appPath, 'src');
  if (fs.existsSync(srcDir2)) {
    for (const filePath of collectPhpFiles(srcDir2, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;
      if (!content.includes('mailgun') && !content.includes('Mailgun')) continue;
      if (!content.includes('webhook') && !content.includes('Webhook')) continue;

      const relFile = path.relative(appPath, filePath);
      const issues: string[] = [];

      if (!content.includes('verifyWebhookSignature') && !content.includes('X-Mailgun-Signature') && !content.includes('token') && !content.includes('signature')) {
        issues.push(`Mailgun webhook handler in ${relFile} with no signature verification — validate X-Mailgun-Signature to prevent spoofed webhook events`);
      }

      results.push({ file: relFile, type: 'webhook', domain: detectedDomain, issues });
    }
  }

  return results;
}

export function listMailgunIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildMailgunIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Mailgun integration found (mailgun/mailgun-php, symfony/mailgun-mailer, MAILGUN_* env vars).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Mailgun Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const domainStr = info.domain ? `  domain:${info.domain}` : '';
      text += `\n  [${info.type.toUpperCase()}]${domainStr}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailgunIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildMailgunIntegrationInfos(appPath);
    let text = `Mailgun Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total patterns:    ${infos.length}\n`;
    text += `  config:          ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `  transactional:   ${infos.filter((i) => i.type === 'transactional').length}\n`;
    text += `  batch:           ${infos.filter((i) => i.type === 'batch').length}\n`;
    text += `  webhook:         ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `  validation:      ${infos.filter((i) => i.type === 'validation').length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMailgunIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_mailgun_integration',
      description: 'Analyze Mailgun integration: detect mailgun/mailgun-php and symfony/mailgun-mailer in composer.json; scan .env* for MAILGUN_API_KEY/DOMAIN/MAILER_DSN; scan src/**/*.php for MailgunClient/messages()->send/suppressions; check mailer.yaml; flag hardcoded API key, missing EU endpoint for GDPR, no webhook signature validation, sandbox domain in prod; masks API key values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_mailgun_integration_stats',
      description: 'Statistics for Mailgun integration: pattern counts by type (config/transactional/batch/webhook/validation) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
