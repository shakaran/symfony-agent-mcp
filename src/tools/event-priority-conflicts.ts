import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ListenerEntry {
  class: string;
  event: string;
  priority: number;
  method: string;
  file: string;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function parseListeners(filePath: string, appPath: string): ListenerEntry[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (!content.includes('getSubscribedEvents') && !content.includes('#[AsEventListener]') && !content.includes('#[AsKernelListener]')) return [];
  if (content.includes('namespace Symfony\\')) return [];
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return [];
  const className = classM[1];
  const entries: ListenerEntry[] = [];
  // Parse getSubscribedEvents() array return
  const subRe = /['"]([^'"]{3,120})['"]\s*=>\s*(?:\[\s*(?:\[\s*)?['"](\w{1,80})['"]\s*,\s*(-?\d+)\s*\])/g;
  let m: RegExpExecArray | null;
  while ((m = subRe.exec(content)) !== null) {
    entries.push({ class: className, event: m[1], priority: parseInt(m[3], 10), method: m[2], file: path.relative(appPath, filePath) });
  }
  // Parse #[AsEventListener] attribute
  const attrRe = /#\[AsEventListener\s*\([^)]{0,200}priority\s*:\s*(-?\d+)[^)]{0,200}\)\]/g;
  while ((m = attrRe.exec(content)) !== null) {
    entries.push({ class: className, event: 'attribute-defined', priority: parseInt(m[1], 10), method: 'attribute', file: path.relative(appPath, filePath) });
  }
  return entries;
}

interface PriorityConflict {
  event: string;
  priority: number;
  listeners: Array<{ class: string; method: string; file: string }>;
}

export function listEventPriorityConflicts(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const allEntries: ListenerEntry[] = [];
    for (const f of getAllPhpFiles(srcDir)) allEntries.push(...parseListeners(f, appPath));
    if (allEntries.length === 0) return { content: [{ type: 'text', text: 'No event listener priority data found (getSubscribedEvents with priority not detected).' }] };
    const groupKey = (e: ListenerEntry): string => `${e.event}::${e.priority}`;
    const groups = new Map<string, ListenerEntry[]>();
    for (const e of allEntries) {
      const key = groupKey(e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    const conflicts: PriorityConflict[] = [];
    for (const [key, entries] of groups.entries()) {
      if (entries.length >= 2) {
        const [event, prioStr] = key.split('::');
        conflicts.push({ event, priority: parseInt(prioStr, 10), listeners: entries.map(e => ({ class: e.class, method: e.method, file: e.file })) });
      }
    }
    if (conflicts.length === 0) {
      return { content: [{ type: 'text', text: `Event listeners analyzed: ${allEntries.length}\nNo same-event same-priority conflicts found.` }] };
    }
    let text = `Event Priority Conflicts\n${'='.repeat(55)}\n\nListeners analyzed: ${allEntries.length}  Conflicts: ${conflicts.length}\n(Listeners at same priority execute in registration order — not deterministic)\n`;
    for (const c of conflicts.sort((a, b) => b.listeners.length - a.listeners.length)) {
      text += `\n  ${c.event}  priority: ${c.priority}\n`;
      for (const l of c.listeners) text += `    ${l.class}::${l.method}  (${l.file})\n`;
      text += `    ⚠ Execution order between these listeners is non-deterministic\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getEventPriorityStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const allEntries: ListenerEntry[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) allEntries.push(...parseListeners(f, appPath));
    }
    const events = new Set(allEntries.map(e => e.event)).size;
    let text = `Event Priority Statistics\n${'='.repeat(40)}\n\n`;
    text += `Listeners with explicit priority: ${allEntries.length}\nDistinct events: ${events}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getEventPriorityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_event_priority_conflicts', description: 'Detect event listeners with same event and same priority: non-deterministic execution order warning, getSubscribedEvents() priority analysis, #[AsEventListener] priority', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_event_priority_stats', description: 'Event priority statistics: listeners with explicit priority, distinct event count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
