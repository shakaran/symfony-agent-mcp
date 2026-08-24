// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Messenger Failure Transport Inspector
 *
 * Distinct from messenger.ts (which covers transports, routing, handlers).
 * Deep inspection of failure handling configuration:
 *
 * messenger.yaml failure_transport:
 *   - Global failure_transport (default for all transports)
 *   - Per-transport failure_transport override
 *   - failure_transport pointing to a transport that itself has no failure (chain risk)
 *
 * Retry strategies per transport:
 *   - max_retries (default 3)
 *   - delay in ms (default 1000)
 *   - multiplier (default 2 = exponential backoff)
 *   - max_delay (cap)
 *   - service (custom RetryStrategyInterface implementation)
 *
 * Analysis:
 *   - Transports without failure_transport (messages silently dropped on final failure)
 *   - Very high max_retries (> 10) — messages may stay in queue for hours
 *   - No retry_strategy configured (defaults may not be suitable for all transports)
 *   - Dead-letter transport with no retry (messages accumulate without alerting)
 *   - Async transports vs sync (sync: exceptions bubble up, no retry needed)
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface RetryStrategy {
  maxRetries?: number;
  delay?: number;
  multiplier?: number;
  maxDelay?: number;
  service?: string;
}

interface TransportFailureConfig {
  name: string;
  dsn: string;
  failureTransport?: string;
  retryStrategy?: RetryStrategy;
  isFailed: boolean;
}

interface FailureConfig {
  globalFailureTransport?: string;
  transports: TransportFailureConfig[];
  issues: string[];
}

function loadMessengerYaml(appPath: string): Record<string, unknown> | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'messenger.yml'),
  ];
  for (const f of candidates) {
    const raw = parseYamlFile(f) as Record<string, unknown> | null;
    if (raw) return raw;
  }
  return null;
}

function analyzeFailures(raw: Record<string, unknown>): FailureConfig {
  const messenger = (raw['framework'] as Record<string, unknown>)?.['messenger'] ??
                    (raw['messenger'] ?? raw) as Record<string, unknown>;
  const m = messenger as Record<string, unknown>;

  const globalFailureTransport = m['failure_transport'] ? String(m['failure_transport']) : undefined;
  const transportsRaw = (m['transports'] ?? {}) as Record<string, unknown>;
  const issues: string[] = [];

  const transports: TransportFailureConfig[] = Object.entries(transportsRaw).map(([name, def]) => {
    const d = (def ?? {}) as Record<string, unknown>;
    const rawDsn = typeof d === 'string' ? d : String(d['dsn'] ?? '');

    const retryRaw = d['retry_strategy'] as Record<string, unknown> | undefined;
    const retryStrategy: RetryStrategy | undefined = retryRaw ? {
      maxRetries: retryRaw['max_retries'] ? parseInt(String(retryRaw['max_retries']), 10) : undefined,
      delay: retryRaw['delay'] ? parseInt(String(retryRaw['delay']), 10) : undefined,
      multiplier: retryRaw['multiplier'] ? parseFloat(String(retryRaw['multiplier'])) : undefined,
      maxDelay: retryRaw['max_delay'] ? parseInt(String(retryRaw['max_delay']), 10) : undefined,
      service: retryRaw['service'] ? String(retryRaw['service']) : undefined,
    } : undefined;

    const isFailed = name.startsWith('failed') || name.includes('dead') || name.includes('dlq') ||
                     rawDsn.includes('failed') || rawDsn.includes('dead_letter');

    return {
      name,
      dsn: rawDsn
        .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
        .replace(/([?&])(password|auth|token|secret|key|api_key|access_key)=[^&\s]*/gi, '$1$2=***'),
      failureTransport: d['failure_transport'] ? String(d['failure_transport']) : undefined,
      retryStrategy,
      isFailed,
    };
  });

  // Detect transports without failure coverage
  const asyncTransports = transports.filter((t) =>
    !t.isFailed && !t.dsn.startsWith('sync://') && t.dsn !== 'sync://'
  );
  for (const t of asyncTransports) {
    const hasFailure = t.failureTransport ?? globalFailureTransport;
    if (!hasFailure) {
      issues.push(`Transport "${t.name}" has no failure_transport — messages silently dropped on final failure`);
    }
  }

  // Detect high retry counts
  for (const t of transports) {
    if (t.retryStrategy?.maxRetries && t.retryStrategy.maxRetries > 10) {
      issues.push(`Transport "${t.name}" has max_retries=${t.retryStrategy.maxRetries} — messages may queue for a long time`);
    }
  }

  // Dead-letter with no retry pointing at it
  const failureTargets = new Set([
    ...(globalFailureTransport ? [globalFailureTransport] : []),
    ...transports.filter((t) => t.failureTransport).map((t) => t.failureTransport as string),
  ]);
  const deadLetterTransports = transports.filter((t) => t.isFailed && !failureTargets.has(t.name));
  if (deadLetterTransports.length > 0) {
    // Only warn if they're defined but nothing points to them
    const orphanDead = deadLetterTransports.filter((t) => !failureTargets.has(t.name) && !t.failureTransport);
    if (orphanDead.length > 0) {
      issues.push(`Dead-letter transports defined but nothing routes to them: ${orphanDead.map((t) => t.name).join(', ')}`);
    }
  }

  return { globalFailureTransport, transports, issues };
}

