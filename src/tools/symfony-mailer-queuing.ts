import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MailerQueuingInfo {
  source: string;
  type: 'async-transport' | 'sync-transport' | 'messenger-integration' | 'config' | 'handler';
  pattern: string;
  issues: string[];
}

function buildMailerQueuingInfos(appPath: string): MailerQueuingInfo[] {
  const results: MailerQueuingInfo[] = [];

  const mailerYaml = path.join(appPath, 'config', 'packages', 'mailer.yaml');
  if (fs.existsSync(mailerYaml)) {
    const cfg = parseYamlFile(mailerYaml) as Record<string, unknown> | null;
    if (cfg) {
      const mailer = (cfg['framework'] ?? cfg['mailer'] ?? {}) as Record<string, unknown>;
      const dsn = String(mailer['dsn'] ?? mailer['transport'] ?? '');
      const issues: string[] = [];

      const isAsync = dsn.startsWith('%env(MAILER') || dsn.includes('sendmail') || dsn.includes('smtp://') || dsn.includes('null://') || dsn.includes('log://');
      const isMessengerRouted = dsn.includes('messenger://') || String(mailer['message_bus'] ?? '').length > 0;

      if (!isMessengerRouted && isAsync && dsn.includes('smtp://')) {
        issues.push('Mailer uses SMTP without Messenger routing — email is sent synchronously during request processing; add message_bus configuration to send via Messenger async transport');
      }

      if (dsn.includes('null://') || dsn.includes('log://')) {
        results.push({ source: 'mailer.yaml', type: 'sync-transport', pattern: `transport: ${dsn.substring(0, 30)}`, issues: ['Mailer using null/log transport — no emails actually delivered; configure a real SMTP/SES/Postmark transport for production'] });
      }

      if (isMessengerRouted) {
        results.push({ source: 'mailer.yaml', type: 'messenger-integration', pattern: 'Messenger-routed mail', issues: [] });
      } else if (isAsync) {
        results.push({ source: 'mailer.yaml', type: 'sync-transport', pattern: `SMTP transport: ${dsn.substring(0, 30)}`, issues });
      }
    }
  }

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    const hasMailerRoute = content.includes('MailerInterface') || content.includes('Mailer\\Messenger') || content.includes('SendEmailMessage') || content.includes('mailer.messenger_message');
    if (hasMailerRoute) {
      const hasFailure = content.includes('failure_transport:');
      const issues: string[] = [];
      if (!hasFailure) {
        issues.push('Mailer messages routed through Messenger without failure_transport — failed email sends are discarded silently; add failure_transport to capture failed deliveries');
      }
      results.push({ source: 'messenger.yaml', type: 'async-transport', pattern: 'Mailer via Messenger', issues });
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            const content = safeRead(full, appPath);
            if (content === null) return;
            if (!content.includes('MailerInterface') && !content.includes('->send(') && !content.includes('Email()')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasEmailInRequestCycle = content.includes('AbstractController') || content.includes('#[Route');
            if (hasEmailInRequestCycle) {
              const hasAsync = content.includes('dispatch(') || content.includes('bus->dispatch') || content.includes('SendEmailMessage');
              if (!hasAsync) {
                issues.push(`Email sent directly in controller "${relFile}" — synchronous email sending blocks request completion; dispatch via Messenger for async delivery`);
              }
            }

            const hasLoop = /foreach[\s\S]{0,100}->send\(|for\s*\([\s\S]{0,100}->send\(/.test(content);
            if (hasLoop) {
              issues.push(`Bulk email sending loop in "${relFile}" — sending in a loop blocks the request for O(n) SMTP round-trips; dispatch individual SendEmailMessage for each recipient`);
            }

            results.push({ source: relFile, type: 'handler', pattern: 'email send call', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listSymfonyMailerQueuing(appPath: string): McpToolResult {
  try {
    const infos = buildMailerQueuingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony Mailer queuing patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Mailer Queuing Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerQueuingStats(appPath: string): McpToolResult {
  try {
    const infos = buildMailerQueuingInfos(appPath);
    let text = `Mailer Queuing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Async routes:  ${infos.filter((i) => i.type === 'async-transport').length}\n`;
    text += `Sync sends:    ${infos.filter((i) => i.type === 'sync-transport').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMailerQueuingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_mailer_queuing', description: 'Analyze Symfony Mailer + Messenger async queuing; warns on synchronous SMTP blocking requests, email sent in controller without dispatch, bulk email loop, Messenger routing without failure transport, null/log transport in production', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_mailer_queuing_stats', description: 'Statistics for mailer queuing: async/sync count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
