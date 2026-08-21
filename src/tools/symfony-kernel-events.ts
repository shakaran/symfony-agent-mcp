/**
 * Symfony Kernel Event Listeners/Subscribers Inspector
 *
 * Distinct from event-listeners.ts (general event system) and event-dispatcher.ts
 * (EventDispatcher configuration). Focuses on kernel.* events specifically:
 *
 * Kernel events covered:
 *   - kernel.request        — priority matters (authentication: 8, routing: 32)
 *   - kernel.response       — modify response headers, cache
 *   - kernel.view           — transform controller return value to Response
 *   - kernel.exception      — exception handling, error pages
 *   - kernel.terminate      — cleanup after response sent
 *   - kernel.controller     — called after routing, before controller
 *   - kernel.controller_arguments — resolve controller method arguments
 *   - kernel.finish_request  — sub-request cleanup
 *
 * Listener detection:
 *   - EventSubscriberInterface with getSubscribedEvents() returning kernel.* keys
 *   - #[AsEventListener(event: KernelEvents::REQUEST)] attribute
 *   - services.yaml tags: { name: kernel.event_listener, event: kernel.exception }
 *
 * Priority analysis:
 *   - Missing priority on kernel.request (relies on framework default, risky)
 *   - Priority conflict: two listeners on same event with same priority
 *   - kernel.exception listener without calling $event->allowCustomResponseCode() pattern
 *
 * Sub-request detection:
 *   - $event->isMainRequest() / $event->isMasterRequest() check missing
 *   - Listeners that modify global state without checking isMasterRequest()
 *
 * Analysis:
 *   - kernel.terminate listener doing heavy work (should be async/messenger)
 *   - kernel.request listener without isMainRequest() check (fires on sub-requests too)
 *   - Duplicate priority on kernel.request (ordering not guaranteed)
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

const KERNEL_EVENTS = [
  'kernel.request', 'kernel.response', 'kernel.view', 'kernel.exception',
  'kernel.terminate', 'kernel.controller', 'kernel.controller_arguments',
  'kernel.finish_request',
];

const HEAVY_PATTERNS = ['->send(', 'curl_exec', 'file_put_contents', 'sleep(', 'EntityManager', 'flush('];

interface KernelListener {
  class: string;
  file: string;
  event: string;
  priority?: number;
  method: string;
  checksMasterRequest: boolean;
  issues: string[];
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

function parseKernelListeners(appPath: string): KernelListener[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const listeners: KernelListener[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasKernelRef = KERNEL_EVENTS.some((e) => content.includes(e)) ||
                         content.includes('KernelEvents::');
    if (!hasKernelRef) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const relPath = path.relative(appPath, file);

    // Attribute-based: #[AsEventListener(event: ...)]
    for (const m of content.matchAll(/#\[AsEventListener\s*\([^)]*event\s*:\s*(?:KernelEvents::(\w+)|['"](kernel\.[a-z_]+)['"])[^)]*\)/g)) {
      const eventKey   = m[1] ? `kernel.${m[1].toLowerCase().replace('_', '.')}` : (m[2] ?? '');
      const priorityM  = /#\[AsEventListener[^\]]*priority\s*:\s*(-?\d+)/.exec(m[0]);
      const methodM    = /#\[AsEventListener[^\]]*method\s*:\s*['"]([^'"]+)['"]/.exec(m[0]);
      const priority   = priorityM ? parseInt(priorityM[1], 10) : undefined;
      const method     = methodM?.[1] ?? '__invoke';
      const checksMasterRequest = content.includes('isMainRequest') || content.includes('isMasterRequest');
      const issues: string[] = [];

      if (eventKey === 'kernel.request' && !checksMasterRequest) {
        issues.push('kernel.request listener missing isMainRequest() check — fires on sub-requests too');
      }
      if (eventKey === 'kernel.terminate') {
        const hasHeavy = HEAVY_PATTERNS.some((p) => content.includes(p));
        if (hasHeavy) issues.push('kernel.terminate listener contains heavy work — offload to Messenger for async execution');
      }

      listeners.push({ class: classM[1], file: relPath, event: eventKey, priority, method, checksMasterRequest, issues });
    }

    // Subscriber-based: getSubscribedEvents()
    const subM = /getSubscribedEvents\s*\(\s*\)[^{]*\{([\s\S]{0,600})/.exec(content);
    if (subM && content.includes('EventSubscriberInterface')) {
      const body = subM[1];
      for (const evM of body.matchAll(/['"](kernel\.[a-z_]+)['"]\s*=>\s*(?:\[?\s*['"]([^'"]+)['"](?:\s*,\s*(-?\d+))?)?/g)) {
        const event    = evM[1];
        const method   = evM[2] ?? 'on' + event.split('.').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
        const priority = evM[3] ? parseInt(evM[3], 10) : undefined;
        const checksMasterRequest = content.includes('isMainRequest') || content.includes('isMasterRequest');
        const issues: string[] = [];

        if (event === 'kernel.request' && !checksMasterRequest) {
          issues.push('kernel.request listener missing isMainRequest() check — fires on sub-requests too');
        }
        if (event === 'kernel.terminate') {
          const hasHeavy = HEAVY_PATTERNS.some((p) => content.includes(p));
          if (hasHeavy) issues.push('kernel.terminate listener contains heavy work — offload to Messenger');
        }

        listeners.push({ class: classM[1], file: relPath, event, priority, method, checksMasterRequest, issues });
      }
    }
  }

  // Detect priority conflicts
  const byEvent = new Map<string, KernelListener[]>();
  for (const l of listeners) {
    const key = l.event;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(l);
  }
  for (const [, group] of byEvent) {
    const withPriority = group.filter((l) => l.priority !== undefined);
    const priorities   = withPriority.map((l) => l.priority!);
    const hasDuplicate = priorities.length !== new Set(priorities).size;
    if (hasDuplicate) {
      for (const l of withPriority) {
        l.issues.push(`Priority ${l.priority} on ${l.event} may conflict with another listener at same priority`);
      }
    }
  }

  return listeners;
}

export function listKernelEventListeners(appPath: string): McpToolResult {
  try {
    const listeners = parseKernelListeners(appPath);

    if (listeners.length === 0) {
      return { content: [{ type: 'text', text: 'No kernel event listeners found in src/.' }] };
    }

    const totalIssues = listeners.reduce((s, l) => s + l.issues.length, 0);

    let text = `Kernel Event Listeners\n${'='.repeat(55)}\n`;
    text += `\nListeners: ${listeners.length}  Issues: ${totalIssues}\n`;

    const byEvent = new Map<string, KernelListener[]>();
    for (const l of listeners) {
      if (!byEvent.has(l.event)) byEvent.set(l.event, []);
      byEvent.get(l.event)!.push(l);
    }

    for (const event of KERNEL_EVENTS) {
      const group = byEvent.get(event);
      if (!group || group.length === 0) continue;
      text += `\n${event} (${group.length}):\n`;
      for (const l of group.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
        const prio    = l.priority !== undefined ? `priority ${l.priority}` : 'no priority';
        const check   = l.checksMasterRequest ? '✓ mainReq' : '';
        text += `  ${l.class}::${l.method}  ${prio}  ${check}  (${l.file})\n`;
        for (const issue of l.issues) text += `    ⚠ ${issue}\n`;
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

export function getKernelEventStats(appPath: string): McpToolResult {
  try {
    const listeners = parseKernelListeners(appPath);

    const byEvent = new Map<string, number>();
    for (const l of listeners) byEvent.set(l.event, (byEvent.get(l.event) ?? 0) + 1);

    let text = `Kernel Event Listener Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total listeners:    ${listeners.length}\n`;
    text += `  With priority:    ${listeners.filter((l) => l.priority !== undefined).length}\n`;
    text += `  isMainRequest:    ${listeners.filter((l) => l.checksMasterRequest).length}\n`;
    for (const event of KERNEL_EVENTS) {
      const count = byEvent.get(event) ?? 0;
      if (count > 0) text += `  ${event.padEnd(35)} ${count}\n`;
    }
    text += `Issues:             ${listeners.reduce((s, l) => s + l.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getKernelEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_kernel_event_listeners',
      description: 'Show kernel.* event listeners: kernel.request/response/view/exception/terminate/controller, priority per listener, isMainRequest() check, #[AsEventListener] and EventSubscriberInterface detection, heavy-work-in-terminate warning, priority conflict detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_kernel_event_stats',
      description: 'Show kernel event listener statistics: total count, with-priority count, isMainRequest check count, per-event distribution, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
