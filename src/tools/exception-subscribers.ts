import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ExceptionSubscriberInfo {
  file: string;
  class: string;
  handlesException: boolean;
  setsStatusCode: boolean;
  setsJsonResponse: boolean;
  catchesAll: boolean;
  catchesList: string[];
  hasPropagationStop: boolean;
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

function parseExceptionSubscriber(filePath: string, appPath: string): ExceptionSubscriberInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isExceptionHandler = content.includes('KernelEvents::EXCEPTION') || content.includes('kernel.exception') || content.includes('ExceptionEvent') || (content.includes('onKernelException') && content.includes('Event'));
  if (!isExceptionHandler) return null;
  if (content.includes('namespace Symfony\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const handlesException = content.includes('ExceptionEvent') || content.includes('getThrowable') || content.includes('getException');
  const setsStatusCode = content.includes('setStatusCode') || content.includes('setResponse') || content.includes('new Response');
  const setsJsonResponse = content.includes('JsonResponse') || content.includes('application/json');
  const catchesList: string[] = [];
  const catchRe = /instanceof\s+([\w\\]{1,120}Exception|[\w\\]{1,120}Error)/g;
  let m: RegExpExecArray | null;
  while ((m = catchRe.exec(content)) !== null) catchesList.push(m[1]);
  const catchesAll = content.includes('instanceof \\Throwable') || content.includes('instanceof Throwable');
  const hasPropagationStop = content.includes('stopPropagation');
  const issues: string[] = [];
  if (!setsStatusCode && !setsJsonResponse) issues.push('Exception subscriber does not set HTTP response — exception may bubble up to default error page');
  if (catchesAll && catchesList.length === 0) issues.push('Catches all Throwable without specific exception mapping — may hide unexpected errors');
  if (!handlesException) issues.push('Exception event listener does not call getThrowable()/getException() — cannot inspect exception type');
  return { file: path.relative(appPath, filePath), class: classM[1], handlesException, setsStatusCode, setsJsonResponse, catchesAll, catchesList, hasPropagationStop, issues };
}

export function listExceptionSubscribers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const subscribers: ExceptionSubscriberInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const s = parseExceptionSubscriber(f, appPath);
      if (s) subscribers.push(s);
    }
    if (subscribers.length === 0) return { content: [{ type: 'text', text: 'No KernelEvents::EXCEPTION subscribers found.' }] };
    const totalIssues = subscribers.reduce((s, sub) => s + sub.issues.length, 0);
    let text = `Exception Subscribers\n${'='.repeat(55)}\n\nSubscribers: ${subscribers.length}  Issues: ${totalIssues}\n`;
    for (const s of subscribers.sort((a, b) => b.issues.length - a.issues.length)) {
      const flags = [
        s.setsStatusCode ? '✓HTTP' : '',
        s.setsJsonResponse ? '✓JSON' : '',
        s.catchesAll ? '⚠catch-all' : '',
        s.hasPropagationStop ? 'stopPropagation' : '',
      ].filter(Boolean).join('  ');
      text += `\n  ${s.class}  ${flags}  (${s.file})\n`;
      if (s.catchesList.length > 0) text += `    catches: ${s.catchesList.join(', ')}\n`;
      for (const i of s.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getExceptionSubscriberStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const subscribers: ExceptionSubscriberInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const s = parseExceptionSubscriber(f, appPath);
        if (s) subscribers.push(s);
      }
    }
    let text = `Exception Subscriber Statistics\n${'='.repeat(40)}\n\n`;
    text += `Subscribers: ${subscribers.length}\n  Set HTTP status: ${subscribers.filter(s => s.setsStatusCode).length}\n  Return JSON: ${subscribers.filter(s => s.setsJsonResponse).length}\n  Catch all: ${subscribers.filter(s => s.catchesAll).length}\nIssues: ${subscribers.reduce((s, sub) => s + sub.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getExceptionSubscriberTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_exception_subscribers', description: 'Detect KernelEvents::EXCEPTION subscribers: HTTP status setting, JSON response, specific exception type mapping, catch-all Throwable warning, missing response warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_exception_subscriber_stats', description: 'Exception subscriber statistics: subscriber count, HTTP/JSON response count, catch-all count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
