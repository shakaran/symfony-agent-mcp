/**
 * Symfony Messenger Tool
 *
 * Provides introspection into Symfony Messenger configuration:
 *   - Transport configurations (AMQP, Redis, SQS, Doctrine, etc.)
 *   - Message routing rules
 *   - Middleware stack
 *   - Message classes from src/Message/
 *   - Handler classes from src/MessageHandler/
 *
 * All data is read-only from configuration files; no actual queue connections are made.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile, loadEnvironmentVariables } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TransportConfig {
  name: string;
  dsn: string;
  dsnDisplay: string;
  options: Record<string, unknown>;
  failureTransport?: string;
}

interface RoutingRule {
  messageClass: string;
  transports: string[];
}

interface MessengerConfig {
  transports: TransportConfig[];
  routing: RoutingRule[];
  middleware: string[];
  defaultMiddleware: boolean;
  buses: string[];
}

interface MessageClass {
  name: string;
  file: string;
  namespace: string;
  handlerFound: boolean;
}

// ─── Config parsing ────────────────────────────────────────────────────────

function parseMessengerConfig(appPath: string): MessengerConfig | null {
  const configPath = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  const config = parseYamlFile(configPath) as Record<string, unknown> | null;

  if (!config) return null;

  const framework = config['framework'] as Record<string, unknown> | undefined;
  const messengerSection = (framework?.['messenger'] ?? config['messenger']) as Record<string, unknown> | undefined;

  if (!messengerSection) return null;

  const env = loadEnvironmentVariables(appPath);
  const transports = parseTransports(messengerSection, env);
  const routing = parseRouting(messengerSection);
  const middleware = parseMiddleware(messengerSection);
  const buses = parseBuses(messengerSection);

  return { transports, routing, middleware, defaultMiddleware: true, buses };
}

function resolveEnvVar(value: string, env: Record<string, string>): string {
  return value.replace(/%env\(([^)]+)\)%/g, (_, varName) => env[varName] ?? `%env(${varName})%`);
}

function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return dsn.replace(/:[^:@/]+@/, ':***@');
  }
}

function parseTransports(messenger: Record<string, unknown>, env: Record<string, string>): TransportConfig[] {
  const transportsConfig = messenger['transports'] as Record<string, unknown> | undefined;
  if (!transportsConfig) return [];

  const transports: TransportConfig[] = [];

  for (const [name, config] of Object.entries(transportsConfig)) {
    if (typeof config === 'string') {
      const dsn = resolveEnvVar(config, env);
      transports.push({ name, dsn, dsnDisplay: redactDsn(dsn), options: {} });
    } else if (config && typeof config === 'object') {
      const cfg = config as Record<string, unknown>;
      const rawDsn = resolveEnvVar((cfg['dsn'] as string) ?? '', env);
      transports.push({
        name,
        dsn: rawDsn,
        dsnDisplay: redactDsn(rawDsn),
        options: (cfg['options'] as Record<string, unknown>) ?? {},
        failureTransport: cfg['failure_transport'] as string | undefined,
      });
    }
  }

  return transports;
}

function parseRouting(messenger: Record<string, unknown>): RoutingRule[] {
  const routingConfig = messenger['routing'] as Record<string, unknown> | undefined;
  if (!routingConfig) return [];

  const rules: RoutingRule[] = [];

  for (const [messageClass, transports] of Object.entries(routingConfig)) {
    const transportList = Array.isArray(transports) ? transports.map(String) : [String(transports)];
    rules.push({ messageClass, transports: transportList });
  }

  return rules;
}

function parseMiddleware(messenger: Record<string, unknown>): string[] {
  const buses = messenger['buses'] as Record<string, unknown> | undefined;
  if (!buses) return [];

  const allMiddleware: string[] = [];
  for (const busConfig of Object.values(buses)) {
    const bus = busConfig as Record<string, unknown>;
    const mw = bus['middleware'] as unknown[] | undefined;
    if (Array.isArray(mw)) {
      allMiddleware.push(...mw.map(String));
    }
  }

  return allMiddleware;
}

function parseBuses(messenger: Record<string, unknown>): string[] {
  const buses = messenger['buses'] as Record<string, unknown> | undefined;
  return buses ? Object.keys(buses) : ['messenger.bus.default'];
}

// ─── Message / Handler scanning ───────────────────────────────────────────

function scanMessageClasses(appPath: string): MessageClass[] {
  const messagePath = path.join(appPath, 'src', 'Message');
  const handlerPath = path.join(appPath, 'src', 'MessageHandler');
  const messages: MessageClass[] = [];

  if (!fs.existsSync(messagePath)) return messages;

  const handlerFiles = fs.existsSync(handlerPath)
    ? getAllPhpFiles(handlerPath)
    : [];

  for (const file of getAllPhpFiles(messagePath)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const classMatch = /class\s+(\w+)/.exec(content);
      const nsMatch = /namespace\s+([\w\\]+)\s*;/.exec(content);

      if (!classMatch) continue;

      const name = classMatch[1];
      const namespace = nsMatch ? nsMatch[1] : '';
      const fqn = namespace ? `${namespace}\\${name}` : name;

      // Check if a corresponding handler exists
      const handlerFound = handlerFiles.some((hFile) => {
        try {
          const hContent = fs.readFileSync(hFile, 'utf-8');
          return hContent.includes(`${name}`) && hContent.includes('MessageHandlerInterface');
        } catch {
          return false;
        }
      });

      messages.push({ name, file: path.basename(file), namespace: fqn, handlerFound });
    } catch {
      // Skip
    }
  }

  return messages;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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
  } catch {
    // Skip
  }
  return files;
}

function detectTransportType(dsn: string): string {
  if (!dsn) return 'unknown';
  if (dsn.startsWith('amqp://') || dsn.startsWith('amqps://')) return 'AMQP/RabbitMQ';
  if (dsn.startsWith('redis://') || dsn.startsWith('rediss://')) return 'Redis';
  if (dsn.startsWith('doctrine://') || dsn.startsWith('sync://')) return dsn.split('://')[0];
  if (dsn.startsWith('sqs://')) return 'SQS';
  if (dsn.startsWith('beanstalkd://')) return 'Beanstalkd';
  if (dsn.startsWith('kafka://')) return 'Kafka';
  if (dsn.startsWith('in-memory://')) return 'In-Memory';
  if (dsn.startsWith('null://')) return 'Null (disabled)';
  return dsn.split('://')[0] ?? 'custom';
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listMessengerTransports(appPath: string): McpToolResult {
  try {
    const config = parseMessengerConfig(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'Symfony Messenger is not configured.\n\nExpected: config/packages/messenger.yaml\n\nInstall with: composer require symfony/messenger',
        }],
      };
    }

    if (config.transports.length === 0) {
      return {
        content: [{ type: 'text', text: 'No transports configured in messenger.yaml.' }],
      };
    }

    let text = `Messenger Transports (${config.transports.length}):\n${'─'.repeat(60)}\n`;
    for (const t of config.transports) {
      const type = detectTransportType(t.dsn);
      text += `\n  ${t.name}\n`;
      text += `    Type:   ${type}\n`;
      text += `    DSN:    ${t.dsnDisplay}\n`;
      if (t.failureTransport) {
        text += `    Fails → ${t.failureTransport}\n`;
      }
      if (Object.keys(t.options).length > 0) {
        text += `    Options: ${Object.entries(t.options).map(([k, v]) => `${k}=${v}`).join(', ')}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading messenger config: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listMessengerRouting(appPath: string): McpToolResult {
  try {
    const config = parseMessengerConfig(appPath);

    if (!config) {
      return {
        content: [{ type: 'text', text: 'Symfony Messenger is not configured (config/packages/messenger.yaml not found).' }],
      };
    }

    if (config.routing.length === 0) {
      return {
        content: [{ type: 'text', text: 'No routing rules configured. Messages will use the default transport.' }],
      };
    }

    let text = `Messenger Routing Rules (${config.routing.length}):\n${'─'.repeat(60)}\n\n`;
    text += 'Message Class                                  → Transport(s)\n';
    text += '─'.repeat(70) + '\n';

    for (const rule of config.routing) {
      const msgClass = rule.messageClass.length > 45
        ? '...' + rule.messageClass.slice(-42)
        : rule.messageClass;
      text += `  ${msgClass.padEnd(45)}  → ${rule.transports.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading messenger routing: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listMessageClasses(appPath: string): McpToolResult {
  try {
    const messages = scanMessageClasses(appPath);

    if (messages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No message classes found in src/Message/.\n\nCreate messages with: php bin/console make:message',
        }],
      };
    }

    let text = `Messenger Message Classes (${messages.length}):\n${'─'.repeat(60)}\n\n`;
    for (const msg of messages) {
      const handlerStatus = msg.handlerFound ? '✓ handler found' : '⚠ no handler detected';
      text += `  ${msg.name}  [${handlerStatus}]\n`;
      text += `    Namespace: ${msg.namespace}\n`;
      text += `    File:      ${msg.file}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error scanning message classes: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerInfo(appPath: string): McpToolResult {
  try {
    const config = parseMessengerConfig(appPath);
    const messages = scanMessageClasses(appPath);

    if (!config) {
      return {
        content: [{
          type: 'text',
          text: `Symfony Messenger Summary\n${'='.repeat(40)}\nStatus: Not configured\n\nInstall: composer require symfony/messenger\nDocs: https://symfony.com/doc/current/messenger.html`,
        }],
      };
    }

    const messagesWithHandler = messages.filter((m) => m.handlerFound).length;

    let text = `Symfony Messenger Summary\n${'='.repeat(40)}\n\n`;
    text += `Buses:           ${config.buses.join(', ')}\n`;
    text += `Transports:      ${config.transports.length}\n`;
    text += `Routing rules:   ${config.routing.length}\n`;
    text += `Message classes: ${messages.length} (${messagesWithHandler} with handlers)\n`;

    if (config.transports.length > 0) {
      text += `\nTransports:\n`;
      for (const t of config.transports) {
        text += `  - ${t.name} (${detectTransportType(t.dsn)})\n`;
      }
    }

    if (config.buses.length > 0 && config.buses[0] !== 'messenger.bus.default') {
      text += `\nCustom Buses:\n`;
      for (const bus of config.buses) {
        text += `  - ${bus}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading messenger info: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getMessengerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'get_messenger_info',
      description: 'Get Symfony Messenger overview: buses, transports, routing rules count, and message class summary',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_messenger_transports',
      description: 'List all Symfony Messenger transport configurations (AMQP, Redis, Doctrine, SQS, etc.) with DSN and options',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_messenger_routing',
      description: 'Show Symfony Messenger routing rules — which message classes are sent to which transports',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_message_classes',
      description: 'List all message classes in src/Message/ and check whether a handler class exists for each',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
