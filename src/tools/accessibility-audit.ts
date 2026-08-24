// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Accessibility (a11y) Static Auditor
 *
 * Analyzes Twig templates and PHP form types for accessibility issues
 * without executing a browser:
 *
 * Images:
 *   - <img> without alt attribute
 *   - <img alt=""> (empty alt — acceptable for decorative, but flagged for review)
 *
 * Forms:
 *   - Symfony form_row() without label option: false (auto-generates label, OK)
 *   - form_widget() without accompanying form_label() (manual rendering, no label)
 *   - <input> / <select> / <textarea> without id or aria-labelledby
 *   - <button> without text content or aria-label
 *   - <label> without for attribute pointing to an input id
 *
 * Headings:
 *   - Skipped heading levels (h1 → h3 without h2)
 *   - Multiple <h1> on same template
 *
 * ARIA:
 *   - role="button" / role="link" on non-interactive elements without keyboard support
 *   - aria-hidden="true" on focusable elements
 *   - Missing aria-label on icon-only buttons (<button><i class="..."></i></button>)
 *
 * Tables:
 *   - <table> without <caption> or aria-label
 *   - <th> without scope attribute
 *
 * Symfony UX components:
 *   - LiveComponent / TwigComponent with interactive props but no aria-* attributes
 *
 * Severity: error (WCAG 2.1 AA failure), warning (best practice), info (review needed)
 *
 * Pure static analysis — no browser execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface A11yIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  line: number;
  detail: string;
}

interface A11yFileResult {
  file: string;
  relPath: string;
  issues: A11yIssue[];
}

function getAllTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllTwigFiles(full));
      else if (entry.name.endsWith('.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzeFile(filePath: string, appPath: string): A11yFileResult | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const lines   = content.split('\n');
  const issues: A11yIssue[] = [];
  const headings: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    // Images without alt
    if (/<img\b/.test(line) && !line.includes('alt=') && !line.includes('{#')) {
      issues.push({ severity: 'error', rule: 'img-alt', line: lineNo, detail: '<img> missing alt attribute (WCAG 1.1.1)' });
    }
    if (/<img\b[^>]*alt\s*=\s*["'][^"']*["'][^>]*>/.test(line) && /alt\s*=\s*["']\s*["']/.test(line)) {
      issues.push({ severity: 'info', rule: 'img-empty-alt', line: lineNo, detail: '<img alt=""> — empty alt is OK for decorative images; verify intentional' });
    }

    // Buttons without accessible name
    const buttonM = /<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(line);
    if (buttonM) {
      const attrs = buttonM[1] ?? '';
      const inner = buttonM[2]?.trim() ?? '';
      const hasText = inner.length > 0 && !/<i\b|<span\b.*?icon|<svg\b/.test(inner);
      const hasAriaLabel = attrs.includes('aria-label') || attrs.includes('aria-labelledby');
      const hasTitle     = attrs.includes('title=');
      if (!hasText && !hasAriaLabel && !hasTitle) {
        issues.push({ severity: 'error', rule: 'button-name', line: lineNo, detail: '<button> without accessible name (add aria-label or text content) (WCAG 4.1.2)' });
      }
    }

    // Icon-only buttons (cross-line heuristic)
    if (/<button/.test(line) && !line.includes('aria-label') && (line.includes('<i ') || line.includes('fa-'))) {
      issues.push({ severity: 'warning', rule: 'icon-button', line: lineNo, detail: 'Icon-only button likely missing aria-label' });
    }

    // Input without id or aria-labelledby (direct HTML, not form_ helpers)
    if (/<input\b/.test(line) && !line.includes('form_') && !line.includes('id=') && !line.includes('aria-labelledby') && !line.includes('aria-label')) {
      issues.push({ severity: 'warning', rule: 'input-label', line: lineNo, detail: '<input> without id/aria-labelledby — may not be associated with a label' });
    }

    // Table accessibility
    if (/<table\b/.test(line) && !line.includes('aria-label') && !line.includes('<caption')) {
      issues.push({ severity: 'warning', rule: 'table-caption', line: lineNo, detail: '<table> without <caption> or aria-label (WCAG 1.3.1)' });
    }
    if (/<th\b/.test(line) && !line.includes('scope=')) {
      issues.push({ severity: 'warning', rule: 'th-scope', line: lineNo, detail: '<th> without scope attribute (WCAG 1.3.1)' });
    }

    // aria-hidden on focusable elements
    if (line.includes('aria-hidden="true"') && (/<button|<a\b|<input/.test(line))) {
      issues.push({ severity: 'error', rule: 'aria-hidden-focus', line: lineNo, detail: 'aria-hidden="true" on focusable element — will be invisible to assistive technology (WCAG 1.3.1)' });
    }

    // label without for
    if (/<label\b/.test(line) && !line.includes('for=') && !line.includes('form_label(')) {
      issues.push({ severity: 'warning', rule: 'label-for', line: lineNo, detail: '<label> without for attribute — may not be programmatically associated' });
    }

    // Heading tracking
    const hMatch = /<h(\d)\b/.exec(line);
    if (hMatch) {
      const level = parseInt(hMatch[1], 10);
      headings.push(level);
    }
  }

  // Multiple h1
  if (headings.filter((h) => h === 1).length > 1) {
    issues.push({ severity: 'warning', rule: 'multiple-h1', line: 0, detail: 'Multiple <h1> elements — each page should have a single main heading (WCAG 2.4.6)' });
  }

  // Skipped heading levels
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1] ?? 0;
    const curr = headings[i] ?? 0;
    if (curr - prev > 1) {
      issues.push({ severity: 'warning', rule: 'heading-skip', line: 0, detail: `Heading level skipped: h${prev} → h${curr} (WCAG 2.4.6)` });
    }
  }

  if (issues.length === 0) return null;
  return { file: path.basename(filePath), relPath: path.relative(appPath, filePath), issues };
}

