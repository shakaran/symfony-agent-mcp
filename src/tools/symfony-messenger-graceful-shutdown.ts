// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MessengerShutdownInfo {
  file: string;
  type: 'signal' | 'limit' | 'transport' | 'middleware';
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

function buildShutdownInfos(appPath: string): MessengerShutdownInfo[] {
  const results: MessengerShutdownInfo[] = [];

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    const cfg = parseYamlFile(messengerYaml) as Record<string, unknown> | null;
    if (cfg) {
      const framework = (cfg['framework'] ?? cfg) as Record<string, unknown>;
      const messenger = (framework['messenger'] ?? {}) as Record<string, unknown>;
      const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;

      for (const [tName, tCfg] of Object.entries(transports)) {
        const transportCfg = (tCfg as Record<string, unknown>);
        const options = (transportCfg['options'] ?? {}) as Record<string, unknown>;
        const issues: string[] = [];

        const retryStrategy = transportCfg['retry_strategy'];
        if (!retryStrategy) {
          issues.push(`Transport "${tName}" has no retry_strategy — messages that fail after processing are lost`);
        }

        const failureTransport = messenger['failure_transport'];
        if (!failureTransport && !retryStrategy) {
          issues.push(`Transport "${tName}" has no failure_transport and no retry — permanently failed messages are discarded`);
        }

        const prefetchCount = options['prefetch_count'];
        if (prefetchCount && parseInt(String(prefetchCount), 10) > 5) {
          issues.push(`Transport "${tName}" prefetch_count=${prefetchCount} — high prefetch means many in-flight messages on SIGTERM (hard to shut down gracefully)`);
        }

        results.push({ file: 'config/packages/messenger.yaml', type: 'transport', pattern: tName, issues });
      }
    }
  }

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const hasSignal = content.includes('SIGTERM') || content.includes('SIGINT') || content.includes('SIGHUP') ||
      content.includes('SignalableCommandInterface') || content.includes('pcntl_signal(');
    if (hasSignal) {
      const gracefulStop = content.includes('$this->shouldStop') || content.includes('->stop()') || content.includes('setAutoExit(');
      if (!gracefulStop) {
        issues.push('Signal handler detected but no graceful stop mechanism — handler may not complete in-flight messages before shutdown');
      }
      results.push({ file: relFile, type: 'signal', pattern: 'SIGTERM/SIGINT handler', issues });
    }

    if (content.includes('StopWorkerOnTimeLimitListener') || content.includes('StopWorkerOnMemoryLimitListener')) {
      results.push({ file: relFile, type: 'limit', pattern: 'StopWorkerOn*Listener', issues: [] });
    }

    const isHandler = content.includes('#[AsMessageHandler]') || content.includes('MessageHandlerInterface');
    if (isHandler) {
      const classMatch = /class\s+(\w{1,100})/.exec(content);
      const name = classMatch ? classMatch[1] : path.basename(file, '.php');
      const isIdempotent = content.includes('idempotent') || content.includes('findOneBy(') && content.includes('if (');
      if (!isIdempotent && (content.includes('->persist(') || content.includes('->flush(') || content.includes('->save('))) {
        issues.push(`Message handler "${name}" writes to DB but may not be idempotent — re-delivery after crash may cause duplicate data`);
      }
    }
  }

  return results;
}

export function listSymfonyMessengerGracefulShutdown(appPath: string): McpToolResult {
  try {
    const infos = buildShutdownInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Messenger graceful shutdown patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Graceful Shutdown Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerGracefulShutdownStats(appPath: string): McpToolResult {
  try {
    const infos = buildShutdownInfos(appPath);
    let text = `Messenger Shutdown Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:   ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Signal hdlrs: ${infos.filter((i) => i.type === 'signal').length}\n`;
    text += `Limits:       ${infos.filter((i) => i.type === 'limit').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerGracefulShutdownTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_messenger_graceful_shutdown', description: 'Analyze Messenger worker graceful shutdown; warns on no retry_strategy, no failure_transport, high prefetch_count, signal handler without stop mechanism, non-idempotent handlers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_messenger_graceful_shutdown_stats', description: 'Statistics for Messenger shutdown: transport/signal/limit count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
