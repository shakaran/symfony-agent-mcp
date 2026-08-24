// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Custom Application Events Inspector
 *
 * Distinct from events.ts (which lists kernel/framework listeners).
 * This tool focuses on APPLICATION-LEVEL custom events:
 *
 * Custom event classes:
 *   - Classes extending Symfony\Contracts\EventDispatcher\Event
 *   - Classes extending Symfony\Component\EventDispatcher\Event (older)
 *   - Classes implementing EventInterface
 *   - Classes with EVENT_* or public const EVENT = 'app.*' constants
 *
 * EventDispatcher call sites:
 *   - $eventDispatcher->dispatch(new XxxEvent(...))
 *   - $this->dispatch(new XxxEvent(...))
 *   - EventDispatcher::dispatch()
 *
 * Listener registration:
 *   - #[AsEventListener] attribute on classes/methods
 *   - EventSubscriberInterface: getSubscribedEvents() returning custom event names
 *   - services.yaml kernel.event_listener tags for custom events
 *
 * Orphan detection:
 *   - Events dispatched but with no registered listener
 *   - Event classes defined but never dispatched
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface CustomEvent {
  class: string;
  file: string;
  constants: string[];
  dispatched: boolean;
}

interface EventListener {
  class: string;
  file: string;
  listensTo: string[];
  kind: 'subscriber' | 'attribute' | 'tagged';
}

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