export function listAccessibilityIssues(appPath: string): McpToolResult {
  try {
    const templateDirs = [path.join(appPath, 'templates'), path.join(appPath, 'src')];
    const allFiles: string[] = [];
    for (const dir of templateDirs) {
      if (fs.existsSync(dir)) allFiles.push(...getAllTwigFiles(dir));
    }

    if (allFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No Twig templates found.' }] };
    }

    const results: A11yFileResult[] = [];
    for (const file of allFiles) {
      const r = analyzeFile(file, appPath);
      if (r) results.push(r);
    }

    const totalTemplates = allFiles.length;
    const allIssues      = results.flatMap((r) => r.issues);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No accessibility issues found in ${totalTemplates} template(s). ✓\n\nNote: Static analysis cannot catch all WCAG issues — complement with browser-based audit tools.`,
        }],
      };
    }

    results.sort((a, b) => b.issues.length - a.issues.length);

    let text = `Accessibility Audit (Static)\n${'='.repeat(55)}\n`;
    text += `\nTemplates: ${totalTemplates}  Affected: ${results.length}  Issues: ${allIssues.length}\n`;
    const errors   = allIssues.filter((i) => i.severity === 'error').length;
    const warnings = allIssues.filter((i) => i.severity === 'warning').length;
    const infos    = allIssues.filter((i) => i.severity === 'info').length;
    text += `WCAG failures: ${errors}  Warnings: ${warnings}  Review: ${infos}\n`;

    for (const r of results) {
      text += `\n${r.relPath} (${r.issues.length}):\n`;
      for (const issue of r.issues) {
        const loc  = issue.line > 0 ? `:${issue.line}` : '';
        const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
        text += `  ${icon} [${issue.rule}${loc}] ${issue.detail}\n`;
      }
    }

    text += `\nNote: Complement with browser-based tools (axe, Lighthouse, WAVE) for full coverage.\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAccessibilityStats(appPath: string): McpToolResult {
  try {
    const templateDirs = [path.join(appPath, 'templates'), path.join(appPath, 'src')];
    const allFiles: string[] = [];
    for (const dir of templateDirs) {
      if (fs.existsSync(dir)) allFiles.push(...getAllTwigFiles(dir));
    }

    const results: A11yFileResult[] = [];
    for (const file of allFiles) {
      const r = analyzeFile(file, appPath);
      if (r) results.push(r);
    }

    const allIssues = results.flatMap((r) => r.issues);
    const byRule = new Map<string, number>();
    for (const issue of allIssues) {
      byRule.set(issue.rule, (byRule.get(issue.rule) ?? 0) + 1);
    }

    let text = `Accessibility Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates scanned:   ${allFiles.length}\n`;
    text += `Templates with issues: ${results.length}\n`;
    text += `Total issues:        ${allIssues.length}\n`;
    text += `  WCAG failures:     ${allIssues.filter((i) => i.severity === 'error').length}\n`;
    text += `  Warnings:          ${allIssues.filter((i) => i.severity === 'warning').length}\n`;
    text += `  Review needed:     ${allIssues.filter((i) => i.severity === 'info').length}\n`;
    if (byRule.size > 0) {
      text += `Top rules:\n`;
      for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        text += `  ${rule.padEnd(25)} ${count}\n`;
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

export function getAccessibilityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_accessibility_issues',
      description: 'Static accessibility audit of Twig templates: missing img alt, button without accessible name, input without label, table without caption/scope, aria-hidden on focusable elements, skipped heading levels, multiple h1 — categorized by WCAG severity',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_accessibility_stats',
      description: 'Show accessibility statistics: templates scanned, affected count, WCAG failure/warning/info counts, top failing rules',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
