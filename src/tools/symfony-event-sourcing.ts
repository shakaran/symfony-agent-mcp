// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface EventSourcingInfo {
  file: string;
  type: 'aggregate' | 'event' | 'projector' | 'store';
  name: string;
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

function buildEventSourcingInfos(appPath: string): EventSourcingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: EventSourcingInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const name = classMatch ? classMatch[1] : path.basename(file, '.php');
    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    const isAggregate = content.includes('recordThat(') ||
      content.includes('releaseEvents()') ||
      content.includes('AggregateRoot') ||
      (content.includes('apply(') && content.includes('AggregateChanged'));

    const isEvent = content.includes('DomainEventInterface') ||
      content.includes('AbstractDomainEvent') ||
      content.includes('AggregateChanged');

    const isProjector = content.includes('ProjectorInterface') ||
      content.includes('#[AsProjector]') ||
      (name.endsWith('Projector') || name.endsWith('Projection'));

    const isStore = content.includes('EventStoreInterface') ||
      name.endsWith('EventStore') ||
      content.includes('appendTo(') && content.includes('EventStreamId');

    if (isAggregate) {
      const hasApply = /function\s+apply\s*\(/.test(content) || /function\s+when/.test(content);
      if (!hasApply) {
        issues.push(`Aggregate "${name}" missing apply()/when*() method — domain events not applied to aggregate state`);
      }
      const hasPublicProps = /public\s+(?!readonly\s)(?!function\s)\w{1,60}\s+\$/.test(content);
      if (hasPublicProps) {
        issues.push(`Aggregate "${name}" has mutable public properties — aggregate state should be protected/private`);
      }
      results.push({ file: relFile, type: 'aggregate', name, issues });
    } else if (isEvent) {
      const hasPublicNonReadonly = /public\s+(?!readonly\s)(?!function\s)(?!static\s)(?!const\s)\w{1,60}\s+\$/.test(content);
      if (hasPublicNonReadonly) {
        issues.push(`Domain event "${name}" has mutable public properties — events should be immutable (use readonly)`);
      }
      results.push({ file: relFile, type: 'event', name, issues });
    } else if (isProjector) {
      const hasReplay = content.includes('replay') || content.includes('replayAll') || content.includes('reset()');
      if (!hasReplay) {
        issues.push(`Projector "${name}" appears to lack replay support — projections cannot be rebuilt from event history`);
      }
      results.push({ file: relFile, type: 'projector', name, issues });
    } else if (isStore) {
      const hasPosition = content.includes('position') || content.includes('sequence') || content.includes('version');
      if (!hasPosition) {
        issues.push(`Event store "${name}" may not track position/sequence — cannot replay events from a specific point`);
      }
      results.push({ file: relFile, type: 'store', name, issues });
    }
  }

  return results;
}

export function listSymfonyEventSourcing(appPath: string): McpToolResult {
  try {
    const infos = buildEventSourcingInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Event Sourcing patterns found in src/ (no AggregateRoot/DomainEvent/Projector/EventStore).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Event Sourcing Analysis\n${'='.repeat(50)}\n\nClasses: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  [${info.type.toUpperCase()}] ${info.name}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEventSourcingStats(appPath: string): McpToolResult {
  try {
    const infos = buildEventSourcingInfos(appPath);
    let text = `Event Sourcing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Aggregates:  ${infos.filter((i) => i.type === 'aggregate').length}\n`;
    text += `Events:      ${infos.filter((i) => i.type === 'event').length}\n`;
    text += `Projectors:  ${infos.filter((i) => i.type === 'projector').length}\n`;
    text += `Stores:      ${infos.filter((i) => i.type === 'store').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyEventSourcingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_event_sourcing', description: 'Detect Event Sourcing patterns in src/; warns on aggregate missing apply(), mutable event properties, projector without replay, event store without position tracking', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_event_sourcing_stats', description: 'Statistics for Event Sourcing: aggregate/event/projector/store count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
