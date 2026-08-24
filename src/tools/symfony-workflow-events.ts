// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Workflow Event Subscriptions Inspector
 *
 * Distinct from symfony-workflow-guards.ts (guard-only) and workflow.ts (config listing).
 * Focuses on all workflow event subscriptions:
 *
 * Scans src/ PHP for:
 *   - getSubscribedEvents() returning workflow.* events
 *   - #[AsEventListener] targeting workflow events
 *   - Workflow event types: guard, transition, entered, completed, leave, announce
 *   - Workflow-specific variants: 'workflow.[name].guard', 'workflow.[name].entered.[place]', etc.
 *
 * Warns about:
 *   - workflow.guard without addTransitionBlocker or setBlocked (no-op guard)
 *   - workflow.entered listener modifying marking directly (bypass workflow)
 *   - Same workflow event subscribed multiple times without priority (non-deterministic)
 *   - Guard handler without checking $event->getSubject() type
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

type WorkflowEventType = 'guard' | 'transition' | 'entered' | 'completed' | 'leave' | 'announce' | 'other';

interface WorkflowEventEntry {
  eventName: string;
  workflowName?: string;
  transitionName?: string;
  type: WorkflowEventType;
  hasBlocker: boolean;
  issues: string[];
}

interface WorkflowEventInfo {
  file: string;
  class: string;
  events: WorkflowEventEntry[];
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const WORKFLOW_EVENT_TYPES: ReadonlyArray<[string, WorkflowEventType]> = [
  ['guard', 'guard'],
  ['transition', 'transition'],
  ['entered', 'entered'],
  ['completed', 'completed'],
  ['leave', 'leave'],
  ['announce', 'announce'],
];

function classifyEvent(eventName: string): WorkflowEventType {
  for (const [keyword, type] of WORKFLOW_EVENT_TYPES) {
    if (eventName.includes(keyword)) return type;
  }
  return 'other';
}

function extractWorkflowName(eventName: string): string | undefined {
  // workflow.[name].guard or workflow.[name].entered etc.
  const parts = eventName.split('.');
  if (parts.length >= 3 && parts[0] === 'workflow') return parts[1];
  return undefined;
}

function extractTransitionName(eventName: string): string | undefined {
  // workflow.[name].guard.[transition] or workflow.[name].transition.[transition]
  const parts = eventName.split('.');
  if (parts.length >= 4) return parts[3];
  return undefined;
}

function extractEventNames(content: string): string[] {
  const events: string[] = [];

  // From getSubscribedEvents() — collect all string values that look like workflow events
  const subscribedBlock = /getSubscribedEvents\s*\([^)]{0,50}\)\s*(?::\s*array\s*)?\{([^}]{0,2000})\}/s.exec(content);
  if (subscribedBlock) {
    const block = subscribedBlock[1];
    const re = /['"]workflow[^'"]{0,200}['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const ev = m[0].replace(/['"]/g, '');
      if (!events.includes(ev)) events.push(ev);
    }
  }

  // From #[AsEventListener] attributes
  const attrRe = /#\[AsEventListener[^\]]{0,300}\]/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(content)) !== null) {
    const attr = am[0];
    const evM = /event\s*:\s*['"]([^'"]{1,200})['"]/i.exec(attr);
    if (evM && evM[1].startsWith('workflow') && !events.includes(evM[1])) {
      events.push(evM[1]);
    }
  }

  return events;
}

