// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Form Events Inspector
 *
 * Analyzes Symfony Form component internal events (FormEvents) in form type classes.
 *
 * Detects:
 *   - Form type files (AbstractType / FormTypeInterface)
 *   - addEventListener() calls with FormEvents constants
 *   - addEventSubscriber() calls
 *   - Priority values passed to addEventListener
 *   - $event->stopPropagation() calls inside listeners
 *
 * Warnings:
 *   - PRE_SUBMIT listener with heavy logic (flush/send/HTTP calls)
 *   - stopPropagation() in form listener without comment
 *   - Form type that calls addEventSubscriber but subscriber class not found in src/
 *   - addEventListener with no priority when multiple listeners on same event
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface FormEventListener {
  event: string;
  priority: number | null;
  hasHeavyLogic: boolean;
  hasStopPropagation: boolean;
  stopPropagationHasComment: boolean;
}

interface FormTypeInfo {
  class: string;
  file: string;
  listeners: FormEventListener[];
  subscribers: string[];
  issues: string[];
}

const FORM_EVENTS = [
  'FormEvents::PRE_SUBMIT',
  'FormEvents::POST_SUBMIT',
  'FormEvents::PRE_SET_DATA',
  'FormEvents::POST_SET_DATA',
  'FormEvents::SUBMIT',
];

const HEAVY_LOGIC_PATTERNS = [
  '->flush(',
  '->send(',
  'curl_exec(',
  'file_get_contents(',
  'GuzzleHttp',
  'HttpClient',
  '->request(',
];

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

function isFormTypeFile(content: string): boolean {
  return (
    content.includes('extends AbstractType') ||
    content.includes('implements FormTypeInterface') ||
    content.includes('FormTypeInterface')
  );
}

function extractListeners(content: string): FormEventListener[] {
  const listeners: FormEventListener[] = [];
  // Match addEventListener calls: ->addEventListener(FormEvents::XXX, ..., priority)
  // Pattern is bounded — no nested unbounded quantifiers
  const addListenerRe = /->addEventListener\(\s*(FormEvents::[A-Z_]+)[^)]{0,300}\)/g;
  let m: RegExpExecArray | null;
  while ((m = addListenerRe.exec(content)) !== null) {
    const eventName = m[1];
    if (!eventName) continue;

    const callStr = m[0];
    // Extract priority: third argument (integer, possibly negative)
    const priorityM = /,\s*(-?\d+)\s*\)/.exec(callStr);
    const priority = priorityM ? parseInt(priorityM[1], 10) : null;

    // Detect heavy logic patterns in surrounding 500-char window
    const start = Math.max(0, m.index);
    const end = Math.min(content.length, m.index + 600);
    const window = content.slice(start, end);
    const hasHeavyLogic = HEAVY_LOGIC_PATTERNS.some((p) => window.includes(p));

    // Detect stopPropagation nearby (look ahead 300 chars after match)
    const ahead = content.slice(m.index, Math.min(content.length, m.index + 400));
    const hasStopPropagation = ahead.includes('->stopPropagation(');
    // Check if there is a comment (// or /* or *) near stopPropagation
    const stopPropIdx = ahead.indexOf('->stopPropagation(');
    let stopPropagationHasComment = false;
    if (hasStopPropagation && stopPropIdx >= 0) {
      const preStop = ahead.slice(Math.max(0, stopPropIdx - 100), stopPropIdx);
      stopPropagationHasComment = preStop.includes('//') || preStop.includes('/*') || preStop.includes('*');
    }

    listeners.push({ event: eventName, priority, hasHeavyLogic, hasStopPropagation, stopPropagationHasComment });
  }
  return listeners;
}

