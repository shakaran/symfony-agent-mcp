import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface KafkaIntegrationInfo {
  source: string;
  type: 'transport' | 'producer' | 'consumer' | 'security' | 'config';
  directive: string;
  value: string;
  issues: string[];
}

function buildKafkaIntegrationInfos(appPath: string): KafkaIntegrationInfo[] {
  const results: KafkaIntegrationInfo[] = [];

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    if (content.includes('kafka://') || content.includes('kafka:') || content.includes('Kafka')) {
      const issues: string[] = [];

      const hasSecurity = content.includes('security.protocol') || content.includes('ssl.') || content.includes('sasl.');
      if (!hasSecurity) {
        issues.push('Kafka transport without security.protocol — defaults to PLAINTEXT (unencrypted, unauthenticated); configure ssl or sasl_ssl with certificates for production clusters');
      }

      const hasGroup = content.includes('group.id') || content.includes('group_id') || content.includes('consumer_group');
      if (!hasGroup) {
        issues.push('Kafka consumer without group.id — without a consumer group each worker receives all messages; set group.id for partitioned consumption across worker instances');
      }

      const hasCommitMode = content.includes('auto.commit') || content.includes('enable.auto.commit') || content.includes('commit_async');
      if (!hasCommitMode) {
        issues.push('Kafka transport without explicit commit configuration — auto.commit.enable defaults to true with 5s interval; messages can be reprocessed or lost on worker crash; set enable.auto.commit=false and commit after successful processing');
      }

      const hasRetention = content.includes('topic.') || content.includes('retention') || content.includes('partitions');
      if (!hasRetention) {
        issues.push('Kafka transport without topic configuration — topic retention, replication factor, and partition count should be set before production to avoid data loss (default replication factor = 1)');
      }

      results.push({ source: 'messenger.yaml', type: 'transport', directive: 'Kafka transport', value: 'kafka://', issues });
    }
  }

  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      const hasKafkaLib = req['enqueue/rdkafka'] || req['jobcloud/php-kafka-lib'] || req['arnaud-lb/kafka-bundle'] || req['lcobucci/clock'];
      if (hasKafkaLib) {
        results.push({ source: 'composer.json', type: 'config', directive: 'Kafka PHP library', value: Object.keys(req).filter((k) => k.includes('kafka')).join(', '), issues: [] });
      }
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('Kafka') && !content.includes('kafka') && !content.includes('KafkaProducer') && !content.includes('KafkaConsumer')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasSchemaRegistry = content.includes('schema_registry') || content.includes('AvroSerializer') || content.includes('SchemaRegistry');
            const hasManualSerialization = content.includes('json_encode(') || content.includes('serialize(');
            if (hasManualSerialization && !hasSchemaRegistry) {
              issues.push(`Kafka producer in "${relFile}" uses manual JSON/PHP serialization — consider Avro with Schema Registry for schema evolution and backward/forward compatibility`);
            }

            const hasIdempotent = content.includes('enable.idempotence') || content.includes('acks');
            if (!hasIdempotent && content.includes('produce(')) {
              issues.push(`Kafka producer in "${relFile}" without enable.idempotence or acks=all — messages can be duplicated on network errors; set enable.idempotence=true for exactly-once producer semantics`);
            }

            results.push({ source: relFile, type: 'producer', directive: 'Kafka producer', value: 'PHP code', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listKafkaIntegration(appPath: string): McpToolResult {
  try {
    const infos = buildKafkaIntegrationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Kafka integration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Kafka Integration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getKafkaIntegrationStats(appPath: string): McpToolResult {
  try {
    const infos = buildKafkaIntegrationInfos(appPath);
    let text = `Kafka Integration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Transports:  ${infos.filter((i) => i.type === 'transport').length}\n`;
    text += `Producers:   ${infos.filter((i) => i.type === 'producer').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getKafkaIntegrationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_kafka_integration', description: 'Analyze Kafka integration in Symfony Messenger; warns on PLAINTEXT transport without TLS/SASL, missing consumer group.id, auto-commit risk, no topic configuration, producer without idempotence, manual serialization without Schema Registry', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_kafka_integration_stats', description: 'Statistics for Kafka integration: transport/producer count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
