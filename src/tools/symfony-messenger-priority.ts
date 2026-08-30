// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface MessengerPriorityInfo {
  transportName: string;
  priority?: number;
  messages: string[];
  hasDeadLetter: boolean;
  issues: string[];
}

function inferPriorityFromName(name: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower.includes('high') || lower.includes('urgent') || lower.includes('critical')) return 10;
  if (lower.includes('low') || lower.includes('background') || lower.includes('slow')) return 1;
  if (lower.includes('priority')) return 5;
  return undefined;
}

function loadMessengerPriorityConfig(appPath: string): MessengerPriorityInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'messenger.yml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (framework['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    const transports = (messenger['transports'] ?? {}) as Record<string, unknown>;
    const routing = (messenger['routing'] ?? {}) as Record<string, unknown>;

    if (Object.keys(transports).length === 0) continue;

    // Build message -> transports map from routing
    const messageTransportMap = new Map<string, string[]>();
    for (const [msgClass, transportsRaw] of Object.entries(routing)) {
      const transportList = Array.isArray(transportsRaw)
        ? (transportsRaw as string[])
        : [String(transportsRaw)];
      messageTransportMap.set(msgClass, transportList);
    }

    // Build transport -> messages map
    const transportMessages = new Map<string, string[]>();
    for (const [msgClass, transportList] of messageTransportMap.entries()) {
      for (const t of transportList) {
        const existing = transportMessages.get(t) ?? [];
        existing.push(msgClass);
        transportMessages.set(t, existing);
      }
    }

    const results: MessengerPriorityInfo[] = [];

    for (const [name, def] of Object.entries(transports)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const options = (d['options'] ?? {}) as Record<string, unknown>;
      const hasDeadLetter = 'failed_transport' in d ||
        JSON.stringify(options).includes('dead') ||
        JSON.stringify(d).includes('failure_transport');

      const priority = inferPriorityFromName(name);
      const messages = transportMessages.get(name) ?? [];

      const issues: string[] = [];

      // FIFO guarantee concern for priority transports
      if (priority !== undefined) {
        const dsn = String(d['dsn'] ?? '');
        if (dsn.includes('amqp') && !dsn.includes('x-max-priority')) {
          issues.push(`Priority transport "${name}" uses AMQP without x-max-priority — no FIFO priority guarantee`);
        }
      }

      if (!hasDeadLetter && priority !== undefined && priority >= 10) {
        issues.push(`High-priority transport "${name}" without dead letter queue — failed high-priority messages are lost`);
      }

      results.push({ transportName: name, priority, messages, hasDeadLetter, issues });
    }

    // Cross-transport issues
    const allTransportNames = results.map((r) => r.transportName);
    const hasPriorityTransport = results.some((r) => r.priority !== undefined);
    if (!hasPriorityTransport && results.length > 0) {
      for (const r of results) {
        r.issues.push('No priority differentiation detected across transports — all messages treated equally');
      }
    }

    // Check same message routed to multiple transports
    for (const [msgClass, transportList] of messageTransportMap.entries()) {
      if (transportList.length > 1) {
        const hasPriorityDiff = transportList.some((t) => inferPriorityFromName(t) !== undefined);
        if (!hasPriorityDiff) {
          for (const t of transportList) {
            const r = results.find((res) => res.transportName === t);
            if (r) {
              r.issues.push(`Message "${msgClass}" routed to multiple transports without priority differentiation`);
            }
          }
        }
      }
    }

    // Check if a worker might consume high and low priority from the same process
    const lowPriorityTransports = results.filter((r) => r.priority !== undefined && r.priority <= 1);
    const highPriorityTransports = results.filter((r) => r.priority !== undefined && r.priority >= 10);
    if (lowPriorityTransports.length > 0 && highPriorityTransports.length > 0) {
      const lowNames = lowPriorityTransports.map((r) => r.transportName).join(', ');
      const highNames = highPriorityTransports.map((r) => r.transportName).join(', ');
      // Heuristic: they belong to same app, warn user
      const firstHigh = results.find((r) => highPriorityTransports.includes(r));
      if (firstHigh) {
        firstHigh.issues.push(`Detected both high [${highNames}] and low [${lowNames}] priority transports — ensure workers are separate per priority level`);
      }
    }

    if (allTransportNames.length > 0 && !hasPriorityTransport) {
      results[0]?.issues.push('Missing low-priority transport — all messages share same priority level');
    }

    return results;
  }

  return [];
}

export function listMessengerPriority(appPath: string): McpToolResult {
  try {
    const configs = loadMessengerPriorityConfig(appPath);
    if (configs.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No messenger transports found for priority analysis.\n\nExample priority setup:\n  transports:\n    high_priority:\n      dsn: \'%env(MESSENGER_TRANSPORT_DSN)%\'\n    low_priority:\n      dsn: \'%env(MESSENGER_TRANSPORT_DSN)%\'',
        }],
      };
    }

    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `Messenger Priority Transports\n${'='.repeat(55)}\n\nTransports: ${configs.length}  Issues: ${totalIssues}\n`;

    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.transportName}\n`;
      text += `    priority:   ${c.priority !== undefined ? String(c.priority) : 'not inferred'}\n`;
      text += `    dead letter: ${c.hasDeadLetter ? 'yes' : 'no'}\n`;
      if (c.messages.length > 0) text += `    messages:   ${c.messages.join(', ')}\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerPriorityStats(appPath: string): McpToolResult {
  try {
    const configs = loadMessengerPriorityConfig(appPath);
    const withPriority = configs.filter((c) => c.priority !== undefined);
    const withDeadLetter = configs.filter((c) => c.hasDeadLetter);

    let text = `Messenger Priority Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports:        ${configs.length}\n`;
    text += `  With priority naming:  ${withPriority.length}\n`;
    text += `  With dead letter:      ${withDeadLetter.length}\n`;
    text += `  Without dead letter:   ${configs.length - withDeadLetter.length}\n`;
    text += `Issues:                  ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMessengerPriorityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_priority',
      description: 'Show Messenger transport priority configuration: high/low priority transport detection, routing, dead letter queues; warns on FIFO guarantee issues, missing priority differentiation, high-priority without dead letter, shared worker risk',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_priority_stats',
      description: 'Show messenger priority statistics: transport count, priority-named transport count, dead letter coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
