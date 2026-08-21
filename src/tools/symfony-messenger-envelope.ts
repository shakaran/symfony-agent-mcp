/**
 * Symfony Messenger Envelope Inspector
 *
 * Scans src/ PHP for:
 *   - Envelope::wrap(, new Envelope(, $envelope->with(
 *   - $envelope->last(, $envelope->withoutAll(, $envelope->withoutStampsOfType(
 *   - Stamp usage: HandledStamp, DelayStamp, ReceivedStamp, ValidationStamp,
 *     SentToFailureTransportStamp, BusNameStamp
 *
 * Warns about:
 *   - Middleware calling $envelope->last(HandledStamp::class) without null check
 *   - DelayStamp with very long delay (>86400s)
 *   - envelope->withoutAll(DelayStamp::class) in retry logic (loses delay context)
 *   - Custom stamp not implementing StampInterface
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface EnvelopeInfo {
  file: string;
  class: string;
  stamps: string[];
  hasNullCheck: boolean;
  hasDelayStamp: boolean;
  delaySeconds?: number;
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

const KNOWN_STAMPS = [
  'HandledStamp',
  'DelayStamp',
  'ReceivedStamp',
  'ValidationStamp',
  'SentToFailureTransportStamp',
  'BusNameStamp',
  'RedeliveryStamp',
  'ErrorDetailsStamp',
  'TransportMessageIdStamp',
];

function extractDelaySeconds(content: string): number | undefined {
  const m = /new\s+DelayStamp\s*\(\s*(\d{1,8})\s*\)/.exec(content);
  return m ? parseInt(m[1], 10) : undefined;
}

function hasNullCheckAfterLast(content: string): boolean {
  // Look for ->last(HandledStamp::class) followed by null check within 200 chars
  const pattern = /->last\s*\(\s*HandledStamp::class\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const snippet = content.slice(match.index, match.index + 200);
    if (/null|===\s*null|\?\s*->|if\s*\(/.test(snippet)) return true;
  }
  return false;
}

function isCustomStamp(content: string, className: string): boolean {
  // Heuristic: class ends with Stamp but is not a known one
  return (
    className.endsWith('Stamp') &&
    !KNOWN_STAMPS.includes(className) &&
    !content.includes('StampInterface') &&
    !content.includes('implements')
  );
}

function scanEnvelopes(appPath: string): EnvelopeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: EnvelopeInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const hasEnvelope =
      content.includes('Envelope::wrap(') ||
      content.includes('new Envelope(') ||
      content.includes('->with(') ||
      content.includes('->last(') ||
      content.includes('->withoutAll(') ||
      content.includes('->withoutStampsOfType(');

    const usedStamps = KNOWN_STAMPS.filter((s) => content.includes(s));

    if (!hasEnvelope && usedStamps.length === 0) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasDelayStamp = usedStamps.includes('DelayStamp');
    const delaySeconds = hasDelayStamp ? extractDelaySeconds(content) : undefined;
    const hasNullCheck = content.includes('->last(') ? hasNullCheckAfterLast(content) : true;

    const issues: string[] = [];

    if (content.includes('->last(HandledStamp::class)') && !hasNullCheck) {
      issues.push('$envelope->last(HandledStamp::class) without null check — throws if message was not handled');
    }
    if (hasDelayStamp && delaySeconds !== undefined && delaySeconds > 86400) {
      issues.push(`DelayStamp with ${delaySeconds}s delay (${Math.round(delaySeconds / 3600)}h) — very long delay; consider a scheduler instead`);
    }
    if (content.includes('->withoutAll(DelayStamp::class)') && content.includes('retry')) {
      issues.push('withoutAll(DelayStamp::class) in retry logic — loses original delay context');
    }
    if (isCustomStamp(content, className)) {
      issues.push(`Class "${className}" looks like a custom stamp but does not implement StampInterface`);
    }

    results.push({ file, class: className, stamps: usedStamps, hasNullCheck, hasDelayStamp, delaySeconds, issues });
  }

  return results;
}

export function listMessengerEnvelopes(appPath: string): McpToolResult {
  try {
    const infos = scanEnvelopes(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Envelope or stamp usage found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Envelope & Stamp Usage\n${'='.repeat(55)}\n\n`;
    text += `Total classes: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  (${path.relative(appPath, info.file)})\n`;
      if (info.stamps.length > 0) text += `    stamps: ${info.stamps.join(', ')}\n`;
      if (info.hasDelayStamp && info.delaySeconds !== undefined) {
        text += `    delay: ${info.delaySeconds}s\n`;
      }
      text += `    nullCheck: ${info.hasNullCheck ? 'yes' : 'no'}\n`;
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

export function getMessengerEnvelopeStats(appPath: string): McpToolResult {
  try {
    const infos = scanEnvelopes(appPath);

    let text = `Messenger Envelope Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes with envelope/stamp usage: ${infos.length}\n`;
    text += `  With DelayStamp:                       ${infos.filter((i) => i.hasDelayStamp).length}\n`;
    text += `  With HandledStamp:                     ${infos.filter((i) => i.stamps.includes('HandledStamp')).length}\n`;
    text += `  With SentToFailureTransport:           ${infos.filter((i) => i.stamps.includes('SentToFailureTransportStamp')).length}\n`;
    text += `  Missing null check on ->last():        ${infos.filter((i) => !i.hasNullCheck).length}\n`;
    text += `  Long delay (>86400s):                  ${infos.filter((i) => i.delaySeconds !== undefined && i.delaySeconds > 86400).length}\n`;
    text += `Total issues:                            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getMessengerEnvelopeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_messenger_envelopes',
      description: 'Scan src/ for Messenger Envelope usage: stamp detection (HandledStamp, DelayStamp, ReceivedStamp, BusNameStamp, etc.), ->last() null checks, withoutAll() in retry logic, custom stamps without StampInterface, long delays',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_messenger_envelope_stats',
      description: 'Statistics for Messenger envelope/stamp usage: class count, stamp type counts, null-check coverage, long-delay count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
