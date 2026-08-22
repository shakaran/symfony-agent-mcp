/**
 * Symfony Monolog Custom Handler Inspector
 *
 * Detects custom Monolog handler implementations in PHP source and
 * cross-references with monolog.yaml configuration.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MonologHandlerEntry {
  file: string;
  className: string;
  handlerType: string;
  level: string;
  issues: string[];
}

// ─── PHP scanning ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...collectPhpFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.php')) {
      results.push(full);
    }
  }
  return results;
}

function extractClassName(content: string, file: string): string {
  const m = /class\s+(\w{1,120})/u.exec(content);
  return m ? m[1] : path.basename(file, '.php');
}

function detectHandlerBaseType(content: string): string {
  if (/extends\s+AbstractProcessingHandler/u.test(content)) return 'AbstractProcessingHandler';
  if (/extends\s+AbstractHandler/u.test(content)) return 'AbstractHandler';
  if (/implements\s+HandlerInterface/u.test(content)) return 'HandlerInterface';
  return 'unknown';
}

function scanPhpForHandlers(appPath: string): MonologHandlerEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: MonologHandlerEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const isHandler =
      /extends\s+AbstractHandler/u.test(content) ||
      /extends\s+AbstractProcessingHandler/u.test(content) ||
      /implements\s+HandlerInterface/u.test(content) ||
      /use\s+Monolog\\Handler/u.test(content);

    if (!isHandler) continue;

    const className = extractClassName(content, file);
    const handlerType = detectHandlerBaseType(content);
    const hasIsHandling = /function\s+isHandling\s*\(/u.test(content);
    const hasWrite = /function\s+write\s*\(/u.test(content);

    const issues: string[] = [];

    if (!hasIsHandling) {
      issues.push(
        'Handler does not override isHandling() — will process all log levels inefficiently; override to filter by level'
      );
    }

    if (handlerType === 'AbstractProcessingHandler' && !hasWrite) {
      issues.push(
        'AbstractProcessingHandler subclass does not implement write() — handler will do nothing when triggered'
      );
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      handlerType,
      level: 'unknown',
      issues,
    });
  }

  return results;
}

// ─── YAML config scanning ────────────────────────────────────────────────────

interface YamlHandlerDef {
  name: string;
  type: string;
  level: string;
  path?: string;
  actionLevel?: string;
  maxFiles?: number;
  members?: string[];
  issues: string[];
}

function scanMonologYaml(appPath: string): YamlHandlerDef[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml'),
  ];

  const seen = new Set<string>();
  const handlers: YamlHandlerDef[] = [];

  for (const candidate of candidates) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(candidate) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!raw) continue;

    const monolog = (raw['monolog'] ?? raw) as Record<string, unknown>;
    const handlersRaw = monolog['handlers'] as Record<string, unknown> | undefined;
    if (!handlersRaw) continue;

    for (const [name, def] of Object.entries(handlersRaw)) {
      if (seen.has(name) || !def || typeof def !== 'object') continue;
      seen.add(name);

      const d = def as Record<string, unknown>;
      const type = String(d['type'] ?? 'stream');
      const level = String(d['level'] ?? 'debug').toLowerCase();
      const pathVal = d['path'] ? String(d['path']) : undefined;
      const actionLevel = d['action_level'] ? String(d['action_level']).toLowerCase() : undefined;
      const maxFiles = d['max_files'] ? Number(d['max_files']) : undefined;
      const members = Array.isArray(d['members'])
        ? (d['members'] as unknown[]).map(String)
        : undefined;

      const issues: string[] = [];

      // stdout in production config
      if (pathVal && (pathVal.includes('/dev/stdout') || pathVal.includes('php://stdout'))) {
        if (candidate.includes('/prod/') || candidate.includes('prod')) {
          issues.push(
            'Handler writes to /dev/stdout or php://stdout in production config — may conflict with web server buffering'
          );
        }
      }

      // FingersCrossed without activation_strategy
      if (type === 'fingers_crossed' && !actionLevel && !d['activation_strategy']) {
        issues.push(
          'FingersCrossedHandler without activation_strategy — activates and flushes buffer on any ERROR, potentially very noisy'
        );
      }

      // GroupHandler duplicate members
      if (type === 'group' && members) {
        const memberSet = new Set<string>();
        const duplicates: string[] = [];
        for (const m of members) {
          if (memberSet.has(m)) duplicates.push(m);
          memberSet.add(m);
        }
        if (duplicates.length > 0) {
          issues.push(
            `GroupHandler has duplicate members: ${duplicates.join(', ')} — log entries will be written multiple times`
          );
        }
      }

      // RotatingFileHandler with too low maxFiles
      if (type === 'rotating_file' && maxFiles !== undefined && maxFiles < 7) {
        issues.push(
          `RotatingFileHandler has max_files=${maxFiles} — logs older than ${maxFiles} days are deleted; consider at least 7 for debugging`
        );
      }

      handlers.push({ name, type, level, path: pathVal, actionLevel, maxFiles, members, issues });
    }
  }

  return handlers;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonyMonologHandlers(appPath: string): McpToolResult {
  try {
    const phpHandlers = scanPhpForHandlers(appPath);
    const yamlHandlers = scanMonologYaml(appPath);

    if (phpHandlers.length === 0 && yamlHandlers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Monolog handlers found in src/ and no handler config found in monolog.yaml.',
        }],
      };
    }

    let text = `Symfony Monolog Handler Inspector\n${'='.repeat(55)}\n`;

    if (phpHandlers.length > 0) {
      text += `\nCustom handler classes (${phpHandlers.length}):\n`;
      for (const h of phpHandlers) {
        text += `  ${h.className}  [extends ${h.handlerType}]\n`;
        text += `    File: ${h.file}\n`;
        for (const issue of h.issues) {
          text += `    [!] ${issue}\n`;
        }
      }
    }

    if (yamlHandlers.length > 0) {
      text += `\nConfigured handlers in monolog.yaml (${yamlHandlers.length}):\n`;
      text += `  ${'Name'.padEnd(28)} ${'Type'.padEnd(20)} Level\n`;
      text += `  ${'-'.repeat(60)}\n`;
      for (const h of yamlHandlers) {
        text += `  ${h.name.padEnd(28)} ${h.type.padEnd(20)} ${h.level}\n`;
        for (const issue of h.issues) {
          text += `    [!] ${issue}\n`;
        }
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

export function getSymfonyMonologHandlerStats(appPath: string): McpToolResult {
  try {
    const phpHandlers = scanPhpForHandlers(appPath);
    const yamlHandlers = scanMonologYaml(appPath);

    const phpIssues = phpHandlers.reduce((s, h) => s + h.issues.length, 0);
    const yamlIssues = yamlHandlers.reduce((s, h) => s + h.issues.length, 0);

    let text = `Monolog Handler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom handler classes:      ${phpHandlers.length}\n`;
    text += `Configured yaml handlers:    ${yamlHandlers.length}\n`;
    text += `PHP handler issues:          ${phpIssues}\n`;
    text += `YAML handler issues:         ${yamlIssues}\n`;
    text += `FingersCrossed handlers:     ${yamlHandlers.filter((h) => h.type === 'fingers_crossed').length}\n`;
    text += `Group handlers:              ${yamlHandlers.filter((h) => h.type === 'group').length}\n`;
    text += `Rotating file handlers:      ${yamlHandlers.filter((h) => h.type === 'rotating_file').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonyMonologHandlerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_monolog_handlers',
      description: 'Detect custom Monolog handler classes and yaml-configured handlers; warns on missing isHandling(), stdout in prod, FingersCrossed without activation_strategy, GroupHandler duplicates, RotatingFile with low maxFiles',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_monolog_handler_stats',
      description: 'Statistics on Monolog handlers: custom class count, configured handler count, issues by category',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
