/**
 * Symfony Messenger Middleware & Stamps Inspector
 *
 * Reads config/packages/messenger.yaml:
 *   - Per-bus middleware chains (built-in + custom)
 *   - Bus names and their transport routing
 *
 * Scans src/ for:
 *   - Custom MiddlewareInterface implementations
 *   - Custom StampInterface implementations
 *   - Envelope decoration patterns
 *   - Middleware in the default bus vs. custom buses
 *
 * Pure static analysis.
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

interface BusMiddleware {
  busName: string;
  middleware: string[];
  isDefault: boolean;
}

interface CustomMiddleware {
  class: string;
  file: string;
  handlesMessage?: string;
}

interface CustomStamp {
  class: string;
  file: string;
}

// ─── Built-in middleware labels ─────────────────────────────────────────────

const BUILTIN_MIDDLEWARE: Record<string, string> = {
  'add_bus_name_stamp_middleware':  'Adds bus name stamp to envelope',
  'reject_redelivered_message_middleware': 'Rejects already-redelivered messages',
  'dispatch_after_current_bus':    'Defers dispatch until current bus finishes',
  'failed_message_processing_middleware': 'Processes messages from the failed transport',
  'send_message':                  'Routes message to transport',
  'handle_message':                'Calls the message handler',
  'validation':                    'Validates message before dispatching',
  'router_context':                'Restores router context from stamp',
};

function labelMiddleware(id: string): string {
  const key = id.replace(/^messenger\.middleware\./, '');
  return BUILTIN_MIDDLEWARE[key] ?? `Custom: ${id}`;
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadBusMiddleware(appPath: string): BusMiddleware[] {
  const messengerFile = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const raw = parseYamlFile(messengerFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const root = ((raw['framework'] as Record<string, unknown>)?.['messenger']
    ?? raw['messenger']
    ?? {}) as Record<string, unknown>;

  const buses = root['buses'] as Record<string, unknown> | undefined;
  const results: BusMiddleware[] = [];

  // default bus middleware
  const defaultMw = root['middleware'] as unknown[] | undefined;
  if (defaultMw) {
    results.push({
      busName: 'default',
      middleware: defaultMw.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))),
      isDefault: true,
    });
  }

  if (buses) {
    for (const [busName, busDef] of Object.entries(buses)) {
      if (!busDef || typeof busDef !== 'object') continue;
      const bd = busDef as Record<string, unknown>;
      const mw = bd['middleware'] as unknown[] | undefined;
      results.push({
        busName,
        middleware: mw
          ? mw.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
          : ['(default chain)'],
        isDefault: false,
      });
    }
  }

  return results;
}

// ─── PHP scanning ───────────────────────────────────────────────────────────

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

function scanCustomMiddleware(appPath: string): CustomMiddleware[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const middlewares: CustomMiddleware[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('MiddlewareInterface') || !content.includes('implements')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Find which message type it handles from handle(Envelope $envelope, StackInterface $stack)
    const handleM = /function\s+handle\s*\(\s*Envelope\s+\$\w+/i.exec(content);
    if (!handleM) continue;

    middlewares.push({
      class: classM[1],
      file: path.basename(file),
    });
  }

  return middlewares.sort((a, b) => a.class.localeCompare(b.class));
}

function scanCustomStamps(appPath: string): CustomStamp[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const stamps: CustomStamp[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('StampInterface') || !content.includes('implements')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    stamps.push({ class: classM[1], file: path.basename(file) });
  }

  return stamps.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listMessengerMiddleware(appPath: string): McpToolResult {
  try {
    const buses = loadBusMiddleware(appPath);
    const customMw = scanCustomMiddleware(appPath);
    const customStamps = scanCustomStamps(appPath);

    if (buses.length === 0 && customMw.length === 0 && customStamps.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Messenger bus configuration found, or no custom middleware/stamps.\n\nDefault middleware chain applies automatically when messenger is configured.\n\nAdd custom middleware:\n  framework:\n    messenger:\n      buses:\n        command.bus:\n          middleware:\n            - App\\Messenger\\Middleware\\LoggingMiddleware',
        }],
      };
    }

    let text = `Messenger Middleware & Stamps\n${'='.repeat(60)}\n`;

    if (buses.length > 0) {
      text += `\nBus middleware chains:\n`;
      for (const bus of buses) {
        text += `\n  Bus: ${bus.busName}${bus.isDefault ? ' (default)' : ''}\n`;
        for (const mw of bus.middleware) {
          const label = labelMiddleware(mw);
          const isCustom = !Object.keys(BUILTIN_MIDDLEWARE).some((k) => mw.includes(k));
          text += `    ${isCustom ? '→ ' : '  '}${mw}  ${isCustom ? '[custom]' : `— ${label}`}\n`;
        }
      }
    }

    if (customMw.length > 0) {
      text += `\nCustom middleware classes (${customMw.length}):\n`;
      for (const m of customMw) {
        text += `  ${m.class}  (${m.file})\n`;
      }
    }

    if (customStamps.length > 0) {
      text += `\nCustom stamps (${customStamps.length}):\n`;
      for (const s of customStamps) {
        text += `  ${s.class}  (${s.file})\n`;
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

export function getMessengerMiddlewareStats(appPath: string): McpToolResult {
  try {
    const buses = loadBusMiddleware(appPath);
    const customMw = scanCustomMiddleware(appPath);
    const customStamps = scanCustomStamps(appPath);

    const totalMw = buses.reduce((s, b) => s + b.middleware.length, 0);

    let text = `Messenger Middleware Statistics\n${'='.repeat(40)}\n\n`;
    text += `Buses configured:   ${buses.length}\n`;
    text += `Total middleware:   ${totalMw}\n`;
    text += `Custom middleware:  ${customMw.length}\n`;
    text += `Custom stamps:      ${customStamps.length}\n`;

    if (buses.length > 0) {
      text += `\nMiddleware per bus:\n`;
      for (const bus of buses) {
        text += `  ${bus.busName.padEnd(30)} ${bus.middleware.length} middleware\n`;
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

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getMessengerMiddlewareTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_messenger_middleware',
      description: 'Show Symfony Messenger bus middleware chains (built-in and custom), custom MiddlewareInterface classes, and custom StampInterface implementations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_messenger_middleware_stats',
      description: 'Show Messenger middleware statistics: bus count, total middleware entries, custom middleware and stamp class counts',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
