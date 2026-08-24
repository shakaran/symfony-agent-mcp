// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface ChannelMapping {
  channel: string;
  handlers: string[];
  excludedFromHandlers: string[];
  issues: string[];
}

function loadChannelMappings(appPath: string): ChannelMapping[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml'),
  ];
  const channelMap = new Map<string, { handlers: Set<string>; excluded: Set<string> }>();
  const handlerDefs: Record<string, Record<string, unknown>> = {};
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const monolog = (raw['monolog'] ?? raw) as Record<string, unknown>;
    const handlers = (monolog['handlers'] ?? {}) as Record<string, unknown>;
    const channels = (monolog['channels'] ?? []) as string[];
    for (const ch of channels) {
      if (!channelMap.has(ch)) channelMap.set(ch, { handlers: new Set(), excluded: new Set() });
    }
    for (const [handlerName, def] of Object.entries(handlers)) {
      const d = (def ?? {}) as Record<string, unknown>;
      handlerDefs[handlerName] = d;
      const chanConf = d['channels'];
      if (!chanConf) continue;
      if (Array.isArray(chanConf)) {
        for (const ch of chanConf) {
          const chStr = String(ch);
          const isExclude = chStr.startsWith('!');
          const chName = isExclude ? chStr.slice(1) : chStr;
          if (!channelMap.has(chName)) channelMap.set(chName, { handlers: new Set(), excluded: new Set() });
          if (isExclude) channelMap.get(chName)!.excluded.add(handlerName);
          else channelMap.get(chName)!.handlers.add(handlerName);
        }
      }
    }
  }
  const results: ChannelMapping[] = [];
  for (const [channel, info] of channelMap.entries()) {
    const issues: string[] = [];
    if (info.handlers.size === 0 && info.excluded.size === 0) issues.push(`Channel "${channel}" has no explicit handler routing — uses all default handlers`);
    if (info.handlers.size > 3) issues.push(`Channel "${channel}" routes to ${info.handlers.size} handlers — many handlers may impact performance`);
    results.push({ channel, handlers: [...info.handlers], excludedFromHandlers: [...info.excluded], issues });
  }
  return results.sort((a, b) => b.handlers.length - a.handlers.length);
}

export function listMonologChannelMapping(appPath: string): McpToolResult {
  try {
    const mappings = loadChannelMappings(appPath);
    if (mappings.length === 0) return { content: [{ type: 'text', text: 'No custom Monolog channel routing found.\n\nExample:\n  monolog:\n    channels: [app, security, doctrine]\n    handlers:\n      security_log:\n        channels: [security]\n        path: "%kernel.logs_dir%/security.log"' }] };
    const totalIssues = mappings.reduce((s, m) => s + m.issues.length, 0);
    let text = `Monolog Channel Mapping\n${'='.repeat(55)}\n\nChannels: ${mappings.length}  Issues: ${totalIssues}\n`;
    for (const m of mappings.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${m.channel}\n`;
      if (m.handlers.length > 0) text += `    handlers: ${m.handlers.join(', ')}\n`;
      if (m.excludedFromHandlers.length > 0) text += `    excluded from: ${m.excludedFromHandlers.join(', ')}\n`;
      for (const i of m.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMonologChannelStats(appPath: string): McpToolResult {
  try {
    const mappings = loadChannelMappings(appPath);
    let text = `Monolog Channel Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom channels: ${mappings.length}\nChannels with explicit routing: ${mappings.filter(m => m.handlers.length > 0).length}\nChannels with exclusions: ${mappings.filter(m => m.excludedFromHandlers.length > 0).length}\nIssues: ${mappings.reduce((s, m) => s + m.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMonologChannelTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_monolog_channel_mapping', description: 'Show Monolog channel-to-handler routing: channel definitions, handler inclusions/exclusions, channels with no explicit routing, too-many-handlers warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_monolog_channel_stats', description: 'Monolog channel statistics: channel count, explicitly-routed count, excluded count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
