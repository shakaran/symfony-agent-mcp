// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface KafkaSchemaRegistryInfo {
  source: string;
  type: 'composer' | 'env' | 'php' | 'schema';
  detail: string;
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
    .replace(/^([^:\s]{4,}):([^:\s]{4,})$/, '***:***');
}

function maskUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@\s]{3,}@/, '$1***@');
}

function maskSchemaCredential(val: string): string {
  return val
    .replace(/:([^@/\s]{1,200})@/g, ':***@')
    .replace(/([?&])(password|auth|token|secret)=[^&\s]*/gi, '$1$2=***')
    .replace(/^([^:\s]{4,}):([^:\s]{4,})$/, '***:***');
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

function scanAvscFiles(dir: string, base: string, callback: (filePath: string, content: string) => void): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        scanAvscFiles(full, base, callback);
      } else if (entry.isFile() && entry.name.endsWith('.avsc')) {
        const content = safeRead(full, base);
        if (content !== null) callback(full, content);
      }
    }
  } catch { /* skip */ }
}

function buildKafkaSchemaRegistryInfos(appPath: string): KafkaSchemaRegistryInfo[] {
  const results: KafkaSchemaRegistryInfo[] = [];

  // composer.json — Avro/Schema Registry packages
  const composerPath = path.join(appPath, 'composer.json');
  const composerContent = safeRead(composerPath, appPath);
  if (!composerContent) return results;

  const avroPackages = [
    'flix-tech/avro-serde-php',
    'arquivei/php-avro-schema-serde',
    'jobcloud/php-kafka-avro-serde',
    'flix-tech/confluent-schema-registry-api',
    'jobcloud/php-avro-schema-serde',
  ];

  let hasAvroPackage = false;
  try {
    const composer = JSON.parse(composerContent) as Record<string, unknown>;
    const req = (composer['require'] ?? {}) as Record<string, string>;
    for (const pkg of avroPackages) {
      if (req[pkg]) {
        hasAvroPackage = true;
        results.push({ source: 'composer.json', type: 'composer', detail: `${pkg}: ${req[pkg]}`, issue: null });
      }
    }
  } catch { /* skip */ }

  // .env* files — SCHEMA_REGISTRY_URL and KAFKA_SCHEMA_REGISTRY_*
  const envFileNames = ['.env', '.env.local', '.env.test', '.env.prod', '.env.staging'];
  for (const fname of envFileNames) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;

    const schemaRegexes: RegExp[] = [
      /SCHEMA_REGISTRY_URL\s*=\s*([^\n]{1,200})/,
      /KAFKA_SCHEMA_REGISTRY_URL\s*=\s*([^\n]{1,200})/,
      /SCHEMA_REGISTRY_BASIC_AUTH_USER_INFO\s*=\s*([^\n]{1,200})/,
      /SCHEMA_REGISTRY_API_KEY\s*=\s*([^\n]{1,200})/,
    ];

    for (const regex of schemaRegexes) {
      const m = regex.exec(content);
      if (!m) continue;

      const rawValue = m[1].trim();
      const varName = regex.source.split('\\s')[0];
      // M-08: pass VAR=value so maskSecrets regex can match the key prefix
      // M-09: also apply maskSchemaCredential for URL credential forms
      const maskedValue = maskSchemaCredential(
        maskSecrets(`${varName}=${maskUrl(rawValue)}`).replace(`${varName}=`, '')
      );

      const hasCredentials = /@/.test(rawValue) && /https?:\/\/[^@]{3,}@/.test(rawValue);
      const isOpenRegistry = /https?:\/\/[^@\s]{3,}/.test(rawValue) && !rawValue.includes('@') && !rawValue.includes('localhost') && !rawValue.includes('127.0.0.1');

      results.push({
        source: fname,
        type: 'env',
        detail: `${varName}=${maskedValue}`,
        issue: hasCredentials
          ? `Schema Registry URL in "${fname}" contains credentials in plaintext — use SCHEMA_REGISTRY_BASIC_AUTH_USER_INFO=key:secret instead of embedding credentials in URL`
          : isOpenRegistry && varName.includes('URL')
            ? `Schema Registry URL in "${fname}" has no authentication credentials — open schema registry allows anyone to read/write schemas; add basic auth or API key`
            : null,
      });
    }
  }

  // src/**/*.php — AvroSerializer, AvroDeserializer, RecordSerializer, SchemaRegistryClient
  const srcDir = path.join(appPath, 'src');
  const phpPatterns = [
    'AvroSerializer(',
    'AvroDeserializer(',
    'RecordSerializer(',
    'SchemaRegistryClient(',
    'CachedRegistry(',
    'PromisingRegistry(',
  ];

  scanPhpFiles(srcDir, appPath, (filePath, content) => {
    const hasPattern = phpPatterns.some((p) => content.includes(p));
    if (!hasPattern) return;

    const relFile = path.relative(appPath, filePath);

    for (const pattern of phpPatterns) {
      if (!content.includes(pattern)) continue;
      const className = pattern.replace('(', '');

      // Check for LATEST schema version usage
      const hasLatest = content.includes("'latest'") || content.includes('"latest"') || content.includes('LATEST');
      const issue = hasLatest
        ? `${className} in "${relFile}" uses LATEST schema version — resolving LATEST at runtime means schema changes can break production silently; pin a specific schema version ID for reproducible deployments`
        : null;

      results.push({ source: relFile, type: 'php', detail: `${className} used`, issue });
    }

    // Check for hardcoded schema JSON instead of registry lookup
    const hasHardcodedSchema = content.includes('AvroSchema::parse(') && (content.includes('{"type"') || content.includes("'type' =>"));
    if (hasHardcodedSchema) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Hardcoded Avro schema JSON',
        issue: `Hardcoded Avro schema JSON in "${relFile}" instead of registry lookup — schema changes require code deployments; use SchemaRegistryClient to fetch schema by subject for schema evolution support`,
      });
    }

    // Check compatibility mode
    const hasCompatibilityConfig = content.includes('updateCompatibility(') || content.includes('compatibility') || content.includes('BACKWARD') || content.includes('FORWARD') || content.includes('"FULL"');
    if (!hasCompatibilityConfig && (content.includes('SchemaRegistryClient(') || content.includes('CachedRegistry('))) {
      results.push({
        source: relFile,
        type: 'php',
        detail: 'Schema compatibility mode not set',
        issue: `SchemaRegistryClient in "${relFile}" without compatibility mode configuration — without BACKWARD/FORWARD/FULL compatibility consumers may fail on schema changes; set compatibility level via updateCompatibility()`,
      });
    }
  });

  // Avro schema files *.avsc in resources/, schemas/, avro/
  const avscDirs = [
    path.join(appPath, 'resources'),
    path.join(appPath, 'schemas'),
    path.join(appPath, 'avro'),
    path.join(appPath, 'src', 'Avro'),
  ];

  for (const avscDir of avscDirs) {
    scanAvscFiles(avscDir, appPath, (filePath, content) => {
      const relFile = path.relative(appPath, filePath);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        results.push({ source: relFile, type: 'schema', detail: 'Avro schema file (invalid JSON)', issue: `Avro schema "${relFile}" is not valid JSON` });
        return;
      }
      const schemaName = typeof parsed['name'] === 'string' ? parsed['name'] : 'unknown';
      const schemaType = typeof parsed['type'] === 'string' ? parsed['type'] : 'unknown';
      results.push({ source: relFile, type: 'schema', detail: `name: ${schemaName}, type: ${schemaType}`, issue: null });

      // Check for missing default values (breaks schema evolution)
      const fields = Array.isArray(parsed['fields']) ? parsed['fields'] as Array<Record<string, unknown>> : [];
      const fieldsWithoutDefault = fields.filter((f) => f['default'] === undefined && f['name'] !== undefined);
      if (fieldsWithoutDefault.length > 0) {
        const fieldNames = fieldsWithoutDefault.map((f) => String(f['name'])).slice(0, 5).join(', ');
        results.push({
          source: relFile,
          type: 'schema',
          detail: `Fields without defaults: ${fieldNames}`,
          issue: `Avro schema "${relFile}" has fields without default values (${fieldNames}) — fields without defaults break backward/forward compatibility; add "default": null or appropriate defaults to all fields`,
        });
      }
    });
  }

  // If no Avro package found but SCHEMA_REGISTRY_URL exists, flag
  if (!hasAvroPackage && results.some((r) => r.type === 'env')) {
    results.push({
      source: 'composer.json',
      type: 'composer',
      detail: 'No Avro serialization package found',
      issue: 'SCHEMA_REGISTRY_URL configured but no Avro serialization package in composer.json — install flix-tech/avro-serde-php or jobcloud/php-kafka-avro-serde for schema-based serialization',
    });
  }

  return results;
}

