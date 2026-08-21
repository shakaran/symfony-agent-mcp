import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface EventManagerUsage {
  file: string;
  class?: string;
  addEventListenerCount: number;
  removeEventListenerCount: number;
  hasDoctrineEventListener: boolean;
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

function parseEventManager(filePath: string, appPath: string): EventManagerUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  if (!content.includes('addEventListener') && !content.includes('EventManager')) return null;
  if (content.includes('namespace Doctrine\\') || content.includes('namespace Symfony\\EventDispatcher')) return null;
  const addEventListenerCount = [...content.matchAll(/->addEventListener\s*\(/g)].length;
  const removeEventListenerCount = [...content.matchAll(/->removeEventListener\s*\(/g)].length;
  if (addEventListenerCount + removeEventListenerCount === 0) return null;
  const classM = /class\s+(\w+)/.exec(content);
  const hasDoctrineEventListener = content.includes('Doctrine\\Common\\EventSubscriber') || content.includes('DoctrineEventListener');
  const issues: string[] = [];
  if (addEventListenerCount > 0 && !content.includes('EventManager')) issues.push('addEventListener() without injecting EventManager — use #[AsDoctrineListener] attribute or service tag instead');
  if (addEventListenerCount > 0 && !hasDoctrineEventListener) issues.push('Old-style addEventListener() — migrate to #[AsDoctrineListener] or Symfony event subscriber for better DI support');
  return { file: path.relative(appPath, filePath), class: classM?.[1], addEventListenerCount, removeEventListenerCount, hasDoctrineEventListener, issues };
}

export function listDoctrineEventManagerUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const usages: EventManagerUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseEventManager(file, appPath);
      if (u) usages.push(u);
    }
    if (usages.length === 0) return { content: [{ type: 'text', text: 'No old-style Doctrine EventManager::addEventListener() usage found.\n\nModern alternative:\n  #[AsDoctrineListener(Events::preUpdate)]\n  class MyListener { public function preUpdate(PreUpdateEventArgs $args): void { ... } }' }] };
    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Doctrine EventManager Old-Style\n${'='.repeat(55)}\n\nFiles: ${usages.length}  Issues: ${totalIssues}\n`;
    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class ?? '(file)'}  addEventListener: ${u.addEventListenerCount}  remove: ${u.removeEventListenerCount}  (${u.file})\n`;
      for (const i of u.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEventManagerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: EventManagerUsage[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseEventManager(file, appPath);
        if (u) usages.push(u);
      }
    }
    let text = `Doctrine EventManager Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with EventManager: ${usages.length}\n  addEventListener calls: ${usages.reduce((s, u) => s + u.addEventListenerCount, 0)}\nIssues: ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineEventManagerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_event_manager_usage', description: 'Show old-style Doctrine EventManager::addEventListener() usage: call count, migration to #[AsDoctrineListener] recommended', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_event_manager_stats', description: 'Show Doctrine EventManager statistics: file count, addEventListener call count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
