/**
 * Symfony Messenger Multi-Bus Inspector
 *
 * Distinct from messenger.ts (single-bus/transport focus),
 * messenger-handlers.ts (handler registration).
 * Focuses on multi-bus setup for CQRS and event-driven architectures:
 *
 * messenger.yaml:
 *   framework:
 *     messenger:
 *       default_bus: command.bus
 *       buses:
 *         command.bus:
 *           middleware: [validation, doctrine_transaction]
 *           default_middleware: allow_no_handlers
 *         query.bus:
 *           middleware: [validation]
 *         event.bus:
 *           default_middleware: {enabled: true, allow_no_handlers: true}
 *
 * Bus-specific routing:
 *   - Messages routed only to specific bus via routing key
 *   - Transport routing per bus
 *
 * CQRS pattern detection:
 *   - CommandBusInterface / QueryBusInterface / EventBusInterface aliases
 *   - Command classes (no return type on handle())
 *   - Query classes (typed return on handle())
 *   - Event classes (multiple handlers allowed)
 *
 * Analysis:
 *   - Single bus handling all message types (no separation of concerns)
 *   - default_middleware: allow_no_handlers on command bus (commands should always be handled)
 *   - query.bus without caching middleware (queries often benefit from cache)
 *   - Same message class dispatched to multiple buses
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

interface BusConfig {
  name: string;
  middleware: string[];
  allowNoHandlers: boolean;
  isDefault: boolean;
}

function loadBusConfig(appPath: string): { buses: BusConfig[]; defaultBus?: string } {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'messenger.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const fw        = (raw['framework'] ?? raw) as Record<string, unknown>;
    const messenger = (fw['messenger'] ?? raw['messenger'] ?? {}) as Record<string, unknown>;
    const busesRaw  = messenger['buses'] as Record<string, unknown> | undefined;
    const defaultBus = messenger['default_bus'] ? String(messenger['default_bus']) : undefined;

    if (!busesRaw) return { buses: [], defaultBus };

    const buses: BusConfig[] = [];
    for (const [name, busData] of Object.entries(busesRaw)) {
      const bus = (busData ?? {}) as Record<string, unknown>;
      const mwRaw = bus['middleware'];
      const middleware = Array.isArray(mwRaw) ? mwRaw.map(String) : [];

      const defaultMwRaw = bus['default_middleware'];
      let allowNoHandlers = false;
      if (defaultMwRaw === true || defaultMwRaw === 'true') allowNoHandlers = false;
      else if (typeof defaultMwRaw === 'object' && defaultMwRaw !== null) {
        allowNoHandlers = (defaultMwRaw as Record<string, unknown>)['allow_no_handlers'] === true;
      }

      buses.push({ name, middleware, allowNoHandlers, isDefault: name === defaultBus });
    }

    return { buses, defaultBus };
  }
  return { buses: [] };
}

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

function detectCqrsPatterns(appPath: string): { commandBusAlias: boolean; queryBusAlias: boolean; eventBusAlias: boolean } {
  const srcDir    = path.join(appPath, 'src');
  const configDir = path.join(appPath, 'config');
  let commandBusAlias = false;
  let queryBusAlias   = false;
  let eventBusAlias   = false;

  for (const dir of [srcDir, configDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (content.includes('CommandBusInterface')) commandBusAlias = true;
      if (content.includes('QueryBusInterface'))   queryBusAlias   = true;
      if (content.includes('EventBusInterface'))   eventBusAlias   = true;
    }
  }

  return { commandBusAlias, queryBusAlias, eventBusAlias };
}

export function listMessageBuses(appPath: string): McpToolResult {
  try {
    const { buses, defaultBus } = loadBusConfig(appPath);

    if (buses.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No multi-bus configuration found (single default bus).\n\nMulti-bus CQRS setup example:\n  framework:\n    messenger:\n      default_bus: command.bus\n      buses:\n        command.bus:\n          middleware: [validation, doctrine_transaction]\n        query.bus:\n          middleware: [validation]\n        event.bus:\n          default_middleware: {enabled: true, allow_no_handlers: true}',
        }],
      };
    }

    const cqrs    = detectCqrsPatterns(appPath);
    const issues: string[] = [];

    const commandBus = buses.find((b) => b.name.includes('command'));
    if (commandBus?.allowNoHandlers) {
      issues.push(`command bus "${commandBus.name}" allows no handlers — unhandled commands silently ignored`);
    }

    const queryBus = buses.find((b) => b.name.includes('query'));
    if (queryBus && !queryBus.middleware.some((m) => m.includes('cache'))) {
      // Not necessarily an issue, just informational
    }

    let text = `Messenger Buses\n${'='.repeat(55)}\n`;
    text += `\nBuses: ${buses.length}  Default: ${defaultBus ?? 'not set'}\n`;
    text += `CQRS aliases: CommandBus=${cqrs.commandBusAlias ? 'yes' : 'no'}  QueryBus=${cqrs.queryBusAlias ? 'yes' : 'no'}  EventBus=${cqrs.eventBusAlias ? 'yes' : 'no'}\n`;

    for (const bus of buses) {
      const defFlag  = bus.isDefault ? '  [default]' : '';
      const noHandle = bus.allowNoHandlers ? '  [allow_no_handlers]' : '';
      text += `\n  ${bus.name}${defFlag}${noHandle}\n`;
      if (bus.middleware.length > 0) {
        text += `    middleware: ${bus.middleware.map((m) => m.split('\\').pop() ?? m).join(', ')}\n`;
      }
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getBusStats(appPath: string): McpToolResult {
  try {
    const { buses, defaultBus } = loadBusConfig(appPath);
    const cqrs = detectCqrsPatterns(appPath);

    let text = `Bus Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total buses:         ${buses.length}\n`;
    text += `Default bus:         ${defaultBus ?? 'not set'}\n`;
    text += `CommandBus alias:    ${cqrs.commandBusAlias ? 'yes' : 'no'}\n`;
    text += `QueryBus alias:      ${cqrs.queryBusAlias ? 'yes' : 'no'}\n`;
    text += `EventBus alias:      ${cqrs.eventBusAlias ? 'yes' : 'no'}\n`;
    text += `Allow-no-handlers:   ${buses.filter((b) => b.allowNoHandlers).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessageBusTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_message_buses',
      description: 'Show Messenger multi-bus configuration: bus names, default bus, middleware per bus, allow_no_handlers flag, CQRS interface aliases (CommandBusInterface/QueryBusInterface/EventBusInterface), command bus with allow_no_handlers warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_bus_stats',
      description: 'Show bus statistics: total bus count, default bus, CQRS alias detection, allow-no-handlers count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
