/**
 * Symfony Monolog Log Rotation Inspector
 *
 * Scans config/packages/monolog.yaml and environment variants
 * (config/packages/dev/monolog.yaml, config/packages/prod/monolog.yaml, etc.)
 * for handler configuration issues: rotating_file without max_files,
 * debug level in production, ephemeral paths, bubble: false mid-chain.
 *
 * Pure static analysis — no process execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function maskDsn(value: string): string {
  return value
    .replace(/:\/\/[^@\s]{1,200}@/g, '://***@')
    .replace(/([?&])(password|auth|token|secret|key)=[^&\s]*/gi, '$1$2=***');
}

interface MonologHandlerFinding {
  handler: string;
  type: string;
  level: string | null;
  maxFiles: string | null;
  path: string | null;
  issue: string | null;
}

function safeReadAbs(filePath: string): string | null {
  try { return fs.readFileSync(path.resolve(filePath), 'utf-8'); } catch { return null; }
}

function findMonologYamlFiles(appPath: string): Array<{ file: string; envContext: string }> {
  const candidates: Array<{ file: string; envContext: string }> = [];

  const base = path.join(appPath, 'config', 'packages');
  const baseFile = path.join(base, 'monolog.yaml');
  if (safeReadAbs(baseFile) !== null) candidates.push({ file: baseFile, envContext: 'all' });

  for (const env of ['dev', 'prod', 'test', 'staging']) {
    const f = path.join(base, env, 'monolog.yaml');
    if (safeReadAbs(f) !== null) candidates.push({ file: f, envContext: env });
  }

  return candidates;
}

