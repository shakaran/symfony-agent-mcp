// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TransportDetail {
  name: string;
  dsn: string;
  driver: string;
  options: Record<string, unknown>;
  retryStrategy?: { maxRetries: number; delay: number; multiplier: number };
  issues: string[];
}

function detectDriver(dsn: string): string {
  if (dsn.startsWith('amqp://') || dsn.startsWith('amqps://')) return 'amqp';
  if (dsn.startsWith('redis://') || dsn.startsWith('rediss://')) return 'redis';
  if (dsn.startsWith('doctrine://')) return 'doctrine';
  if (dsn.startsWith('sqs://') || dsn.includes('amazonaws.com')) return 'sqs';
  if (dsn.startsWith('beanstalkd://')) return 'beanstalkd';
  if (dsn.startsWith('in-memory://') || dsn === 'in-memory://') return 'in-memory';
  if (dsn.startsWith('sync://') || dsn === 'sync://') return 'sync';
  if (dsn.startsWith('%env(')) return 'env-ref';
  return 'unknown';
}

function loadTransportDetails(appPath: string): TransportDetail[] {
  const details: TransportDetail[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(transports)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const dsn = typeof def === 'string' ? def : String(d['dsn'] ?? '');
      const driver = detectDriver(dsn);
      const options = (d['options'] ?? {}) as Record<string, unknown>;
      const retryRaw = (d['retry_strategy'] ?? null) as Record<string, unknown> | null;
      const retryStrategy = retryRaw ? {
        maxRetries: Number(retryRaw['max_retries'] ?? 3),
        delay: Number(retryRaw['delay'] ?? 1000),
        multiplier: Number(retryRaw['multiplier'] ?? 2),
      } : undefined;
      const issues: string[] = [];
      if (driver === 'in-memory' || driver === 'sync') issues.push(`${driver} transport — messages lost on process restart; use only for dev/test`);
      if (driver === 'amqp' && !options['prefetch_count']) issues.push('AMQP without prefetch_count — defaults to unlimited prefetch; set to 1-10 for fair dispatch');
      if (retryStrategy && retryStrategy.maxRetries > 10) issues.push(`max_retries=${retryStrategy.maxRetries} — risk of accumulating failed messages`);
      details.push({ name, dsn: dsn.replace(/:\/\/[^@\s]*:[^@\s]*@/, '://***:***@'), driver, options, retryStrategy, issues });
    }
  }
  return details;
}

export function listMessengerTransportOptions(appPath: string): McpToolResult {
  try {
    const transports = loadTransportDetails(appPath);
    if (transports.length === 0) return { content: [{ type: 'text', text: 'No messenger transports found.\n\nExample:\n  framework:\n    messenger:\n      transports:\n        async:\n          dsn: \'%env(MESSENGER_TRANSPORT_DSN)%\'\n          options:\n            auto_setup: true' }] };
    const totalIssues = transports.reduce((s, t) => s + t.issues.length, 0);
    let text = `Messenger Transport Options\n${'='.repeat(55)}\n\nTransports: ${transports.length}  Issues: ${totalIssues}\n`;
    for (const t of transports.sort((a, b) => b.issues.length - a.issues.length)) {
      const retry = t.retryStrategy ? `  retry: max${t.retryStrategy.maxRetries}×${t.retryStrategy.delay}ms` : '';
      const opts = Object.keys(t.options).length > 0 ? `  opts: ${Object.keys(t.options).join(',')}` : '';
      text += `\n  ${t.name}  driver: ${t.driver}${retry}${opts}\n    DSN: ${t.dsn}\n`;
      for (const i of t.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerTransportOptionStats(appPath: string): McpToolResult {
  try {
    const transports = loadTransportDetails(appPath);
    const drivers = new Map<string, number>();
    for (const t of transports) drivers.set(t.driver, (drivers.get(t.driver) ?? 0) + 1);
    let text = `Messenger Transport Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports: ${transports.length}\n`;
    for (const [driver, count] of drivers.entries()) text += `  ${driver}: ${count}\n`;
    text += `With retry strategy: ${transports.filter((t) => t.retryStrategy).length}\nIssues: ${transports.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerTransportOptionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_messenger_transport_options', description: 'Show Messenger transport driver options: AMQP prefetch_count, Redis stream/group, Doctrine queue_name, SQS wait_time, retry strategy (max_retries/delay/multiplier), in-memory/sync dev-only warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_messenger_transport_option_stats', description: 'Show messenger transport statistics: total count, by driver type, retry strategy count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
