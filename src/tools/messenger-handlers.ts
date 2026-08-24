// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Messenger Handler Deep Map
 *
 * Scans src/ for #[AsMessageHandler] attributes:
 *   - Handler class, bus assignment, priority, from_transport
 *   - Message class handled (from __invoke type hint)
 *
 * Builds bidirectional maps:
 *   - message → handler(s) (fan-out detection)
 *   - handler → message
 *
 * Reads config/packages/messenger.yaml for:
 *   - Retry strategies per transport
 *   - Failed transport configuration
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface MessageHandler {
  class: string;
  file: string;
  messageClass?: string;
  bus?: string;
  priority: number;
  fromTransport?: string;
  method: string;
}

interface TransportRetry {
  name: string;
  maxRetries?: number;
  delay?: number;
  multiplier?: number;
  failedTransport?: string;
}

// ─── File scanning ──────────────────────────────────────────────────────────


function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

// ─── Handler parsing ────────────────────────────────────────────────────────

function parseHandler(filePath: string): MessageHandler | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('AsMessageHandler')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const attrM = /#\[AsMessageHandler\s*(?:\(([^)]*)\))?\]/.exec(content);
  const attrOptions = attrM?.[1] ?? '';

  const busM = /bus\s*:\s*['"]([^'"]+)['"]/.exec(attrOptions);
  const prioM = /priority\s*:\s*(-?\d+)/.exec(attrOptions);
  const transportM = /from_transport\s*:\s*['"]([^'"]+)['"]/.exec(attrOptions);

  // Find __invoke or handle method and its type-hint
  const invokeRe = /(?:public\s+)?function\s+((?:__invoke|handle))\s*\(\s*(?:[^$]*\s+)?\$(\w+)\s*(?::([^)]+))?\)/;
  const invokeM = invokeRe.exec(content);

  // Type hint may be before the param name or be declared separately
  let messageClass: string | undefined;
  if (invokeM) {
    // Look for typed parameter: public function __invoke(CreateOrderMessage $message)
    const paramRe = new RegExp(
      `function\\s+${invokeM[1]}\\s*\\(\\s*(?:readonly\\s+)?([\\w\\\\]+)\\s+\\$\\w+`
    );
    const paramM = paramRe.exec(content);
    if (paramM) {
      messageClass = paramM[1].split('\\').pop();
    }
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    messageClass,
    bus: busM?.[1],
    priority: prioM ? parseInt(prioM[1], 10) : 0,
    fromTransport: transportM?.[1],
    method: invokeM?.[1] ?? '__invoke',
  };
}

