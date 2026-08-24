// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Monolog Formatter Inspector
 *
 * Detects custom Monolog formatter implementations in PHP source and
 * formatter configuration in monolog.yaml.
 *
 * Pure static analysis.
 */

import * as path from 'path';
import * as fs from 'fs';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface MonologFormatterEntry {
  file: string;
  className: string;
  formatterType: string;
  hasJsonUnicode: boolean;
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

function detectFormatterBaseType(content: string): string {
  if (/extends\s+JsonFormatter/u.test(content)) return 'JsonFormatter';
  if (/extends\s+NormalizerFormatter/u.test(content)) return 'NormalizerFormatter';
  if (/extends\s+LineFormatter/u.test(content)) return 'LineFormatter';
  if (/implements\s+FormatterInterface/u.test(content)) return 'FormatterInterface';
  return 'unknown';
}

function scanPhpForFormatters(appPath: string): MonologFormatterEntry[] {
  const srcDir = path.join(appPath, 'src');
  const files = collectPhpFiles(srcDir);
  const results: MonologFormatterEntry[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const isFormatter =
      /implements\s+FormatterInterface/u.test(content) ||
      /extends\s+LineFormatter/u.test(content) ||
      /extends\s+JsonFormatter/u.test(content) ||
      /extends\s+NormalizerFormatter/u.test(content) ||
      /use\s+Monolog\\Formatter/u.test(content);

    if (!isFormatter) continue;

    const className = extractClassName(content, file);
    const formatterType = detectFormatterBaseType(content);
    const hasJsonUnicode =
      /JSON_UNESCAPED_UNICODE/u.test(content) || /json_encode.*JSON_UNESCAPED/u.test(content);
    const hasFormat = /function\s+format\s*\(/u.test(content);
    const hasFormatBatch = /function\s+formatBatch\s*\(/u.test(content);
    const hasIncludeStacktraces =
      /includeStacktraces\s*=\s*true/u.test(content) ||
      /setIncludeStacktraces\s*\(\s*true\s*\)/u.test(content);
    const hasHardcodedTimezone =
      /new\s+\\?DateTimeZone\s*\(/u.test(content) &&
      !/env\s*\(|getenv\s*\(|parameter\s*\(/u.test(content);

    const issues: string[] = [];

    if (formatterType === 'JsonFormatter' && !hasJsonUnicode) {
      issues.push(
        'JsonFormatter without JSON_UNESCAPED_UNICODE — Unicode characters are escaped as \\uXXXX in logs, making them harder to read'
      );
    }

    if (formatterType === 'LineFormatter' && hasIncludeStacktraces) {
      issues.push(
        'LineFormatter with includeStacktraces=true — each log entry includes a full stack trace, causing massive log volume in production'
      );
    }

    if (formatterType === 'FormatterInterface' || formatterType === 'unknown') {
      if (hasFormat && !hasFormatBatch) {
        issues.push(
          'Custom formatter implements format() but not formatBatch() — batch logging (e.g. from BufferHandler) will use the default loop implementation'
        );
      }
    }

    if (hasHardcodedTimezone) {
      issues.push(
        'Formatter contains a hardcoded DateTimeZone — logs may show incorrect timestamps in multi-region deployments'
      );
    }

    results.push({
      file: path.relative(appPath, file),
      className,
      formatterType,
      hasJsonUnicode,
      issues,
    });
  }

  return results;
}

// ─── YAML config scanning ────────────────────────────────────────────────────

interface YamlFormatterDef {
  handlerName: string;
  formatterService: string;
}

function scanYamlForFormatters(appPath: string): YamlFormatterDef[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'monolog.yaml'),
  ];

  const results: YamlFormatterDef[] = [];
  const seen = new Set<string>();

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
      if (!def || typeof def !== 'object' || seen.has(name)) continue;
      seen.add(name);
      const d = def as Record<string, unknown>;
      if (d['formatter']) {
        results.push({ handlerName: name, formatterService: String(d['formatter']) });
      }
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listSymfonyMonologFormatters(appPath: string): McpToolResult {
  try {
    const phpFormatters = scanPhpForFormatters(appPath);
    const yamlFormatters = scanYamlForFormatters(appPath);

    if (phpFormatters.length === 0 && yamlFormatters.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Monolog formatters found in src/ and no formatter config found in monolog.yaml.',
        }],
      };
    }

    let text = `Symfony Monolog Formatter Inspector\n${'='.repeat(55)}\n`;

    if (phpFormatters.length > 0) {
      text += `\nCustom formatter classes (${phpFormatters.length}):\n`;
      for (const f of phpFormatters) {
        text += `\n  ${f.className}  [${f.formatterType}]\n`;
        text += `    File:               ${f.file}\n`;
        text += `    JSON_UNESCAPED:     ${f.hasJsonUnicode ? 'yes' : 'no'}\n`;
        for (const issue of f.issues) {
          text += `    [!] ${issue}\n`;
        }
      }
    }

    if (yamlFormatters.length > 0) {
      text += `\nFormatters configured in monolog.yaml (${yamlFormatters.length}):\n`;
      for (const yf of yamlFormatters) {
        text += `  Handler: ${yf.handlerName.padEnd(28)} formatter: ${yf.formatterService}\n`;
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

export function getSymfonyMonologFormatterStats(appPath: string): McpToolResult {
  try {
    const phpFormatters = scanPhpForFormatters(appPath);
    const yamlFormatters = scanYamlForFormatters(appPath);

    const withIssues = phpFormatters.filter((f) => f.issues.length > 0);
    const jsonFormatters = phpFormatters.filter((f) => f.formatterType === 'JsonFormatter');
    const withoutUnicode = jsonFormatters.filter((f) => !f.hasJsonUnicode);

    let text = `Monolog Formatter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom formatter classes:        ${phpFormatters.length}\n`;
    text += `Formatters with issues:          ${withIssues.length}\n`;
    text += `JsonFormatter classes:           ${jsonFormatters.length}\n`;
    text += `JSON without UNESCAPED_UNICODE:  ${withoutUnicode.length}\n`;
    text += `LineFormatter classes:           ${phpFormatters.filter((f) => f.formatterType === 'LineFormatter').length}\n`;
    text += `Yaml formatter bindings:         ${yamlFormatters.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getSymfonyMonologFormatterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_symfony_monolog_formatters',
      description: 'Detect custom Monolog formatter classes; warns on JsonFormatter without JSON_UNESCAPED_UNICODE, LineFormatter with includeStacktraces in production, missing formatBatch(), and hardcoded timezones',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_symfony_monolog_formatter_stats',
      description: 'Statistics on Monolog formatters: class count by type, issues detected, JSON unicode flag status, yaml formatter bindings',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
