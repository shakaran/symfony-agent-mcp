// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Messenger Transport DSN Inspector
 *
 * Reads config/packages/messenger.yaml for transport DSN values.
 * Parses DSN scheme: amqp://, redis://, doctrine://, in-memory://, sync://, null://, sqs://.
 *
 * Warns on:
 *   - DSN using literal password (not env var)
 *   - amqp:// without heartbeat (connection drops silently)
 *   - doctrine:// with auto_setup:true in production (schema changes at runtime)
 *   - redis:// without auth (open Redis)
 *   - sync:// transport in async-expected context
 *   - in-memory:// in non-test environment
 *   - DSN with %env(...)% but env var not defined in .env
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TransportDsnInfo {
  transportName: string;
  scheme: string;
  hasEnvVar: boolean;
  hasAuth: boolean;
  isTest: boolean;
  issues: string[];
}

const DSN_SCHEMES = ['amqp', 'amqps', 'redis', 'rediss', 'doctrine', 'in-memory', 'sync', 'null', 'sqs', 'kafka', 'beanstalkd'];

function detectScheme(dsn: string): string {
  for (const scheme of DSN_SCHEMES) {
    if (dsn.startsWith(scheme + '://') || dsn.startsWith(scheme + ':')) {
      return scheme;
    }
  }
  return 'unknown';
}

function hasLiteralPassword(dsn: string): boolean {
  // Match scheme://user:password@ pattern where password is not an env var
  const m = /^[a-z-]{1,20}:\/\/[^:@]{1,100}:([^@%]{1,100})@/.exec(dsn);
  if (!m) return false;
  const pw = m[1];
  return pw.length > 0 && !pw.startsWith('%env(') && !pw.startsWith('{');
}

function loadEnvKeys(appPath: string): Set<string> {
  const envFile = path.join(appPath, '.env');
  const keys = new Set<string>();
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const m = /^([A-Z_]{1,80})=/.exec(line.trim());
      if (m) keys.add(m[1]);
    }
  } catch { /* skip */ }
  return keys;
}

function extractEnvVarName(dsn: string): string | null {
  const m = /%env\(([^)]{1,80})\)%/.exec(dsn);
  return m ? m[1] : null;
}

function scanMessengerTransports(appPath: string): TransportDsnInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'test', 'messenger.yaml'),
  ];

  const envKeys = loadEnvKeys(appPath);
  const results: TransportDsnInfo[] = [];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const isTestEnv = filePath.includes('/test/');

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    const transportsRaw = (messenger['transports'] ?? {}) as Record<string, unknown>;

    for (const [name, transportData] of Object.entries(transportsRaw)) {
      const transport = (transportData ?? {}) as Record<string, unknown>;

      let dsn = '';
      if (typeof transport['dsn'] === 'string') {
        dsn = transport['dsn'];
      } else if (typeof transportData === 'string') {
        dsn = transportData;
      }

      if (!dsn) continue;

      const scheme = detectScheme(dsn);
      const hasEnvVar = dsn.includes('%env(') || dsn.startsWith('env(');
      const envVarName = extractEnvVarName(dsn);
      const hasAuth = /:[^/@]{1,200}@/.test(dsn) || dsn.includes('?auth=') || dsn.includes('password=');
      const autoSetup = (transport['options'] as Record<string, unknown>)?.['auto_setup'];

      const issues: string[] = [];

      if (hasLiteralPassword(dsn)) {
        issues.push(`Transport "${name}" DSN contains a literal password — use %%env(TRANSPORT_DSN)%% instead`);
      }

      if (scheme === 'amqp' || scheme === 'amqps') {
        const optionsRaw = (transport['options'] ?? {}) as Record<string, unknown>;
        const heartbeat = optionsRaw['heartbeat'];
        if (heartbeat === undefined) {
          issues.push(`Transport "${name}" uses amqp:// without heartbeat option — connection may drop silently`);
        }
      }

      if (scheme === 'doctrine' && autoSetup === true) {
        issues.push(`Transport "${name}" uses doctrine:// with auto_setup:true — schema changes happen at runtime in production`);
      }

      if (scheme === 'redis' && !hasAuth) {
        if (!dsn.includes('@') && !dsn.includes('?auth=') && !dsn.includes('redis://:')) {
          issues.push(`Transport "${name}" uses redis:// without authentication — open Redis instance`);
        }
      }

      if (scheme === 'sync' && !isTestEnv) {
        issues.push(`Transport "${name}" uses sync:// — messages handled synchronously, may block async-expected flows`);
      }

      if (scheme === 'in-memory' && !isTestEnv) {
        issues.push(`Transport "${name}" uses in-memory:// outside test environment — messages lost on process restart`);
      }

      if (hasEnvVar && envVarName) {
        const resolvedName = envVarName.replace(/^[A-Z_]{1,20}:/, '');
        if (!envKeys.has(resolvedName) && !envKeys.has(envVarName)) {
          issues.push(`Transport "${name}" references %%env(${envVarName})%% but var not found in .env`);
        }
      }

      results.push({ transportName: name, scheme, hasEnvVar, hasAuth, isTest: isTestEnv, issues });
    }
  }

  return results;
}

export function listMessengerTransportDsns(appPath: string): McpToolResult {
  try {
    const infos = scanMessengerTransports(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Messenger transports found in config/packages/messenger.yaml.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Transport DSN Analysis\n${'='.repeat(55)}\n\n`;
    text += `Transports: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.transportName}\n`;
      text += `    scheme: ${info.scheme}  envVar: ${info.hasEnvVar ? 'yes' : 'no'}  auth: ${info.hasAuth ? 'yes' : 'no'}  test: ${info.isTest ? 'yes' : 'no'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerTransportDsnStats(appPath: string): McpToolResult {
  try {
    const infos = scanMessengerTransports(appPath);

    const schemeCounts = new Map<string, number>();
    for (const i of infos) schemeCounts.set(i.scheme, (schemeCounts.get(i.scheme) ?? 0) + 1);

    let text = `Messenger Transport DSN Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports:         ${infos.length}\n`;
    text += `  Using env vars:         ${infos.filter((i) => i.hasEnvVar).length}\n`;
    text += `  With auth:              ${infos.filter((i) => i.hasAuth).length}\n`;
    text += `  Test transports:        ${infos.filter((i) => i.isTest).length}\n`;
    text += `Total issues:             ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    if (schemeCounts.size > 0) {
      text += `\nScheme breakdown:\n`;
      for (const [scheme, count] of schemeCounts) {
        text += `  ${scheme.padEnd(20)} ${count}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// Spec-required export aliases
export const listSymfonyMessengerTransportDsns = listMessengerTransportDsns;
export const getSymfonyMessengerTransportDsnStats = getMessengerTransportDsnStats;

export function getMessengerTransportDsnTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_messenger_transport_dsns',
      description: 'Inspect Symfony Messenger transport DSN configs: scheme detection (amqp/redis/doctrine/sync/in-memory/sqs), env var usage, literal password detection, amqp heartbeat, doctrine auto_setup, redis auth, sync in async context, in-memory outside tests',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_messenger_transport_dsn_stats',
      description: 'Statistics for Symfony Messenger transport DSNs: transport count, env-var coverage, auth coverage, test transport count, scheme breakdown, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}

export const getSymfonyMessengerTransportDsnTools = getMessengerTransportDsnTools;
