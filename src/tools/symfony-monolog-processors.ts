// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface MonologProcessorInfo {
  class?: string;
  file?: string;
  channel?: string;
  handler?: string;
  hasInvoke: boolean;
  returnsLogRecord: boolean;
  isRegistered: boolean;
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

function loadYamlProcessors(appPath: string): MonologProcessorInfo[] {
  const found: MonologProcessorInfo[] = [];
  const candidates = [path.join(appPath, 'config', 'packages', 'monolog.yaml'), path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml')];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const monolog = (raw['monolog'] ?? {}) as Record<string, unknown>;
    const handlers = (monolog['handlers'] ?? {}) as Record<string, unknown>;
    for (const [handlerName, def] of Object.entries(handlers)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const processors = Array.isArray(d['processors']) ? (d['processors'] as string[]) : [];
      for (const proc of processors) {
        found.push({ class: proc, handler: handlerName, hasInvoke: true, returnsLogRecord: true, isRegistered: true, issues: [] });
      }
    }
    const processors = (monolog['processors'] ?? []) as string[];
    for (const proc of processors) {
      found.push({ class: proc, hasInvoke: true, returnsLogRecord: true, isRegistered: true, issues: [] });
    }
  }
  return found;
}

function scanPhpProcessors(appPath: string): MonologProcessorInfo[] {
  const found: MonologProcessorInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return found;
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('ProcessorInterface') && !(content.includes('LogRecord') && content.includes('__invoke'))) continue;
    if (content.includes('namespace Monolog\\')) return found;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;
    const hasInvoke = content.includes('function __invoke(');
    const returnsLogRecord = content.includes(': LogRecord') || content.includes('return $record');
    const isRegistered = content.includes('#[AsMonologProcessor') || content.includes('monolog.processor');
    const issues: string[] = [];
    if (!hasInvoke) issues.push('Processor without __invoke() — Monolog processors must be callable');
    if (!returnsLogRecord) issues.push('Processor may not return LogRecord — must return the (possibly modified) record');
    if (!isRegistered) issues.push('Processor not tagged — register with tag: monolog.processor or #[AsMonologProcessor]');
    found.push({ class: classM[1], file: path.relative(appPath, file), hasInvoke, returnsLogRecord, isRegistered, issues });
  }
  return found;
}

export function listMonologProcessors(appPath: string): McpToolResult {
  try {
    const yamlProcessors = loadYamlProcessors(appPath);
    const phpProcessors = scanPhpProcessors(appPath);
    const all = [...phpProcessors, ...yamlProcessors];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No Monolog processors found.\n\nExample:\n  use Monolog\\LogRecord;\n  #[AsMonologProcessor]\n  class RequestIdProcessor {\n    public function __invoke(LogRecord $record): LogRecord {\n      return $record->with(extra: [...$record->extra, \'request_id\' => uuid()]);\n    }\n  }' }] };
    const totalIssues = all.reduce((s, p) => s + p.issues.length, 0);
    let text = `Monolog Processors\n${'='.repeat(55)}\n\nProcessors: ${all.length}  Issues: ${totalIssues}\n`;
    for (const p of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const reg = p.isRegistered ? '  ✓ registered' : '  ⚠ not tagged';
      const handler = p.handler ? `  handler: ${p.handler}` : '';
      text += `\n  ${p.class ?? '(unknown)'}${handler}${reg}  ${p.file ? `(${p.file})` : '[yaml]'}\n`;
      for (const i of p.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMonologProcessorStats(appPath: string): McpToolResult {
  try {
    const all = [...loadYamlProcessors(appPath), ...scanPhpProcessors(appPath)];
    let text = `Monolog Processor Statistics\n${'='.repeat(40)}\n\n`;
    text += `Processors: ${all.length}\n  From YAML: ${all.filter((p) => !p.file).length}\n  From PHP: ${all.filter((p) => !!p.file).length}\n  Registered: ${all.filter((p) => p.isRegistered).length}\nIssues: ${all.reduce((s, p) => s + p.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getMonologProcessorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_monolog_processors', description: 'Show Monolog ProcessorInterface implementations and YAML processor config: __invoke() presence, LogRecord return, #[AsMonologProcessor] tagging, missing callable warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_monolog_processor_stats', description: 'Show Monolog processor statistics: total count, YAML vs PHP source, registered count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
