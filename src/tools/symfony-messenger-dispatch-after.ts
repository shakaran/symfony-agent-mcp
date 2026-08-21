/**
 * Symfony Messenger DispatchAfterCurrentBus Inspector
 *
 * Scans src/ PHP for:
 *   - DispatchAfterCurrentBusMiddleware usage
 *   - DispatchAfterCurrentBus stamp
 *   - Message handlers that call $this->bus->dispatch() (inner dispatch)
 *
 * Warns about:
 *   - Dispatch inside handler without DispatchAfterCurrentBus stamp
 *   - DispatchAfterCurrentBusMiddleware not in middleware stack (stamp has no effect)
 *   - Nested dispatch chain >3 levels deep
 *   - dispatch-after without corresponding transaction middleware
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DispatchAfterInfo {
  file: string;
  class: string;
  hasInnerDispatch: boolean;
  hasDispatchAfterStamp: boolean;
  middlewareConfigured: boolean;
  nestingDepth: number;
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

function checkMiddlewareConfigured(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('DispatchAfterCurrentBusMiddleware') || content.includes('dispatch_after_current_bus')) {
        return true;
      }
    } catch { /* skip */ }
  }

  // Also check YAML structure
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const content = JSON.stringify(raw);
    if (content.includes('DispatchAfterCurrentBus') || content.includes('dispatch_after_current_bus')) {
      return true;
    }
  }

  return false;
}

function hasTransactionMiddleware(appPath: string): boolean {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
  ];
  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('doctrine_transaction') || content.includes('DoctrineTransactionMiddleware')) {
        return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

function countNestingDepth(content: string): number {
  // Estimate dispatch nesting by counting dispatch() calls
  const matches = content.match(/->dispatch\s*\(/g);
  return matches ? matches.length : 0;
}

function isMessageHandler(content: string): boolean {
  return (
    content.includes('MessageHandlerInterface') ||
    content.includes('#[AsMessageHandler]') ||
    content.includes('AsMessageHandler') ||
    /function\s+__invoke\s*\([^)]{0,200}Message/.test(content)
  );
}

function scanDispatchAfter(appPath: string): DispatchAfterInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const middlewareConfigured = checkMiddlewareConfigured(appPath);
  const hasTransaction = hasTransactionMiddleware(appPath);
  const results: DispatchAfterInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasDispatchAfterStamp = content.includes('DispatchAfterCurrentBus');
    const hasMiddlewareRef = content.includes('DispatchAfterCurrentBusMiddleware');
    const hasInnerDispatch = isMessageHandler(content) && /->dispatch\s*\(/.test(content);

    if (!hasDispatchAfterStamp && !hasMiddlewareRef && !hasInnerDispatch) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const nestingDepth = countNestingDepth(content);
    const issues: string[] = [];

    if (hasInnerDispatch && !hasDispatchAfterStamp) {
      issues.push('Message handler dispatches inner message without DispatchAfterCurrentBus stamp — may dispatch before transaction commits');
    }
    if (hasDispatchAfterStamp && !middlewareConfigured) {
      issues.push('DispatchAfterCurrentBus stamp used but DispatchAfterCurrentBusMiddleware not found in messenger config — stamp has no effect');
    }
    if (nestingDepth > 3) {
      issues.push(`Nested dispatch chain depth ~${nestingDepth} — deep nesting complicates transaction boundaries`);
    }
    if (hasDispatchAfterStamp && !hasTransaction) {
      issues.push('DispatchAfterCurrentBus used without DoctrineTransactionMiddleware — dispatch-after is most useful with transactions');
    }

    results.push({
      file,
      class: className,
      hasInnerDispatch,
      hasDispatchAfterStamp,
      middlewareConfigured,
      nestingDepth,
      issues,
    });
  }

  return results;
}

export function listDispatchAfterCurrentBus(appPath: string): McpToolResult {
  try {
    const infos = scanDispatchAfter(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No DispatchAfterCurrentBus usage or inner dispatch in message handlers found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger DispatchAfterCurrentBus Analysis\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;
    text += `DispatchAfterCurrentBusMiddleware configured: ${infos[0]?.middlewareConfigured ? 'yes' : 'no'}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      text += `    innerDispatch: ${info.hasInnerDispatch ? 'yes' : 'no'}`;
      text += `  dispatchAfterStamp: ${info.hasDispatchAfterStamp ? 'yes' : 'no'}`;
      text += `  nestingDepth: ${info.nestingDepth}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDispatchAfterStats(appPath: string): McpToolResult {
  try {
    const infos = scanDispatchAfter(appPath);

    let text = `DispatchAfterCurrentBus Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:                    ${infos.length}\n`;
    text += `  With inner dispatch:            ${infos.filter((i) => i.hasInnerDispatch).length}\n`;
    text += `  With DispatchAfterCurrentBus:   ${infos.filter((i) => i.hasDispatchAfterStamp).length}\n`;
    text += `  Middleware configured:          ${infos.length > 0 && infos[0].middlewareConfigured ? 'yes' : 'no'}\n`;
    text += `  Deep nesting (>3):              ${infos.filter((i) => i.nestingDepth > 3).length}\n`;
    text += `Total issues:                     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDispatchAfterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_dispatch_after_current_bus',
      description: 'Scan src/ for DispatchAfterCurrentBus usage: inner dispatch in handlers, stamp without middleware configured, deep nesting chains, missing transaction middleware; warns on patterns that cause premature dispatch',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_dispatch_after_stats',
      description: 'Statistics for DispatchAfterCurrentBus: class count, inner dispatch count, stamp usage, middleware config status, deep nesting count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
