// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Template Injection Vulnerability Scanner
 *
 * Scans src/**\/*.php and src/**\/*.twig for template injection vulnerabilities:
 *   - Twig Environment::createTemplate($userInput) — user-controlled template string
 *   - Twig {{ variable | raw }} combined with unvalidated user data
 *   - Smarty::display($userTemplate) with user-controlled path
 *   - PHP eval() with template-like string containing user data
 *   - Custom template engines passing $_GET/$_POST directly to template renderer
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TemplateInjectionInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'critical' | 'high' | 'medium';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectFiles(dir: string, base: string, exts: string[]): string[] {
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
    if (stat.isDirectory()) results.push(...collectFiles(full, base, exts));
    else if (exts.some((e) => entry.endsWith(e))) results.push(full);
  }
  return results;
}

// ─── User-input markers ───────────────────────────────────────────────────────

const USER_INPUT_PATTERN = /\$_(GET|POST|REQUEST|COOKIE)|->get\s*\(|->query\s*\(|->request\s*\(|->getContent\s*\(/;

// ─── PHP file analysis ────────────────────────────────────────────────────────

function analyzePhpFile(filePath: string, base: string): TemplateInjectionInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: TemplateInjectionInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    // Pattern 1: Twig createTemplate() with user-controlled argument
    if (/->createTemplate\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (USER_INPUT_PATTERN.test(line) || USER_INPUT_PATTERN.test(contextWindow)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'twig-create-template',
          issue: 'Twig Environment::createTemplate() called with user-controlled input — allows attacker to inject arbitrary Twig code including {{ ... }} expressions for RCE; never pass user data as a template string',
          severity: 'critical',
        });
      } else {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'twig-create-template',
          issue: 'Twig Environment::createTemplate() detected — verify the template string is never user-controlled; user input in template strings leads to server-side template injection (SSTI)',
          severity: 'medium',
        });
      }
    }

    // Pattern 2: eval() with user data or template-like strings
    if (/\beval\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      const hasUserInput = USER_INPUT_PATTERN.test(line) || USER_INPUT_PATTERN.test(contextWindow);
      const hasTemplateMarkers = /\$\{|\{\{|<%/.test(line);

      if (hasUserInput) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'eval-user-input',
          issue: 'eval() with user-controlled data — direct code execution from user input; critical RCE vulnerability; remove eval() entirely and use a safe alternative',
          severity: 'critical',
        });
      } else if (hasTemplateMarkers) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'eval-template-string',
          issue: 'eval() with template-like string (${...} or {{...}) — if template variables derive from user input this is RCE; audit all data sources feeding into this eval()',
          severity: 'high',
        });
      }
    }

    // Pattern 3: Smarty display with user-controlled template path
    if (/\$smarty\s*->\s*display\s*\(/.test(line) || /Smarty\s*::\s*display\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (USER_INPUT_PATTERN.test(line) || USER_INPUT_PATTERN.test(contextWindow)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'smarty-user-template',
          issue: 'Smarty::display() called with user-controlled template path — allows path traversal to render arbitrary files as Smarty templates; whitelist allowed template names',
          severity: 'critical',
        });
      }
    }

    // Pattern 4: Custom renderer passing superglobals
    if (/render\s*\(\s*\$_(GET|POST|REQUEST)/.test(line) ||
        /->render\s*\([^)]{0,100}\$_(GET|POST|REQUEST)/.test(line)) {
      results.push({
        file: relFile,
        line: lineNum,
        pattern: 'renderer-superglobal',
        issue: 'Template renderer called with superglobal ($_GET/$_POST/$_REQUEST) as template path or data — user can control which template is rendered or inject template syntax',
        severity: 'high',
      });
    }
  }

  return results;
}

// ─── Twig file analysis ────────────────────────────────────────────────────────

function analyzeTwigFile(filePath: string, base: string): TemplateInjectionInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: TemplateInjectionInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Pattern: {{ variable | raw }} — output raw without escaping
    // Flag if variable name looks like it could come from user input
    const rawFilterRe = /\{\{\s*([\w.[\]'"]{1,80})\s*\|\s*raw\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = rawFilterRe.exec(line)) !== null) {
      const varName = m[1].toLowerCase();
      // Flag if variable name suggests user content
      const isSuspect = /user|input|content|html|body|text|comment|description|message|value|data|raw|unsafe/.test(varName);
      if (isSuspect) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'twig-raw-filter-suspect',
          issue: `Twig {{ ${m[1]} | raw }} with variable name suggesting user content — raw filter disables auto-escaping; if this variable contains user input it is a stored XSS / SSTI vector`,
          severity: 'high',
        });
      } else {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'twig-raw-filter',
          issue: `Twig {{ ${m[1]} | raw }} — raw filter disables auto-escaping; verify this variable is never populated with unvalidated user data`,
          severity: 'medium',
        });
      }
    }
  }

  return results;
}

function loadAll(appPath: string): TemplateInjectionInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: TemplateInjectionInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const f of collectFiles(srcDir, appPath, ['.php'])) {
      results.push(...analyzePhpFile(f, appPath));
    }
    for (const f of collectFiles(srcDir, appPath, ['.twig'])) {
      results.push(...analyzeTwigFile(f, appPath));
    }
  }

  return results.sort((a, b) => {
    const sev: Record<string, number> = { critical: 0, high: 1, medium: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpTemplateInjection(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No template injection vulnerabilities found in src/.\n\n' +
            'Checked: Twig createTemplate(), eval() with user data, Smarty::display() with user path, ' +
            '{{ variable | raw }} in Twig, custom renderer with superglobals.',
        }],
      };
    }

    const critical = items.filter((i) => i.severity === 'critical');
    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');

    let text = `PHP Template Injection Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:   ${items.length}\n`;
    text += `  Critical:         ${critical.length}\n`;
    text += `  High:             ${high.length}\n`;
    text += `  Medium:           ${medium.length}\n`;
    text += `  Files affected:   ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
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

export function getPhpTemplateInjectionStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `PHP Template Injection Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:     ${items.length}\n`;
    text += `Critical:  ${items.filter((i) => i.severity === 'critical').length}\n`;
    text += `High:      ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:    ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Files:     ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
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

export function getPhpTemplateInjectionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_template_injection',
      description: 'Scan src/**/*.php and src/**/*.twig for template injection: Twig createTemplate() with user input (SSTI), eval() with user data (RCE), Smarty::display() with user-controlled path, {{ var | raw }} in Twig on suspect variables, custom renderer with superglobals',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_template_injection_stats',
      description: 'Statistics for PHP template injection findings: total count, breakdown by severity (critical/high/medium) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
