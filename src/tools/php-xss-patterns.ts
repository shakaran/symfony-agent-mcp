// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP XSS Pattern Scanner
 *
 * Scans src/**\/*.php and templates/**\/*.phtml for raw PHP output XSS risks:
 *   - echo $variable without nearby escaping
 *   - print $variable without nearby escaping
 *   - <?= $variable ?> in .phtml files
 *   - echo $_GET/$_POST/$_REQUEST — high severity
 *   - echo $request->get(...) — medium severity
 *
 * Skips if same line or 3 prior lines contain:
 *   htmlspecialchars, htmlentities, strip_tags, esc_html, ->e(
 *
 * Note: Twig templates (.html.twig) are auto-escaped and are NOT scanned.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface XssPatternInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function collectFiles(dir: string, base: string, ext: string): string[] {
  const resolvedDir = path.resolve(dir);
  const resolvedBase = path.resolve(base);
  if (!resolvedDir.startsWith(resolvedBase + path.sep) && resolvedDir !== resolvedBase) {
    return [];
  }
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(resolvedDir, { withFileTypes: true })) {
      const full = path.join(resolvedDir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        files.push(...collectFiles(full, base, ext));
      } else if (e.name.endsWith(ext)) {
        files.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return files;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null;
  }
  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Escaping context check ───────────────────────────────────────────────────

const ESCAPE_MARKERS = ['htmlspecialchars', 'htmlentities', 'strip_tags', 'esc_html', '->e('];

function hasEscapingNearby(lines: string[], lineIdx: number): boolean {
  // Check current line and up to 3 prior lines
  const start = Math.max(0, lineIdx - 3);
  for (let i = start; i <= lineIdx; i++) {
    const l = lines[i];
    for (const marker of ESCAPE_MARKERS) {
      if (l.includes(marker)) return true;
    }
  }
  return false;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): XssPatternInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const isPhtml = filePath.endsWith('.phtml');
  const lines = content.split('\n');
  const results: XssPatternInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // echo patterns
    if (/\becho\s+\$/.test(line)) {
      if (hasEscapingNearby(lines, i)) continue;

      const hasSuperglobal = /\$_(GET|POST|REQUEST)/.test(line);
      const hasRequestGet  = /\$request\s*->\s*get\s*\(/.test(line);

      let severity: 'high' | 'medium' = 'medium';
      let issue = 'echo with unescaped variable — wrap with htmlspecialchars() to prevent XSS';

      if (hasSuperglobal) {
        severity = 'high';
        issue = 'echo with superglobal ($_GET/$_POST/$_REQUEST) — direct user input echoed without escaping; high XSS risk';
      } else if (hasRequestGet) {
        issue = 'echo $request->get() without escaping — request data echoed directly; wrap with htmlspecialchars()';
      }

      results.push({ file: relFile, line: lineNum, fn: 'echo', issue, severity });
      continue;
    }

    // print patterns
    if (/\bprint\s+\$/.test(line)) {
      if (hasEscapingNearby(lines, i)) continue;

      const hasSuperglobal = /\$_(GET|POST|REQUEST)/.test(line);
      const hasRequestGet  = /\$request\s*->\s*get\s*\(/.test(line);

      let severity: 'high' | 'medium' = 'medium';
      let issue = 'print with unescaped variable — wrap with htmlspecialchars() to prevent XSS';

      if (hasSuperglobal) {
        severity = 'high';
        issue = 'print with superglobal ($_GET/$_POST/$_REQUEST) — direct user input printed without escaping; high XSS risk';
      } else if (hasRequestGet) {
        issue = 'print $request->get() without escaping — request data printed directly; wrap with htmlspecialchars()';
      }

      results.push({ file: relFile, line: lineNum, fn: 'print', issue, severity });
      continue;
    }

    // <?= $var ?> in phtml files
    if (isPhtml && /<\?=\s*\$/.test(line)) {
      if (hasEscapingNearby(lines, i)) continue;

      const hasSuperglobal = /\$_(GET|POST|REQUEST)/.test(line);
      let severity: 'high' | 'medium' = 'medium';
      let issue = '<?= short echo tag with unescaped variable in phtml — wrap with htmlspecialchars()';

      if (hasSuperglobal) {
        severity = 'high';
        issue = '<?= short echo with superglobal in phtml — user input rendered without escaping; high XSS risk';
      }

      results.push({ file: relFile, line: lineNum, fn: '<?=', issue, severity });
    }
  }

  return results;
}

function loadXssPatterns(appPath: string): XssPatternInfo[] {
  const srcDir       = path.join(appPath, 'src');
  const templatesDir = path.join(appPath, 'templates');

  const results: XssPatternInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const file of collectFiles(srcDir, appPath, '.php')) {
      results.push(...analyzeFile(file, appPath));
    }
  }

  if (fs.existsSync(templatesDir)) {
    for (const file of collectFiles(templatesDir, appPath, '.phtml')) {
      results.push(...analyzeFile(file, appPath));
    }
  }

  return results.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return sev[a.severity] - sev[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpXssPatterns(appPath: string): McpToolResult {
  try {
    const items = loadXssPatterns(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No unescaped PHP output patterns found in src/ or templates/.\n\n' +
            'Best practice for raw PHP output:\n' +
            '  echo htmlspecialchars($value, ENT_QUOTES, \'UTF-8\');\n' +
            'Note: Twig templates are auto-escaped by default.',
        }],
      };
    }

    const high   = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low    = items.filter((i) => i.severity === 'low');

    let text = `PHP XSS Pattern Scan\n${'='.repeat(55)}\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High severity:   ${high.length}\n`;
    text += `  Medium severity: ${medium.length}\n`;
    text += `  Low severity:    ${low.length}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  fn=${item.fn}\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpXssPatternsStats(appPath: string): McpToolResult {
  try {
    const items = loadXssPatterns(appPath);

    const fnCounts: Record<string, number> = {};
    for (const item of items) {
      fnCounts[item.fn] = (fnCounts[item.fn] ?? 0) + 1;
    }

    let text = `PHP XSS Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:   ${items.length}\n`;
    text += `High:    ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:  ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:     ${items.filter((i) => i.severity === 'low').length}\n\n`;
    text += `By function:\n`;
    for (const [fn, count] of Object.entries(fnCounts)) {
      text += `  ${fn}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getPhpXssPatternsTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_xss_patterns',
      description: 'Scan PHP src/ and templates/*.phtml for XSS risks: echo/print/<?= with unescaped variables; superglobal output (high), request->get() (medium), plain variable (medium); skips lines with htmlspecialchars/htmlentities/strip_tags/esc_html/->e() nearby; Twig templates not scanned (auto-escaped)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_xss_patterns_stats',
      description: 'Statistics for PHP XSS pattern findings: total count, counts by severity (high/medium/low), counts by output function (echo/print/<?=)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
