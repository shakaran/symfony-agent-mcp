/**
 * Doctrine Event Subscribers Inspector
 *
 * Analyzes Doctrine-native event subscribers (doctrine/event-manager),
 * NOT Symfony's EventSubscriberInterface.
 *
 * Detects:
 *   - Classes implementing Doctrine\Common\EventSubscriber
 *   - getSubscribedEvents() returning doctrine event names
 *   - flush() calls inside onFlush/preFlush handlers (infinite loop risk)
 *   - UnitOfWork access ($args->getEntityManager()->getUnitOfWork())
 *   - #[AsDoctrineListener] attribute (Symfony 6.3+)
 *
 * Warnings:
 *   - flush() inside onFlush handler (infinite flush loop)
 *   - flush() inside preFlush handler (same risk)
 *   - getSubscribedEvents() returning empty array (never fires)
 *   - loadClassMetadata handler without platform check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DoctrineSubscriber {
  class: string;
  file: string;
  events: string[];
  hasFlushInOnFlush: boolean;
  hasFlushInPreFlush: boolean;
  usesUnitOfWork: boolean;
  hasAsDoctrineListener: boolean;
  emptyEvents: boolean;
  issues: string[];
}

const DOCTRINE_EVENTS = [
  'onFlush',
  'postFlush',
  'preFlush',
  'postPersist',
  'prePersist',
  'postUpdate',
  'preUpdate',
  'postRemove',
  'preRemove',
  'postLoad',
  'loadClassMetadata',
  'onClassMetadata',
  'onClear',
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

function isDoctrineSubscriber(content: string): boolean {
  return (
    content.includes('EventSubscriber') ||
    content.includes('getSubscribedEvents') ||
    content.includes('#[AsDoctrineListener')
  );
}

function extractSubscribedEvents(content: string): string[] {
  // Find getSubscribedEvents method body — bounded extraction
  const methodRe = /function\s+getSubscribedEvents\s*\(\s*\)[^{]{0,40}\{([^}]{0,800})\}/;
  const m = methodRe.exec(content);
  if (!m?.[1]) return [];
  const body = m[1];
  const events: string[] = [];
  for (const evt of DOCTRINE_EVENTS) {
    if (body.includes(`'${evt}'`) || body.includes(`"${evt}"`)) {
      events.push(evt);
    }
  }
  return events;
}

function hasFlushInMethod(content: string, methodName: string): boolean {
  // Extract method body (bounded, up to 1500 chars)
  const re = new RegExp(`function\\s+${methodName}\\s*\\([^)]{0,200}\\)[^{]{0,40}\\{([^}]{0,1500})\\}`);
  const m = re.exec(content);
  if (!m?.[1]) return false;
  const body = m[1];
  return body.includes('->flush(') || body.includes('->flush()');
}

function hasLoadMetadataWithoutPlatformCheck(content: string): boolean {
  const re = /function\s+loadClassMetadata\s*\([^)]{0,200}\)[^{]{0,40}\{([^}]{0,1500})\}/;
  const m = re.exec(content);
  if (!m?.[1]) return false;
  const body = m[1];
  return !body.includes('getPlatform(') && !body.includes('getDatabasePlatform(');
}

function parseDoctrineSubscriber(filePath: string, appPath: string): DoctrineSubscriber | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!isDoctrineSubscriber(content)) return null;
  // Skip Symfony/Doctrine core namespaces
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\Common\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const hasAsDoctrineListener = content.includes('#[AsDoctrineListener');
  const events = extractSubscribedEvents(content);
  const emptyEvents = events.length === 0 && content.includes('getSubscribedEvents') && !hasAsDoctrineListener;

  const hasFlushInOnFlush = events.includes('onFlush') && hasFlushInMethod(content, 'onFlush');
  const hasFlushInPreFlush = events.includes('preFlush') && hasFlushInMethod(content, 'preFlush');
  const usesUnitOfWork = content.includes('->getUnitOfWork(');

  const issues: string[] = [];

  if (hasFlushInOnFlush) {
    issues.push('flush() called inside onFlush handler — causes infinite flush loop');
  }
  if (hasFlushInPreFlush) {
    issues.push('flush() called inside preFlush handler — causes infinite flush loop');
  }
  if (emptyEvents) {
    issues.push('getSubscribedEvents() returns empty array — subscriber never fires');
  }
  if (events.includes('loadClassMetadata') && hasLoadMetadataWithoutPlatformCheck(content)) {
    issues.push('loadClassMetadata handler modifies metadata without checking platform — may break non-default databases');
  }

  // Only include if it looks like a Doctrine subscriber (has events or attribute)
  if (events.length === 0 && !hasAsDoctrineListener && !emptyEvents) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    events,
    hasFlushInOnFlush,
    hasFlushInPreFlush,
    usesUnitOfWork,
    hasAsDoctrineListener,
    emptyEvents,
    issues,
  };
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listDoctrineEventSubscribers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const subscribers: DoctrineSubscriber[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const s = parseDoctrineSubscriber(file, appPath);
      if (s) subscribers.push(s);
    }

    if (subscribers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine event subscribers found in src/.\n\nExample:\n  class MyDoctrineSubscriber implements EventSubscriber\n  {\n    public function getSubscribedEvents(): array\n    {\n      return [Events::postPersist, Events::postUpdate];\n    }\n    public function postPersist(PostPersistEventArgs $args): void { ... }\n  }',
        }],
      };
    }

    const totalIssues = subscribers.reduce((s, sub) => s + sub.issues.length, 0);
    let text = `Doctrine Event Subscribers\n${'='.repeat(55)}\n`;
    text += `\nSubscribers found: ${subscribers.length}  Issues: ${totalIssues}\n`;

    for (const sub of subscribers.sort((a, b) => a.class.localeCompare(b.class))) {
      text += `\n  ${sub.class}  (${sub.file})\n`;

      if (sub.hasAsDoctrineListener) {
        text += `    Style: #[AsDoctrineListener] attribute\n`;
      } else {
        text += `    Style: implements EventSubscriber\n`;
      }

      if (sub.events.length > 0) {
        text += `    Events: ${sub.events.join(', ')}\n`;
      } else if (sub.emptyEvents) {
        text += `    Events: (empty — never fires)\n`;
      }

      const flags: string[] = [];
      if (sub.usesUnitOfWork) flags.push('uses-UnitOfWork');
      if (sub.hasFlushInOnFlush || sub.hasFlushInPreFlush) flags.push('calls-flush');
      if (flags.length > 0) text += `    Flags: ${flags.join(', ')}\n`;

      for (const issue of sub.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getDoctrineSubscriberStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files = fs.existsSync(srcDir) ? getAllPhpFiles(srcDir) : [];
    const subscribers: DoctrineSubscriber[] = [];

    for (const file of files) {
      const s = parseDoctrineSubscriber(file, appPath);
      if (s) subscribers.push(s);
    }

    const eventCounts: Record<string, number> = {};
    for (const sub of subscribers) {
      for (const evt of sub.events) {
        eventCounts[evt] = (eventCounts[evt] ?? 0) + 1;
      }
    }

    let text = `Doctrine Event Subscriber Statistics\n${'='.repeat(40)}\n\n`;
    text += `Subscribers:          ${subscribers.length}\n`;
    text += `  With attribute:     ${subscribers.filter((s) => s.hasAsDoctrineListener).length}\n`;
    text += `  With interface:     ${subscribers.filter((s) => !s.hasAsDoctrineListener).length}\n`;
    text += `  Empty events:       ${subscribers.filter((s) => s.emptyEvents).length}\n`;
    text += `  Uses UnitOfWork:    ${subscribers.filter((s) => s.usesUnitOfWork).length}\n`;
    text += `Issues detected:      ${subscribers.reduce((s, sub) => s + sub.issues.length, 0)}\n`;

    if (Object.keys(eventCounts).length > 0) {
      text += `\nListeners per event:\n`;
      for (const [evt, cnt] of Object.entries(eventCounts).sort()) {
        text += `  ${evt.padEnd(25)} ${cnt}\n`;
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

export function getDoctrineEventSubscriberTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_event_subscribers',
      description: 'Show Doctrine-native event subscribers (EventSubscriber interface and #[AsDoctrineListener]): subscribed events, flush-in-onFlush infinite loop warning, empty getSubscribedEvents() warning, UnitOfWork access, loadClassMetadata platform check',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_subscriber_stats',
      description: 'Show Doctrine event subscriber statistics: total count, attribute vs interface style, events per subscriber, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