export function listKafkaSchemaRegistry(appPath: string): McpToolResult {
  try {
    const infos = buildKafkaSchemaRegistryInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Kafka Schema Registry / Avro configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Kafka Schema Registry / Avro Configuration\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.type.toUpperCase()}] ${info.source}\n`;
      text += `  Detail: ${info.detail}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.detail}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning Kafka Schema Registry config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getKafkaSchemaRegistryStats(appPath: string): McpToolResult {
  try {
    const infos = buildKafkaSchemaRegistryInfos(appPath);
    const byType = { composer: 0, env: 0, php: 0, schema: 0 };
    for (const i of infos) byType[i.type]++;
    const issues = infos.filter((i) => i.issue !== null);
    const text = [
      `Kafka Schema Registry Stats`,
      `===========================`,
      `Total entries   : ${infos.length}`,
      `  Composer      : ${byType.composer}`,
      `  Env vars      : ${byType.env}`,
      `  PHP files     : ${byType.php}`,
      `  Avro schemas  : ${byType.schema}`,
      `Issues          : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getKafkaSchemaRegistryTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_kafka_schema_registry',
      description: 'Scan for Confluent Schema Registry / Avro schema patterns: composer packages (flix-tech/avro-serde-php, etc.), env vars (SCHEMA_REGISTRY_URL), PHP usage (AvroSerializer, SchemaRegistryClient), and .avsc schema files. Flags open registry, LATEST version in production, missing compatibility mode, and Avro fields without defaults.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_kafka_schema_registry_stats',
      description: 'Return summary statistics for Kafka Schema Registry configuration: entry counts by type and total issues found.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
