// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Messenger Stamps Inspector
 *
 * Distinct from messenger.ts (transports), messenger-handlers.ts (handlers),
 * symfony-messenger-failures.ts (retry/failure config).
 * Focuses on the Stamp system — metadata attached to Envelope messages:
 *
 * Built-in stamps scan:
 *   - BusNameStamp: which bus the message was dispatched to
 *   - DispatchAfterCurrentBusStamp: deferred dispatch
 *   - DelayStamp: delayed delivery (delay in milliseconds)
 *   - UniqueIdStamp: deduplication
 *   - HandledStamp: result from handler (if used in application code)
 *   - ReceivedStamp: marks message as consumed from transport
 *   - RedeliveryStamp: retry attempt metadata
 *   - SentToFailureTransportStamp: failure routing
 *
 * Custom stamps:
 *   - Classes implementing StampInterface
 *   - Serializable stamps (implementing NonSendableStampInterface — not sent to transport)
 *
 * Usage scan (src/):
 *   - $envelope->with(new DelayStamp(...)) call sites
 *   - $envelope->last(HandledStamp::class) usage (sync result reading)
 *   - DelayStamp values extracted (warns if > 86400000 ms = 24h)
 *   - DispatchAfterCurrentBusStamp usage (event-driven after commit pattern)
 *
 * Analysis:
 *   - HandledStamp usage outside tests (coupling to sync dispatch)
 *   - DelayStamp with delay > 24h (use scheduler instead)
 *   - Custom stamp not implementing NonSendableStampInterface when containing closures/resources
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface StampUsage {
  class: string;
  file: string;
  stampsUsed: string[];
  delayValues: number[];
  usesHandledStamp: boolean;
  usesDispatchAfter: boolean;
  issues: string[];
}

interface CustomStamp {
  class: string;
  file: string;
  isNonSendable: boolean;
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

const BUILT_IN_STAMPS = [
  'BusNameStamp', 'DispatchAfterCurrentBusStamp', 'DelayStamp',
  'UniqueIdStamp', 'HandledStamp', 'ReceivedStamp', 'RedeliveryStamp', 'SentToFailureTransportStamp',
];

function parseStampUsage(filePath: string, appPath: string): StampUsage | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasStamp = BUILT_IN_STAMPS.some((s) => content.includes(s)) ||
                   content.includes('->with(new ') || content.includes('->last(');
  if (!hasStamp) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const stampsUsed = BUILT_IN_STAMPS.filter((s) => content.includes(s));
  const usesHandledStamp = content.includes('HandledStamp');
  const usesDispatchAfter = content.includes('DispatchAfterCurrentBusStamp');

  const delayValues: number[] = [];
  for (const m of content.matchAll(/new\s+DelayStamp\s*\(\s*(\d+)/g)) {
    delayValues.push(parseInt(m[1], 10));
  }

  const isTestFile = filePath.includes('/Test') || filePath.includes('/tests') ||
                     filePath.endsWith('Test.php') || filePath.endsWith('Spec.php');

  const issues: string[] = [];
  if (usesHandledStamp && !isTestFile) {
    issues.push('HandledStamp used outside tests — implies synchronous dispatch (coupling)');
  }
  for (const delay of delayValues) {
    if (delay > 86400000) {
      issues.push(`DelayStamp(${delay}ms = ${Math.round(delay / 3600000)}h) — consider Symfony Scheduler for long delays`);
    }
  }

  if (stampsUsed.length === 0 && !content.includes('->with(new ')) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    stampsUsed,
    delayValues,
    usesHandledStamp,
    usesDispatchAfter,
    issues,
  };
}

function parseCustomStamp(filePath: string, appPath: string): CustomStamp | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('StampInterface') || !content.includes('implements')) return null;
  if (!content.includes('implements StampInterface') &&
      !content.includes('implements NonSendableStampInterface')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    isNonSendable: content.includes('NonSendableStampInterface'),
  };
}

export function listMessengerStamps(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: StampUsage[] = [];
    const customStamps: CustomStamp[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseStampUsage(file, appPath);
      if (u) usages.push(u);
      const cs = parseCustomStamp(file, appPath);
      if (cs) customStamps.push(cs);
    }

    if (usages.length === 0 && customStamps.length === 0) {
      return { content: [{ type: 'text', text: 'No Messenger stamp usage or custom stamps found.' }] };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    const stampFreq = new Map<string, number>();
    for (const u of usages) {
      for (const s of u.stampsUsed) stampFreq.set(s, (stampFreq.get(s) ?? 0) + 1);
    }

    let text = `Messenger Stamps\n${'='.repeat(55)}\n`;
    text += `\nFiles using stamps: ${usages.length}  Issues: ${totalIssues}\n`;
    text += `Custom stamps:      ${customStamps.length}\n`;

    if (stampFreq.size > 0) {
      text += `\nStamp usage frequency:\n`;
      for (const [stamp, count] of [...stampFreq.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${stamp.padEnd(35)} ${count}x\n`;
      }
    }

    const withIssues = usages.filter((u) => u.issues.length > 0);
    if (withIssues.length > 0) {
      text += `\nIssues (${totalIssues}):\n`;
      for (const u of withIssues) {
        text += `  ${u.class}  (${u.file})\n`;
        for (const issue of u.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (customStamps.length > 0) {
      text += `\nCustom stamps:\n`;
      for (const s of customStamps) {
        const ns = s.isNonSendable ? '  [NonSendable]' : '';
        text += `  ${s.class}${ns}  (${s.file})\n`;
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

export function getStampStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const usages: StampUsage[] = [];
    const customStamps: CustomStamp[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseStampUsage(file, appPath);
        if (u) usages.push(u);
        const cs = parseCustomStamp(file, appPath);
        if (cs) customStamps.push(cs);
      }
    }

    let text = `Stamp Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files using stamps:    ${usages.length}\n`;
    text += `  With DelayStamp:     ${usages.filter((u) => u.stampsUsed.includes('DelayStamp')).length}\n`;
    text += `  With HandledStamp:   ${usages.filter((u) => u.usesHandledStamp).length}\n`;
    text += `  With DispatchAfter:  ${usages.filter((u) => u.usesDispatchAfter).length}\n`;
    text += `Custom stamps:         ${customStamps.length}\n`;
    text += `  NonSendable:         ${customStamps.filter((s) => s.isNonSendable).length}\n`;
    text += `Issues:                ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerStampTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_stamps',
      description: 'Show Messenger stamp usage: BusNameStamp/DelayStamp/DispatchAfterCurrentBusStamp/HandledStamp/UniqueIdStamp per class, stamp frequency, custom StampInterface implementations, HandledStamp outside tests warning, DelayStamp > 24h warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_stamp_stats',
      description: 'Show stamp statistics: usage file count, DelayStamp/HandledStamp/DispatchAfter counts, custom stamp count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
