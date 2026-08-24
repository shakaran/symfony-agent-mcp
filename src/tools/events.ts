// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Event/Listener Inspector
 *
 * Parses event listeners and subscribers from:
 *   - src/EventListener/  (classes tagged kernel.event_listener)
 *   - src/EventSubscriber/ (classes implementing EventSubscriberInterface)
 *   - config/services.yaml (explicit kernel.event_listener tags)
 *
 * Extracts: event name, listener class, method, priority.
 * All data is read from source files — no PHP execution required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface EventListener {
  event: string;
  class: string;
  method: string;
  priority: number;
  source: 'attribute' | 'subscriber' | 'service_tag' | 'yaml';
}

interface EventSubscriber {
  class: string;
  file: string;
  events: Array<{ event: string; method: string; priority: number }>;
}

// ─── PHP file scanning ─────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch {
    // Skip
  }
  return files;
}

function extractClassName(content: string): string {
  const m = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
  return m ? m[1] : '';
}

function extractNamespace(content: string): string {
  const m = /^namespace\s+([\w\\]+)\s*;/m.exec(content);
  return m ? m[1] : '';
}

// ─── EventSubscriber parsing ───────────────────────────────────────────────

function parseSubscriberFile(content: string, filePath: string): EventSubscriber | null {
  if (!content.includes('EventSubscriberInterface') && !content.includes('getSubscribedEvents')) {
    return null;
  }

  const className = extractClassName(content);
  if (!className) return null;
  const namespace = extractNamespace(content);

  const events: Array<{ event: string; method: string; priority: number }> = [];

  // Extract getSubscribedEvents() return body
  const methodMatch = /getSubscribedEvents\s*\(\s*\)[^{]*\{([\s\S]*?)^\s{4}\}/m.exec(content);
  if (!methodMatch) {
    // Fallback: look for return [...] anywhere
    const retMatch = /return\s*\[([\s\S]*?)\];/.exec(content);
    if (retMatch) {
      parseSubscribedEventsBlock(retMatch[1], events);
    }
  } else {
    parseSubscribedEventsBlock(methodMatch[1], events);
  }

  // If no events parsed, try to extract from #[AsEventListener] attributes
  if (events.length === 0) {
    parseAsEventListenerAttributes(content, events);
  }

  return {
    class: namespace ? `${namespace}\\${className}` : className,
    file: path.basename(filePath),
    events,
  };
}

function parseSubscribedEventsBlock(
  block: string,
  events: Array<{ event: string; method: string; priority: number }>
): void {
  // Pattern: 'event.name' => 'methodName'
  // Pattern: 'event.name' => ['methodName', priority]
  // Pattern: 'event.name' => [['methodA', 10], ['methodB', 5]]
  // Pattern: KernelEvents::REQUEST => 'methodName'

  const singleMethod = /(['"]([\w.\\:]+)['"]|[\w\\]+::\w+)\s*=>\s*['"](\w+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = singleMethod.exec(block)) !== null) {
    events.push({
      event: normalizeEventName(m[2] ?? m[1]),
      method: m[3],
      priority: 0,
    });
  }

  // Pattern: 'event.name' => ['methodName', priority]
  const withPriority = /(['"]([\w.\\:]+)['"]|[\w\\]+::\w+)\s*=>\s*\[\s*['"](\w+)['"]\s*,\s*(-?\d+)/g;
  while ((m = withPriority.exec(block)) !== null) {
    // Replace if already added without priority
    const existing = events.find((e) => e.event === normalizeEventName(m![2] ?? m![1]) && e.method === m![3]);
    if (existing) {
      existing.priority = parseInt(m[4], 10);
    } else {
      events.push({
        event: normalizeEventName(m[2] ?? m[1]),
        method: m[3],
        priority: parseInt(m[4], 10),
      });
    }
  }
}

function parseAsEventListenerAttributes(
  content: string,
  events: Array<{ event: string; method: string; priority: number }>
): void {
  // #[AsEventListener(event: 'kernel.request', method: 'onKernelRequest', priority: 10)]
  const pattern = /#\[AsEventListener\(([^)]+)\)\]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const args = m[1];
    const eventMatch = /event\s*:\s*['"]([\w.]+)['"]/.exec(args);
    const methodMatch = /method\s*:\s*['"]([\w]+)['"]/.exec(args);
    const priorityMatch = /priority\s*:\s*(-?\d+)/.exec(args);
    if (eventMatch) {
      events.push({
        event: eventMatch[1],
        method: methodMatch ? methodMatch[1] : '__invoke',
        priority: priorityMatch ? parseInt(priorityMatch[1], 10) : 0,
      });
    }
  }
}

// ─── EventListener attribute parsing ──────────────────────────────────────

function parseListenerFile(content: string, _filePath: string): EventListener[] {
  const listeners: EventListener[] = [];
  const className = extractClassName(content);
  if (!className) return listeners;
  const namespace = extractNamespace(content);
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // #[AsEventListener(event: 'kernel.request', method: 'onKernelRequest')]
  const attrPattern = /#\[AsEventListener\(([^)]+)\)\]\s*(?:public|protected|private)?\s*function\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(content)) !== null) {
    const args = m[1];
    const method = m[2];
    const eventMatch = /event\s*:\s*['"]([\w.]+)['"]/.exec(args);
    const priorityMatch = /priority\s*:\s*(-?\d+)/.exec(args);
    listeners.push({
      event: eventMatch ? eventMatch[1] : 'unknown',
      class: fqn,
      method,
      priority: priorityMatch ? parseInt(priorityMatch[1], 10) : 0,
      source: 'attribute',
    });
  }

  // Fallback: class-level #[AsEventListener]
  if (listeners.length === 0 && content.includes('AsEventListener')) {
    const classAttr = /#\[AsEventListener\(([^)]+)\)\][\s\S]*?class\s+\w+/.exec(content);
    if (classAttr) {
      const args = classAttr[1];
      const eventMatch = /event\s*:\s*['"]([\w.]+)['"]/.exec(args);
      if (eventMatch) {
        listeners.push({
          event: eventMatch[1],
          class: fqn,
          method: '__invoke',
          priority: 0,
          source: 'attribute',
        });
      }
    }
  }

  return listeners;
}

// ─── YAML service tag parsing ──────────────────────────────────────────────

function parseDetailedYamlListeners(appPath: string): EventListener[] {
  const listeners: EventListener[] = [];
  const servicesFile = path.join(appPath, 'config', 'services.yaml');
  const config = parseYamlFile(servicesFile) as Record<string, unknown> | null;
  if (!config) return listeners;

  const services = (config['services'] ?? {}) as Record<string, unknown>;

  for (const [id, def] of Object.entries(services)) {
    if (!def || typeof def !== 'object') continue;
    const svc = def as Record<string, unknown>;
    const tags = svc['tags'] as Array<unknown> | undefined;
    if (!Array.isArray(tags)) continue;

    for (const tag of tags) {
      if (typeof tag === 'object' && tag !== null) {
        const t = tag as Record<string, unknown>;
        if (t['name'] === 'kernel.event_listener') {
          listeners.push({
            event: String(t['event'] ?? 'unknown'),
            class: String(svc['class'] ?? id),
            method: String(t['method'] ?? 'onEvent'),
            priority: Number(t['priority'] ?? 0),
            source: 'yaml',
          });
        }
      }
    }
  }

  return listeners;
}

// ─── Normalization ─────────────────────────────────────────────────────────

const KERNEL_EVENTS: Record<string, string> = {
  'KernelEvents::REQUEST': 'kernel.request',
  'KernelEvents::RESPONSE': 'kernel.response',
  'KernelEvents::EXCEPTION': 'kernel.exception',
  'KernelEvents::VIEW': 'kernel.view',
  'KernelEvents::CONTROLLER': 'kernel.controller',
  'KernelEvents::CONTROLLER_ARGUMENTS': 'kernel.controller_arguments',
  'KernelEvents::TERMINATE': 'kernel.terminate',
  'KernelEvents::FINISH_REQUEST': 'kernel.finish_request',
  'ConsoleEvents::COMMAND': 'console.command',
  'ConsoleEvents::TERMINATE': 'console.terminate',
  'ConsoleEvents::ERROR': 'console.error',
  'MessageEvents::MESSAGE_SENT': 'message.sent',
};

function normalizeEventName(raw: string): string {
  return KERNEL_EVENTS[raw.trim()] ?? raw.trim();
}

// ─── Main loading ──────────────────────────────────────────────────────────

function loadAllListeners(appPath: string): {
  subscribers: EventSubscriber[];
  listeners: EventListener[];
} {
  const subscribers: EventSubscriber[] = [];
  const listeners: EventListener[] = [];

  const scanDirs = [
    path.join(appPath, 'src', 'EventListener'),
    path.join(appPath, 'src', 'EventSubscriber'),
    path.join(appPath, 'src', 'Listener'),
    path.join(appPath, 'src', 'Subscriber'),
  ];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.length > 500_000) continue;
        const sub = parseSubscriberFile(content, file);
        if (sub && sub.events.length > 0) {
          subscribers.push(sub);
        } else {
          const lits = parseListenerFile(content, file);
          listeners.push(...lits);
        }
      } catch {
        // Skip
      }
    }
  }

  // Also check src/Security, src/Controller etc. for AsEventListener attributes
  const extraDirs = [
    path.join(appPath, 'src', 'Security'),
    path.join(appPath, 'src', 'Service'),
  ];
  for (const dir of extraDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.length > 500_000) continue;
        if (!content.includes('AsEventListener')) continue;
        listeners.push(...parseListenerFile(content, file));
      } catch {
        // Skip
      }
    }
  }

  // YAML-defined listeners
  listeners.push(...parseDetailedYamlListeners(appPath));

  return { subscribers, listeners };
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listEventListeners(appPath: string): McpToolResult {
  try {
    const { subscribers, listeners } = loadAllListeners(appPath);

    if (subscribers.length === 0 && listeners.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No event listeners or subscribers found.\n\nExpected locations:\n  src/EventListener/\n  src/EventSubscriber/\n\nCreate with: php bin/console make:listener\n             php bin/console make:subscriber',
        }],
      };
    }

    let text = `Event Listeners & Subscribers\n${'='.repeat(50)}\n\n`;

    if (subscribers.length > 0) {
      text += `Event Subscribers (${subscribers.length}):\n${'─'.repeat(50)}\n`;
      for (const sub of subscribers) {
        const shortClass = sub.class.split('\\').pop() ?? sub.class;
        text += `\n  ${shortClass}  (${sub.file})\n`;
        for (const ev of sub.events) {
          const pri = ev.priority !== 0 ? `  [priority: ${ev.priority}]` : '';
          text += `    ${ev.event.padEnd(40)}→ ${ev.method}${pri}\n`;
        }
      }
      text += '\n';
    }

    if (listeners.length > 0) {
      text += `Event Listeners (${listeners.length}):\n${'─'.repeat(50)}\n`;
      for (const l of listeners) {
        const shortClass = l.class.split('\\').pop() ?? l.class;
        const pri = l.priority !== 0 ? `  [priority: ${l.priority}]` : '';
        text += `  ${l.event.padEnd(40)}→ ${shortClass}::${l.method}${pri}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error scanning event listeners: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEventListenersByEvent(appPath: string, eventName: string): McpToolResult {
  try {
    const { subscribers, listeners } = loadAllListeners(appPath);
    const lq = eventName.toLowerCase();

    const matchedSubs = subscribers.filter((s) =>
      s.events.some((e) => e.event.toLowerCase().includes(lq))
    );
    const matchedListeners = listeners.filter((l) => l.event.toLowerCase().includes(lq));

    if (matchedSubs.length === 0 && matchedListeners.length === 0) {
      return {
        content: [{ type: 'text', text: `No listeners found for event matching "${eventName}".` }],
      };
    }

    let text = `Listeners for event matching "${eventName}":\n${'─'.repeat(50)}\n\n`;

    for (const sub of matchedSubs) {
      const matchedEvents = sub.events.filter((e) => e.event.toLowerCase().includes(lq));
      for (const ev of matchedEvents) {
        const shortClass = sub.class.split('\\').pop() ?? sub.class;
        text += `  [subscriber] ${shortClass}::${ev.method}`;
        if (ev.priority !== 0) text += `  (priority: ${ev.priority})`;
        text += `\n    Full class: ${sub.class}\n\n`;
      }
    }

    for (const l of matchedListeners) {
      const shortClass = l.class.split('\\').pop() ?? l.class;
      text += `  [listener]   ${shortClass}::${l.method}`;
      if (l.priority !== 0) text += `  (priority: ${l.priority})`;
      text += `\n    Full class: ${l.class}\n    Source: ${l.source}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEventStats(appPath: string): McpToolResult {
  try {
    const { subscribers, listeners } = loadAllListeners(appPath);

    const eventCounts: Record<string, number> = {};

    for (const sub of subscribers) {
      for (const ev of sub.events) {
        eventCounts[ev.event] = (eventCounts[ev.event] ?? 0) + 1;
      }
    }
    for (const l of listeners) {
      eventCounts[l.event] = (eventCounts[l.event] ?? 0) + 1;
    }

    const totalEvents = Object.keys(eventCounts).length;
    const totalListeners = listeners.length + subscribers.reduce((s, sub) => s + sub.events.length, 0);

    let text = `Event System Statistics\n${'='.repeat(40)}\n\n`;
    text += `Subscribers:       ${subscribers.length}\n`;
    text += `Listener classes:  ${listeners.length}\n`;
    text += `Total hooks:       ${totalListeners}\n`;
    text += `Distinct events:   ${totalEvents}\n`;

    if (totalEvents > 0) {
      text += `\nEvents by listener count:\n`;
      const sorted = Object.entries(eventCounts).sort(([, a], [, b]) => b - a);
      for (const [event, count] of sorted) {
        text += `  ${event.padEnd(45)} ${count} listener(s)\n`;
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getEventTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_event_listeners',
      description: 'List all Symfony event listeners and subscribers from src/EventListener/, src/EventSubscriber/, and services.yaml tags',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_event_listeners_by_event',
      description: 'Find all listeners registered for a specific event name (e.g. kernel.request, kernel.exception)',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          event_name: { type: 'string', description: 'Event name or partial match (e.g. "kernel.request")' },
        },
        required: ['app_path', 'event_name'],
      },
    },
    {
      name: 'get_event_stats',
      description: 'Show event system statistics: total subscribers, listeners, distinct events, and listener count per event',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
