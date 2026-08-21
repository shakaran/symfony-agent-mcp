import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SqsFifoQueuesInfo {
  file: string;
  type: 'deduplication' | 'groupid' | 'visibility' | 'dlq' | 'messenger' | 'config';
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

function buildSqsFifoQueuesInfos(appPath: string): SqsFifoQueuesInfo[] {
  const results: SqsFifoQueuesInfo[] = [];

  // Scan config/**/*.yaml for FIFO patterns
  const yamlFiles = scanDirRecursive(path.join(appPath, 'config'), '.yaml');
  for (const filePath of yamlFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('.fifo')) continue;
    const relFile = path.relative(appPath, filePath);

    // Symfony Messenger SQS transport with .fifo but missing fifo_queue: true
    if (content.includes('sqs') && content.includes('.fifo') && !content.includes('fifo_queue: true')) {
      results.push({
        file: relFile,
        type: 'messenger',
        issues: [
          `SQS FIFO queue used in Symfony Messenger transport in ${relFile} without 'fifo_queue: true' option — add fifo_queue: true to the transport DSN options to enable proper FIFO handling`,
        ],
      });
    }

    // Dead-letter queue not configured for FIFO queue
    if (content.includes('.fifo') && !content.includes('deadLetterTargetArn') && !content.includes('RedrivePolicy') && !content.includes('dead_letter')) {
      results.push({
        file: relFile,
        type: 'dlq',
        issues: [
          `FIFO queue configured in ${relFile} without dead-letter queue (deadLetterTargetArn/RedrivePolicy) — configure a DLQ to capture failed messages and prevent infinite reprocessing loops`,
        ],
      });
    }

    // MaxReceiveCount set to 1
    if (/MaxReceiveCount\s*:\s*1[^0-9]/.test(content) || /max_receive_count\s*:\s*1[^0-9]/.test(content)) {
      results.push({
        file: relFile,
        type: 'dlq',
        issues: [
          `MaxReceiveCount set to 1 in ${relFile} — messages will be immediately moved to DLQ on first failure; set to at least 3-5 to allow transient-error retries`,
        ],
      });
    }

    // VisibilityTimeout below 30 seconds
    const vtMatch = /VisibilityTimeout\s*:\s*([0-9]+)/.exec(content);
    if (vtMatch) {
      const vt = parseInt(vtMatch[1], 10);
      if (vt < 30) {
        results.push({
          file: relFile,
          type: 'visibility',
          issues: [
            `VisibilityTimeout set to ${vt}s in ${relFile} (below 30s) — set visibility timeout to at least the maximum expected processing time to avoid duplicate deliveries`,
          ],
        });
      }
    }

    results.push({ file: relFile, type: 'config', issues: [] });
  }

  // Scan src/**/*.php for FIFO queue patterns
  const phpFiles = scanDirRecursive(path.join(appPath, 'src'), '.php');
  for (const filePath of phpFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('.fifo')) continue;

    const relFile = path.relative(appPath, filePath);

    // FIFO queue URL used without MessageGroupId
    if (content.includes('.fifo') && !content.includes('MessageGroupId')) {
      results.push({
        file: relFile,
        type: 'groupid',
        issues: [
          `FIFO queue used in ${relFile} without MessageGroupId — all messages default to a single group, eliminating parallelism; set a meaningful MessageGroupId per logical message stream`,
        ],
      });
    }

    // MessageDeduplicationId not set and no ContentBasedDeduplication hint
    if (content.includes('.fifo') && !content.includes('MessageDeduplicationId') && !content.includes('ContentBasedDeduplication')) {
      results.push({
        file: relFile,
        type: 'deduplication',
        issues: [
          `FIFO queue used in ${relFile} without MessageDeduplicationId and no ContentBasedDeduplication — provide a MessageDeduplicationId or enable content-based deduplication on the queue to prevent duplicate processing`,
        ],
      });
    }

    // VisibilityTimeout below 30 in PHP code
    const vtPhpMatch = /VisibilityTimeout['"]\s*=>\s*([0-9]+)/.exec(content);
    if (vtPhpMatch) {
      const vt = parseInt(vtPhpMatch[1], 10);
      if (vt < 30) {
        results.push({
          file: relFile,
          type: 'visibility',
          issues: [
            `VisibilityTimeout set to ${vt}s in ${relFile} (below 30s) — set visibility timeout to at least the maximum expected processing time to avoid duplicate deliveries`,
          ],
        });
      }
    }

    // Dead-letter queue not configured
    if (content.includes('.fifo') && !content.includes('deadLetterTargetArn') && !content.includes('RedrivePolicy')) {
      results.push({
        file: relFile,
        type: 'dlq',
        issues: [
          `FIFO queue referenced in ${relFile} without dead-letter queue configuration (deadLetterTargetArn/RedrivePolicy) — configure a DLQ to handle poison-pill messages`,
        ],
      });
    }

    // MaxReceiveCount set to 1 in PHP
    if (/MaxReceiveCount['"]\s*=>\s*1[^0-9]/.test(content) || /max_receive_count['"]\s*=>\s*1[^0-9]/.test(content)) {
      results.push({
        file: relFile,
        type: 'dlq',
        issues: [
          `MaxReceiveCount set to 1 in ${relFile} — messages immediately sent to DLQ on first failure; increase to 3-5 to tolerate transient errors`,
        ],
      });
    }
  }

  // Scan .env* for SQS FIFO queue URL
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    if (!content.includes('.fifo')) continue;
    const issues: string[] = [];

    if (content.includes('.fifo') && !content.includes('fifo_queue')) {
      issues.push(`SQS FIFO queue URL (.fifo suffix) found in ${fname} — ensure transport config uses fifo_queue: true in Symfony Messenger options`);
    }
    if (issues.length > 0) {
      results.push({ file: fname, type: 'config', issues });
    }
  }

  return results;
}

export function listSqsFifoQueues(appPath: string): McpToolResult {
  try {
    const infos = buildSqsFifoQueuesInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SQS FIFO queue patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SQS FIFO Queue Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSqsFifoQueuesStats(appPath: string): McpToolResult {
  try {
    const infos = buildSqsFifoQueuesInfos(appPath);
    let text = `SQS FIFO Queue Statistics\n${'='.repeat(40)}\n\n`;
    text += `Deduplication patterns: ${infos.filter((i) => i.type === 'deduplication').length}\n`;
    text += `GroupId patterns:       ${infos.filter((i) => i.type === 'groupid').length}\n`;
    text += `Visibility patterns:    ${infos.filter((i) => i.type === 'visibility').length}\n`;
    text += `DLQ patterns:           ${infos.filter((i) => i.type === 'dlq').length}\n`;
    text += `Messenger patterns:     ${infos.filter((i) => i.type === 'messenger').length}\n`;
    text += `Config patterns:        ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Total issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSqsFifoQueuesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_sqs_fifo_queues',
      description: 'Scan the Symfony application for SQS FIFO queue patterns: missing MessageGroupId, absent MessageDeduplicationId, short visibility timeouts, missing DLQ, Messenger misconfiguration, and MaxReceiveCount of 1.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_sqs_fifo_queues_stats',
      description: 'Return aggregated counts of SQS FIFO deduplication/groupid/visibility/dlq/messenger/config patterns and total issues found.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
