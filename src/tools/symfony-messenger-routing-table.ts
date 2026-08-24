// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Messenger Routing Table Inspector
 *
 * Scans config/packages/messenger.yaml (and dev/prod variants):
 *   - Parses routing: section — message class → transport mapping
 *   - Parses transports: section — defined transport names
 *   - Cross-checks routing entries pointing to undefined transports
 *   - Detects wildcard routing ('*':) — flags if used
 *   - Scans src/ PHP files for message classes (MessageInterface, #[AsMessage],
 *     dispatch(new XxxMessage) usages) and flags those with no routing entry
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface MessengerRoutingEntry {
  messageClass: string;
  transport: string | null;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
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
  } catch { /* skip */ }
  return files;
}

function extractTransportNames(content: string): string[] {
  const names: string[] = [];
  const transportsBlock = /^[ \t]*transports:\s*\n([\s\S]*?)(?=^[^\s#]|(?![\s\S]))/m.exec(content);
  if (!transportsBlock) return names;
  const block = transportsBlock[1];
  const nameRe = /^[ \t]{4,8}(\S[^:\n]{0,120}):/gm;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(block)) !== null) {
    const candidate = m[1].trim();
    if (candidate && !candidate.startsWith('#')) names.push(candidate);
  }
  return names;
}

function extractRoutingEntries(content: string): Array<{ messageClass: string; transports: string[] }> {
  const entries: Array<{ messageClass: string; transports: string[] }> = [];
  const routingBlock = /^[ \t]*routing:\s*\n([\s\S]*?)(?=^[^\s#]|(?![\s\S]))/m.exec(content);
  if (!routingBlock) return entries;
  const block = routingBlock[1];

  // Each routing entry: "    'App\Message\Foo': async" or with array transport list
  const entryRe = /^[ \t]{4,8}['"]([\w\\*]{1,200})['"]:\s*([^\n]{0,300})/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block)) !== null) {
    const msgClass = m[1].trim();
    const rawTransport = m[2].trim();
    // Could be: "async", "[async, failed]", "- async"
    const transports: string[] = [];
    if (rawTransport.startsWith('[')) {
      const inner = rawTransport.replace(/[[\]]/g, '');
      for (const t of inner.split(',')) {
        const clean = t.trim().replace(/['"]/g, '');
        if (clean) transports.push(clean);
      }
    } else if (rawTransport.startsWith('-')) {
      const clean = rawTransport.replace(/^-\s*/, '').replace(/['"]/g, '').trim();
      if (clean) transports.push(clean);
    } else if (rawTransport) {
      transports.push(rawTransport.replace(/['"]/g, ''));
    }
    entries.push({ messageClass: msgClass, transports });
  }
  return entries;
}

function loadAllMessengerYamls(appPath: string): string {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'messenger.yaml'),
  ];
  const parts: string[] = [];
  for (const candidate of candidates) {
    const content = safeRead(candidate, appPath);
    if (content) parts.push(content);
  }
  return parts.join('\n');
}

function findMessageClassesInSrc(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const classes: string[] = [];

  for (const filePath of getAllPhpFiles(srcDir)) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const hasMessageInterface = /implements\s+[^{]{0,200}MessageInterface/.test(content);
    const hasAsMessage = /#\[AsMessage/.test(content);
    if (!hasMessageInterface && !hasAsMessage) continue;

    const nsM = /namespace\s+([\w\\]{1,200});/.exec(content);
    const classM = /class\s+(\w{1,120})/.exec(content);
    if (!classM) continue;
    const fqn = nsM ? `${nsM[1]}\\${classM[1]}` : classM[1];
    classes.push(fqn);
  }
  return classes;
}

function findDispatchedMessageClasses(appPath: string): string[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const dispatched: string[] = [];
  const dispatchRe = /\$[a-zA-Z_][a-zA-Z0-9_]{0,60}->dispatch\(\s*new\s+([\w\\]{1,200})\s*[,(]/g;

  for (const filePath of getAllPhpFiles(srcDir)) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    if (!content.includes('->dispatch(')) continue;

    let m: RegExpExecArray | null;
    dispatchRe.lastIndex = 0;
    while ((m = dispatchRe.exec(content)) !== null) {
      const rawClass = m[1].trim();
      if (rawClass && !dispatched.includes(rawClass)) dispatched.push(rawClass);
    }
  }
  return dispatched;
}

function buildRoutingEntries(appPath: string): {
  entries: MessengerRoutingEntry[];
  transportNames: string[];
  hasWildcard: boolean;
  yamlFound: boolean;
} {
  const combinedYaml = loadAllMessengerYamls(appPath);
  if (!combinedYaml) {
    return { entries: [], transportNames: [], hasWildcard: false, yamlFound: false };
  }

  const transportNames = extractTransportNames(combinedYaml);
  const routingRaw = extractRoutingEntries(combinedYaml);
  const hasWildcard = routingRaw.some((r) => r.messageClass === '*');

  const entries: MessengerRoutingEntry[] = [];

  for (const r of routingRaw) {
    const undefinedTransports = r.transports.filter(
      (t) => transportNames.length > 0 && !transportNames.includes(t)
    );
    let issue: string | null = null;
    if (r.messageClass === '*') {
      issue = 'Wildcard routing (*) catches all messages — may hide misconfigured or unrouted message classes';
    } else if (undefinedTransports.length > 0) {
      issue = `Transport(s) not defined in transports: section: ${undefinedTransports.join(', ')}`;
    }
    entries.push({
      messageClass: r.messageClass,
      transport: r.transports.join(', ') || null,
      issue,
    });
  }

  // Find message classes from PHP source not covered by routing
  const routedClasses = new Set(routingRaw.map((r) => r.messageClass));
  const msgClasses = findMessageClassesInSrc(appPath);
  const dispatchedClasses = findDispatchedMessageClasses(appPath);

  const allSourceClasses = [...new Set([...msgClasses, ...dispatchedClasses])];

  for (const cls of allSourceClasses) {
    const shortName = cls.includes('\\') ? (cls.split('\\').pop() ?? cls) : cls;
    const isRouted =
      routedClasses.has(cls) ||
      routedClasses.has(shortName) ||
      [...routedClasses].some((rc) => rc === '*' || cls.endsWith(`\\${rc}`) || rc.endsWith(`\\${shortName}`));

    if (!isRouted) {
      entries.push({
        messageClass: cls,
        transport: null,
        issue: hasWildcard
          ? 'No explicit routing entry — covered only by wildcard (*) routing'
          : 'No routing entry found — message may be dispatched synchronously or is misconfigured',
      });
    }
  }

  return { entries, transportNames, hasWildcard, yamlFound: true };
}

export function listSymfonyMessengerRoutingTable(appPath: string): McpToolResult {
  try {
    const { entries, transportNames, hasWildcard, yamlFound } = buildRoutingEntries(appPath);

    if (!yamlFound) {
      return { content: [{ type: 'text', text: 'No messenger.yaml found in config/packages/ (including dev/ and prod/ subdirectories).' }] };
    }

    let text = `Symfony Messenger Routing Table\n${'='.repeat(55)}\n\n`;
    text += `Defined transports: ${transportNames.length > 0 ? transportNames.join(', ') : '(none)'}\n`;
    if (hasWildcard) text += `WARNING: Wildcard routing (*) is active — all unrouted messages fall through\n`;
    text += `\nRouting entries: ${entries.filter((e) => !e.issue?.includes('No routing entry') && !e.issue?.includes('No explicit routing')).length}\n`;
    text += `Source message classes with issues: ${entries.filter((e) => e.issue !== null).length}\n\n`;

    const withIssues = entries.filter((e) => e.issue !== null);
    const clean = entries.filter((e) => e.issue === null);

    if (clean.length > 0) {
      text += `Correctly routed messages (${clean.length}):\n`;
      for (const e of clean) {
        text += `  ${e.messageClass.padEnd(60)} -> ${e.transport ?? '(sync)'}\n`;
      }
      text += '\n';
    }

    if (withIssues.length > 0) {
      text += `Issues (${withIssues.length}):\n`;
      for (const e of withIssues) {
        text += `  ${e.messageClass}\n`;
        if (e.transport) text += `    Transport: ${e.transport}\n`;
        text += `    Issue: ${e.issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerRoutingTableStats(appPath: string): McpToolResult {
  try {
    const { entries, transportNames, hasWildcard, yamlFound } = buildRoutingEntries(appPath);

    let text = `Symfony Messenger Routing Table Statistics\n${'='.repeat(50)}\n\n`;

    if (!yamlFound) {
      text += 'messenger.yaml: not found\n';
      return { content: [{ type: 'text', text }] };
    }

    const totalRouted = entries.filter((e) => e.transport !== null && !e.issue?.includes('No routing') && !e.issue?.includes('No explicit')).length;
    const unrouted = entries.filter((e) => e.issue?.includes('No routing entry') || e.issue?.includes('No explicit routing')).length;
    const badTransport = entries.filter((e) => e.issue?.includes('Transport(s) not defined')).length;
    const wildcardEntries = entries.filter((e) => e.messageClass === '*').length;

    text += `Defined transports:       ${transportNames.length}\n`;
    text += `Routing entries:          ${entries.filter((e) => e.messageClass !== '*' && !e.issue?.includes('No routing') && !e.issue?.includes('No explicit')).length}\n`;
    text += `Correctly routed:         ${totalRouted}\n`;
    text += `Unrouted source classes:  ${unrouted}\n`;
    text += `Undefined transport refs: ${badTransport}\n`;
    text += `Wildcard routing active:  ${wildcardEntries > 0 ? 'YES (risk)' : 'no'}\n`;
    text += `Wildcard warning:         ${hasWildcard ? 'Wildcard (*) hides unrouted messages' : 'none'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerRoutingTableTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_messenger_routing_table',
      description: 'List Symfony Messenger routing table: message class → transport mappings, undefined transport references, wildcard routing detection, source message classes with no routing entry',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_messenger_routing_table_stats',
      description: 'Show Symfony Messenger routing table statistics: transport count, routing entry count, unrouted classes, undefined transport references, wildcard routing flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
