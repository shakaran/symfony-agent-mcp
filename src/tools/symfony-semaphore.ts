// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Semaphore Usage Inspector
 *
 * Reads framework.yaml semaphore section: semaphores map with store DSN, maxCount.
 * Scans src/ PHP for SemaphoreInterface, SemaphoreFactory, createSemaphore(),
 * acquire(), release() — checks release() in finally block.
 *
 * Warns: acquire() without release() in finally (deadlock risk),
 * semaphore without maxCount (defaults to 1, use Lock instead),
 * SemaphoreFactory not in framework.yaml, maxCount: 1 (use Lock).
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface SemaphoreConfigEntry {
  name: string;
  store?: string;
  maxCount?: number;
}

interface SemaphoreUsageInfo {
  name?: string;
  store?: string;
  maxCount?: number;
  hasAcquire: boolean;
  hasReleaseInFinally: boolean;
  file: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseSemaphoreConfig(appPath: string): SemaphoreConfigEntry[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'semaphore.yaml'),
  ];

  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;

    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const semaphoreSection = framework['semaphore'] as Record<string, unknown> | undefined;
    if (!semaphoreSection) continue;

    // semaphore: section can be a map of named semaphores or a simple DSN string
    if (typeof semaphoreSection === 'string') {
      return [{ name: 'default', store: semaphoreSection }];
    }

    const entries: SemaphoreConfigEntry[] = [];
    for (const [name, def] of Object.entries(semaphoreSection)) {
      if (!def || typeof def !== 'object') {
        entries.push({ name, store: String(def) });
        continue;
      }
      const d = def as Record<string, unknown>;
      const maxCount = d['max_count'] !== undefined ? Number(d['max_count']) : undefined;
      entries.push({
        name,
        store: d['store'] ? String(d['store']) : undefined,
        maxCount,
      });
    }
    return entries;
  }

  return [];
}

function detectReleaseInFinally(content: string, acquirePos: number): boolean {
  // Look for a finally block after the acquire call that contains release()
  const window = content.slice(acquirePos, Math.min(acquirePos + 3000, content.length));
  const finallyRe = /finally\s*\{[^}]{0,500}->release\s*\(/;
  return finallyRe.test(window);
}

function parseSemaphoreUsage(filePath: string, appPath: string): SemaphoreUsageInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasSemaphore =
    content.includes('SemaphoreInterface') ||
    content.includes('SemaphoreFactory') ||
    content.includes('createSemaphore(');

  if (!hasSemaphore) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const hasAcquire = content.includes('->acquire(');
  const hasRelease = content.includes('->release(');

  const acquirePos = content.indexOf('->acquire(');
  const hasReleaseInFinally = hasAcquire ? detectReleaseInFinally(content, acquirePos) : false;

  // Extract semaphore name from createSemaphore('name', maxCount)
  const createM = /createSemaphore\s*\(\s*'([^']{1,100})'(?:\s*,\s*(\d{1,5}))?/.exec(content)
    ?? /createSemaphore\s*\(\s*"([^"]{1,100})"(?:\s*,\s*(\d{1,5}))?/.exec(content);

  const semName = createM?.[1];
  const maxCount = createM?.[2] !== undefined ? parseInt(createM[2], 10) : undefined;

  const issues: string[] = [];

  if (hasAcquire && !hasReleaseInFinally) {
    if (!hasRelease) {
      issues.push('acquire() called but release() not found — semaphore will never be released (deadlock)');
    } else {
      issues.push('release() not in a finally block — exception will leave semaphore acquired (deadlock risk)');
    }
  }
  if (maxCount !== undefined && maxCount === 1) {
    issues.push('Semaphore maxCount is 1 — this is equivalent to a Lock; consider using symfony/lock instead');
  }
  if (maxCount === undefined && content.includes('createSemaphore(')) {
    issues.push('createSemaphore() without maxCount — defaults to 1 (mutex behaviour); set maxCount > 1 or use Lock');
  }

  return {
    name: semName,
    maxCount,
    hasAcquire,
    hasReleaseInFinally,
    file: path.relative(appPath, filePath),
    issues,
  };
}

export function listSemaphoreUsage(appPath: string): McpToolResult {
  try {
    const config = parseSemaphoreConfig(appPath);
    const srcDir = path.join(appPath, 'src');
    const usages: SemaphoreUsageInfo[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseSemaphoreUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    if (config.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony Semaphore configuration or usage found.\n\nExample config/packages/framework.yaml:\n  framework:\n    semaphore:\n      my_semaphore:\n        store: "%env(SEMAPHORE_DSN)%"\n        max_count: 5',
        }],
      };
    }

    const totalIssues = usages.reduce((s, u) => s + u.issues.length, 0);
    let text = `Symfony Semaphore\n${'='.repeat(55)}\n`;

    if (config.length > 0) {
      text += `\nConfigured semaphores (${config.length}):\n`;
      for (const c of config) {
        text += `  ${c.name}  store: ${c.store ?? '(inherited)'}  maxCount: ${c.maxCount ?? '(default 1)'}\n`;
        if (c.maxCount === 1) text += `    WARNING: maxCount: 1 — equivalent to a Lock\n`;
      }
    } else {
      text += '\nNo semaphore configuration found in framework.yaml\n';
    }

    if (usages.length > 0) {
      text += `\nSemaphore usage in src/ (${usages.length} files)  Issues: ${totalIssues}\n`;
      for (const u of usages.sort((a, b) => b.issues.length - a.issues.length)) {
        text += `\n  ${u.file}\n`;
        if (u.name) text += `    Semaphore: ${u.name}  maxCount: ${u.maxCount ?? '(not set)'}\n`;
        text += `    acquire: ${u.hasAcquire ? 'yes' : 'no'}  release in finally: ${u.hasReleaseInFinally ? 'yes' : 'NO'}\n`;
        for (const issue of u.issues) {
          text += `    WARNING: ${issue}\n`;
        }
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

export function getSemaphoreStats(appPath: string): McpToolResult {
  try {
    const config = parseSemaphoreConfig(appPath);
    const srcDir = path.join(appPath, 'src');
    const usages: SemaphoreUsageInfo[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const u = parseSemaphoreUsage(file, appPath);
        if (u) usages.push(u);
      }
    }

    let text = `Semaphore Statistics\n${'='.repeat(40)}\n\n`;
    text += `Configured semaphores:        ${config.length}\n`;
    text += `  maxCount: 1 (use Lock):     ${config.filter((c) => c.maxCount === 1).length}\n`;
    text += `Files with semaphore usage:   ${usages.length}\n`;
    text += `  With acquire():             ${usages.filter((u) => u.hasAcquire).length}\n`;
    text += `  Release in finally:         ${usages.filter((u) => u.hasReleaseInFinally).length}\n`;
    text += `  Missing finally release:    ${usages.filter((u) => u.hasAcquire && !u.hasReleaseInFinally).length}\n`;
    text += `Issues detected:              ${usages.reduce((s, u) => s + u.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSemaphoreTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_semaphore_usage',
      description: 'Show Symfony Semaphore configuration and usage: configured semaphores with store/maxCount, createSemaphore/acquire/release detection, release-in-finally check; warns on acquire without finally release (deadlock), maxCount:1 (use Lock instead), missing maxCount',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_semaphore_stats',
      description: 'Show Semaphore statistics: configured count, maxCount:1 count, files with usage, acquire count, release-in-finally count, missing finally count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
