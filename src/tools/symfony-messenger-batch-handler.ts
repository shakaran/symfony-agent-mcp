import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MessengerBatchHandlerInfo {
  file: string;
  class: string;
  messageType: string;
  batchSize: number;
  hasGetBatchSize: boolean;
  hasAcknowledge: boolean;
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

function parseBatchHandlerFile(filePath: string, appPath: string): MessengerBatchHandlerInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('BatchHandlerInterface')) return null;
  if (!content.includes('implements')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const hasGetBatchSize = content.includes('getBatchSize');
  const hasAcknowledge = content.includes('acknowledgeItems');

  // Try to extract batch size from getBatchSize method
  let batchSize = 0;
  const batchSizeM = /getBatchSize\s*\([^)]{0,50}\)\s*:\s*\w+\s*\{[^}]{0,200}return\s+(\d+)/s.exec(content);
  if (batchSizeM) {
    batchSize = parseInt(batchSizeM[1], 10);
  }

  // Try to extract message type from invoke or __invoke
  let messageType = 'unknown';
  const invokeM = /function\s+__invoke\s*\(\s*(\w{1,80})\s+\$/.exec(content);
  if (invokeM) messageType = invokeM[1];

  const issues: string[] = [];

  if (!hasGetBatchSize) {
    issues.push('BatchHandlerInterface without getBatchSize() override — uses default batch size which may be too large/small for your workload');
  }

  if (batchSize > 1000) {
    issues.push(`Very large batch size (${batchSize}) — risk of excessive memory usage when processing batch`);
  }

  if (hasAcknowledge) {
    // Heuristic: check for throw inside acknowledgeItems without re-queue logic
    const ackBodyM = /acknowledgeItems\s*\([^)]{0,100}\)[^{]{0,20}\{([\s\S]{0,500})\}/s.exec(content);
    if (ackBodyM) {
      const body = ackBodyM[1];
      if (body.includes('throw') && !body.includes('dispatch') && !body.includes('reject')) {
        issues.push('acknowledgeItems() throws on partial failure without re-queuing unprocessed items — messages may be lost');
      }
    }
  } else {
    issues.push('BatchHandlerInterface without acknowledgeItems() implementation — batch acknowledgement not handled');
  }

  if (!content.includes('beginTransaction') && !content.includes('transactional') && !content.includes('wrapInTransaction')) {
    issues.push('Batch handler without transaction wrapping — partial commit on failure may corrupt data');
  }

  if (content.includes('->request(') || content.includes('HttpClient') || content.includes('GuzzleHttp')) {
    issues.push('Batch handler with external API calls — risk of rate limiting when processing large batches');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    messageType,
    batchSize,
    hasGetBatchSize,
    hasAcknowledge,
    issues,
  };
}

function loadBatchHandlers(appPath: string): MessengerBatchHandlerInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: MessengerBatchHandlerInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseBatchHandlerFile(file, appPath);
    if (info) results.push(info);
  }
  return results;
}

export function listMessengerBatchHandler(appPath: string): McpToolResult {
  try {
    const handlers = loadBatchHandlers(appPath);
    if (handlers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No BatchHandlerInterface implementations found.\n\nExample:\n  class MyBatchHandler implements BatchHandlerInterface {\n    public function __invoke(MyMessage $message, Acknowledger $ack): void { ... }\n    private function getBatchSize(): int { return 50; }\n  }',
        }],
      };
    }

    const totalIssues = handlers.reduce((s, h) => s + h.issues.length, 0);
    let text = `Messenger Batch Handlers\n${'='.repeat(55)}\n\nHandlers: ${handlers.length}  Issues: ${totalIssues}\n`;

    for (const h of handlers.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${h.class}  (${h.file})\n`;
      text += `    message type:    ${h.messageType}\n`;
      text += `    batch size:      ${h.batchSize > 0 ? String(h.batchSize) : 'default'}\n`;
      text += `    getBatchSize():  ${h.hasGetBatchSize ? 'yes' : 'no (using default)'}\n`;
      text += `    acknowledgeItems(): ${h.hasAcknowledge ? 'yes' : 'no'}\n`;
      for (const issue of h.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerBatchHandlerStats(appPath: string): McpToolResult {
  try {
    const handlers = loadBatchHandlers(appPath);

    let text = `Messenger Batch Handler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total batch handlers:      ${handlers.length}\n`;
    text += `  With getBatchSize():     ${handlers.filter((h) => h.hasGetBatchSize).length}\n`;
    text += `  With acknowledgeItems(): ${handlers.filter((h) => h.hasAcknowledge).length}\n`;
    text += `  With batch size > 1000:  ${handlers.filter((h) => h.batchSize > 1000).length}\n`;
    text += `Issues:                    ${handlers.reduce((s, h) => s + h.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerBatchHandlerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_batch_handler',
      description: 'Show BatchHandlerInterface implementations: message type, batch size, getBatchSize/acknowledgeItems presence; warns on missing getBatchSize, throw without re-queue in acknowledgeItems, no transaction wrapping, very large batch size, external API calls',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_batch_handler_stats',
      description: 'Show batch handler statistics: total count, getBatchSize/acknowledgeItems coverage, oversized batch count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
