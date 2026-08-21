/**
 * Symfony Server-Sent Events (SSE) Inspector
 *
 * Detects Symfony Server-Sent Events (EventStreamResponse, StreamedResponse for SSE).
 * Scans src/ PHP for: EventStreamResponse, new EventStream(), StreamedResponse for
 *   text/event-stream, Content-Type: text/event-stream, echo "data: ".
 *
 * Checks composer.json for symfony/mercure (SSE might use Mercure instead).
 *
 * Warns on:
 *   - SSE response without Content-Type: text/event-stream header
 *   - SSE callback not setting ob_implicit_flush(true)
 *   - SSE without keep-alive/ping mechanism (clients disconnect after timeout)
 *   - SSE without Last-Event-ID handling (reconnect loses position)
 *   - SSE used without checking Mercure alternative
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type SseType = 'event-stream-response' | 'streamed' | 'raw';

interface SseInfo {
  file: string;
  className: string;
  sseType: SseType;
  hasContentType: boolean;
  hasKeepalive: boolean;
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

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function hasMercurePackage(appPath: string): boolean {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    return 'symfony/mercure' in req || 'symfony/mercure-bundle' in req;
  } catch { return false; }
}

function parseSseFile(filePath: string): SseInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isSse =
    content.includes('EventStreamResponse') ||
    content.includes('text/event-stream') ||
    (content.includes('StreamedResponse') && (content.includes('data: ') || content.includes("'data: '"))) ||
    (content.includes('echo "data:') || content.includes("echo 'data:"));

  if (!isSse) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const className = classM[1];
  const issues: string[] = [];

  let sseType: SseType = 'raw';
  if (content.includes('EventStreamResponse')) {
    sseType = 'event-stream-response';
  } else if (content.includes('StreamedResponse')) {
    sseType = 'streamed';
  }

  // Check Content-Type header
  const hasContentType =
    content.includes('text/event-stream') &&
    (content.includes('Content-Type') || content.includes('content-type') || content.includes('EventStreamResponse'));

  if (!hasContentType) {
    issues.push('SSE response does not set Content-Type: text/event-stream — browsers will not treat the response as an event stream');
  }

  // Check ob_implicit_flush
  if (sseType !== 'event-stream-response') {
    if (!content.includes('ob_implicit_flush') && !content.includes('flush()')) {
      issues.push('SSE callback does not call ob_implicit_flush(true) or flush() — events may be buffered and not sent to client in real time');
    }
  }

  // Check keep-alive / ping mechanism
  const hasKeepalive =
    content.includes('ping') ||
    content.includes('keepalive') ||
    content.includes('keep-alive') ||
    content.includes(': ping') ||
    content.includes("'comment'") ||
    content.includes(': comment') ||
    content.includes('retry:');

  if (!hasKeepalive) {
    issues.push('SSE implementation has no keep-alive/ping mechanism — clients will disconnect after proxy/server timeout (typically 30–120 s)');
  }

  // Check Last-Event-ID handling
  if (!content.includes('Last-Event-ID') && !content.includes('lastEventId') && !content.includes('last_event_id')) {
    issues.push('SSE implementation does not handle Last-Event-ID header — client reconnects after disconnect will lose their position in the event stream');
  }

  return { file: filePath, className, sseType, hasContentType, hasKeepalive, issues };
}

function loadSseInfos(appPath: string): SseInfo[] {
  const results: SseInfo[] = [];
  const dirs = [
    path.join(appPath, 'src'),
    path.join(appPath, 'templates'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const phpFiles = getAllPhpFiles(dir);
    const twigFiles = getAllTwigFiles(dir);
    for (const f of [...phpFiles, ...twigFiles]) {
      const r = parseSseFile(f);
      if (r) {
        r.file = path.relative(appPath, r.file);
        results.push(r);
      }
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonyServerSentEvents(appPath: string): McpToolResult {
  try {
    const infos = loadSseInfos(appPath);
    const hasMercure = hasMercurePackage(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No Server-Sent Events implementations found.\n` +
            `Mercure bundle: ${hasMercure ? 'installed (consider using Mercure for SSE)' : 'not found'}`,
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Server-Sent Events Inspector (${infos.length} usages)\n${'='.repeat(58)}\n`;
    text += `Mercure alternative available: ${hasMercure ? 'yes' : 'no'}\n`;
    text += `Issues: ${totalIssues}\n`;

    if (hasMercure && infos.length > 0) {
      text += `WARN: symfony/mercure is installed — consider using Mercure Hub instead of raw SSE for scalability and reconnect support\n`;
    }

    for (const info of infos) {
      text += `\n  ${info.file}  [${info.className}]\n`;
      text += `    type: ${info.sseType}  content-type: ${info.hasContentType ? 'ok' : 'MISSING'}  keepalive: ${info.hasKeepalive ? 'ok' : 'MISSING'}\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyServerSentEventStats(appPath: string): McpToolResult {
  try {
    const infos = loadSseInfos(appPath);
    const hasMercure = hasMercurePackage(appPath);

    let text = `Server-Sent Events Statistics\n${'='.repeat(40)}\n\n`;
    text += `SSE implementations:              ${infos.length}\n`;
    text += `  EventStreamResponse:            ${infos.filter((i) => i.sseType === 'event-stream-response').length}\n`;
    text += `  StreamedResponse:               ${infos.filter((i) => i.sseType === 'streamed').length}\n`;
    text += `  Raw echo:                       ${infos.filter((i) => i.sseType === 'raw').length}\n`;
    text += `  With correct Content-Type:      ${infos.filter((i) => i.hasContentType).length}\n`;
    text += `  With keep-alive/ping:           ${infos.filter((i) => i.hasKeepalive).length}\n`;
    text += `Mercure alternative installed:    ${hasMercure ? 'yes' : 'no'}\n`;
    text += `Issues:                           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getServerSentEventTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_server_sent_events',
      description: 'List Symfony Server-Sent Events (SSE) implementations: detects EventStreamResponse, StreamedResponse, raw echo for text/event-stream; warns on missing Content-Type header, missing ob_implicit_flush, no keep-alive/ping, no Last-Event-ID handling, Mercure alternative available',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_server_sent_event_stats',
      description: 'Show SSE statistics: total implementations by type, Content-Type and keep-alive coverage, Mercure package presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
