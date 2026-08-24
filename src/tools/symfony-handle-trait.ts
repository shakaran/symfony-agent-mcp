// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface HandleTraitInfo {
  file: string;
  class: string;
  messageBusType: string;
  messageTypes: string[];
  usesInController: boolean;
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

function inferBusType(content: string): string {
  if (content.includes('query') || content.includes('QueryBus') || content.includes('query_bus')) return 'query_bus';
  if (content.includes('command') || content.includes('CommandBus') || content.includes('command_bus')) return 'command_bus';
  if (content.includes('event') || content.includes('EventBus') || content.includes('event_bus')) return 'event_bus';
  return 'messenger.default_bus';
}

function extractHandledMessageTypes(content: string): string[] {
  const types: string[] = [];
  // $this->handle(new SomeMessage(...)) or $this->handle($message)
  for (const m of content.matchAll(/\$this->handle\s*\(\s*new\s+(\w{1,100})\s*\(/g)) {
    if (!types.includes(m[1])) types.push(m[1]);
  }
  // Type-hinted variables: SomeMessage $msg; $this->handle($msg)
  for (const m of content.matchAll(/(\w{1,100})\s+\$\w{1,80}\s*;[\s\S]{0,200}\$this->handle\s*\(/g)) {
    const t = m[1];
    if (t !== 'mixed' && t !== 'object' && !types.includes(t)) types.push(t);
  }
  return types;
}

function parseHandleTraitFile(filePath: string, appPath: string): HandleTraitInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('HandleTrait')) return null;
  if (!content.includes('use HandleTrait')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const messageBusType = inferBusType(content);
  const messageTypes = extractHandledMessageTypes(content);

  // Is this used in a controller?
  const usesInController = content.includes('extends AbstractController') ||
    content.includes('extends Controller') ||
    content.includes('#[AsController]') ||
    filePath.includes('/Controller/');

  const issues: string[] = [];

  // Check if $this->handle() has proper type hint on argument
  if (messageTypes.length === 0) {
    issues.push('HandleTrait->handle() called without typed message argument — no type safety (handles any message)');
  }

  if (usesInController) {
    issues.push('HandleTrait used in controller — prefer direct $this->bus->dispatch() in controllers; HandleTrait is intended for service classes');
  }

  // Check for async message types — heuristic: message class name contains "Async" or "Command"
  for (const msgType of messageTypes) {
    if (msgType.toLowerCase().includes('async')) {
      issues.push(`HandleTrait with async message "${msgType}" — handle() blocks waiting for result that never returns`);
    }
  }

  // Check for multiple HandleTrait uses (mixing command/query buses)
  const busPropertyMatches = [...content.matchAll(/(?:private|protected|public)\s+(?:\w+\s+)?\$messageBus\b/g)];
  if (busPropertyMatches.length > 1) {
    issues.push('Multiple $messageBus properties detected — mixing command/query buses with HandleTrait is error-prone');
  }

  // Check exception handling around handle() calls
  const handleCallRegex = /\$this->handle\s*\(/g;
  const handleCalls = [...content.matchAll(handleCallRegex)];
  if (handleCalls.length > 0) {
    const hasTryCatch = content.includes('try {') || content.includes('try{');
    if (!hasTryCatch) {
      issues.push('HandleTrait->handle() without try/catch — unhandled message exception propagates as 500 error');
    }
  }

  return {
    file: path.relative(appPath, filePath),
    class: className,
    messageBusType,
    messageTypes,
    usesInController,
    issues,
  };
}

function loadHandleTraitUsage(appPath: string): HandleTraitInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: HandleTraitInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseHandleTraitFile(file, appPath);
    if (info) results.push(info);
  }
  return results;
}

export function listHandleTraitUsage(appPath: string): McpToolResult {
  try {
    const usages = loadHandleTraitUsage(appPath);
    if (usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No HandleTrait usage found.\n\nExample:\n  class QueryService {\n    use HandleTrait;\n    public function __construct(MessageBusInterface $queryBus) {\n      $this->messageBus = $queryBus;\n    }\n    public function find(FindUserQuery $query): User {\n      return $this->handle($query);\n    }\n  }',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `HandleTrait Usage\n${'='.repeat(55)}\n\nClasses: ${usages.length}  Issues: ${totalIssues}\n`;

    for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${u.class}  (${u.file})\n`;
      text += `    bus type:       ${u.messageBusType}\n`;
      text += `    in controller:  ${u.usesInController ? 'yes (warning)' : 'no'}\n`;
      if (u.messageTypes.length > 0) text += `    messages:       ${u.messageTypes.join(', ')}\n`;
      for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHandleTraitStats(appPath: string): McpToolResult {
  try {
    const usages = loadHandleTraitUsage(appPath);

    let text = `HandleTrait Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes using HandleTrait:   ${usages.length}\n`;
    text += `  In controllers:            ${usages.filter((u) => u.usesInController).length}\n`;
    text += `  With typed messages:       ${usages.filter((u) => u.messageTypes.length > 0).length}\n`;
    text += `  Without typed messages:    ${usages.filter((u) => u.messageTypes.length === 0).length}\n`;

    const busTypes = new Map<string, number>();
    for (const u of usages) busTypes.set(u.messageBusType, (busTypes.get(u.messageBusType) ?? 0) + 1);
    for (const [type, count] of busTypes.entries()) text += `  ${type}: ${count}\n`;

    text += `Issues:                      ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHandleTraitTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_handle_trait_usage',
      description: 'Show HandleTrait usage: bus type, message types, controller usage; warns on untyped handle() argument, HandleTrait in controller, async message with handle(), multiple bus mixing, no exception handling',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_handle_trait_stats',
      description: 'Show HandleTrait statistics: total classes, controller usage count, typed/untyped message count, bus type distribution, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