function parseWorkflowEventFile(filePath: string, appPath: string): WorkflowEventInfo | null {
  const srcDir = path.join(appPath, 'src');
  const content = safeRead(filePath, srcDir);
  if (content === null) return null;

  const hasWorkflowRef = content.includes('workflow') &&
    (content.includes('getSubscribedEvents') || content.includes('AsEventListener') || content.includes('EventSubscriberInterface'));
  if (!hasWorkflowRef) return null;
  if (content.includes('namespace Symfony\\Component\\Workflow')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const eventNames = extractEventNames(content);
  const workflowEvents = eventNames.filter((e) => e.startsWith('workflow'));
  if (workflowEvents.length === 0) return null;

  const hasBlocker = content.includes('addTransitionBlocker(') || content.includes('setBlocked(');
  const hasSubjectTypeCheck = content.includes('getSubject()') &&
    (content.includes('instanceof') || content.includes('getSubject()) instanceof'));
  const hasMarkingDirectModification = content.includes('getMarking()') &&
    (content.includes('mark(') || content.includes('unmark('));

  const fileIssues: string[] = [];
  const events: WorkflowEventEntry[] = [];

  // Check duplicate events without priority
  const eventCounts = new Map<string, number>();
  for (const ev of workflowEvents) {
    eventCounts.set(ev, (eventCounts.get(ev) ?? 0) + 1);
  }
  for (const [ev, count] of eventCounts.entries()) {
    if (count > 1) {
      fileIssues.push(`Event "${ev}" subscribed ${count} times without priority — execution order is non-deterministic`);
    }
  }

  const seenEvents = new Set<string>();
  for (const eventName of workflowEvents) {
    if (seenEvents.has(eventName)) continue;
    seenEvents.add(eventName);

    const type = classifyEvent(eventName);
    const workflowName = extractWorkflowName(eventName);
    const transitionName = extractTransitionName(eventName);
    const entryIssues: string[] = [];

    if (type === 'guard' && !hasBlocker) {
      entryIssues.push('workflow.guard listener without addTransitionBlocker() or setBlocked() — guard is a no-op');
    }
    if (type === 'guard' && !hasSubjectTypeCheck) {
      entryIssues.push('Guard handler does not check $event->getSubject() type — may throw on unexpected subject types');
    }
    if (type === 'entered' && hasMarkingDirectModification) {
      entryIssues.push('workflow.entered listener modifies marking directly — bypasses workflow logic and audit trail');
    }

    events.push({
      eventName,
      workflowName,
      transitionName,
      type,
      hasBlocker: type === 'guard' ? hasBlocker : false,
      issues: entryIssues,
    });
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    events,
    issues: fileIssues,
  };
}

function loadWorkflowEventInfos(appPath: string): WorkflowEventInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: WorkflowEventInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseWorkflowEventFile(f, appPath);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listWorkflowEventSubscriptions(appPath: string): McpToolResult {
  try {
    const infos = loadWorkflowEventInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No workflow event subscriptions found in src/.\n\nSubscribe to workflow events:\n  use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;\n  use Symfony\\Component\\Workflow\\Event\\GuardEvent;\n\n  class OrderWorkflowSubscriber implements EventSubscriberInterface {\n    public static function getSubscribedEvents(): array {\n      return [\n        \'workflow.order.guard.ship\' => \'onGuard\',\n        \'workflow.order.entered.shipped\' => \'onEntered\',\n      ];\n    }\n    public function onGuard(GuardEvent $event): void {\n      if (!$event->getSubject() instanceof Order) return;\n      if (!$this->canShip($event->getSubject())) {\n        $event->addTransitionBlocker(new TransitionBlocker(\'Cannot ship\', \'0\'));\n      }\n    }\n  }',
        }],
      };
    }

    const withIssues = infos.filter(
      (i) => i.issues.length > 0 || i.events.some((e) => e.issues.length > 0)
    );

    let text = `Workflow Event Subscriptions (${infos.length} classes)\n${'='.repeat(60)}\n`;

    for (const info of infos) {
      text += `\n  ${info.class}  (${info.file})\n`;
      for (const ev of info.events) {
        const blocker = ev.type === 'guard' ? (ev.hasBlocker ? '  [blocks]' : '  [NO blocker]') : '';
        text += `    ${ev.type.padEnd(12)}  ${ev.eventName}${blocker}\n`;
        for (const issue of ev.issues) {
          text += `      WARN: ${issue}\n`;
        }
      }
      for (const issue of info.issues) {
        text += `    WARN: ${issue}\n`;
      }
    }

    if (withIssues.length > 0) {
      text += `\nClasses with issues: ${withIssues.length}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWorkflowEventStats(appPath: string): McpToolResult {
  try {
    const infos = loadWorkflowEventInfos(appPath);
    const allEvents = infos.flatMap((i) => i.events);

    let text = `Workflow Event Statistics\n${'='.repeat(40)}\n\n`;
    text += `Subscriber/listener classes: ${infos.length}\n`;
    text += `Total event subscriptions:   ${allEvents.length}\n`;
    text += `  guard events:              ${allEvents.filter((e) => e.type === 'guard').length}\n`;
    text += `  entered events:            ${allEvents.filter((e) => e.type === 'entered').length}\n`;
    text += `  completed events:          ${allEvents.filter((e) => e.type === 'completed').length}\n`;
    text += `  leave events:              ${allEvents.filter((e) => e.type === 'leave').length}\n`;
    text += `  transition events:         ${allEvents.filter((e) => e.type === 'transition').length}\n`;
    text += `  announce events:           ${allEvents.filter((e) => e.type === 'announce').length}\n`;
    text += `No-op guards:                ${allEvents.filter((e) => e.type === 'guard' && !e.hasBlocker).length}\n`;
    text += `Classes with issues:         ${infos.filter((i) => i.issues.length > 0 || i.events.some((e) => e.issues.length > 0)).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getWorkflowEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_workflow_event_subscriptions',
      description: 'List Symfony workflow event subscriptions: guard/transition/entered/completed/leave/announce events, workflow and transition name extraction, no-op guard detection, direct marking modification warnings, duplicate subscription detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_workflow_event_stats',
      description: 'Show workflow event statistics: subscriber class count, total subscriptions, breakdown by event type, no-op guard count, classes with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
