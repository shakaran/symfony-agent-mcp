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

interface SessionHandlerInfo {
  class: string;
  file: string;
  methods: string[];
  hasGcImplementation: boolean;
  isRegistered: boolean;
  issues: string[];
}

const REQUIRED_METHODS = ['open', 'close', 'read', 'write', 'destroy', 'gc'];

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

function parseSessionHandler(filePath: string, appPath: string): SessionHandlerInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;
  if (!content.includes('SessionHandlerInterface') && !content.includes('\\SessionHandler')) return null;
  if (!content.includes('implements') && !content.includes('extends')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Predis\\')) return null;
  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;
  const methods = REQUIRED_METHODS.filter((m) => new RegExp(`function\\s+${m}\\s*\\(`).test(content));
  const hasGcImplementation = /function\s+gc\s*\([^)]*\)[^{]*\{[\s\S]{0,200}return\s+(?!false)/.test(content);
  const isRegistered = content.includes('framework.yaml') || content.includes('session.handler') || content.includes('#[AsService');
  const issues: string[] = [];
  const missingMethods = REQUIRED_METHODS.filter((m) => !methods.includes(m));
  if (missingMethods.length > 0) issues.push(`Missing SessionHandlerInterface methods: ${missingMethods.join(', ')}`);
  if (methods.includes('gc') && !hasGcImplementation) issues.push('gc() may return false — must return int|false (number of deleted sessions or false on failure)');
  return { class: classM[1], file: path.relative(appPath, filePath), methods, hasGcImplementation, isRegistered, issues };
}

export function listSessionHandlers(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const handlers: SessionHandlerInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const h = parseSessionHandler(file, appPath);
      if (h) handlers.push(h);
    }
    if (handlers.length === 0) return { content: [{ type: 'text', text: 'No custom SessionHandlerInterface implementations found.\n\nExample:\n  class RedisSessionHandler implements \\SessionHandlerInterface {\n    public function open(string $savePath, string $sessionName): bool { ... }\n    public function gc(int $maxlifetime): int|false { ... }\n  }' }] };
    const totalIssues = handlers.reduce((s, h) => s + h.issues.length, 0);
    let text = `Custom Session Handlers\n${'='.repeat(55)}\n\nHandlers: ${handlers.length}  Issues: ${totalIssues}\n`;
    for (const h of handlers.sort((a, b) => b.issues.length - a.issues.length)) {
      const impl = `${h.methods.length}/${REQUIRED_METHODS.length} methods`;
      text += `\n  ${h.class}  ${impl}  (${h.file})\n`;
      for (const i of h.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSessionHandlerStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const handlers: SessionHandlerInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const h = parseSessionHandler(file, appPath);
        if (h) handlers.push(h);
      }
    }
    let text = `Session Handler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom handlers: ${handlers.length}\n  Fully implemented: ${handlers.filter((h) => h.methods.length === REQUIRED_METHODS.length).length}\nIssues: ${handlers.reduce((s, h) => s + h.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSessionHandlerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_session_handlers', description: 'Show custom SessionHandlerInterface implementations: method coverage (open/close/read/write/destroy/gc), gc() return type warning, missing method warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_session_handler_stats', description: 'Show session handler statistics: handler count, fully implemented count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
