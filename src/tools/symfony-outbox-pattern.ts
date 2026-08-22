import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface OutboxPatternInfo {
  file: string;
  type: 'entity' | 'subscriber' | 'transport';
  name: string;
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

function buildOutboxInfos(appPath: string): OutboxPatternInfo[] {
  const results: OutboxPatternInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const classMatch = /class\s+(\w{1,100})/.exec(content);
      const name = classMatch ? classMatch[1] : path.basename(file, '.php');
      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      const isOutboxEntity = /class\s+\w{0,60}Outbox\w{0,60}/.test(content) ||
        /class\s+\w{0,60}OutboxMessage\w{0,60}/.test(content) ||
        (content.includes('payload') && content.includes('published_at') && content.includes('created_at'));

      const isOutboxSubscriber = (content.includes('#[AsDoctrineListener]') || content.includes('EventSubscriber')) &&
        (content.includes('postFlush') || content.includes('onFlush')) &&
        (content.includes('dispatch(') || content.includes('MessageBus'));

      if (isOutboxEntity) {
        const hasIndex = content.includes('index') || content.includes('@Index') || content.includes('#[Index]');
        if (!hasIndex) {
          issues.push(`Outbox entity "${name}" has no index annotation — polling by published_at/created_at will be slow without an index`);
        }
        results.push({ file: relFile, type: 'entity', name, issues });
      }

      if (isOutboxSubscriber) {
        if (content.includes('postFlush') && content.includes('flush()')) {
          issues.push(`Outbox subscriber "${name}" calls flush() inside postFlush — this triggers another postFlush, causing infinite loop`);
        }
        if (!content.includes('transaction') && !content.includes('beginTransaction')) {
          issues.push(`Outbox subscriber "${name}" dispatches without explicit transaction — outbox write must be in same transaction as business entity`);
        }
        results.push({ file: relFile, type: 'subscriber', name, issues });
      }
    }
  }

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    const cfg = parseYamlFile(messengerYaml) as Record<string, unknown> | null;
    if (cfg) {
      const framework = (cfg['framework'] ?? cfg) as Record<string, unknown>;
      const messenger = (framework['messenger'] ?? {}) as Record<string, unknown>;
      const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;

      for (const [tName, tCfg] of Object.entries(transports)) {
        const dsnStr = String((tCfg as Record<string, unknown>)['dsn'] ?? tCfg ?? '');
        if (dsnStr.startsWith('doctrine://')) {
          const issues: string[] = [];
          issues.push(`Transport "${tName}" uses Doctrine DSN (doctrine outbox pattern) — ensure messages table has cleanup job to prevent unbounded growth`);
          results.push({ file: 'config/packages/messenger.yaml', type: 'transport', name: tName, issues });
        }
      }
    }
  }

  return results;
}

export function listSymfonyOutboxPatterns(appPath: string): McpToolResult {
  try {
    const infos = buildOutboxInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Transactional Outbox patterns found (no Outbox entity, subscriber, or doctrine:// transport).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Transactional Outbox Pattern Analysis\n${'='.repeat(55)}\n\nClasses: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyOutboxStats(appPath: string): McpToolResult {
  try {
    const infos = buildOutboxInfos(appPath);
    let text = `Outbox Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Entities:    ${infos.filter((i) => i.type === 'entity').length}\n`;
    text += `Subscribers: ${infos.filter((i) => i.type === 'subscriber').length}\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyOutboxTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_outbox_patterns', description: 'Detect transactional outbox patterns; warns on missing index, flush() in postFlush listener (infinite loop), no transaction wrapping, doctrine:// transport without cleanup', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_outbox_stats', description: 'Statistics for outbox patterns: entity/subscriber/transport count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