// Minimal line-based YAML parser for monolog handler blocks
function parseHandlers(content: string, envContext: string): MonologHandlerFinding[] {
  const findings: MonologHandlerFinding[] = [];
  const lines = content.split('\n');

  // State machine: find "handlers:" section then parse each named handler
  let inHandlers = false;
  let handlerIndent = -1;

  let currentHandler = '';
  let currentType: string | null = null;
  let currentLevel: string | null = null;
  let currentMaxFiles: string | null = null;
  let currentPath: string | null = null;
  let currentBubble: string | null = null;

  const flushHandler = (): void => {
    if (!currentHandler || !currentType) return;

    const issues: string[] = [];

    if (currentType === 'rotating_file') {
      if (currentMaxFiles === null) {
        issues.push('max_files not set — defaults to unlimited rotation, disk can fill up; set max_files: 30 or similar');
      } else if (parseInt(currentMaxFiles, 10) === 0) {
        issues.push('max_files: 0 means unlimited rotation — disk can fill up; set a positive value');
      } else if (parseInt(currentMaxFiles, 10) > 365) {
        issues.push(`max_files: ${currentMaxFiles} is very large (> 365) — consider reducing to avoid accumulating too many log files`);
      }
    }

    if (currentType === 'stream' || currentType === 'rotating_file') {
      if (currentPath && currentPath.includes('/tmp/')) {
        issues.push(`Log path uses /tmp/ (${currentPath}) — ephemeral; use %kernel.logs_dir% instead`);
      }
      if (currentPath && currentPath.includes('%kernel.logs_dir%')) {
        // Good pattern — no issue
      }
    }

    if (currentLevel === 'debug' && envContext === 'prod') {
      issues.push('level: debug in production context — generates excessive logs and may expose sensitive data; use warning or error');
    }

    if (currentBubble === 'false') {
      issues.push('bubble: false — this handler silences all further handlers in the chain; ensure this is intentional and it is the last meaningful handler');
    }

    findings.push({
      handler: currentHandler,
      type: currentType,
      level: currentLevel,
      maxFiles: currentMaxFiles,
      path: currentPath,
      issue: issues.length > 0 ? issues.join(' | ') : null,
    });

    // Reset state
    currentHandler = '';
    currentType = null;
    currentLevel = null;
    currentMaxFiles = null;
    currentPath = null;
    currentBubble = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Detect "handlers:" section
    if (/^\s{4,8}handlers\s*:/.test(trimmed) || /^handlers\s*:/.test(trimmed)) {
      inHandlers = true;
      handlerIndent = (trimmed.match(/^(\s*)/) ?? ['', ''])[1].length + 4;
      continue;
    }

    if (!inHandlers) continue;

    // Detect new handler name (indented key without deeper nesting)
    const handlerNameMatch = new RegExp(`^(\\s{${handlerIndent}})(\\w[a-zA-Z0-9_-]{0,80})\\s*:`).exec(trimmed);
    if (handlerNameMatch) {
      flushHandler();
      currentHandler = handlerNameMatch[2];
      continue;
    }

    // Back to top-level — exit handlers section
    if (/^\S/.test(trimmed) && !/^monolog\s*:/.test(trimmed)) {
      if (!trimmed.startsWith(' ') && trimmed.length > 0) {
        flushHandler();
        inHandlers = false;
        continue;
      }
    }

    if (!currentHandler) continue;

    // Parse handler properties
    const typeMatch = /^\s+type\s*:\s*([a-z_]{1,40})/.exec(trimmed);
    if (typeMatch) { currentType = typeMatch[1]; continue; }

    const levelMatch = /^\s+level\s*:\s*([a-z]{1,20})/.exec(trimmed);
    if (levelMatch) { currentLevel = levelMatch[1]; continue; }

    const maxFilesMatch = /^\s+max_files\s*:\s*(\d+)/.exec(trimmed);
    if (maxFilesMatch) { currentMaxFiles = maxFilesMatch[1]; continue; }

    const pathMatch = /^\s+path\s*:\s*([^\s#][^\n]{0,200})/.exec(trimmed);
    if (pathMatch) { currentPath = pathMatch[1].trim().replace(/^['"]|['"]$/g, ''); continue; }

    const bubbleMatch = /^\s+bubble\s*:\s*(true|false)/.exec(trimmed);
    if (bubbleMatch) { currentBubble = bubbleMatch[1]; continue; }


  }

  flushHandler();

  // Cross-handler check: multiple handlers writing to same path
  const pathCounts: Record<string, number> = {};
  for (const f of findings) {
    if (f.path) pathCounts[f.path] = (pathCounts[f.path] ?? 0) + 1;
  }
  for (const f of findings) {
    if (f.path && (pathCounts[f.path] ?? 0) > 1) {
      const existing = f.issue ? f.issue + ' | ' : '';
      f.issue = `${existing}Multiple handlers write to same path (${f.path}) — log entries may interleave`;
    }
  }

  return findings;
}

function loadFindings(appPath: string): Array<MonologHandlerFinding & { source: string }> {
  const files = findMonologYamlFiles(appPath);
  const all: Array<MonologHandlerFinding & { source: string }> = [];
  for (const { file, envContext } of files) {
    const raw = safeReadAbs(file);
    if (!raw) continue;
    const handlers = parseHandlers(raw, envContext);
    for (const h of handlers) all.push({ ...h, source: `${path.relative(appPath, file)} [${envContext}]` });
  }
  return all;
}

export function listSymfonyMonologRotation(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    if (findings.length === 0) {
      return { content: [{ type: 'text', text: 'No Monolog handler configuration found in config/packages/monolog.yaml.\n\nExample:\n  monolog:\n    handlers:\n      main:\n        type: rotating_file\n        path: \'%kernel.logs_dir%/%kernel.environment%.log\'\n        level: debug\n        max_files: 10' }] };
    }
    const issues = findings.filter(f => f.issue !== null);
    let text = `Symfony Monolog Log Rotation\n${'='.repeat(55)}\n\nHandlers: ${findings.length}  Issues: ${issues.length}\n`;
    for (const f of findings) {
      text += `\n  [${f.handler}]  type: ${f.type}  source: ${f.source}\n`;
      if (f.level) text += `    level: ${f.level}\n`;
      if (f.maxFiles !== null) text += `    max_files: ${f.maxFiles}\n`;
      if (f.path) text += `    path: ${maskDsn(f.path)}\n`;
      if (f.issue) text += `    ⚠ ${f.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMonologRotationStats(appPath: string): McpToolResult {
  try {
    const findings = loadFindings(appPath);
    const byType: Record<string, number> = {};
    for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
    const issues = findings.filter(f => f.issue !== null);
    const rotatingNoLimit = findings.filter(f => f.type === 'rotating_file' && (f.maxFiles === null || f.maxFiles === '0'));
    let text = `Symfony Monolog Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total handlers: ${findings.length}\nWith issues: ${issues.length}\nRotating without limit: ${rotatingNoLimit.length}\n\nBy type:\n`;
    for (const [t, count] of Object.entries(byType)) text += `  ${t}: ${count}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMonologRotationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_monolog_rotation', description: 'Parse config/packages/monolog.yaml (and dev/prod variants) for handler issues: rotating_file without max_files, max_files:0, debug level in prod, /tmp path, bubble:false mid-chain, duplicate log paths', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_monolog_rotation_stats', description: 'Statistics for Monolog handlers: total handlers, issues count, rotating handlers without size limit, breakdown by handler type', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