function scanCustomEventClasses(appPath: string): CustomEvent[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: CustomEvent[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const isEvent =
      content.includes('extends Event') ||
      content.includes('implements EventInterface') ||
      (content.includes('class ') && /const\s+EVENT(?:_[A-Z]+)?\s*=/.test(content));

    if (!isEvent) continue;
    if (content.includes('EventSubscriberInterface') || content.includes('EventListener')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const constants: string[] = [];
    for (const m of content.matchAll(/const\s+(EVENT[_A-Z]*)\s*=/g)) {
      constants.push(m[1]);
    }

    results.push({ class: classM[1], file: path.basename(file), constants, dispatched: false });
  }
  return results;
}

function scanDispatchCallSites(appPath: string): Set<string> {
  const srcDir = path.join(appPath, 'src');
  const dispatched = new Set<string>();
  if (!fs.existsSync(srcDir)) return dispatched;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('dispatch(')) continue;
    for (const m of content.matchAll(/dispatch\s*\(\s*new\s+(\w+)\s*\(/g)) {
      dispatched.add(m[1]);
    }
    for (const m of content.matchAll(/dispatch\s*\(\s*(\w+Event)\s*[,)]/g)) {
      dispatched.add(m[1]);
    }
  }
  return dispatched;
}

function scanEventListeners(appPath: string): EventListener[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const listeners: EventListener[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const isListener =
      content.includes('EventSubscriberInterface') ||
      content.includes('#[AsEventListener') ||
      content.includes('AsEventListener');

    if (!isListener) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const listensTo: string[] = [];
    let kind: EventListener['kind'] = 'attribute';

    if (content.includes('EventSubscriberInterface')) {
      kind = 'subscriber';
      for (const m of content.matchAll(/['"]([A-Za-z\\]+(?:Event|Created|Updated|Deleted))['"]/g)) {
        const parts = m[1].split('\\');
        const short = parts[parts.length - 1] ?? m[1];
        if (!listensTo.includes(short)) listensTo.push(short);
      }
    } else if (content.includes('#[AsEventListener')) {
      kind = 'attribute';
      for (const m of content.matchAll(/#\[AsEventListener[^)]*event\s*:\s*(\w+)::class/g)) {
        listensTo.push(m[1]);
      }
      for (const m of content.matchAll(/#\[AsEventListener[^)]*event\s*:\s*['"]([^'"]+)['"]/g)) {
        listensTo.push(m[1].split('\\').pop() ?? m[1]);
      }
    }

    listeners.push({ class: classM[1], file: path.basename(file), listensTo, kind });
  }
  return listeners.sort((a, b) => a.class.localeCompare(b.class));
}

export function listCustomEvents(appPath: string): McpToolResult {
  try {
    const events    = scanCustomEventClasses(appPath);
    const dispatched = scanDispatchCallSites(appPath);
    const listeners = scanEventListeners(appPath);

    // Mark dispatched events
    for (const e of events) {
      e.dispatched = dispatched.has(e.class);
    }

    if (events.length === 0 && listeners.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom application events found.\n\nCreate a custom event:\n  class OrderPlacedEvent extends Event\n  {\n    public const NAME = \'order.placed\';\n    public function __construct(public readonly Order $order) {}\n  }\n\nDispatch it:\n  $this->eventDispatcher->dispatch(new OrderPlacedEvent($order));',
        }],
      };
    }

    let text = `Custom Application Events\n${'='.repeat(55)}\n`;

    if (events.length > 0) {
      const withListeners  = events.filter((e) => {
        const eventListeners = listeners.filter((l) => l.listensTo.some((lt) => lt.includes(e.class) || e.class.includes(lt)));
        return eventListeners.length > 0;
      });
      const orphanNotDispatched = events.filter((e) => !e.dispatched);
      const orphanNoListener    = events.filter((e) => {
        return !listeners.some((l) => l.listensTo.some((lt) => lt.includes(e.class) || e.class.includes(lt)));
      });

      text += `\nCustom event classes (${events.length}):\n`;
      for (const e of events) {
        const hasListener = listeners.some((l) => l.listensTo.some((lt) => lt.includes(e.class) || e.class.includes(lt)));
        const dispatchedIcon = e.dispatched ? '✓ dispatched' : '─ not dispatched';
        const listenerIcon   = hasListener ? '✓ has listener' : '⚠ no listener';
        text += `  ${e.class.padEnd(40)} ${dispatchedIcon}  ${listenerIcon}\n`;
        if (e.constants.length > 0) text += `    Constants: ${e.constants.join(', ')}\n`;
      }

      if (orphanNotDispatched.length > 0) {
        text += `\n⚠ Events never dispatched (${orphanNotDispatched.length}): ${orphanNotDispatched.map((e) => e.class).join(', ')}\n`;
      }
      if (orphanNoListener.length > 0) {
        text += `⚠ Events with no listener (${orphanNoListener.length}): ${orphanNoListener.map((e) => e.class).join(', ')}\n`;
      }

      void withListeners;
    }

    if (listeners.length > 0) {
      text += `\nEvent listeners/subscribers (${listeners.length}):\n`;
      for (const l of listeners) {
        const events2 = l.listensTo.length > 0 ? `  listens: ${l.listensTo.slice(0, 3).join(', ')}${l.listensTo.length > 3 ? '...' : ''}` : '';
        text += `  ${l.class.padEnd(40)} [${l.kind}]${events2}\n`;
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

export function getCustomEventStats(appPath: string): McpToolResult {
  try {
    const events    = scanCustomEventClasses(appPath);
    const dispatched = scanDispatchCallSites(appPath);
    const listeners  = scanEventListeners(appPath);

    for (const e of events) e.dispatched = dispatched.has(e.class);

    let text = `Custom Event Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom event classes:  ${events.length}\n`;
    text += `Dispatched events:     ${events.filter((e) => e.dispatched).length}\n`;
    text += `Undispatched events:   ${events.filter((e) => !e.dispatched).length}\n`;
    text += `Listeners/subscribers: ${listeners.length}\n`;
    text += `  Subscribers:         ${listeners.filter((l) => l.kind === 'subscriber').length}\n`;
    text += `  AsEventListener:     ${listeners.filter((l) => l.kind === 'attribute').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomEventsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_custom_events',
      description: 'Show custom application events: event classes extending Event with EVENT_* constants, dispatch call sites, #[AsEventListener] and EventSubscriberInterface listeners, orphan detection (events never dispatched or without listeners)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_custom_event_stats',
      description: 'Show custom event statistics: event class count, dispatched/undispatched counts, listener/subscriber count by type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
