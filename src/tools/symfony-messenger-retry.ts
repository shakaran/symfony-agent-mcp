// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface RetryInfo {
  transport: string;
  hasRetryStrategy: boolean;
  maxRetries?: number;
  delay?: number;
  multiplier?: number;
  maxDelay?: number;
  hasCustomStrategy: boolean;
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

function scanCustomRetryStrategies(appPath: string): { hasNullStrategy: boolean; hasCustomStrategy: boolean } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { hasNullStrategy: false, hasCustomStrategy: false };

  let hasNullStrategy = false;
  let hasCustomStrategy = false;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (content.includes('NullRetryStrategy')) hasNullStrategy = true;
    if (content.includes('RetryStrategyInterface') && content.includes('implements')) hasCustomStrategy = true;
  }

  return { hasNullStrategy, hasCustomStrategy };
}

function loadRetryConfig(appPath: string): RetryInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  const { hasNullStrategy, hasCustomStrategy } = scanCustomRetryStrategies(appPath);

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;

    if (Object.keys(transports).length === 0) continue;

    const results: RetryInfo[] = [];
    for (const [name, def] of Object.entries(transports)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const retryRaw = (typeof d === 'object' ? d['retry_strategy'] : null) as Record<string, unknown> | null;

      if (!retryRaw) {
        const issues: string[] = [];
        issues.push(`Transport "${name}" has no retry_strategy — messages lost on processing failure`);
        results.push({ transport: name, hasRetryStrategy: false, hasCustomStrategy, issues });
        continue;
      }

      const maxRetries = retryRaw['max_retries'] !== undefined ? parseInt(String(retryRaw['max_retries']), 10) : undefined;
      const delay = retryRaw['delay'] !== undefined ? parseInt(String(retryRaw['delay']), 10) : undefined;
      const multiplier = retryRaw['multiplier'] !== undefined ? parseFloat(String(retryRaw['multiplier'])) : undefined;
      const maxDelay = retryRaw['max_delay'] !== undefined ? parseInt(String(retryRaw['max_delay']), 10) : undefined;

      const issues: string[] = [];
      if (maxRetries === 0) {
        issues.push(`max_retries=0 on transport "${name}" — messages not retried; equivalent to no retry strategy`);
      }
      if (maxDelay === undefined) {
        issues.push(`max_delay not set on "${name}" — exponential backoff unbounded; set max_delay to cap retry interval`);
      }
      if (hasNullStrategy) {
        issues.push('NullRetryStrategy detected in src/ — explicit no-retry; confirm this is intentional');
      }
      if (maxRetries !== undefined && maxRetries > 10) {
        issues.push(`max_retries=${maxRetries} on "${name}" — very high; check if intentional (risk of message queue saturation)`);
      }

      results.push({ transport: name, hasRetryStrategy: true, maxRetries, delay, multiplier, maxDelay, hasCustomStrategy, issues });
    }

    return results;
  }
  return [];
}

export function listMessengerRetryConfig(appPath: string): McpToolResult {
  try {
    const configs = loadRetryConfig(appPath);
    if (configs.length === 0) {
      return { content: [{ type: 'text', text: 'No messenger transports found.\n\nExample:\n  framework:\n    messenger:\n      transports:\n        async:\n          dsn: \'%env(MESSENGER_TRANSPORT_DSN)%\'\n          retry_strategy:\n            max_retries: 3\n            delay: 1000\n            multiplier: 2\n            max_delay: 0' }] };
    }

    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `Messenger Retry Configuration\n${'='.repeat(55)}\n\nTransports: ${configs.length}  Issues: ${totalIssues}\n`;

    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.transport}\n`;
      if (c.hasRetryStrategy) {
        if (c.maxRetries !== undefined) text += `    max_retries: ${c.maxRetries}\n`;
        if (c.delay !== undefined) text += `    delay: ${c.delay}ms\n`;
        if (c.multiplier !== undefined) text += `    multiplier: ${c.multiplier}\n`;
        text += `    max_delay: ${c.maxDelay !== undefined ? `${c.maxDelay}ms` : 'not set (unbounded)'}\n`;
      } else {
        text += `    retry_strategy: not configured\n`;
      }
      if (c.hasCustomStrategy) text += `    custom strategy: detected in src/\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerRetryStats(appPath: string): McpToolResult {
  try {
    const configs = loadRetryConfig(appPath);
    const withRetry = configs.filter((c) => c.hasRetryStrategy);

    let text = `Messenger Retry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports:       ${configs.length}\n`;
    text += `With retry_strategy:    ${withRetry.length}\n`;
    text += `  With max_delay set:   ${withRetry.filter((c) => c.maxDelay !== undefined).length}\n`;
    text += `  max_retries > 10:     ${withRetry.filter((c) => c.maxRetries !== undefined && c.maxRetries > 10).length}\n`;
    text += `  max_retries = 0:      ${withRetry.filter((c) => c.maxRetries === 0).length}\n`;
    text += `Custom strategies:      ${configs.filter((c) => c.hasCustomStrategy).length > 0 ? 'detected' : 'none'}\n`;
    text += `Issues:                 ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerRetryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_retry_config',
      description: 'Show Messenger retry_strategy per transport: max_retries, delay, multiplier, max_delay; warns on missing retry strategy (message loss), max_retries=0, unbounded max_delay, NullRetryStrategy, max_retries>10',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_retry_stats',
      description: 'Show messenger retry statistics: transport count, retry strategy coverage, max_delay set count, high/zero retry counts, custom strategy detection, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
