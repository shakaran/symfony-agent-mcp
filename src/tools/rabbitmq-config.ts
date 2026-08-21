import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RabbitmqConfigInfo {
  source: string;
  type: 'transport' | 'exchange' | 'queue' | 'vhost' | 'security';
  directive: string;
  value: string;
  issues: string[];
}

function maskDsn(dsn: string): string {
  return dsn
    .replace(/(amqps?:\/\/)[^:@]+:[^@]+@/, '$1***:***@')
    .replace(/(amqps?:\/\/)[^:@\s]+/, '$1***');
}

function buildRabbitmqConfigInfos(appPath: string): RabbitmqConfigInfo[] {
  const results: RabbitmqConfigInfo[] = [];

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('amqp://') || content.includes('amqps://') || content.includes('RABBITMQ')) {
      const issues: string[] = [];

      const hasTls = content.includes('amqps://');
      if (!hasTls) {
        issues.push('RabbitMQ transport uses amqp:// (unencrypted) — use amqps:// for TLS-encrypted connections, especially for production and cross-network deployments');
      }

      const hasVhost = /amqp[s]?:\/\/[^/]+\/([^?\n]+)/.exec(content)?.[1];
      if (!hasVhost || hasVhost === '%2F' || hasVhost === '/') {
        issues.push('RabbitMQ transport uses default virtual host "/" — use dedicated vhosts per environment/application to isolate exchanges, queues, and permissions');
      }

      const hasDlx = content.includes('dead_letter_exchange:') || content.includes('x-dead-letter-exchange');
      if (!hasDlx) {
        issues.push('RabbitMQ transport without dead_letter_exchange — failed messages are lost after max retries; configure dead_letter_exchange to route failed messages to a DLX queue for investigation');
      }

      const hasPrefetch = content.includes('prefetch_count:') || content.includes('qos:');
      if (!hasPrefetch) {
        issues.push('RabbitMQ transport without prefetch_count (QoS) — consumers fetch unlimited messages causing memory spikes; add prefetch_count: 10 to control in-flight message volume per worker');
      }

      const hasDurable = content.includes('durable: true');
      if (!hasDurable && content.includes('queues:')) {
        issues.push('RabbitMQ queue without durable: true — queues and messages survive broker restart only if durable; for production ensure queues and exchanges are declared as durable');
      }

      results.push({ source: 'messenger.yaml', type: 'transport', directive: 'AMQP transport', value: 'amqp://', issues });
    }
  }

  const envFiles = [path.join(appPath, '.env'), path.join(appPath, '.env.local')];
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    let content = '';
    try { content = fs.readFileSync(envFile, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, envFile);

    const amqpMatch = /RABBITMQ_DSN\s*=\s*([^\n]+)/.exec(content) ?? /AMQP_DSN\s*=\s*([^\n]+)/.exec(content);
    if (amqpMatch) {
      const dsn = amqpMatch[1].trim();
      const issues: string[] = [];
      const hasDefaultCreds = dsn.includes('guest:guest@') || dsn.includes('guest@');
      if (hasDefaultCreds) {
        issues.push(`RabbitMQ DSN in "${relFile}" uses default "guest" credentials — change username and password before production deployment; guest account is disabled for non-localhost connections`);
      }
      results.push({ source: relFile, type: 'security', directive: 'AMQP DSN', value: maskDsn(dsn), issues });
    }
  }

  return results;
}

export function listRabbitmqConfig(appPath: string): McpToolResult {
  try {
    const infos = buildRabbitmqConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No RabbitMQ configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `RabbitMQ Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRabbitmqConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildRabbitmqConfigInfos(appPath);
    let text = `RabbitMQ Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Security:    ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRabbitmqConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_rabbitmq_config', description: 'Analyze RabbitMQ/AMQP Messenger transport configuration; warns on unencrypted amqp://, default vhost, no dead_letter_exchange, no prefetch_count QoS, non-durable queues, default guest credentials', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_rabbitmq_config_stats', description: 'Statistics for RabbitMQ config: transport/security count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