function extractSubscriberNames(content: string): string[] {
  const names: string[] = [];
  // Match ->addEventSubscriber(new ClassName(...)) or ->addEventSubscriber($this->xxx)
  const re = /->addEventSubscriber\(\s*new\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  // Also match variable-based: ->addEventSubscriber($varName) — extract variable name
  const reVar = /->addEventSubscriber\(\s*(\$\w+)\s*\)/g;
  while ((m = reVar.exec(content)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function parseFormType(filePath: string, appPath: string, allClasses: Set<string>): FormTypeInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!isFormTypeFile(content)) return null;
  // Skip Symfony core files
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const listeners = extractListeners(content);
  const subscribers = extractSubscriberNames(content);

  if (listeners.length === 0 && subscribers.length === 0) return null;

  const issues: string[] = [];

  // PRE_SUBMIT with heavy logic
  for (const l of listeners) {
    if (l.event === 'FormEvents::PRE_SUBMIT' && l.hasHeavyLogic) {
      issues.push('PRE_SUBMIT listener contains heavy logic (flush/send/HTTP call) — runs synchronously on form submit');
    }
    if (l.hasStopPropagation && !l.stopPropagationHasComment) {
      issues.push(`stopPropagation() in ${l.event} listener without comment — unexpected behavior may go unnoticed`);
    }
  }

  // Multiple listeners on same event without priority
  const eventCounts: Record<string, number> = {};
  for (const l of listeners) {
    eventCounts[l.event] = (eventCounts[l.event] ?? 0) + 1;
  }
  for (const [evt, count] of Object.entries(eventCounts)) {
    if (count > 1) {
      const withoutPriority = listeners.filter((l) => l.event === evt && l.priority === null);
      if (withoutPriority.length > 0) {
        issues.push(`Multiple listeners on ${evt} but some have no priority — execution order is undefined`);
      }
    }
  }

  // Subscriber class not found
  for (const sub of subscribers) {
    if (!sub.startsWith('$') && !allClasses.has(sub)) {
      issues.push(`addEventSubscriber(new ${sub}) — class ${sub} not found in src/`);
    }
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    listeners,
    subscribers,
    issues,
  };
}

function collectAllClassNames(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    let c = '';
    try { c = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    const m = /class\s+(\w+)/.exec(c);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listFormEvents(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const files = getAllPhpFiles(srcDir);
    const allClasses = collectAllClassNames(files);
    const formTypes: FormTypeInfo[] = [];

    for (const file of files) {
      const ft = parseFormType(file, appPath, allClasses);
      if (ft) formTypes.push(ft);
    }

    if (formTypes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No form types with event listeners found in src/.\n\nExample:\n  $builder->addEventListener(FormEvents::PRE_SUBMIT, function (PreSubmitEvent $event) {\n    // modify submitted data before validation\n  });',
        }],
      };
    }

    const totalIssues = formTypes.reduce((s, ft) => s + ft.issues.length, 0);
    let text = `Symfony Form Events\n${'='.repeat(55)}\n`;
    text += `\nForm types with listeners: ${formTypes.length}  Issues: ${totalIssues}\n`;

    for (const ft of formTypes.sort((a, b) => a.class.localeCompare(b.class))) {
      text += `\n  ${ft.class}  (${ft.file})\n`;

      if (ft.listeners.length > 0) {
        text += `    Listeners (${ft.listeners.length}):\n`;
        for (const l of ft.listeners) {
          const prio = l.priority !== null ? `  priority=${l.priority}` : '';
          const flags: string[] = [];
          if (l.hasHeavyLogic) flags.push('[heavy-logic]');
          if (l.hasStopPropagation) flags.push('[stopPropagation]');
          text += `      ${l.event}${prio}  ${flags.join(' ')}\n`;
        }
      }

      if (ft.subscribers.length > 0) {
        text += `    Subscribers: ${ft.subscribers.join(', ')}\n`;
      }

      for (const issue of ft.issues) {
        text += `    WARNING: ${issue}\n`;
      }
    }

    // Summary of supported events seen
    const eventsSeen = new Set<string>();
    for (const ft of formTypes) {
      for (const l of ft.listeners) eventsSeen.add(l.event);
    }
    if (eventsSeen.size > 0) {
      text += `\nEvents used: ${[...eventsSeen].sort().join(', ')}\n`;
      const unused = FORM_EVENTS.filter((e) => !eventsSeen.has(e));
      if (unused.length > 0) {
        text += `Events not used: ${unused.join(', ')}\n`;
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

export function getFormEventStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files = fs.existsSync(srcDir) ? getAllPhpFiles(srcDir) : [];
    const allClasses = collectAllClassNames(files);
    const formTypes: FormTypeInfo[] = [];

    for (const file of files) {
      const ft = parseFormType(file, appPath, allClasses);
      if (ft) formTypes.push(ft);
    }

    const eventCounts: Record<string, number> = {};
    let totalListeners = 0;
    let totalSubscribers = 0;
    let totalIssues = 0;

    for (const ft of formTypes) {
      totalSubscribers += ft.subscribers.length;
      totalIssues += ft.issues.length;
      for (const l of ft.listeners) {
        totalListeners++;
        eventCounts[l.event] = (eventCounts[l.event] ?? 0) + 1;
      }
    }

    let text = `Form Event Statistics\n${'='.repeat(40)}\n\n`;
    text += `Form types with events:  ${formTypes.length}\n`;
    text += `Total event listeners:   ${totalListeners}\n`;
    text += `Total event subscribers: ${totalSubscribers}\n`;
    text += `Issues detected:         ${totalIssues}\n`;

    if (Object.keys(eventCounts).length > 0) {
      text += `\nListeners per event:\n`;
      for (const [evt, cnt] of Object.entries(eventCounts).sort()) {
        text += `  ${evt.padEnd(30)} ${cnt}\n`;
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

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getFormEventTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_form_events',
      description: 'Show Symfony Form event listeners: FormEvents::PRE_SUBMIT/POST_SUBMIT/PRE_SET_DATA/POST_SET_DATA/SUBMIT, addEventSubscriber calls, priority values, stopPropagation usage, heavy-logic in PRE_SUBMIT warning, missing subscriber class warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_form_event_stats',
      description: 'Show form event statistics: count of form types with listeners, total listeners per event type, subscriber count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
