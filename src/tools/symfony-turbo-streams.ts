// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface TurboStreamInfo {
  file: string;
  type: 'response' | 'controller' | 'template' | 'broadcast' | 'config';
  pattern: string;
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
      else if (e.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildTurboStreamInfos(appPath: string): TurboStreamInfo[] {
  const results: TurboStreamInfo[] = [];

  let hasTurboBundle = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/ux-turbo']) hasTurboBundle = true;
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of getAllPhpFiles(srcDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      if (!content.includes('TurboStream') && !content.includes('turbo-stream') && !content.includes('#[Broadcast')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('TurboStreamResponse') || content.includes('turbo_stream(')) {
        const hasAcceptCheck = content.includes("'text/vnd.turbo-stream.html'") || content.includes('turbo_stream_response') || content.includes('isTurboStreamRequest');
        if (!hasAcceptCheck) {
          issues.push('Turbo Stream response served without checking Accept: text/vnd.turbo-stream.html — regular browser requests would receive stream markup instead of HTML');
        }

        const hasCsrfCheck = content.includes('isCsrfTokenValid') || content.includes('csrf') || content.includes('CSRF');
        if (!hasCsrfCheck && (content.includes('POST') || content.includes('form'))) {
          issues.push('Turbo Stream POST endpoint without CSRF check — Turbo streams modify DOM; ensure standard Symfony CSRF protection is applied');
        }

        results.push({ file: relFile, type: 'response', pattern: 'TurboStreamResponse', issues });
      }

      if (content.includes('#[Broadcast]') || content.includes('#[\\Symfony\\UX\\Turbo\\Attribute\\Broadcast]')) {
        const issues2: string[] = [];
        const hasAuthorize = content.includes('authorizeUpdate') || content.includes('shouldBroadcast') || content.includes('canSeeUpdate');
        if (!hasAuthorize) {
          issues2.push('#[Broadcast] without authorization check — entity updates broadcast to all subscribers; implement shouldBroadcast() to filter by user');
        }
        results.push({ file: relFile, type: 'broadcast', pattern: '#[Broadcast]', issues: issues2 });
      }
    }
  }

  const templatesDir = path.join(appPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const file of getAllTwigFiles(templatesDir)) {
      const content = safeRead(file, appPath);
      if (content === null) continue;

      if (!content.includes('turbo_stream') && !content.includes('<turbo-stream') && !content.includes('turbo-frame')) continue;

      const relFile = path.relative(appPath, file);
      const issues: string[] = [];

      if (content.includes('<turbo-stream action="remove"') && content.includes('target="')) {
        const hasNonce = content.includes('nonce') || content.includes('id=');
        if (!hasNonce) {
          issues.push('turbo-stream action="remove" without stable target ID — if target IDs contain user data, ensure they are sanitized to prevent DOM manipulation via crafted entity IDs');
        }
      }

      if (content.includes('turbo_stream(') && !content.includes('|e') && !content.includes('|escape')) {
        issues.push('Turbo stream template may include unescaped content — use |e or Twig auto-escape for all dynamic content in stream templates to prevent XSS');
      }

      results.push({ file: relFile, type: 'template', pattern: 'turbo-stream template', issues });
    }
  }

  if (!hasTurboBundle && results.length === 0) {
    results.push({ file: 'composer.json', type: 'config', pattern: 'symfony/ux-turbo', issues: ['symfony/ux-turbo not installed — install with: composer require symfony/ux-turbo'] });
  }

  return results;
}

export function listSymfonyTurboStreams(appPath: string): McpToolResult {
  try {
    const infos = buildTurboStreamInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Turbo Streams patterns found (no TurboStreamResponse, #[Broadcast], or turbo-stream templates).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Turbo Streams Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTurboStreamsStats(appPath: string): McpToolResult {
  try {
    const infos = buildTurboStreamInfos(appPath);
    let text = `Turbo Streams Statistics\n${'='.repeat(40)}\n\n`;
    text += `Responses:    ${infos.filter((i) => i.type === 'response').length}\n`;
    text += `Broadcasts:   ${infos.filter((i) => i.type === 'broadcast').length}\n`;
    text += `Templates:    ${infos.filter((i) => i.type === 'template').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyTurboStreamsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_turbo_streams', description: 'Analyze Turbo Streams usage; warns on response without Accept header check, POST without CSRF, #[Broadcast] without authorization, unescaped content in stream templates, unsafe target IDs', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_turbo_streams_stats', description: 'Statistics for Turbo Streams: response/broadcast/template count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
