import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ChatNotifierInfo {
  source: string;
  type: 'slack' | 'telegram' | 'discord' | 'teams' | 'rocketchat' | 'generic';
  dsn: string;
  issues: string[];
}

function detectChatType(dsn: string): ChatNotifierInfo['type'] {
  if (dsn.startsWith('slack://')) return 'slack';
  if (dsn.startsWith('telegram://')) return 'telegram';
  if (dsn.startsWith('discord://')) return 'discord';
  if (dsn.startsWith('microsoftteams://') || dsn.startsWith('teams://')) return 'teams';
  if (dsn.startsWith('rocketchat://')) return 'rocketchat';
  return 'generic';
}

function maskDsn(dsn: string): string {
  return dsn
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

function buildSymfonyChatNotifierInfos(appPath: string): ChatNotifierInfo[] {
  const results: ChatNotifierInfo[] = [];

  // Check notifier.yaml
  const notifierYaml = path.join(appPath, 'config', 'packages', 'notifier.yaml');
  if (fs.existsSync(notifierYaml)) {
    let content = '';
    try { content = fs.readFileSync(notifierYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('chatter_transports')) {
      const lines = content.split('\n');
      for (const line of lines) {
        const dsnMatch = line.match(/:\s*((?:slack|telegram|discord|teams|microsoftteams|rocketchat):\/\/\S+)/);
        if (dsnMatch) {
          const dsn = dsnMatch[1];
          const type = detectChatType(dsn);
          const issues: string[] = [];
          if (!dsn.includes('%env(') && !dsn.includes('%env ')) {
            issues.push(`Chat DSN contains literal token in notifier.yaml — move to environment variable: slack://TOKEN@... should be slack://%env(SLACK_TOKEN)%@...`);
          }
          results.push({ source: 'config/packages/notifier.yaml', type, dsn: maskDsn(dsn), issues });
        }
      }
    }
  }

  // Check .env and .env.local files
  const envFiles = ['.env', '.env.local'];
  const chatEnvVars = ['SLACK_DSN', 'TELEGRAM_DSN', 'DISCORD_DSN', 'MICROSOFT_TEAMS_DSN', 'ROCKETCHAT_DSN'];
  for (const envFile of envFiles) {
    const envPath = path.join(appPath, envFile);
    if (!fs.existsSync(envPath)) continue;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { continue; }
    for (const varName of chatEnvVars) {
      const match = content.match(new RegExp(`${varName}=(.+)`));
      if (match) {
        const dsn = match[1].trim();
        const type = detectChatType(dsn);
        const issues: string[] = [];
        if (type === 'slack' && /xoxb-\w+/.test(dsn)) {
          issues.push('Slack DSN contains literal bot token (xoxb-...) — do not commit tokens to version control; use secrets management');
        }
        results.push({ source: envFile, type, dsn: maskDsn(dsn), issues });
      }
    }
  }

  if (results.length === 0) {
    results.push({ source: 'config', type: 'generic', dsn: 'none', issues: ['No chat notifier transports configured — add chatter_transports in notifier.yaml to enable chat notifications'] });
  }

  return results;
}

export function listSymfonyChatNotifiers(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyChatNotifierInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No chat notifiers found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Chat Notifier Analysis\n${'='.repeat(55)}\n\nTransports: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.dsn}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyChatNotifierStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyChatNotifierInfos(appPath);
    let text = `Symfony Chat Notifier Statistics\n${'='.repeat(40)}\n\n`;
    text += `Slack:        ${infos.filter((i) => i.type === 'slack').length}\n`;
    text += `Telegram:     ${infos.filter((i) => i.type === 'telegram').length}\n`;
    text += `Discord:      ${infos.filter((i) => i.type === 'discord').length}\n`;
    text += `Teams:        ${infos.filter((i) => i.type === 'teams').length}\n`;
    text += `RocketChat:   ${infos.filter((i) => i.type === 'rocketchat').length}\n`;
    text += `Generic:      ${infos.filter((i) => i.type === 'generic').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyChatNotifierTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_chat_notifiers', description: 'Analyze Symfony chat notifier transports: Slack/Telegram/Discord/Teams/RocketChat DSN configuration, literal token detection, missing transport warnings', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_chat_notifier_stats', description: 'Statistics for Symfony chat notifiers: counts by type and total issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
