/**
 * Symfony Kernel Terminate Inspector
 *
 * Scans src/ PHP for: kernel.terminate event subscribers, TerminableInterface implementations,
 * terminate() method, onKernelTerminate(), afterResponse(), KernelEvents::TERMINATE.
 *
 * Warns about:
 *   - Terminate listener making DB writes (connection may be closed)
 *   - Terminate listener calling $request->getContent() (stream already consumed)
 *   - Terminate listener with exception that silently fails (terminate exceptions swallowed)
 *   - Terminate work that should be in Messenger (fire-and-forget via async transport)
 *   - TerminableInterface without fastcgi_finish_request() context note
 *   - Very slow terminate listener (blocks process recycling in FPM)
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface KernelTerminateInfo {
  file: string;
  class: string;
  type: 'subscriber' | 'terminable';
  terminateWork: string[];
  hasDbWrite: boolean;
  hasMessengerAlternative: boolean;
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

function extractClassName(content: string): string {
  const m = content.match(/class\s+([A-Za-z0-9_]{1,120})/);
  return m ? m[1] : '(unknown)';
}

function buildKernelTerminateInfos(appPath: string): KernelTerminateInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: KernelTerminateInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isTerminableSubscriber =
      content.includes('KernelEvents::TERMINATE') ||
      content.includes("'kernel.terminate'") ||
      content.includes('"kernel.terminate"') ||
      content.includes('onKernelTerminate');

    const isTerminableInterface =
      content.includes('TerminableInterface') && /function\s+terminate\s*\(/.test(content);

    const hasAfterResponse = content.includes('afterResponse(');

    if (!isTerminableSubscriber && !isTerminableInterface && !hasAfterResponse) continue;

    const className = extractClassName(content);
    const type: 'subscriber' | 'terminable' = isTerminableInterface ? 'terminable' : 'subscriber';
    const terminateWork: string[] = [];
    const issues: string[] = [];

    // Detect DB writes
    const hasDbWrite =
      /->flush\s*\(/.test(content) ||
      /->persist\s*\(/.test(content) ||
      /->save\s*\(/.test(content) ||
      /->execute\s*\(.*INSERT|UPDATE|DELETE/i.test(content) ||
      /->createQuery\s*\(/.test(content);

    if (hasDbWrite) {
      terminateWork.push('db-write');
      issues.push(`"${className}" performs DB writes in terminate listener — Doctrine connection may already be closed after response`);
    }

    // Detect getContent() usage
    if (/->getContent\s*\(/.test(content)) {
      terminateWork.push('request-content');
      issues.push(`"${className}" calls getContent() in terminate listener — request stream is already consumed after response is sent`);
    }

    // Detect try/catch absence (terminate exceptions are swallowed)
    const hasTerminateMethod = /function\s+(terminate|onKernelTerminate|afterResponse)\s*\(/.test(content);
    if (hasTerminateMethod && !content.includes('try {') && !content.includes('try{')) {
      issues.push(`"${className}" terminate listener has no try/catch — any exception will be silently swallowed by Symfony's terminate handling`);
    }

    // Detect heavy work that could be async
    const hasSendEmail = /->send\s*\(/.test(content) || content.includes('MailerInterface') || content.includes('swift_mailer');
    const hasHttpRequest = content.includes('HttpClientInterface') || /->request\s*\(/.test(content);
    const hasSlowWork = hasSendEmail || hasHttpRequest || content.includes('curl_exec');

    if (hasSendEmail) terminateWork.push('email-send');
    if (hasHttpRequest) terminateWork.push('http-request');

    if (hasSlowWork && !content.includes('MessageBus') && !content.includes('DispatcherInterface')) {
      issues.push(`"${className}" does slow work (email/HTTP) in terminate — consider using Symfony Messenger async transport instead`);
    }

    // Detect Messenger already in use
    const hasMessengerAlternative =
      content.includes('MessageBusInterface') ||
      content.includes('->dispatch(') ||
      content.includes('MessengerInterface');

    if (isTerminableInterface && !content.includes('fastcgi_finish_request')) {
      issues.push(`"${className}" implements TerminableInterface — terminate() only saves time in PHP-FPM context (fastcgi_finish_request); no benefit in CLI or other SAPIs`);
    }

    results.push({
      file,
      class: className,
      type,
      terminateWork,
      hasDbWrite,
      hasMessengerAlternative,
      issues,
    });
  }

  return results;
}

export function listKernelTerminate(appPath: string): McpToolResult {
  try {
    const infos = buildKernelTerminateInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No kernel.terminate listeners or TerminableInterface implementations found in src/.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Kernel Terminate Listener Analysis\n${'='.repeat(55)}\n\n`;
    text += `Terminate listeners: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.class}  [${info.type}]\n`;
      text += `    file:           ${info.file}\n`;
      text += `    hasDbWrite:     ${info.hasDbWrite ? 'yes' : 'no'}\n`;
      text += `    messengerUsed:  ${info.hasMessengerAlternative ? 'yes' : 'no'}\n`;
      if (info.terminateWork.length > 0) text += `    work:           ${info.terminateWork.join(', ')}\n`;
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

export function getKernelTerminateStats(appPath: string): McpToolResult {
  try {
    const infos = buildKernelTerminateInfos(appPath);

    let text = `Kernel Terminate Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total listeners:             ${infos.length}\n`;
    text += `  Subscribers:               ${infos.filter((i) => i.type === 'subscriber').length}\n`;
    text += `  TerminableInterface:       ${infos.filter((i) => i.type === 'terminable').length}\n`;
    text += `  With DB writes:            ${infos.filter((i) => i.hasDbWrite).length}\n`;
    text += `  With Messenger:            ${infos.filter((i) => i.hasMessengerAlternative).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getKernelTerminateTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_kernel_terminate',
      description: 'Inspect kernel.terminate event listeners and TerminableInterface implementations: DB writes, request stream consumption, missing try/catch, slow work that should use Messenger; warns on connection-closed DB writes, swallowed exceptions, FPM-only benefit',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_kernel_terminate_stats',
      description: 'Statistics for kernel terminate listeners: subscriber vs terminable count, DB write count, Messenger usage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
