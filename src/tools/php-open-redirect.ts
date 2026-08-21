/**
 * PHP Open Redirect Scanner
 *
 * Scans src/ PHP for open redirect risks:
 *   - header('Location: ' . $variable) — medium severity
 *   - header with $_GET/$_POST/$_REQUEST — high severity
 *   - $response->redirect($variable) — medium severity
 *   - wp_redirect() / drupal_goto() — medium severity (CMS context)
 *   - ->redirectToRoute() with variable — low severity
 *   - Presence of in_array/strpos validation within 10 lines → lower severity to low
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface OpenRedirectInfo {
  file: string;
  line: number;
  fn: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ────────────────────────────────────────────────────────────

function collectPhpFiles(dir: string, base: string): string[] {
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
        files.push(...collectPhpFiles(full, base));
      } else if (e.name.endsWith('.php')) {
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

// ─── Validation window check ─────────────────────────────────────────────────

function hasValidationNearby(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 10);
  const end = Math.min(lines.length - 1, lineIdx + 10);
  for (let i = start; i <= end; i++) {
    const l = lines[i];
    if (l.includes('in_array') || l.includes('strpos')) {
      return true;
    }
  }
  return false;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): OpenRedirectInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: OpenRedirectInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // header() with Location and a variable
    if (line.includes('header(') && line.includes('Location') && line.includes('$')) {
      const hasSuperglobal = /\$_(GET|POST|REQUEST)/.test(line);
      let severity: 'high' | 'medium' | 'low' = hasSuperglobal ? 'high' : 'medium';
      const issue = hasSuperglobal
        ? 'header(Location) redirect using superglobal — user-controlled URL can redirect to arbitrary external site'
        : 'header(Location) redirect using variable — ensure URL is validated against an allowlist';

      if (severity !== 'high' && hasValidationNearby(lines, i)) {
        severity = 'low';
      }

      results.push({ file: relFile, line: lineNum, fn: 'header', issue, severity });
      continue;
    }

    // $response->redirect($variable)
    if (/->redirect\s*\(\s*\$/.test(line)) {
      let severity: 'medium' | 'low' = 'medium';
      if (hasValidationNearby(lines, i)) severity = 'low';
      results.push({
        file: relFile,
        line: lineNum,
        fn: '->redirect()',
        issue: 'Response redirect using variable — verify URL is validated against an allowlist before redirecting',
        severity,
      });
      continue;
    }

    // wp_redirect() or drupal_goto()
    if (/\bwp_redirect\s*\(/.test(line) || /\bdrupal_goto\s*\(/.test(line)) {
      const fn = /\bwp_redirect\s*\(/.test(line) ? 'wp_redirect()' : 'drupal_goto()';
      let severity: 'medium' | 'low' = 'medium';
      if (hasValidationNearby(lines, i)) severity = 'low';
      results.push({
        file: relFile,
        line: lineNum,
        fn,
        issue: `CMS redirect function ${fn} detected — if redirect target includes user input, validate against allowlist`,
        severity,
      });
      continue;
    }

    // ->redirectToRoute() with variable
    if (/->redirectToRoute\s*\(/.test(line) && line.includes('$')) {
      results.push({
        file: relFile,
        line: lineNum,
        fn: '->redirectToRoute()',
        issue: 'Symfony redirectToRoute with variable argument — Symfony routes are internal but confirm variable is not an external URL',
        severity: 'low',
      });
    }
  }

  return results;
}

function loadOpenRedirects(appPath: string): OpenRedirectInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: OpenRedirectInfo[] = [];
  for (const file of collectPhpFiles(srcDir, appPath)) {
    results.push(...analyzeFile(file, appPath));
  }
  return results.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return sev[a.severity] - sev[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listPhpOpenRedirect(appPath: string): McpToolResult {
  try {
    const items = loadOpenRedirects(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No open redirect risks found in src/.\n\n' +
            'Best practice: always validate redirect targets against an allowlist:\n' +
            '  if (!in_array($url, $allowedUrls)) { $url = \'/\'; }\n' +
            '  header(\'Location: \' . $url);',
        }],
      };
    }

    const high   = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low    = items.filter((i) => i.severity === 'low');

    let text = `PHP Open Redirect Scan\n${'='.repeat(55)}\n`;
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

export function getPhpOpenRedirectStats(appPath: string): McpToolResult {
  try {
    const items = loadOpenRedirects(appPath);

    const fnCounts: Record<string, number> = {};
    for (const item of items) {
      fnCounts[item.fn] = (fnCounts[item.fn] ?? 0) + 1;
    }

    let text = `PHP Open Redirect Statistics\n${'='.repeat(40)}\n\n`;
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

export function getPhpOpenRedirectTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_open_redirect',
      description: 'Scan PHP src/ for open redirect vulnerabilities: header(Location) with variables, superglobal-based redirects (high), response->redirect(), wp_redirect/drupal_goto (medium), redirectToRoute with variable (low); detects in_array/strpos allowlist validation to reduce severity',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_open_redirect_stats',
      description: 'Statistics for PHP open redirect findings: total count, counts by severity (high/medium/low), counts by redirect function',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
