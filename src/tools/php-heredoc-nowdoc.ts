// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Heredoc / Nowdoc Inspector
 *
 * Scans src/**\/*.php for heredoc and nowdoc usage:
 * - <<<EOT / <<<EOL / <<<SQL (heredoc — variable interpolation)
 * - <<<'EOT' / <<<'SQL' (nowdoc — no interpolation)
 * - SQL in heredoc with $variable interpolation (injection risk)
 * - HTML in heredoc (XSS risk if echoed)
 * - Recommendation to use parameterized queries for SQL heredocs
 *
 * Pure static analysis only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HeredocInfo {
  file: string;
  type: 'heredoc' | 'nowdoc';
  hasVariables: boolean;
  issues: string[];
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

function extractHeredocBlocks(content: string, relFile: string): HeredocInfo[] {
  const infos: HeredocInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match heredoc: <<<IDENTIFIER or <<<IDENTIFIER (no quotes)
    const heredocMatch = /^.*<<<([A-Z_][A-Z0-9_]*)/.exec(line);
    // Match nowdoc: <<<'IDENTIFIER'
    const nowdocMatch = /^.*<<<'([A-Z_][A-Z0-9_]*)'/.exec(line);

    if (nowdocMatch) {
      const label = nowdocMatch[1];
      // Collect body until closing label
      const body = collectHeredocBody(lines, i + 1, label);
      const issues: string[] = [];
      // nowdoc has no variable interpolation by definition
      if (/SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE/i.test(body)) {
        issues.push(`Nowdoc contains SQL — consider parameterized queries even without interpolation`);
      }
      infos.push({ file: relFile, type: 'nowdoc', hasVariables: false, issues });
    } else if (heredocMatch) {
      const label = heredocMatch[1];
      const body = collectHeredocBody(lines, i + 1, label);
      const hasVariables = /\$[a-zA-Z_]/.test(body);
      const issues: string[] = [];

      if (/SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE/i.test(body)) {
        if (hasVariables) {
          issues.push(`Heredoc SQL with ${'$'}variable interpolation — SQL injection risk; use parameterized queries`);
        } else {
          issues.push(`Heredoc SQL — prefer parameterized queries for all SQL construction`);
        }
      }
      if (/<[a-zA-Z]/.test(body) && hasVariables) {
        issues.push(`Heredoc HTML with ${'$'}variable interpolation — XSS risk if echoed without escaping`);
      }
      if (hasVariables && issues.length === 0) {
        issues.push(`Heredoc with variable interpolation — ensure values are validated/escaped before use`);
      }

      infos.push({ file: relFile, type: 'heredoc', hasVariables, issues });
    }
  }

  return infos;
}

function collectHeredocBody(lines: string[], startLine: number, label: string): string {
  const bodyLines: string[] = [];
  for (let i = startLine; i < Math.min(lines.length, startLine + 200); i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === label || trimmed === label + ';') break;
    bodyLines.push(lines[i]);
  }
  return bodyLines.join('\n');
}

function buildHeredocInfos(appPath: string): HeredocInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: HeredocInfo[] = [];
  const files = collectPhpFiles(srcDir, appPath);
  for (const file of files) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!/<<</.test(content)) continue;
    const infos = extractHeredocBlocks(content, path.relative(appPath, file));
    results.push(...infos);
  }
  return results;
}

export function listPhpHeredocNowdoc(appPath: string): McpToolResult {
  try {
    const infos = buildHeredocInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No heredoc or nowdoc blocks found in src/.' }] };
    }

    let text = `PHP Heredoc / Nowdoc Analysis\n${'='.repeat(50)}\n\n`;
    text += `Total blocks found: ${infos.length}\n`;
    text += `  Heredoc: ${infos.filter((i) => i.type === 'heredoc').length}\n`;
    text += `  Nowdoc:  ${infos.filter((i) => i.type === 'nowdoc').length}\n\n`;

    const withIssues = infos.filter((i) => i.issues.length > 0);
    text += `Blocks with issues: ${withIssues.length}\n\n`;

    for (const info of withIssues) {
      const varStr = info.type === 'heredoc' ? (info.hasVariables ? ' [has variables]' : '') : '';
      text += `  [${info.type.toUpperCase()}]${varStr} ${info.file}\n`;
      for (const issue of info.issues) {
        text += `    - ${issue}\n`;
      }
    }

    if (withIssues.length === 0) {
      text += 'No issues found in heredoc/nowdoc blocks.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpHeredocNowdocStats(appPath: string): McpToolResult {
  try {
    const infos = buildHeredocInfos(appPath);

    const heredocCount = infos.filter((i) => i.type === 'heredoc').length;
    const nowdocCount = infos.filter((i) => i.type === 'nowdoc').length;
    const withVars = infos.filter((i) => i.type === 'heredoc' && i.hasVariables).length;
    const withIssues = infos.filter((i) => i.issues.length > 0).length;
    const sqlRisk = infos.filter((i) => i.issues.some((iss) => iss.includes('SQL'))).length;
    const xssRisk = infos.filter((i) => i.issues.some((iss) => iss.includes('XSS'))).length;
    const filesAffected = new Set(infos.map((i) => i.file)).size;

    let text = `PHP Heredoc / Nowdoc Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files with heredoc/nowdoc: ${filesAffected}\n`;
    text += `Total blocks:              ${infos.length}\n`;
    text += `  Heredoc:                 ${heredocCount}\n`;
    text += `  Nowdoc:                  ${nowdocCount}\n`;
    text += `  Heredoc with variables:  ${withVars}\n\n`;
    text += `Issues:\n`;
    text += `  Blocks with issues:      ${withIssues}\n`;
    text += `  SQL injection risk:      ${sqlRisk}\n`;
    text += `  XSS risk:                ${xssRisk}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpHeredocNowdocTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_heredoc_nowdoc',
      description: 'List PHP heredoc and nowdoc blocks: SQL injection risks (heredoc with variable interpolation in SQL), XSS risks (HTML with interpolation), recommendations for parameterized queries',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_heredoc_nowdoc_stats',
      description: 'Get PHP heredoc/nowdoc statistics: counts by type, variable interpolation usage, SQL injection and XSS risk counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
