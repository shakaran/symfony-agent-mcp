// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface LokiLogConfigInfo {
  file: string;
  type: 'promtail' | 'loki' | 'docker';
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
  return value.replace(/([A-Za-z_][A-Za-z0-9_]*\s*=\s*)[^\s$#'"]{8,}/g, '$1***');
}

function maskUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@\s]{3,}@/, '$1***@');
}

function scanDirForYaml(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) continue;
      if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch { /* skip */ }
  return files;
}

function buildLokiLogConfigInfos(appPath: string): LokiLogConfigInfo[] {
  const results: LokiLogConfigInfo[] = [];

  const promtailNames = ['promtail.yml', 'promtail.yaml'];
  const lokiNames = ['loki-config.yml', 'loki-config.yaml', 'loki.yml', 'loki.yaml'];
  const searchDirs = [appPath, path.join(appPath, 'docker'), path.join(appPath, 'monitoring')];

  for (const dir of searchDirs) {
    const allYaml = scanDirForYaml(dir);
    for (const filePath of allYaml) {
      const name = path.basename(filePath);
      const relFile = path.relative(appPath, filePath);
      const content = safeRead(filePath, appPath);
      if (!content) continue;

      if (promtailNames.includes(name)) {
        // clients[].url — Loki endpoint
        const clientUrlMatches = content.matchAll(/url\s*:\s*([^\n]{1,200})/g);
        for (const m of clientUrlMatches) {
          const rawUrl = m[1].trim();
          const hasCredentials = /@/.test(rawUrl) && /https?:\/\/[^@]{3,}@/.test(rawUrl);
          const maskedUrl = maskUrl(rawUrl);
          results.push({
            file: relFile,
            type: 'promtail',
            key: 'clients[].url',
            value: maskedUrl,
            issue: hasCredentials
              ? 'Loki client URL contains credentials in plaintext — use basic_auth section or bearer_token_file instead of embedding credentials in URL'
              : null,
          });
        }

        // scrape_configs[].job_name
        const jobMatches = content.matchAll(/job_name\s*:\s*([^\n]{1,100})/g);
        for (const m of jobMatches) {
          results.push({ file: relFile, type: 'promtail', key: 'scrape_configs[].job_name', value: m[1].trim(), issue: null });
        }

        // pipeline_stages
        const hasPipelineStages = content.includes('pipeline_stages:');
        if (!hasPipelineStages) {
          results.push({
            file: relFile,
            type: 'promtail',
            key: 'pipeline_stages',
            value: 'not configured',
            issue: 'No pipeline_stages defined in Promtail — without stages logs are shipped as raw lines; add json/regex/timestamp stages for structured log parsing and labeling',
          });
        }

        // retention
        const hasRetention = content.includes('retention_period') || content.includes('retention:');
        if (!hasRetention) {
          results.push({
            file: relFile,
            type: 'promtail',
            key: 'retention',
            value: 'not set',
            issue: 'No retention policy configured — without retention Loki accumulates logs indefinitely; set limits_config.retention_period in Loki server config',
          });
        }
      }

      if (lokiNames.includes(name)) {
        // storage_config.boltdb_shipper
        const boltdbMatch = /active_index_directory\s*:\s*([^\n]{1,200})/.exec(content);
        if (boltdbMatch) {
          results.push({
            file: relFile,
            type: 'loki',
            key: 'storage_config.boltdb_shipper.active_index_directory',
            value: boltdbMatch[1].trim(),
            issue: null,
          });

          const hasRemoteStorage = content.includes('gcs') || content.includes('s3') || content.includes('azure') || content.includes('object_store');
          if (!hasRemoteStorage) {
            results.push({
              file: relFile,
              type: 'loki',
              key: 'storage_config.boltdb_shipper',
              value: 'local only',
              issue: 'boltdb_shipper configured without remote object store (GCS/S3) — local storage loses index data on container restart; configure object_store: gcs or object_store: s3 for persistence',
            });
          }
        }

        // schema_config.configs[].object_store
        const objectStoreMatches = content.matchAll(/object_store\s*:\s*([^\n]{1,100})/g);
        for (const m of objectStoreMatches) {
          results.push({ file: relFile, type: 'loki', key: 'schema_config.configs[].object_store', value: m[1].trim(), issue: null });
        }

        // retention_period
        const retentionMatch = /retention_period\s*:\s*([^\n]{1,50})/.exec(content);
        if (!retentionMatch) {
          results.push({
            file: relFile,
            type: 'loki',
            key: 'limits_config.retention_period',
            value: 'not set',
            issue: 'No retention_period in Loki limits_config — logs accumulate indefinitely; set retention_period (e.g., 744h for 31 days) and enable compactor.retention_enabled: true',
          });
        } else {
          results.push({ file: relFile, type: 'loki', key: 'limits_config.retention_period', value: retentionMatch[1].trim(), issue: null });
        }
      }
    }
  }

  // docker-compose.yml — grafana/promtail or grafana/loki images
  const dcFiles = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
    path.join(appPath, 'docker', 'docker-compose.yml'),
    path.join(appPath, 'docker', 'docker-compose.yaml'),
  ];
  for (const dcFile of dcFiles) {
    const content = safeRead(dcFile, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, dcFile);

    const hasPromtail = content.includes('grafana/promtail');
    const hasLoki = content.includes('grafana/loki');

    if (hasPromtail) {
      const imageMatch = /grafana\/promtail:[^\s\n]{1,50}/.exec(content);
      results.push({
        file: relFile,
        type: 'docker',
        key: 'service image',
        value: imageMatch ? imageMatch[0] : 'grafana/promtail',
        issue: null,
      });
    }

    if (hasLoki) {
      const imageMatch = /grafana\/loki:[^\s\n]{1,50}/.exec(content);
      results.push({
        file: relFile,
        type: 'docker',
        key: 'service image',
        value: imageMatch ? imageMatch[0] : 'grafana/loki',
        issue: null,
      });
    }
  }

  // Monolog config — type: gelf or type: socket
  const monologYamlPaths = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
  ];
  for (const mPath of monologYamlPaths) {
    const content = safeRead(mPath, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, mPath);

    const gelfMatch = /type\s*:\s*gelf/.test(content);
    const socketMatch = /type\s*:\s*socket/.test(content);

    if (gelfMatch) {
      results.push({
        file: relFile,
        type: 'loki',
        key: 'monolog handler type',
        value: 'gelf',
        issue: 'Monolog GELF handler ships logs without structured JSON format — GELF is a Graylog-specific binary format; for Loki use type: fingers_crossed with a JSON formatter or promtail file scraping instead',
      });
    }

    if (socketMatch) {
      results.push({
        file: relFile,
        type: 'loki',
        key: 'monolog handler type',
        value: 'socket',
        issue: 'Monolog socket handler ships logs without structured format — raw socket shipping loses structured fields; for Loki use file handler with JSON formatter and promtail scraping',
      });
    }
  }

  // Mask any remaining secrets in values
  for (const info of results) {
    info.value = maskSecrets(info.value);
  }

  return results;
}

export function listLokiLogConfig(appPath: string): McpToolResult {
  try {
    const infos = buildLokiLogConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Grafana Loki / Promtail log shipping configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Grafana Loki Log Shipping Configuration\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.type.toUpperCase()}] ${info.file}\n`;
      text += `  Key:   ${info.key}\n`;
      text += `  Value: ${info.value}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.file}] ${info.key}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning Loki config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getLokiLogConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildLokiLogConfigInfos(appPath);
    const byType = { promtail: 0, loki: 0, docker: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `Loki Log Config Stats`,
      `=====================`,
      `Total entries : ${infos.length}`,
      `  Promtail    : ${byType.promtail}`,
      `  Loki server : ${byType.loki}`,
      `  Docker      : ${byType.docker}`,
      `Issues        : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getLokiLogConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_loki_log_config',
      description: 'Scan for Grafana Loki / Promtail log shipping configuration including promtail.yml, loki.yaml, docker-compose services, and Monolog handlers. Flags missing retention policies, plaintext credentials in URLs, boltdb_shipper without remote storage, and unstructured log shipping.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_loki_log_config_stats',
      description: 'Return a summary count of Loki/Promtail configuration entries and issues found in the project.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
