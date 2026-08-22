import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface MailerBounceHandlingInfo {
  source: string;
  type: 'webhook' | 'verp' | 'event-listener' | 'unsubscribe' | 'transport';
  pattern: string;
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

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function detectTransportType(dsn: string): string {
  if (dsn.startsWith('postmark://')) return 'postmark';
  if (dsn.startsWith('sendgrid://')) return 'sendgrid';
  if (dsn.startsWith('mailgun://')) return 'mailgun';
  if (dsn.startsWith('ses://') || dsn.startsWith('ses+smtp://')) return 'ses';
  if (dsn.startsWith('smtp://') || dsn.startsWith('smtps://')) return 'smtp';
  return 'unknown';
}

function buildSymfonyMailerBounceHandlingInfos(appPath: string): MailerBounceHandlingInfo[] {
  const results: MailerBounceHandlingInfo[] = [];
  let transportType = 'unknown';
  let hasBounceListener = false;
  let hasWebhookRoute = false;

  // Check mailer.yaml
  const mailerYaml = path.join(appPath, 'config', 'packages', 'mailer.yaml');
  if (fs.existsSync(mailerYaml)) {
    const content = readFileSafe(mailerYaml);
    const dsnMatch = content.match(/dsn:\s*(\S+)/);
    if (dsnMatch) {
      const dsn = dsnMatch[1].replace(/['"]/g, '');
      transportType = detectTransportType(dsn);
      results.push({ source: 'config/packages/mailer.yaml', type: 'transport', pattern: `${transportType} transport`, issues: [] });

      if (transportType === 'smtp') {
        results.push({ source: 'config/packages/mailer.yaml', type: 'transport', pattern: 'smtp without bounce handling', issues: ['SMTP transport without bounce handling — direct SMTP connections need VERP or bounce email parsing; consider Postmark/SendGrid/Mailgun which provide bounce webhooks'] });
      }
    }
  }

  // Check .env for MAILER_DSN
  const envFiles = ['.env', '.env.local'];
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    const content = readFileSafe(envPath);
    const match = content.match(/MAILER_DSN=(.+)/);
    if (match) {
      const dsn = match[1].trim();
      transportType = detectTransportType(dsn);
      results.push({ source: envFile, type: 'transport', pattern: `MAILER_DSN=${transportType}`, issues: [] });
    }
  }

  // Scan PHP files for bounce listeners and webhook handlers
  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = readFileSafe(file);
      const rel = path.relative(appPath, file);

      if (content.includes('implements MessageListener') || content.includes('SentMessage') || content.includes('onMessage')) {
        hasBounceListener = true;
        results.push({ source: rel, type: 'event-listener', pattern: 'Mailer event listener', issues: [] });
      }
      if (/bounce/i.test(path.basename(file)) || /bounce/i.test(content.slice(0, 500))) {
        hasBounceListener = true;
        results.push({ source: rel, type: 'event-listener', pattern: 'bounce handler class', issues: [] });
      }
    }
  }

  // Check routing files for inbound webhook routes
  const configDirs = [path.join(appPath, 'config', 'routes'), path.join(appPath, 'config')];
  for (const dir of configDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const stat = fs.statSync(dir);
      const files = stat.isDirectory() ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [dir];
      for (const f of files) {
        const content = readFileSafe(f);
        if (content.includes('/webhook/bounce') || content.includes('/inbound') || content.includes('/bounce')) {
          hasWebhookRoute = true;
          results.push({ source: path.relative(appPath, f), type: 'webhook', pattern: 'bounce webhook route', issues: [] });
        }
      }
    } catch { /* skip */ }
  }

  // Warn if transactional transport but no bounce listener
  const transactionalTransports = ['postmark', 'sendgrid', 'mailgun', 'ses'];
  if (transactionalTransports.includes(transportType) && !hasBounceListener) {
    results.push({ source: 'project', type: 'event-listener', pattern: 'no bounce listener', issues: ['Transactional email transport without bounce event listener — implement MessageListener to handle hard/soft bounces and maintain clean email lists'] });
  }

  if (transactionalTransports.includes(transportType) && !hasWebhookRoute) {
    results.push({ source: 'project', type: 'webhook', pattern: 'no webhook endpoint', issues: ['Email transport supports bounce webhooks but no webhook endpoint found — configure and handle bounce webhooks to maintain deliverability'] });
  }

  return results;
}

export function listSymfonyMailerBounceHandling(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyMailerBounceHandlingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No mailer bounce handling configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Mailer Bounce Handling Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerBounceHandlingStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyMailerBounceHandlingInfos(appPath);
    let text = `Symfony Mailer Bounce Handling Statistics\n${'='.repeat(40)}\n\n`;
    text += `Webhook:         ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `VERP:            ${infos.filter((i) => i.type === 'verp').length}\n`;
    text += `Event-listener:  ${infos.filter((i) => i.type === 'event-listener').length}\n`;
    text += `Unsubscribe:     ${infos.filter((i) => i.type === 'unsubscribe').length}\n`;
    text += `Transport:       ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerBounceHandlingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_mailer_bounce_handling', description: 'Analyze Symfony Mailer bounce handling: webhook endpoints, event listeners, VERP, transport type detection, missing bounce handling warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_mailer_bounce_handling_stats', description: 'Statistics for mailer bounce handling: counts by type (webhook/verp/event-listener/unsubscribe/transport) and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