function loadHandlers(appPath: string): MessageHandler[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const handlers: MessageHandler[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const h = parseHandler(file);
    if (h) handlers.push(h);
  }
  return handlers.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Transport retry config ─────────────────────────────────────────────────

function loadTransportRetry(appPath: string): TransportRetry[] {
  const messengerFile = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const raw = parseYamlFile(messengerFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const root = ((raw['framework'] as Record<string, unknown>)?.['messenger']
    ?? raw['messenger']
    ?? {}) as Record<string, unknown>;

  const transportsRaw = root['transports'] as Record<string, unknown> | undefined;
  if (!transportsRaw) return [];

  const retries: TransportRetry[] = [];
  const failureTransport = root['failure_transport'] ? String(root['failure_transport']) : undefined;

  for (const [name, def] of Object.entries(transportsRaw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const retryStrategy = d['retry_strategy'] as Record<string, unknown> | undefined;

    retries.push({
      name,
      maxRetries:     retryStrategy?.['max_retries'] ? Number(retryStrategy['max_retries']) : undefined,
      delay:          retryStrategy?.['delay']        ? Number(retryStrategy['delay'])       : undefined,
      multiplier:     retryStrategy?.['multiplier']   ? Number(retryStrategy['multiplier'])  : undefined,
      failedTransport: d['failure_transport'] ? String(d['failure_transport']) : failureTransport,
    });
  }

  return retries;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listMessengerHandlers(appPath: string): McpToolResult {
  try {
    const handlers = loadHandlers(appPath);
    const transports = loadTransportRetry(appPath);

    if (handlers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No #[AsMessageHandler] handlers found.\n\nCreate:\n  use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;\n\n  #[AsMessageHandler]\n  final class CreateOrderHandler {\n    public function __invoke(CreateOrder $message): void { ... }\n  }',
        }],
      };
    }

    // Build message → handlers map
    const msgMap = new Map<string, MessageHandler[]>();
    for (const h of handlers) {
      const key = h.messageClass ?? '(unknown message)';
      const list = msgMap.get(key) ?? [];
      list.push(h);
      msgMap.set(key, list);
    }

    const fanOut = [...msgMap.entries()].filter(([, hs]) => hs.length > 1);
    const byBus = new Map<string, MessageHandler[]>();
    for (const h of handlers) {
      const bus = h.bus ?? 'default';
      const list = byBus.get(bus) ?? [];
      list.push(h);
      byBus.set(bus, list);
    }

    let text = `Messenger Handler Map  (${handlers.length} handlers, ${msgMap.size} messages)\n${'='.repeat(65)}\n`;

    if (fanOut.length > 0) {
      text += `\nFan-out messages (multiple handlers, ${fanOut.length}):\n`;
      for (const [msg, hs] of fanOut) {
        text += `  ${msg}\n`;
        for (const h of hs.sort((a, b) => b.priority - a.priority)) {
          text += `    → ${h.class}  priority: ${h.priority}\n`;
        }
      }
    }

    text += `\nMessage → Handler map:\n`;
    for (const [msg, hs] of [...msgMap.entries()].sort()) {
      for (const h of hs) {
        const bus = h.bus ? `  bus: ${h.bus}` : '';
        const transport = h.fromTransport ? `  from: ${h.fromTransport}` : '';
        const prio = h.priority !== 0 ? `  priority: ${h.priority}` : '';
        text += `  ${msg.padEnd(35)} → ${h.class}${bus}${transport}${prio}\n`;
      }
    }

    if (byBus.size > 1) {
      text += `\nBy bus:\n`;
      for (const [bus, hs] of byBus) {
        text += `  ${bus}: ${hs.map((h) => h.class).join(', ')}\n`;
      }
    }

    if (transports.length > 0) {
      text += `\nTransport retry config:\n`;
      for (const t of transports) {
        const retries = t.maxRetries !== undefined ? `  max: ${t.maxRetries}` : '';
        const delay = t.delay !== undefined ? `  delay: ${t.delay}ms` : '';
        const mult = t.multiplier !== undefined ? `  ×${t.multiplier}` : '';
        const failed = t.failedTransport ? `  failed→${t.failedTransport}` : '';
        text += `  ${t.name.padEnd(20)}${retries}${delay}${mult}${failed}\n`;
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

export function getMessengerHandlerStats(appPath: string): McpToolResult {
  try {
    const handlers = loadHandlers(appPath);
    const transports = loadTransportRetry(appPath);

    const msgMap = new Map<string, number>();
    for (const h of handlers) {
      const key = h.messageClass ?? '(unknown)';
      msgMap.set(key, (msgMap.get(key) ?? 0) + 1);
    }

    const fanOut = [...msgMap.values()].filter((n) => n > 1).length;
    const buses = new Set(handlers.map((h) => h.bus ?? 'default'));
    const withPriority = handlers.filter((h) => h.priority !== 0).length;
    const withTransport = handlers.filter((h) => h.fromTransport).length;

    let text = `Messenger Handler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total handlers:    ${handlers.length}\n`;
    text += `Distinct messages: ${msgMap.size}\n`;
    text += `Fan-out messages:  ${fanOut}\n`;
    text += `Buses used:        ${buses.size}  (${[...buses].join(', ')})\n`;
    text += `With priority:     ${withPriority}\n`;
    text += `From specific transport: ${withTransport}\n`;
    text += `Transports with retry:   ${transports.filter((t) => t.maxRetries !== undefined).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getMessengerHandlerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_messenger_handlers',
      description: 'Show complete Messenger handler map: message→handler(s), fan-out detection, bus/priority/from_transport per handler, transport retry strategies',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_messenger_handler_stats',
      description: 'Show Messenger handler statistics: handler count, distinct message count, fan-out messages, buses, handlers with priority/transport assignment',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
