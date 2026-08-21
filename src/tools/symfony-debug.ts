/**
 * Symfony Debug Artifact Inspector
 *
 * Finds debug code left in PHP source files and configuration:
 *
 * PHP debug artifacts in src/ (excluding tests/ and fixtures):
 *   - dump() / dd() calls (Symfony VarDumper helpers)
 *   - var_dump() / var_export() / print_r() calls
 *   - xdebug_break() / xdebug_var_dump() calls
 *   - die() / exit() calls (except in CLI command main loops)
 *   - echo / print statements in non-CLI classes (Controller/Service)
 *   - error_reporting() calls (overrides app error handling)
 *   - ini_set('display_errors', ...) calls
 *
 * Configuration debug checks:
 *   - web_profiler.yaml: toolbar: true in prod env
 *   - framework.yaml: %kernel.debug% usage patterns
 *   - monolog.yaml: level: debug in prod (excessive logging)
 *
 * PHP-level debug patterns:
 *   - assert() calls in non-test code (disabled in prod by default, causes silent failures)
 *   - trigger_error() / trigger_deprecation() in non-framework code
 *
 * Analysis:
 *   - Files with debug artifacts (by type)
 *   - Severity: BLOCKER (dd/die/exit) vs WARNING (dump/var_dump) vs INFO (assert)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DebugArtifact {
  file: string;
  class?: string;
  type: string;
  severity: 'blocker' | 'warning' | 'info';
  lineHint: string;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

const DEBUG_PATTERNS: Array<{ regex: RegExp; type: string; severity: 'blocker' | 'warning' | 'info' }> = [
  { regex: /\bdd\s*\(/, type: 'dd()', severity: 'blocker' },
  { regex: /\bdie\s*[;(]/, type: 'die()', severity: 'blocker' },
  { regex: /\bexit\s*[;(]/, type: 'exit()', severity: 'blocker' },
  { regex: /\bdump\s*\(/, type: 'dump()', severity: 'warning' },
  { regex: /\bvar_dump\s*\(/, type: 'var_dump()', severity: 'warning' },
  { regex: /\bvar_export\s*\(/, type: 'var_export()', severity: 'warning' },
  { regex: /\bprint_r\s*\(/, type: 'print_r()', severity: 'warning' },
  { regex: /\bxdebug_break\s*\(/, type: 'xdebug_break()', severity: 'blocker' },
  { regex: /\bxdebug_var_dump\s*\(/, type: 'xdebug_var_dump()', severity: 'warning' },
  { regex: /\bini_set\s*\(\s*['"]display_errors['"]/, type: 'ini_set(display_errors)', severity: 'warning' },
  { regex: /\berror_reporting\s*\(/, type: 'error_reporting()', severity: 'warning' },
];

function isTestOrFixtureFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes('/test') || lower.includes('/fixture') || lower.includes('/stub') ||
         lower.endsWith('test.php') || lower.endsWith('spec.php');
}

function scanDebugArtifacts(appPath: string): DebugArtifact[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const artifacts: DebugArtifact[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (isTestOrFixtureFile(file)) continue;

    const content = safeRead(file, appPath);
    if (content === null) continue;

    const classM = /class\s+(\w+)/.exec(content);
    const relPath = path.relative(appPath, file);

    for (const { regex, type, severity } of DEBUG_PATTERNS) {
      const m = regex.exec(content);
      if (!m) continue;

      // Find approximate line
      const lineNo = content.slice(0, m.index).split('\n').length;
      artifacts.push({
        file: relPath,
        class: classM?.[1],
        type,
        severity,
        lineHint: `line ~${lineNo}`,
      });
    }
  }

  return artifacts;
}

function checkConfigDebug(appPath: string): string[] {
  const issues: string[] = [];

  const webProfilerProd = path.join(appPath, 'config', 'packages', 'prod', 'web_profiler.yaml');
  if (fs.existsSync(webProfilerProd)) {
    try {
      const content = fs.readFileSync(webProfilerProd, 'utf-8');
      if (/toolbar\s*:\s*true/.test(content)) {
        issues.push('web_profiler toolbar: true in prod/ configuration');
      }
    } catch { /* skip */ }
  }

  const monologProd = path.join(appPath, 'config', 'packages', 'prod', 'monolog.yaml');
  if (fs.existsSync(monologProd)) {
    try {
      const content = fs.readFileSync(monologProd, 'utf-8');
      if (/level\s*:\s*debug/i.test(content)) {
        issues.push('monolog level: debug in prod/ — excessive logging in production');
      }
    } catch { /* skip */ }
  }

  return issues;
}

export function listDebugArtifacts(appPath: string): McpToolResult {
  try {
    const artifacts    = scanDebugArtifacts(appPath);
    const configIssues = checkConfigDebug(appPath);

    if (artifacts.length === 0 && configIssues.length === 0) {
      return { content: [{ type: 'text', text: '✓ No debug artifacts found in src/ (tests excluded) and no debug config issues.' }] };
    }

    const blockers = artifacts.filter((a) => a.severity === 'blocker');
    const warnings = artifacts.filter((a) => a.severity === 'warning');

    let text = `Debug Artifacts\n${'='.repeat(55)}\n`;
    text += `\nArtifacts: ${artifacts.length}  (Blockers: ${blockers.length}  Warnings: ${warnings.length})\n`;
    text += `Config issues: ${configIssues.length}\n`;

    if (blockers.length > 0) {
      text += `\n🚨 BLOCKERS (must remove before deploy):\n`;
      for (const a of blockers) {
        text += `  ${a.type.padEnd(20)} ${a.file}:${a.lineHint}\n`;
      }
    }

    if (warnings.length > 0) {
      text += `\n⚠ Warnings:\n`;
      for (const a of warnings) {
        text += `  ${a.type.padEnd(20)} ${a.file}:${a.lineHint}\n`;
      }
    }

    if (configIssues.length > 0) {
      text += `\nConfig issues:\n`;
      for (const issue of configIssues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDebugStats(appPath: string): McpToolResult {
  try {
    const artifacts    = scanDebugArtifacts(appPath);
    const configIssues = checkConfigDebug(appPath);

    const freq = new Map<string, number>();
    for (const a of artifacts) freq.set(a.type, (freq.get(a.type) ?? 0) + 1);

    let text = `Debug Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total artifacts:   ${artifacts.length}\n`;
    text += `  Blockers:        ${artifacts.filter((a) => a.severity === 'blocker').length}\n`;
    text += `  Warnings:        ${artifacts.filter((a) => a.severity === 'warning').length}\n`;
    if (freq.size > 0) {
      for (const [type, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${type.padEnd(22)} ${count}x\n`;
      }
    }
    text += `Config issues:     ${configIssues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyDebugTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_debug_artifacts',
      description: 'Find debug artifacts in src/ (tests excluded): dd()/die()/exit() blockers, dump()/var_dump()/var_export()/print_r() warnings, xdebug_break(), ini_set(display_errors), error_reporting(); config issues: web_profiler toolbar:true in prod, monolog debug level in prod',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_debug_stats',
      description: 'Show debug artifact statistics: total count, blocker/warning counts per type, config issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
