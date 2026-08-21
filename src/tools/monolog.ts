/**
 * Monolog Deep Inspector
 *
 * Reads config/packages/monolog.yaml (and dev/prod/test overrides):
 *   - Handlers: type, level, channel, formatter
 *   - Channels: custom channel definitions
 *   - Processors: registered log processors
 *   - Fingers-crossed: action_level, passthru_level, handler
 *   - Alert handlers: email, Slack, Sentry, PagerDuty
 *
 * Pure static analysis.
 */

import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

interface MonologHandler {
  name: string;
  type: string;
  level?: string;
  channels?: string[];
  path?: string;
  url?: string;
  actionLevel?: string;
  handler?: string;
  isAlert: boolean;
  formatter?: string;
  maxFiles?: number;
}

interface MonologConfig {
  handlers: MonologHandler[];
  channels: string[];
  processors: string[];
}

// ─── Handler type classification ────────────────────────────────────────────

const ALERT_TYPES = new Set(['swift_mailer', 'native_mailer', 'symfony_mailer', 'slack', 'slackwebhook', 'telegram', 'sentry', 'rollbar', 'raygun', 'hipchat', 'pushover']);

function isAlertHandler(type: string): boolean {
  return ALERT_TYPES.has(type.toLowerCase());
}

const TYPE_LABELS: Record<string, string> = {
  stream:           'File (stream)',
  rotating_file:    'Rotating file',
  syslog:           'Syslog',
  fingers_crossed:  'Fingers-crossed (buffer)',
  filter:           'Filter (level range)',
  group:            'Group (fan-out)',
  redis:            'Redis',
  mongo:            'MongoDB',
  elasticsearch:    'Elasticsearch',
  gelf:             'GELF (Graylog)',
  logstash:         'Logstash',
  slack:            'Slack',
  slackwebhook:     'Slack Webhook',
  swift_mailer:     'Email (SwiftMailer)',
  native_mailer:    'Email (native)',
  symfony_mailer:   'Email (SymfonyMailer)',
  sentry:           'Sentry',
  rollbar:          'Rollbar',
  telegram:         'Telegram',
  console:          'Console output',
  null:             'Null (discard)',
  test:             'In-memory (test)',
  browser_console:  'Browser console',
  server_log:       'Symfony server log',
};

// ─── Config loading ─────────────────────────────────────────────────────────

function loadMonologFromFile(filePath: string): Partial<MonologConfig> {
  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return {};

  const monolog = (raw['monolog'] ?? raw) as Record<string, unknown>;
  const handlersRaw = monolog['handlers'] as Record<string, unknown> | undefined;
  const channelsRaw = monolog['channels'] as string[] | undefined;
  const processorsRaw = monolog['processors'] as string[] | undefined;

  const handlers: MonologHandler[] = [];

  if (handlersRaw) {
    for (const [name, def] of Object.entries(handlersRaw)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const type = String(d['type'] ?? 'stream');

      const channelsRawVal = d['channels'] as string | string[] | undefined;
      const channels: string[] = channelsRawVal
        ? (Array.isArray(channelsRawVal) ? channelsRawVal : [channelsRawVal])
        : [];

      const pathVal = d['path'] ?? d['url'];
      const maskedPath = pathVal
        ? String(pathVal).replace(/%[^%]+%/g, '%***%')
        : undefined;

      handlers.push({
        name,
        type,
        level: d['level'] ? String(d['level']).toLowerCase() : undefined,
        channels,
        path: maskedPath,
        actionLevel: d['action_level'] ? String(d['action_level']).toLowerCase() : undefined,
        handler: d['handler'] ? String(d['handler']) : undefined,
        isAlert: isAlertHandler(type),
        formatter: d['formatter'] ? String(d['formatter']) : undefined,
        maxFiles: d['max_files'] ? Number(d['max_files']) : undefined,
      });
    }
  }

  return {
    handlers,
    channels: channelsRaw ?? [],
    processors: processorsRaw ?? [],
  };
}

