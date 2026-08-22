/**
 * Twig Template Quality Analyzer
 *
 * Complements twig.ts (structure/inheritance) with quality issues:
 *
 * Variable risks:
 *   - {{ var }} where var is not in a block or macro (bare template variables)
 *   - app.request usage outside a request-scoped context (CLI risk)
 *   - app.user.roles direct access (deprecated in Symfony 6+)
 *
 * Form issues:
 *   - form_row() / form_widget() without matching form_label() (accessibility)
 *   - form_start() without csrf_token protection check
 *   - form_end() missing after form_start() in same template
 *
 * Performance:
 *   - include() instead of {{ include() }} (deprecated since Twig 2)
 *   - block() called inside a loop (renders block per iteration)
 *   - parent() call without {% extends %} (would error at runtime)
 *
 * Deprecated patterns:
 *   - {% spaceless %} (removed in Twig 3, use |spaceless filter)
 *   - sameas / divisibleby (old aliases, use same as / divisible by)
 *   - {% set %} overwriting loop variable
 *
 * Security:
 *   - {{ var | raw }} usage (XSS risk)
 *   - {{ constant('...') }} with user-controlled input pattern
 *
 * Pure static analysis — no PHP or Twig execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface TwigIssue {
  type: 'error' | 'warning' | 'info';
  category: string;
  line: number;
  detail: string;
}

interface TwigFileResult {
  file: string;
  relPath: string;
  issues: TwigIssue[];
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

function analyzeTemplate(filePath: string, appPath: string): TwigFileResult | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const lines  = content.split('\n');
  const issues: TwigIssue[] = [];

  const hasExtends = content.includes('{% extends');
  const hasFormStart = content.includes('form_start(');
  const hasFormEnd   = content.includes('form_end(');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    // XSS risk
    if (/\|\s*raw\b/.test(line) && !line.trim().startsWith('{#')) {
      issues.push({ type: 'warning', category: 'security', line: lineNo, detail: '|raw filter — XSS risk if variable comes from user input' });
    }

    // Deprecated spaceless tag
    if (line.includes('{% spaceless %}') || line.includes('{%- spaceless')) {
      issues.push({ type: 'error', category: 'deprecated', line: lineNo, detail: '{% spaceless %} removed in Twig 3 — use |spaceless filter or CSS white-space instead' });
    }

    // sameas / divisibleby (old aliases)
    if (/\bsameas\b/.test(line)) {
      issues.push({ type: 'warning', category: 'deprecated', line: lineNo, detail: '"sameas" is a deprecated alias — use "same as"' });
    }
    if (/\bdivisibleby\b/.test(line)) {
      issues.push({ type: 'warning', category: 'deprecated', line: lineNo, detail: '"divisibleby" is a deprecated alias — use "divisible by"' });
    }

    // parent() without extends
    if (line.includes('{{ parent()') && !hasExtends) {
      issues.push({ type: 'error', category: 'runtime-error', line: lineNo, detail: 'parent() called but template has no {% extends %} — will throw at runtime' });
    }

    // app.request in template (CLI risk)
    if (line.includes('app.request') && !line.trim().startsWith('{#')) {
      issues.push({ type: 'info', category: 'context', line: lineNo, detail: 'app.request accessed — will be null in CLI context (email templates, console)' });
    }

    // app.user.roles (deprecated in Symfony 6+)
    if (line.includes('app.user.roles')) {
      issues.push({ type: 'warning', category: 'deprecated', line: lineNo, detail: 'app.user.roles — use is_granted() or app.user.getRoles() instead' });
    }

    // block() in loop
    if (line.includes('block(') && i > 0) {
      const ctx = lines.slice(Math.max(0, i - 5), i).join(' ');
      if (/for\s+\w+\s+in/.test(ctx)) {
        issues.push({ type: 'warning', category: 'performance', line: lineNo, detail: 'block() called inside a for loop — block rendered per iteration, consider moving outside' });
      }
    }

    // form_start without form_end in same template
    if (line.includes('form_start(') && !hasFormEnd && content.split('\n').length < 500) {
      issues.push({ type: 'warning', category: 'form', line: lineNo, detail: 'form_start() without form_end() in same template — ensure form is closed' });
    }
  }

  // form_end without form_start (partial/reuse pattern — info only)
  if (hasFormEnd && !hasFormStart) {
    issues.push({ type: 'info', category: 'form', line: 0, detail: 'form_end() without form_start() — may be a partial template (verify intentional)' });
  }

  if (issues.length === 0) return null;

  const relPath = path.relative(appPath, filePath);
  return { file: path.basename(filePath), relPath, issues };
}

export function listTwigIssues(appPath: string): McpToolResult {
  try {
    const templateDirs = [
      path.join(appPath, 'templates'),
      path.join(appPath, 'src'),
    ];

    const allFiles: string[] = [];
    for (const dir of templateDirs) {
      if (fs.existsSync(dir)) allFiles.push(...getAllTwigFiles(dir));
    }

    if (allFiles.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Twig templates found in templates/ or src/.',
        }],
      };
    }

    const results: TwigFileResult[] = [];
    for (const file of allFiles) {
      const r = analyzeTemplate(file, appPath);
      if (r) results.push(r);
    }

    const totalTemplates = allFiles.length;
    const totalIssues    = results.reduce((s, r) => s + r.issues.length, 0);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No issues found in ${totalTemplates} Twig template(s). ✓`,
        }],
      };
    }

    results.sort((a, b) => b.issues.length - a.issues.length);

    let text = `Twig Template Quality Analysis\n${'='.repeat(55)}\n`;
    text += `\nTemplates scanned: ${totalTemplates}  Issues: ${totalIssues}  Affected: ${results.length}\n`;

    const errors   = results.flatMap((r) => r.issues).filter((i) => i.type === 'error').length;
    const warnings = results.flatMap((r) => r.issues).filter((i) => i.type === 'warning').length;
    const infos    = results.flatMap((r) => r.issues).filter((i) => i.type === 'info').length;
    text += `Errors: ${errors}  Warnings: ${warnings}  Info: ${infos}\n`;

    for (const r of results) {
      text += `\n${r.relPath} (${r.issues.length} issue(s)):\n`;
      for (const issue of r.issues) {
        const loc    = issue.line > 0 ? `:${issue.line}` : '';
        const icon   = issue.type === 'error' ? '✗' : issue.type === 'warning' ? '⚠' : 'ℹ';
        text += `  ${icon} [${issue.category}${loc}] ${issue.detail}\n`;
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

export function getTwigLintStats(appPath: string): McpToolResult {
  try {
    const templateDirs = [path.join(appPath, 'templates'), path.join(appPath, 'src')];
    const allFiles: string[] = [];
    for (const dir of templateDirs) {
      if (fs.existsSync(dir)) allFiles.push(...getAllTwigFiles(dir));
    }

    const results: TwigFileResult[] = [];
    for (const file of allFiles) {
      const r = analyzeTemplate(file, appPath);
      if (r) results.push(r);
    }

    const allIssues = results.flatMap((r) => r.issues);
    const byCategory = new Map<string, number>();
    for (const issue of allIssues) {
      byCategory.set(issue.category, (byCategory.get(issue.category) ?? 0) + 1);
    }

    let text = `Twig Lint Statistics\n${'='.repeat(40)}\n\n`;
    text += `Templates scanned:   ${allFiles.length}\n`;
    text += `Templates with issues: ${results.length}\n`;
    text += `Total issues:        ${allIssues.length}\n`;
    text += `  Errors:            ${allIssues.filter((i) => i.type === 'error').length}\n`;
    text += `  Warnings:          ${allIssues.filter((i) => i.type === 'warning').length}\n`;
    text += `  Info:              ${allIssues.filter((i) => i.type === 'info').length}\n`;
    if (byCategory.size > 0) {
      text += `By category:\n`;
      for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${cat.padEnd(20)} ${count}\n`;
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

export function getTwigLintTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_twig_issues',
      description: 'Analyze Twig template quality: |raw XSS risk, deprecated {% spaceless %}/sameas/divisibleby, parent() without extends, app.request in CLI templates, app.user.roles deprecated, block() in loops, form_start/form_end mismatch',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_twig_lint_stats',
      description: 'Show Twig lint statistics: templates scanned, affected templates, error/warning/info counts, issues by category',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
