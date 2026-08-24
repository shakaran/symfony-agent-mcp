// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP File Inclusion Security Inspector
 *
 * Scans src/**\/*.php for dynamic file inclusion patterns:
 * - include $variable, include_once $variable (dynamic)
 * - require $variable, require_once $variable (dynamic)
 * - include $_GET / $_POST / $_REQUEST (high risk — LFI/RFI)
 * - Dynamic includes with string concatenation
 * - Distinguishes static includes (safe) from dynamic (risky)
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FileInclusionInfo {
  file: string;
  type: 'include' | 'include_once' | 'require' | 'require_once';
  isDynamic: boolean;
  risk: 'high' | 'medium' | 'low';
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

function classifyInclusionLine(line: string, keyword: string): { isDynamic: boolean; risk: 'high' | 'medium' | 'low' } | null {
  // Match: include/require keyword followed by value
  const pattern = new RegExp(`\\b${keyword}\\s+(.+?);`);
  const m = pattern.exec(line);
  if (!m) return null;

  const arg = m[1].trim();

  // High risk: user-supplied input directly
  if (/\$_(GET|POST|REQUEST|COOKIE|SERVER)\s*\[/.test(arg)) {
    return { isDynamic: true, risk: 'high' };
  }

  // Static string literal — safe
  if (/^['"]/.test(arg) || /^__DIR__\s*\.?\s*['"]/.test(arg)) {
    return { isDynamic: false, risk: 'low' };
  }

  // Variable or concatenation
  if (/\$[a-zA-Z_]/.test(arg)) {
    // Concatenation with variable
    if (/\.\s*\$/.test(arg) || /\$\w+\s*\./.test(arg)) {
      return { isDynamic: true, risk: 'medium' };
    }
    return { isDynamic: true, risk: 'medium' };
  }

  return { isDynamic: false, risk: 'low' };
}

function analyseFileInclusionsInFile(content: string, relFile: string): FileInclusionInfo[] {
  const infos: FileInclusionInfo[] = [];
  const keywords = ['include_once', 'require_once', 'include', 'require'] as const;
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    for (const kw of keywords) {
      if (!new RegExp(`\\b${kw}\\b`).test(trimmed)) continue;
      const result = classifyInclusionLine(trimmed, kw);
      if (result === null) continue;
      // Only record dynamic or high-risk ones
      if (result.isDynamic || result.risk !== 'low') {
        infos.push({
          file: relFile,
          type: kw,
          isDynamic: result.isDynamic,
          risk: result.risk,
        });
      }
    }
  }

  return infos;
}

function buildFileInclusionInfos(appPath: string): FileInclusionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: FileInclusionInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/\b(?:include|require)/.test(content)) continue;
    const infos = analyseFileInclusionsInFile(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpFileInclusionSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildFileInclusionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No dynamic file inclusion issues found in src/.' }] };
    }

    const highRisk = infos.filter((i) => i.risk === 'high');
    const mediumRisk = infos.filter((i) => i.risk === 'medium');

    let text = `PHP File Inclusion Security Analysis\n${'='.repeat(55)}\n\n`;
    text += `Dynamic inclusions found: ${infos.length}\n`;
    text += `  High risk (user input): ${highRisk.length}\n`;
    text += `  Medium risk (variable): ${mediumRisk.length}\n\n`;

    if (highRisk.length > 0) {
      text += `HIGH RISK — Local/Remote File Inclusion:\n`;
      for (const info of highRisk) {
        text += `  [${info.type}] ${info.file}\n`;
        text += `    User-controlled path — LFI/RFI vulnerability; never include() user input\n`;
      }
      text += '\n';
    }

    if (mediumRisk.length > 0) {
      text += `MEDIUM RISK — Dynamic Variable Inclusion:\n`;
      for (const info of mediumRisk) {
        text += `  [${info.type}] ${info.file}\n`;
        text += `    Dynamic include — verify path is validated against an allowlist\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFileInclusionSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildFileInclusionInfos(appPath);

    const highRisk = infos.filter((i) => i.risk === 'high').length;
    const mediumRisk = infos.filter((i) => i.risk === 'medium').length;
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    const byType: Record<string, number> = {};
    for (const info of infos) {
      byType[info.type] = (byType[info.type] ?? 0) + 1;
    }

    let text = `PHP File Inclusion Security Statistics\n${'='.repeat(45)}\n\n`;
    text += `Files with dynamic inclusions: ${filesAffected}\n`;
    text += `Total dynamic inclusions:      ${infos.length}\n`;
    text += `  High risk (LFI/RFI):         ${highRisk}\n`;
    text += `  Medium risk (variable path):  ${mediumRisk}\n\n`;
    text += `By inclusion type:\n`;
    text += `  include:       ${byType['include'] ?? 0}\n`;
    text += `  include_once:  ${byType['include_once'] ?? 0}\n`;
    text += `  require:       ${byType['require'] ?? 0}\n`;
    text += `  require_once:  ${byType['require_once'] ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpFileInclusionSecurityTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_file_inclusion_security',
      description: 'List PHP dynamic file inclusion security issues: user-input inclusions (LFI/RFI — high risk), variable-path inclusions (medium risk), with include/require/include_once/require_once breakdown',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_file_inclusion_security_stats',
      description: 'Get PHP file inclusion security statistics: counts by risk level (high/medium) and inclusion type, number of affected files',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
