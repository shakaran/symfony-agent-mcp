/**
 * Symfony Stopwatch Usage Inspector
 *
 * Analyzes Symfony Stopwatch component usage outside the Profiler.
 *
 * Detects in src/:
 *   - StopwatchInterface or Stopwatch injection in constructor
 *   - $this->stopwatch->start() and ->stop() calls
 *   - Section names and categories used
 *   - $stopwatch->lap() calls
 *   - Debug guard: if ($this->kernel->isDebug()) or similar
 *
 * Also checks config/packages/framework.yaml for stopwatch: { enabled: true }
 *
 * Warnings:
 *   - Stopwatch in service NOT guarded by debug check (always active in production)
 *   - start() without matching stop() in same file (resource leak pattern)
 *   - Stopwatch in high-frequency service (Repository, EntityListener) without debug guard
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface StopwatchSection {
  name: string;
  category: string | null;
}

interface StopwatchUsage {
  class: string;
  file: string;
  sections: StopwatchSection[];
  startCount: number;
  stopCount: number;
  lapCount: number;
  hasDebugGuard: boolean;
  isHighFrequency: boolean;
  issues: string[];
}

const HIGH_FREQUENCY_PATTERNS = [
  'Repository',
  'EntityListener',
  'DoctrineListener',
  'EventSubscriber',
  'EventListener',
];

const DEBUG_GUARD_PATTERNS = [
  '->isDebug()',
  'kernel->isDebug',
  'isDebug()',
  'APP_DEBUG',
  'getEnvironment() === \'dev\'',
  "getEnvironment() === \"dev\"",
  '->getEnvironment() ===',
];

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

function hasStopwatchInjection(content: string): boolean {
  return (
    content.includes('StopwatchInterface') ||
    content.includes('Stopwatch $') ||
    content.includes('Stopwatch $stopwatch') ||
    (content.includes('stopwatch') && content.includes('__construct'))
  );
}

function extractSections(content: string): StopwatchSection[] {
  const sections: StopwatchSection[] = [];
  // Match ->start('section-name') or ->start('section-name', 'category')
  const re = /->start\s*\(\s*'([^']{1,100})'(?:\s*,\s*'([^']{1,100})')?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    sections.push({ name: m[1], category: m[2] ?? null });
  }
  // Also match double-quoted variants
  const reDouble = /->start\s*\(\s*"([^"]{1,100})"(?:\s*,\s*"([^"]{1,100})")?\s*\)/g;
  while ((m = reDouble.exec(content)) !== null) {
    sections.push({ name: m[1], category: m[2] ?? null });
  }
  return sections;
}

function parseStopwatchUsage(filePath: string, appPath: string): StopwatchUsage | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  if (!hasStopwatchInjection(content)) return null;
  if (!content.includes('->start(') && !content.includes('->stop(') && !content.includes('->lap(')) return null;
  // Skip Symfony core
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const sections = extractSections(content);
  const startCount = (content.match(/->start\s*\(/g) ?? []).length;
  const stopCount = (content.match(/->stop\s*\(/g) ?? []).length;
  const lapCount = (content.match(/->lap\s*\(/g) ?? []).length;

  const hasDebugGuard = DEBUG_GUARD_PATTERNS.some((p) => content.includes(p));
  const isHighFrequency = HIGH_FREQUENCY_PATTERNS.some((p) => classM[1].includes(p));

  const issues: string[] = [];

  if (!hasDebugGuard) {
    issues.push('Stopwatch is NOT guarded by debug check — runs in production (overhead in every request)');
  }

  if (startCount > stopCount) {
    issues.push(`${startCount} start() calls vs ${stopCount} stop() calls — potential resource leak (unmatched start)`);
  }

  if (isHighFrequency && !hasDebugGuard) {
    issues.push('Stopwatch in high-frequency service without debug guard — significant performance impact');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    sections,
    startCount,
    stopCount,
    lapCount,
    hasDebugGuard,
    isHighFrequency,
    issues,
  };
}

function checkFrameworkStopwatchConfig(appPath: string): boolean | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const f of candidates) {
    const raw = parseYamlFile(f) as Record<string, unknown> | null;
    if (!raw) continue;
    const fw = (raw['framework'] ?? raw) as Record<string, unknown>;
    const sw = fw['stopwatch'] as Record<string, unknown> | undefined;
    if (!sw) continue;
    if (sw['enabled'] === true || sw['enabled'] === 'true') return true;
    if (sw['enabled'] === false || sw['enabled'] === 'false') return false;
  }
  return null;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listStopwatchUsage(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const usages: StopwatchUsage[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const u = parseStopwatchUsage(file, appPath);
      if (u) usages.push(u);
    }

    const frameworkEnabled = checkFrameworkStopwatchConfig(appPath);

    if (usages.length === 0) {
      let text = 'No Stopwatch usage found in src/.\n';
      if (frameworkEnabled === true) {
        text += '\nNote: framework.yaml has stopwatch enabled: true\n';
      }
      return { content: [{ type: 'text', text }] };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Symfony Stopwatch Usage\n${'='.repeat(55)}\n`;
    text += `\nServices using Stopwatch: ${usages.length}  Issues: ${totalIssues}\n`;

    if (frameworkEnabled !== null) {
      text += `framework.yaml stopwatch.enabled: ${frameworkEnabled ? 'true' : 'false'}\n`;
    }

    for (const u of usages.sort((a, b) => a.class.localeCompare(b.class))) {
      text += `\n  ${u.class}  (${u.file})\n`;
      text += `    start: ${u.startCount}  stop: ${u.stopCount}  lap: ${u.lapCount}\n`;
      text += `    Debug guarded: ${u.hasDebugGuard ? 'yes' : 'NO'}\n`;
      if (u.isHighFrequency) {
        text += `    High-frequency class: yes\n`;
      }
      if (u.sections.length > 0) {
        const sectionNames = [...new Set(u.sections.map((s) => s.name))];
        text += `    Sections: ${sectionNames.join(', ')}\n`;
        const withCategories = u.sections.filter((s) => s.category);
        if (withCategories.length > 0) {
          text += `    Categories: ${[...new Set(withCategories.map((s) => s.category!))].join(', ')}\n`;
        }
      }
      for (const issue of u.issues) {
        text += `    WARNING: ${issue}\n`;
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

export function getStopwatchStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const files = fs.existsSync(srcDir) ? getAllPhpFiles(srcDir) : [];
    const usages: StopwatchUsage[] = [];

    for (const file of files) {
      const u = parseStopwatchUsage(file, appPath);
      if (u) usages.push(u);
    }

    const frameworkEnabled = checkFrameworkStopwatchConfig(appPath);

    let text = `Stopwatch Statistics\n${'='.repeat(40)}\n\n`;
    text += `Services with Stopwatch:    ${usages.length}\n`;
    text += `  Debug-guarded:            ${usages.filter((u) => u.hasDebugGuard).length}\n`;
    text += `  NOT guarded (production): ${usages.filter((u) => !u.hasDebugGuard).length}\n`;
    text += `  High-frequency service:   ${usages.filter((u) => u.isHighFrequency).length}\n`;
    text += `Total start() calls:        ${usages.reduce((s, u) => s + u.startCount, 0)}\n`;
    text += `Total stop() calls:         ${usages.reduce((s, u) => s + u.stopCount, 0)}\n`;
    text += `Total lap() calls:          ${usages.reduce((s, u) => s + u.lapCount, 0)}\n`;
    text += `Issues detected:            ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    if (frameworkEnabled !== null) {
      text += `framework.yaml enabled:     ${frameworkEnabled ? 'true' : 'false'}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getStopwatchTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_stopwatch_usage',
      description: 'Show Symfony Stopwatch usage outside Profiler: StopwatchInterface injections, start/stop/lap calls, section names, debug guard detection, production-overhead warning for unguarded stopwatch, start-without-stop leak warning, high-frequency service warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_stopwatch_stats',
      description: 'Show Stopwatch statistics: service count, debug-guarded vs unguarded, high-frequency service count, total start/stop/lap call counts, framework.yaml enabled flag',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
