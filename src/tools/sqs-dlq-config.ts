// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SqsDlqConfigInfo {
  source: string;
  type: 'env' | 'messenger' | 'php' | 'infra';
  key: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecrets(value: string): string {
  return value
    .replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{4,}/g, '$1***')
    .replace(/(['"][A-Za-z_][A-Za-z0-9_]*['"]\s*=>\s*['"])[^'"]{4,}(['"])/g, '$1***$2');
}

function maskUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@\s]{3,}@/, '$1***@');
}

function scanPhpFiles(dir: string, base: string, callback: (filePath: string, content: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanPhpFiles(full, base, callback);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        const content = safeRead(full, base);
        if (content !== null) callback(full, content);
      }
    }
  } catch { /* skip */ }
}

function scanInfraFiles(dir: string, base: string, callback: (filePath: string, content: string, ext: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanInfraFiles(full, base, callback);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (ext === '.tf' || ext === '.json') {
          const content = safeRead(full, base);
          if (content !== null) callback(full, content, ext);
        }
      }
    }
  } catch { /* skip */ }
}

function buildSqsDlqConfigInfos(appPath: string): SqsDlqConfigInfo[] {
  const results: SqsDlqConfigInfo[] = [];

  // .env* files — SQS_* env vars
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const sqsVarRegex = /^(SQS_[A-Z0-9_]+)\s*=\s*([^\n]{1,300})/mg;
    let m: RegExpExecArray | null;
    while ((m = sqsVarRegex.exec(content)) !== null) {
      const varName = m[1];
      const rawValue = m[2].trim();
      const maskedFull = maskSecrets(`${varName}=${maskUrl(rawValue)}`);
      const maskedValue = maskedFull.startsWith(`${varName}=`) ? maskedFull.slice(varName.length + 1) : maskedFull;
      results.push({ source: fname, type: 'env', key: varName, value: maskedValue, issue: null });
    }

    // AWS credentials check
    const accessKeyMatch = /AWS_ACCESS_KEY_ID\s*=\s*([^\n]{1,100})/.exec(content);
    if (accessKeyMatch) {
      const key = accessKeyMatch[1].trim();
      if (key.startsWith('AKIA') || key.startsWith('ASIA')) {
        results.push({
          source: fname,
          type: 'env',
          key: 'AWS_ACCESS_KEY_ID',
          value: `${key.slice(0, 8)}...`,
          issue: `Static AWS IAM key in "${fname}" — never commit AWS credentials; use IAM roles (ECS task role, EC2 instance profile, or GitHub OIDC) instead of static access keys`,
        });
      }
    }
  }

  // config/packages/messenger.yaml — SQS transport DLQ options
  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const messengerContent = safeRead(messengerYaml, appPath);
  if (messengerContent) {
    const isSqsTransport = messengerContent.includes('sqs://') || messengerContent.includes('amazonaws.com') || messengerContent.includes('SqsTransport');
    if (isSqsTransport) {
      // DLQ
      const hasDlq = messengerContent.includes('dead_letter_queue_name') || messengerContent.includes('dead_letter_arn') || messengerContent.includes('RedrivePolicy');
      results.push({
        source: 'config/packages/messenger.yaml',
        type: 'messenger',
        key: 'dead_letter_queue_name',
        value: hasDlq ? 'configured' : 'not set',
        issue: !hasDlq
          ? 'SQS transport without dead_letter_queue_name — messages that exceed maxReceiveCount are deleted permanently; configure a DLQ to capture failed messages for debugging and reprocessing'
          : null,
      });

      // max_receive_count
      const maxReceiveMatch = /max_receive_count\s*:\s*(\d+)/.exec(messengerContent);
      if (maxReceiveMatch) {
        const count = parseInt(maxReceiveMatch[1], 10);
        let issue: string | null = null;
        if (count === 1) {
          issue = `max_receive_count=1 — message is moved to DLQ after a single failure; transient errors (DB blip, API timeout) will cause permanent message loss; set max_receive_count to 3–5 for resilience`;
        } else if (count > 10) {
          issue = `max_receive_count=${count} — very high retry count causes message storm; a poisoned message will be retried ${count} times before DLQ, blocking the queue; keep max_receive_count between 3 and 10`;
        }
        results.push({ source: 'config/packages/messenger.yaml', type: 'messenger', key: 'max_receive_count', value: String(count), issue });
      }

      // visibility_timeout
      const hasVisibility = messengerContent.includes('visibility_timeout') || messengerContent.includes('VisibilityTimeout');
      results.push({
        source: 'config/packages/messenger.yaml',
        type: 'messenger',
        key: 'visibility_timeout',
        value: hasVisibility ? 'configured' : 'not set',
        issue: !hasVisibility
          ? 'SQS transport without visibility_timeout — default 30s; if handler takes longer the message becomes visible again and is reprocessed concurrently; set visibility_timeout to exceed maximum expected handler duration'
          : null,
      });

      // DLQ monitoring
      const hasDlqAlert = messengerContent.includes('alarm') || messengerContent.includes('alert') || messengerContent.includes('monitor') || messengerContent.includes('cloudwatch');
      if (hasDlq && !hasDlqAlert) {
        results.push({
          source: 'config/packages/messenger.yaml',
          type: 'messenger',
          key: 'dlq_monitoring',
          value: 'no alert found',
          issue: 'DLQ configured but no monitoring/alert found — without a CloudWatch alarm on ApproximateNumberOfMessagesVisible on the DLQ, failed messages accumulate silently; add an alarm to notify on DLQ depth > 0',
        });
      }
    }
  }

  // src/**/*.php — SqsClient, createQueue, setQueueAttributes, sendMessage
  const srcDir = path.join(appPath, 'src');
  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasSqs = content.includes('SqsClient') || content.includes('->sendMessage(') || content.includes('->createQueue(') || content.includes('->setQueueAttributes(');
    if (!hasSqs) return;

    const relFile = path.relative(appPath, filePath);

    if (content.includes('->createQueue(')) {
      const hasRedrivePolicy = content.includes('RedrivePolicy') || content.includes('redrive_policy');
      results.push({
        source: relFile,
        type: 'php',
        key: '->createQueue()',
        value: hasRedrivePolicy ? 'with RedrivePolicy' : 'without RedrivePolicy',
        issue: !hasRedrivePolicy
          ? `createQueue() in "${relFile}" without RedrivePolicy — queue created without DLQ configuration; add RedrivePolicy with deadLetterTargetArn and maxReceiveCount when creating queues programmatically`
          : null,
      });
    }

    if (content.includes('->sendMessage(')) {
      const hasGroupId = content.includes('MessageGroupId') || content.includes('message_group_id');
      const hasFifo = content.includes('.fifo') || content.includes('fifo');
      if (hasFifo && !hasGroupId) {
        results.push({
          source: relFile,
          type: 'php',
          key: '->sendMessage()',
          value: 'FIFO without MessageGroupId',
          issue: `sendMessage() to FIFO queue in "${relFile}" without MessageGroupId — FIFO queues require MessageGroupId for ordering; messages without a group ID will fail with InvalidParameterValue`,
        });
      } else {
        results.push({ source: relFile, type: 'php', key: '->sendMessage()', value: 'found', issue: null });
      }
    }

    if (content.includes('SqsClient')) {
      const hasRegion = content.includes('region') || content.includes('AWS_DEFAULT_REGION') || content.includes('AWS_REGION');
      if (!hasRegion) {
        results.push({
          source: relFile,
          type: 'php',
          key: 'SqsClient',
          value: 'no explicit region',
          issue: `SqsClient in "${relFile}" without explicit region — relies on environment defaults which may differ between environments; set 'region' explicitly in SqsClient constructor`,
        });
      }
    }
  });

  // infra/ or terraform/ — aws_sqs_queue with redrive_policy
  const infraDirs = [path.join(appPath, 'infra'), path.join(appPath, 'terraform'), path.join(appPath, 'infrastructure')];
  for (const infraDir of infraDirs) {
    scanInfraFiles(infraDir, appPath, (filePath, content, ext) => {
      const relFile = path.relative(appPath, filePath);
      const hasSqs = content.includes('aws_sqs_queue') || content.includes('sqs:') || content.includes('SQS');
      if (!hasSqs) return;

      if (ext === '.tf') {
        const hasDlq = content.includes('redrive_policy') || content.includes('dead_letter_queue');
        results.push({
          source: relFile,
          type: 'infra',
          key: 'aws_sqs_queue',
          value: hasDlq ? 'with redrive_policy' : 'without redrive_policy',
          issue: !hasDlq
            ? `Terraform aws_sqs_queue resource in "${relFile}" without redrive_policy — add redrive_policy block with deadLetterTargetArn and maxReceiveCount for DLQ protection`
            : null,
        });

        // Check max_receive_count in Terraform redrive_policy JSON
        const redriveMatches = content.matchAll(/"maxReceiveCount"\s*:\s*(\d+)/g);
        for (const rm of redriveMatches) {
          const count = parseInt(rm[1], 10);
          let issue: string | null = null;
          if (count === 1) {
            issue = `maxReceiveCount=1 in "${relFile}" redrive_policy — too low; transient errors cause permanent DLQ routing; use 3–5`;
          } else if (count > 10) {
            issue = `maxReceiveCount=${count} in "${relFile}" — excessively high retry count; keep between 3 and 10 to prevent message storms`;
          }
          results.push({ source: relFile, type: 'infra', key: 'maxReceiveCount', value: String(count), issue });
        }
      }
    });
  }

  return results;
}

