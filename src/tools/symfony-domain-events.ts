// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DomainEventInfo {
  file: string;
  class: string;
  isDomainEvent: boolean;
  isAggregate: boolean;
  eventTypes: string[];
  hasRelease: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseDomainEventFile(filePath: string, appPath: string): DomainEventInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Detect if this is a domain event class
  const isDomainEvent = (
    content.includes('DomainEventInterface') ||
    content.includes('DomainEvent') ||
    (className.endsWith('Event') && !content.includes('EventSubscriberInterface') && !content.includes('EventListenerInterface')) ||
    content.includes('implements DomainEvent')
  ) && !content.includes('EventDispatcherInterface');

  // Detect if this is an aggregate root (collects events)
  const isAggregate = (
    content.includes('releaseEvents') ||
    content.includes('getRecordedEvents') ||
    content.includes('recordEvent') ||
    content.includes('raiseDomainEvent') ||
    content.includes('pullDomainEvents') ||
    (content.includes('private array $') && (content.includes('Events') || content.includes('events')) &&
     (content.includes('recordEvent') || content.includes('raiseDomainEvent')))
  );

  if (!isDomainEvent && !isAggregate) return null;

  // Extract event types collected/dispatched
  const eventTypes: string[] = [];
  for (const m of content.matchAll(/new\s+(\w{1,100}Event)\s*\(/g)) {
    if (!eventTypes.includes(m[1])) eventTypes.push(m[1]);
  }
  for (const m of content.matchAll(/recordEvent\s*\(\s*new\s+(\w{1,100})\s*\(/g)) {
    if (!eventTypes.includes(m[1])) eventTypes.push(m[1]);
  }

  // Check if there's a release method
  const hasRelease = content.includes('releaseEvents') || content.includes('getRecordedEvents') ||
    content.includes('pullDomainEvents');

  const issues: string[] = [];

  if (isAggregate && !hasRelease) {
    issues.push('Aggregate records events but has no releaseEvents()/getRecordedEvents() method — events may never be dispatched');
  }

  if (isDomainEvent && !className.endsWith('final') && !/^\s*final\s+class/.test(content)) {
    // Check if class is not final
    if (!/\bfinal\b/.test(content.split('class ')[0] ?? '')) {
      issues.push(`Domain event class "${className}" is not final — subclassing events changes semantics`);
    }
  }

  // Detect if events are recorded in constructor (before entity persisted)
  if (isAggregate) {
    const constructorM = /function\s+__construct\s*\([^)]{0,300}\)\s*\{([\s\S]{0,500})\}/s.exec(content);
    if (constructorM) {
      const body = constructorM[1];
      if (body.includes('recordEvent') || body.includes('raiseDomainEvent')) {
        issues.push('Domain event recorded inside constructor — event raised before entity is persisted (risk of inconsistency)');
      }
    }
  }

  // Detect synchronous dispatch in same transaction
  if (content.includes('EventDispatcherInterface') || content.includes('eventDispatcher->dispatch')) {
    if (content.includes('entityManager') || content.includes('flush()')) {
      issues.push('Domain events dispatched synchronously within same transaction — event handler failure may not roll back the transaction');
    }
  }

  // Check mixing domain events with Symfony EventDispatcher
  if (isAggregate && content.includes('EventDispatcherInterface')) {
    issues.push('Aggregate directly uses Symfony EventDispatcher — coupling domain layer to framework infrastructure');
  }

  return {
    file: path.relative(appPath, filePath),
    class: className,
    isDomainEvent,
    isAggregate,
    eventTypes,
    hasRelease,
    issues,
  };
}

function checkDispatcherUsage(srcDir: string, aggregateClasses: string[]): Map<string, boolean> {
  const dispatched = new Map<string, boolean>();
  for (const cls of aggregateClasses) dispatched.set(cls, false);

  if (aggregateClasses.length === 0) return dispatched;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    for (const cls of aggregateClasses) {
      if (content.includes(`releaseEvents`) || content.includes(`getRecordedEvents`) ||
        content.includes(`pullDomainEvents`)) {
        dispatched.set(cls, true);
      }
    }
  }

  return dispatched;
}

function loadDomainEvents(appPath: string): DomainEventInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: DomainEventInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseDomainEventFile(file, appPath);
    if (info) results.push(info);
  }

  // Cross-check: find aggregates whose events are never dispatched
  const aggregates = results.filter((r) => r.isAggregate && r.hasRelease);
  const dispatched = checkDispatcherUsage(srcDir, aggregates.map((a) => a.class));

  for (const agg of aggregates) {
    const isDispatched = dispatched.get(agg.class) ?? false;
    if (!isDispatched && !agg.issues.some((i) => i.includes('dispatched'))) {
      agg.issues.push(`Domain events from aggregate "${agg.class}" may never be dispatched — no releaseEvents() call found in handlers/services`);
    }
  }

  return results;
}

export function listDomainEvents(appPath: string): McpToolResult {
  try {
    const events = loadDomainEvents(appPath);
    if (events.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No domain event patterns found.\n\nExpected patterns: DomainEventInterface, releaseEvents(), recordEvent(), raiseDomainEvent(), DomainEvent base class.',
        }],
      };
    }

    const totalIssues = events.reduce((s, e) => s + e.issues.length, 0);
    const aggregates = events.filter((e) => e.isAggregate);
    const domainEvents = events.filter((e) => e.isDomainEvent && !e.isAggregate);

    let text = `Domain Events\n${'='.repeat(55)}\n\nAggregates: ${aggregates.length}  Domain events: ${domainEvents.length}  Issues: ${totalIssues}\n`;

    for (const info of events.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${info.file})\n`;
      text += `    role:         ${info.isAggregate ? 'aggregate' : ''}${info.isDomainEvent ? 'domain event' : ''}\n`;
      text += `    has release:  ${info.hasRelease ? 'yes' : 'no'}\n`;
      if (info.eventTypes.length > 0) text += `    event types:  ${info.eventTypes.slice(0, 5).join(', ')}\n`;
      for (const issue of info.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDomainEventStats(appPath: string): McpToolResult {
  try {
    const events = loadDomainEvents(appPath);
    const aggregates = events.filter((e) => e.isAggregate);
    const domainEvents = events.filter((e) => e.isDomainEvent && !e.isAggregate);

    let text = `Domain Event Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes detected:   ${events.length}\n`;
    text += `  Aggregates:             ${aggregates.length}\n`;
    text += `    With release method:  ${aggregates.filter((a) => a.hasRelease).length}\n`;
    text += `  Domain events:          ${domainEvents.length}\n`;
    text += `Issues:                   ${events.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDomainEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_domain_events',
      description: 'Show domain event patterns: aggregate roots (recordEvent/releaseEvents), domain event classes; warns on events never dispatched, non-final domain event class, events in constructor, sync dispatch in same transaction, mixing with Symfony EventDispatcher',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_domain_event_stats',
      description: 'Show domain event statistics: total classes, aggregate count, domain event count, release method coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
