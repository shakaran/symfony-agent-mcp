/**
 * Symfony HttpKernel Event Subscriber Middleware Inspector
 *
 * Scans src/**\/*.php for EventSubscriberInterface implementations that subscribe
 * to KernelEvents: REQUEST, RESPONSE, EXCEPTION, TERMINATE, FINISH_REQUEST, VIEW.
 * Extracts event-to-method mapping, priority, and flags common issues.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HttpMiddlewareFinding {
  file: string;
  class: string;
  event: string;
  priority: number | null;
  method: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

// Maps KernelEvents constant name to string event name
const KERNEL_EVENTS: Record<string, string> = {
  REQUEST:        'kernel.request',
  RESPONSE:       'kernel.response',
  EXCEPTION:      'kernel.exception',
  TERMINATE:      'kernel.terminate',
  FINISH_REQUEST: 'kernel.finish_request',
  VIEW:           'kernel.view',
};

// Extract getSubscribedEvents static method body (up to 3000 chars)
function extractSubscribedEventsBody(content: string): string | null {
  const match = /function\s+getSubscribedEvents\s*\([^)]{0,100}\)\s*(?::\s*array\s*)?\{([^}]{0,3000})\}/s.exec(content);
  return match ? match[1] : null;
}

interface SubscriptionEntry {
  event: string;
  method: string;
  priority: number | null;
}

function parseSubscribedEvents(body: string): SubscriptionEntry[] {
  const entries: SubscriptionEntry[] = [];
  const lines = body.split('\n');

  for (const line of lines) {
    // Match patterns like:
    //   KernelEvents::REQUEST => 'onKernelRequest'
    //   KernelEvents::REQUEST => ['onKernelRequest', 10]
    //   'kernel.request' => 'onKernelRequest'
    //   'kernel.request' => ['onKernelRequest', 10]
    const kernelConstMatch = /KernelEvents\s*::\s*([A-Z_]{1,40})\s*=>\s*(.{0,200})/.exec(line);
    const stringEventMatch = /['"]kernel\.([a-z_]{1,40})['"]\s*=>\s*(.{0,200})/.exec(line);

    let eventName: string | null = null;
    let rhs = '';

    if (kernelConstMatch) {
      const constName = kernelConstMatch[1];
      eventName = KERNEL_EVENTS[constName] ?? null;
      rhs = kernelConstMatch[2];
    } else if (stringEventMatch) {
      eventName = `kernel.${stringEventMatch[1]}`;
      rhs = stringEventMatch[2];
    }

    if (!eventName) continue;

    // Parse RHS: could be 'method' or ['method', priority] or [['method', priority], ...]
    const singleMethodMatch = /^['"]([a-zA-Z_][a-zA-Z0-9_]{0,80})['"]/.exec(rhs.trim());
    if (singleMethodMatch) {
      entries.push({ event: eventName, method: singleMethodMatch[1], priority: null });
      continue;
    }

    // Array form: ['method', priority]
    const arrayMethodMatch = /\[\s*['"]([a-zA-Z_][a-zA-Z0-9_]{0,80})['"]\s*,\s*(-?\d+)/.exec(rhs);
    if (arrayMethodMatch) {
      entries.push({ event: eventName, method: arrayMethodMatch[1], priority: parseInt(arrayMethodMatch[2], 10) });
      continue;
    }

    // Array form without priority: ['method']
    const arrayNoPrioMatch = /\[\s*['"]([a-zA-Z_][a-zA-Z0-9_]{0,80})['"]\s*\]/.exec(rhs);
    if (arrayNoPrioMatch) {
      entries.push({ event: eventName, method: arrayNoPrioMatch[1], priority: null });
    }
  }

  return entries;
}

function analyseFile(filePath: string, base: string): HttpMiddlewareFinding[] {
  const content = safeRead(filePath, base);
  if (!content) return [];
  if (!content.includes('EventSubscriberInterface')) return [];

  const findings: HttpMiddlewareFinding[] = [];

  const classMatch = /class\s+([A-Za-z_][A-Za-z0-9_]{0,80})/.exec(content);
  const className = classMatch ? classMatch[1] : path.basename(filePath, '.php');

  const body = extractSubscribedEventsBody(content);
  if (!body) return [];

  const subscriptions = parseSubscribedEvents(body);

  // Filter only kernel.* events
  const kernelSubs = subscriptions.filter(s => s.event.startsWith('kernel.'));
  if (kernelSubs.length === 0) return [];

  // Track all subscriptions to detect same-priority conflicts per event
  const priorityMap: Record<string, number[]> = {};
  for (const s of kernelSubs) {
    if (!priorityMap[s.event]) priorityMap[s.event] = [];
    priorityMap[s.event].push(s.priority ?? 0);
  }

  for (const sub of kernelSubs) {
    const issues: string[] = [];
    const prio = sub.priority ?? 0;

    if (sub.event === 'kernel.request') {
      if (prio > 200) {
        issues.push(`Priority ${prio} > 200 on kernel.request — runs before most Symfony internals (router at 32, firewall at 8); ensure this is intentional`);
      }
      // Check if method calls setResponse without stopPropagation
      const methodBodyMatch = new RegExp(`function\\s+${sub.method}\\s*\\([^)]{0,200}\\)\\s*\\{([^}]{0,1500})\\}`, 's').exec(content);
      if (methodBodyMatch) {
        const mb = methodBodyMatch[1];
        if (/->setResponse\s*\(/.test(mb) && !/->stopPropagation\s*\(/.test(mb)) {
          issues.push(`${sub.method}() calls setResponse() but not stopPropagation() — subsequent REQUEST listeners still run after response is set`);
        }
      }
    }

    if (sub.event === 'kernel.response' && prio < 0) {
      issues.push(`Negative priority ${prio} on kernel.response — runs after response is sent in terminate context; modifications may be ignored`);
    }

    // Detect same priority for same event across this subscriber's own subscriptions
    const samePrioCount = kernelSubs.filter(s2 => s2.event === sub.event && (s2.priority ?? 0) === prio && s2 !== sub).length;
    if (samePrioCount > 0) {
      issues.push(`Multiple listeners for ${sub.event} at same priority ${prio} within this subscriber — execution order is undefined`);
    }

    findings.push({
      file: filePath,
      class: className,
      event: sub.event,
      priority: sub.priority,
      method: sub.method,
      issue: issues.length > 0 ? issues.join(' | ') : null,
    });
  }

  return findings;
}

function loadFindings(appPath: string): HttpMiddlewareFinding[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir, srcDir);
  const findings: HttpMiddlewareFinding[] = [];
  for (const f of files) findings.push(...analyseFile(f, srcDir));
  return findings;
}

export function listSymfonyHttpMiddleware(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No HttpKernel event subscriber middleware found in src/.\n\nExample:\n  class MyMiddleware implements EventSubscriberInterface {\n    public static function getSubscribedEvents(): array {\n      return [KernelEvents::REQUEST => [\'onKernelRequest\', 10]];\n    }\n  }' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony HttpKernel Event Middleware\n${'='.repeat(55)}\n\nSubscriptions: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      const rel = path.relative(appPath, f.file);
      const prioStr = f.priority !== null ? ` priority: ${f.priority}` : '';
      text += `\n  ${f.class}::${f.method}  event: ${f.event}${prioStr}\n    file: ${rel}\n`;
      if (f.issue) {
        for (const part of f.issue.split(' | ')) text += `    ⚠ ${part}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpMiddlewareStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byEvent: Record<string, number> = {};
    for (const f of findings) byEvent[f.event] = (byEvent[f.event] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    const highPriority = findings.filter(f => f.event === 'kernel.request' && (f.priority ?? 0) > 200);
    let text = `Symfony HttpKernel Middleware Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total subscriptions: ${findings.length}\nWith issues: ${issues.length}\nHigh-priority REQUEST subscribers (> 200): ${highPriority.length}\n\nBy event:\n`;
    for (const [evt, count] of Object.entries(byEvent)) text += `  ${evt}: ${count}\n`;
    const files = new Set(findings.map(f => f.file));
    text += `\nSubscriber files: ${files.size}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpMiddlewareTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_http_middleware', description: 'Scan src/**/*.php for EventSubscriberInterface classes subscribing to KernelEvents (REQUEST/RESPONSE/EXCEPTION/TERMINATE/FINISH_REQUEST/VIEW) — flags high priority REQUEST handlers, negative priority RESPONSE, missing stopPropagation with setResponse, same-priority collisions', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_http_middleware_stats', description: 'Statistics for HttpKernel event middleware: total subscriptions, issues, high-priority REQUEST subscribers, breakdown by event type, subscriber files', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
