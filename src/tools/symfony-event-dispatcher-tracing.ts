import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface EventDispatcherUsage {
  file: string;
  class?: string;
  stopPropagationCount: number;
  dispatchInsideListenerCount: number;
  hasTracedDispatcher: boolean;
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

function parseDispatcherUsage(filePath: string, appPath: string): EventDispatcherUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isListener = content.includes('EventSubscriberInterface') || /function\s+on[A-Z]/.test(content);
  const stopPropagationCount = [...content.matchAll(/->stopPropagation\s*\(\s*\)/g)].length;
  const dispatchInsideListenerCount = [...content.matchAll(/->dispatch\s*\(/g)].length;
  const hasTracedDispatcher = content.includes('TraceableEventDispatcher') || content.includes('debug.event_dispatcher');
  if (stopPropagationCount + dispatchInsideListenerCount + (hasTracedDispatcher ? 1 : 0) === 0) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const issues: string[] = [];
  if (stopPropagationCount > 0 && !content.includes('propagationStopped')) issues.push('stopPropagation() called — other listeners of this event will be skipped; document which listeners expect to run after');
  if (isListener && dispatchInsideListenerCount > 0) issues.push('dispatch() inside event listener — potential reentrant dispatch; ensure listener does not trigger the same event recursively');
  return { file: path.relative(appPath, filePath), class: classM?.[1], stopPropagationCount, dispatchInsideListenerCount, hasTracedDispatcher, issues };
}

export function listEventDispatcherTracing(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: EventDispatcherUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseDispatcherUsage(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No stopPropagation()/reentrant dispatch patterns found.' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Event Dispatcher Tracing\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `  stopPropagation calls: ${usages.reduce((s, u) => s + u.stopPropagationCount, 0)}\n  dispatch inside listeners: ${usages.reduce((s, u) => s + u.dispatchInsideListenerCount, 0)}\n`;
    for (const u of usages.filter((x) => x.issues.length > 0)) {
      text += `\n  ${u.class ?? '(file)'}  stop: ${u.stopPropagationCount}  inner dispatch: ${u.dispatchInsideListenerCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getEventDispatcherTracingStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: EventDispatcherUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseDispatcherUsage(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Event Dispatcher Tracing Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${usages.length}\n  stopPropagation calls: ${usages.reduce((s, u) => s + u.stopPropagationCount, 0)}\n  Reentrant dispatch: ${usages.filter((u) => u.dispatchInsideListenerCount > 0).length}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getEventDispatcherTracingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_event_dispatcher_tracing', description: 'Show event dispatcher patterns: stopPropagation() usage, dispatch() calls inside listeners (reentrant dispatch), TraceableEventDispatcher wiring, propagation-stopped listeners warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_event_dispatcher_tracing_stats', description: 'Show event dispatcher tracing statistics: file count, stopPropagation count, reentrant dispatch count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
