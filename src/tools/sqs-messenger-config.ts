import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SqsConfigInfo {
  source: string;
  type: 'transport' | 'dlq' | 'visibility' | 'fifo' | 'security';
  directive: string;
  value: string;
  issues: string[];
}

function buildSqsConfigInfos(appPath: string): SqsConfigInfo[] {
  const results: SqsConfigInfo[] = [];

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('sqs://') || content.includes('amazonaws.com/sqs') || content.includes('SqsTransport')) {
      const issues: string[] = [];

      const hasDlq = content.includes('dead_letter_queue_name') || content.includes('dead_letter_arn') || content.includes('RedrivePolicy');
      if (!hasDlq) {
        issues.push('SQS transport without Dead Letter Queue (DLQ) configured — failed messages exceed maxReceiveCount and are deleted; configure dead_letter_queue_name to capture failed messages for debugging');
      }

      const hasVisibility = content.includes('visibility_timeout:') || content.includes('VisibilityTimeout');
      if (!hasVisibility) {
        issues.push('SQS transport without visibility_timeout — defaults to 30s; if message processing takes longer, message becomes visible again and is reprocessed; set visibility_timeout to exceed maximum processing time');
      }

      const hasWaitTime = content.includes('wait_time:') || content.includes('WaitTimeSeconds');
      if (!hasWaitTime) {
        issues.push('SQS transport without wait_time (long polling) — short polling runs empty requests incurring AWS cost; set wait_time: 20 for long polling to reduce API calls by up to 99%');
      }

      const hasFifo = content.includes('.fifo') || content.includes('fifo:');
      if (!hasFifo) {
        issues.push('SQS Standard queue used — messages may be delivered out of order and duplicate; for ordered processing use FIFO queues (queue name ending in .fifo with ContentBasedDeduplication)');
      }

      const hasRegion = content.includes('region:') || content.includes('AWS_DEFAULT_REGION') || content.includes('AWS_REGION');
      if (!hasRegion) {
        issues.push('SQS transport without explicit region — relies on environment variable or EC2 instance metadata; set region explicitly to prevent cross-region message delivery and unexpected latency');
      }

      results.push({ source: 'messenger.yaml', type: 'transport', directive: 'SQS transport', value: 'sqs://', issues });
    }
  }

  const envFiles = [path.join(appPath, '.env'), path.join(appPath, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, envFile);

    const hasAccessKey = /AWS_ACCESS_KEY_ID\s*=\s*([^\n]+)/.exec(content);
    if (hasAccessKey) {
      const key = hasAccessKey[1].trim();
      const isHardcoded = key.length > 0 && !key.startsWith('$') && !key.startsWith('%') && key !== 'your_access_key_id';
      if (isHardcoded && key.startsWith('AKIA')) {
        results.push({ source: relFile, type: 'security', directive: 'AWS_ACCESS_KEY_ID', value: `${key.substring(0, 8)}...`, issues: [`AWS_ACCESS_KEY_ID in "${relFile}" appears to be a real IAM key — never commit AWS credentials; use IAM roles (ECS task role / EC2 instance profile) instead of static credentials`] });
      }
    }
  }

  return results;
}

export function listSqsMessengerConfig(appPath: string): McpToolResult {
  try {
    const infos = buildSqsConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SQS Messenger configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SQS Messenger Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSqsMessengerConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildSqsConfigInfos(appPath);
    let text = `SQS Messenger Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Security:    ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSqsMessengerConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_sqs_messenger_config', description: 'Analyze AWS SQS Messenger transport configuration; warns on missing DLQ, no visibility_timeout, no long polling wait_time, Standard vs FIFO queue, missing region, hardcoded AWS credentials', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_sqs_messenger_config_stats', description: 'Statistics for SQS config: transport/security count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