export function listMessengerFailureConfig(appPath: string): McpToolResult {
  try {
    const raw = loadMessengerYaml(appPath);

    if (!raw) {
      return {
        content: [{
          type: 'text',
          text: 'No messenger.yaml found.\n\nConfigure failure transports:\n  framework:\n    messenger:\n      failure_transport: failed\n      transports:\n        async:\n          dsn: \'%env(MESSENGER_TRANSPORT_DSN)%\'\n          retry_strategy:\n            max_retries: 3\n            delay: 1000\n            multiplier: 2\n        failed:\n          dsn: doctrine://default?queue_name=failed',
        }],
      };
    }

    const config = analyzeFailures(raw);

    let text = `Messenger Failure Configuration\n${'='.repeat(55)}\n\n`;
    text += `Global failure_transport: ${config.globalFailureTransport ?? '⚠ none'}\n`;

    text += `\nTransports (${config.transports.length}):\n`;
    for (const t of config.transports) {
      const ft    = t.failureTransport ? `  → failure: ${t.failureTransport}` : (config.globalFailureTransport ? '' : '  → ⚠ no failure');
      const retry = t.retryStrategy ? `  retries: ${t.retryStrategy.maxRetries ?? 3}` : '  retries: default (3)';
      const dead  = t.isFailed ? '  [dead-letter]' : '';
      text += `  ${t.name.padEnd(25)} ${t.dsn.length < 30 ? t.dsn.padEnd(30) : t.dsn.slice(0, 28) + '..'}${dead}\n`;
      text += `    ${retry}${ft}\n`;
      if (t.retryStrategy) {
        if (t.retryStrategy.delay) text += `    delay: ${t.retryStrategy.delay}ms  multiplier: ${t.retryStrategy.multiplier ?? 2}  maxDelay: ${t.retryStrategy.maxDelay ?? 'none'}\n`;
        if (t.retryStrategy.service) text += `    custom service: ${t.retryStrategy.service}\n`;
      }
    }

    if (config.issues.length > 0) {
      text += `\nIssues (${config.issues.length}):\n`;
      for (const issue of config.issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerFailureStats(appPath: string): McpToolResult {
  try {
    const raw = loadMessengerYaml(appPath);

    let text = `Messenger Failure Statistics\n${'='.repeat(40)}\n\n`;
    if (!raw) {
      text += `messenger.yaml:          not found\n`;
      return { content: [{ type: 'text', text }] };
    }

    const config = analyzeFailures(raw);
    text += `Global failure transport: ${config.globalFailureTransport ?? 'none'}\n`;
    text += `Total transports:         ${config.transports.length}\n`;
    text += `  Dead-letter transports: ${config.transports.filter((t) => t.isFailed).length}\n`;
    text += `  With retry strategy:    ${config.transports.filter((t) => t.retryStrategy).length}\n`;
    text += `  Without failure cover:  ${config.transports.filter((t) => !t.isFailed && !t.failureTransport && !config.globalFailureTransport).length}\n`;
    text += `Issues detected:          ${config.issues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerFailureTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_failure_config',
      description: 'Show Messenger failure transport configuration: global failure_transport, per-transport failure_transport, retry_strategy (max_retries, delay, multiplier, max_delay, custom service), transports without failure coverage, high-retry warning, dead-letter orphan detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_failure_stats',
      description: 'Show Messenger failure statistics: global failure transport, transport count, dead-letter count, retry strategy count, uncovered transport count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
