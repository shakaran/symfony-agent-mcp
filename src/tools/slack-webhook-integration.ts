import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SlackWebhookInfo {
  file: string;
  type: 'webhook' | 'api' | 'event' | 'slash-command';
  channel: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function buildSlackWebhookIntegrationInfos(appPath: string): SlackWebhookInfo[] {
  const results: SlackWebhookInfo[] = [];

  // Check composer.json for Slack packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (composerContent) {
    if (composerContent.includes('jolicode/slack-php-api')) {
      results.push({ file: 'composer.json', type: 'api', channel: '', issues: [] });
    }
    if (composerContent.includes('wrklst/slackhook')) {
      results.push({ file: 'composer.json', type: 'webhook', channel: '', issues: [] });
    }
  }

  // Scan .env* for Slack credentials
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const webhookMatch = /SLACK_WEBHOOK_URL\s*=\s*([^\n]+)/.exec(content);
    const tokenMatch = /SLACK_BOT_TOKEN\s*=\s*([^\n]+)/.exec(content);
    const signingMatch = /SLACK_SIGNING_SECRET\s*=\s*([^\n]+)/.exec(content);

    if (webhookMatch) {
      const rawUrl = webhookMatch[1].trim();
      const issues: string[] = [];
      if (rawUrl && rawUrl.startsWith('https://hooks.slack.com/') && !rawUrl.startsWith('%env(')) {
        issues.push(`SLACK_WEBHOOK_URL with hardcoded value in ${fname} — inject via CI secrets; webhook URLs grant access to post to your Slack workspace`);
      }
      results.push({ file: fname, type: 'webhook', channel: '', issues });
    }

    if (tokenMatch) {
      const rawToken = tokenMatch[1].trim();
      const issues: string[] = [];
      if (rawToken && rawToken.startsWith('xoxb-') && !rawToken.startsWith('%env(')) {
        issues.push(`SLACK_BOT_TOKEN present in ${fname} — inject via CI secrets; bot tokens have full API access to your Slack workspace`);
      }
      results.push({ file: fname, type: 'api', channel: '', issues });
    }

    if (!signingMatch && (webhookMatch || tokenMatch)) {
      results.push({
        file: fname,
        type: 'event',
        channel: '',
        issues: ['SLACK_SIGNING_SECRET not configured — without signing secret verification, Slack event endpoints accept requests from any source; verify X-Slack-Signature header on all event/slash-command endpoints'],
      });
    } else if (signingMatch) {
      results.push({ file: fname, type: 'event', channel: '', issues: [] });
    }
  }

  // Scan src/**/*.php for Slack usage
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (
      !content.includes('SlackClient') &&
      !content.includes('->chat()->postMessage(') &&
      !content.includes('Webhook') &&
      !content.includes("'text' =>") &&
      !content.includes("'blocks' =>") &&
      !content.includes('slack')
    ) continue;

    const relFile = path.relative(appPath, filePath);
    const issues: string[] = [];

    // Hardcoded webhook URL
    if (/https:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]+/.test(content)) {
      issues.push(`Hardcoded Slack webhook URL in ${relFile} — use SLACK_WEBHOOK_URL env variable instead of inline URL`);
    }

    // No signing secret validation for events/slash commands
    if (content.includes('Request') && (content.includes('command') || content.includes('event') || content.includes('Event'))) {
      const hasValidation = content.includes('X-Slack-Signature') || content.includes('signing_secret') || content.includes('verifySignature');
      if (!hasValidation) {
        issues.push(`Possible Slack event/slash-command handler in ${relFile} without signing secret validation — verify X-Slack-Signature header using SLACK_SIGNING_SECRET to prevent forged requests`);
      }
    }

    // No retry on rate limit
    if (content.includes('->chat()->postMessage(') || content.includes('postMessage')) {
      const hasRetry = content.includes('retry') || content.includes('Retry') || content.includes('sleep') || content.includes('RateLimiter');
      if (!hasRetry) {
        issues.push(`Slack postMessage in ${relFile} without rate limit handling — Slack API returns HTTP 429 on rate limit; implement exponential backoff or use a queue (Messenger) for batch notifications`);
      }
    }

    // Detect channel
    const channelM = /'channel'\s*=>\s*'([#@a-zA-Z0-9_-]{1,80})'/.exec(content)
      ?? /"channel"\s*=>\s*"([#@a-zA-Z0-9_-]{1,80})"/.exec(content);
    const channel = channelM ? channelM[1] : '';

    const type: SlackWebhookInfo['type'] = content.includes('command') ? 'slash-command'
      : content.includes('event') || content.includes('Event') ? 'event'
      : content.includes('->chat()->postMessage(') ? 'api'
      : 'webhook';

    results.push({ file: relFile, type, channel, issues });
  }

  return results;
}

export function listSlackWebhookIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildSlackWebhookIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Slack webhook integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Slack Webhook Integration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      const chanStr = info.channel ? `  channel:${info.channel}` : '';
      text += `\n  [${info.type.toUpperCase()}]${chanStr}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSlackWebhookIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildSlackWebhookIntegrationInfos(appPath);
    let text = `Slack Webhook Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Webhook patterns:       ${infos.filter((i) => i.type === 'webhook').length}\n`;
    text += `API patterns:           ${infos.filter((i) => i.type === 'api').length}\n`;
    text += `Event patterns:         ${infos.filter((i) => i.type === 'event').length}\n`;
    text += `Slash-command patterns: ${infos.filter((i) => i.type === 'slash-command').length}\n`;
    text += `Issues:                 ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSlackWebhookIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_slack_webhook_integration',
      description: 'Analyze Slack integration: detect composer packages (jolicode/slack-php-api, wrklst/slackhook), env credentials (SLACK_WEBHOOK_URL/BOT_TOKEN/SIGNING_SECRET), PHP SlackClient/postMessage/Webhook/blocks usage, flag hardcoded webhook URL, no signing secret validation for events, no retry on rate limit',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_slack_webhook_integration_stats',
      description: 'Statistics for Slack integration: webhook/api/event/slash-command pattern counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