function loadMonologConfig(appPath: string): MonologConfig {
  const pkgDir = path.join(appPath, 'config', 'packages');
  const merged: MonologConfig = { handlers: [], channels: [], processors: [] };

  // Load base + per-env (prod override wins for display)
  const filesToTry = [
    path.join(pkgDir, 'monolog.yaml'),
    path.join(pkgDir, 'prod', 'monolog.yaml'),
    path.join(pkgDir, 'dev', 'monolog.yaml'),
  ];

  const seenHandlers = new Set<string>();

  for (const f of filesToTry) {
    const partial = loadMonologFromFile(f);
    if (partial.handlers) {
      for (const h of partial.handlers) {
        if (!seenHandlers.has(h.name)) {
          seenHandlers.add(h.name);
          merged.handlers.push(h);
        }
      }
    }
    if (partial.channels) merged.channels.push(...partial.channels.filter((c) => !merged.channels.includes(c)));
    if (partial.processors) merged.processors.push(...partial.processors.filter((p) => !merged.processors.includes(p)));
  }

  return merged;
}

// ─── Tool functions ─────────────────────────────────────────────────────────

const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

function levelIcon(level: string | undefined): string {
  if (!level) return '   ';
  const idx = LEVEL_ORDER.indexOf(level as LogLevel);
  if (idx >= 6) return '[!!]';
  if (idx >= 4) return '[!] ';
  if (idx >= 2) return '[~] ';
  return '    ';
}

export function listMonologConfig(appPath: string): McpToolResult {
  try {
    const config = loadMonologConfig(appPath);

    if (config.handlers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Monolog configuration found.\n\nMonolog is included in Symfony by default.\nCheck config/packages/monolog.yaml.',
        }],
      };
    }

    const alertHandlers = config.handlers.filter((h) => h.isAlert);
    const fingersCrossed = config.handlers.filter((h) => h.type === 'fingers_crossed');

    let text = `Monolog Configuration  (${config.handlers.length} handlers)\n${'='.repeat(60)}\n`;

    if (alertHandlers.length > 0) {
      text += `\nAlert handlers (${alertHandlers.length}) — notify on errors:\n`;
      for (const h of alertHandlers) {
        text += `  ${h.name.padEnd(25)} ${TYPE_LABELS[h.type] ?? h.type}\n`;
      }
    }

    if (fingersCrossed.length > 0) {
      text += `\nFingers-crossed handlers (${fingersCrossed.length}) — buffer until threshold:\n`;
      for (const h of fingersCrossed) {
        text += `  ${h.name.padEnd(25)} action_level: ${h.actionLevel ?? '?'}  →  ${h.handler ?? '?'}\n`;
      }
    }

    text += `\nAll handlers:\n`;
    text += `  ${'Name'.padEnd(25)} ${'Type'.padEnd(22)} Level   Channels\n`;
    text += `  ${'-'.repeat(75)}\n`;
    for (const h of config.handlers) {
      const icon = levelIcon(h.level ?? h.actionLevel);
      const level = (h.level ?? h.actionLevel ?? '-').padEnd(10);
      const type = (TYPE_LABELS[h.type] ?? h.type).padEnd(22);
      const chans = (h.channels?.length ?? 0) > 0 ? h.channels!.join(', ') : 'all';
      text += `  ${h.name.padEnd(25)} ${type} ${icon}${level} ${chans}\n`;
      if (h.path) text += `    path: ${h.path}\n`;
      if (h.maxFiles) text += `    max_files: ${h.maxFiles}\n`;
    }

    if (config.channels.length > 0) {
      text += `\nCustom channels: ${config.channels.join(', ')}\n`;
    }
    if (config.processors.length > 0) {
      text += `\nProcessors: ${config.processors.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMonologStats(appPath: string): McpToolResult {
  try {
    const config = loadMonologConfig(appPath);

    let text = `Monolog Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total handlers:      ${config.handlers.length}\n`;
    text += `Alert handlers:      ${config.handlers.filter((h) => h.isAlert).length}\n`;
    text += `Fingers-crossed:     ${config.handlers.filter((h) => h.type === 'fingers_crossed').length}\n`;
    text += `File/stream:         ${config.handlers.filter((h) => ['stream', 'rotating_file'].includes(h.type)).length}\n`;
    text += `Custom channels:     ${config.channels.length}\n`;
    text += `Processors:          ${config.processors.length}\n`;

    const types = new Set(config.handlers.map((h) => h.type));
    text += `\nHandler types: ${[...types].join(', ')}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getMonologTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_monolog_config',
      description: 'Show Monolog handlers (type, level, channels, path), alert handlers (Slack/email/Sentry), fingers-crossed buffers, custom channels and processors',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_monolog_stats',
      description: 'Show Monolog statistics: handler count by category (alert, file, fingers-crossed), custom channels, processors',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