export function listSqsDlqConfig(appPath: string): McpToolResult {
  try {
    const infos = buildSqsDlqConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No AWS SQS DLQ configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `AWS SQS Dead Letter Queue Configuration\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.type.toUpperCase()}] ${info.source}\n`;
      text += `  Key:   ${info.key}\n`;
      text += `  Value: ${info.value}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.key}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning SQS DLQ config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getSqsDlqConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildSqsDlqConfigInfos(appPath);
    const byType = { env: 0, messenger: 0, php: 0, infra: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `SQS DLQ Config Stats`,
      `====================`,
      `Total entries   : ${infos.length}`,
      `  Env vars      : ${byType.env}`,
      `  Messenger     : ${byType.messenger}`,
      `  PHP code      : ${byType.php}`,
      `  Infrastructure: ${byType.infra}`,
      `Issues          : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getSqsDlqConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_sqs_dlq_config',
      description: 'Scan for AWS SQS Dead Letter Queue configuration distinct from general SQS transport: env vars (SQS_*), messenger.yaml DLQ options (dead_letter_queue_name, max_receive_count, visibility_timeout), PHP SqsClient usage, and Terraform infra files. Flags missing DLQ, unsafe max_receive_count values, missing visibility timeout, and DLQ without monitoring.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_sqs_dlq_config_stats',
      description: 'Return summary statistics for SQS DLQ configuration: entry counts by type and total issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
