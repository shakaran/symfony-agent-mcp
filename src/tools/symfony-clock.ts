// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Clock Component Inspector
 *
 * Symfony 6.2+ Clock component for testable time handling:
 *
 * ClockInterface implementations:
 *   - NativeClock (production)
 *   - MockClock (testing)
 *   - MonotonicClock
 *   - Custom implementations of ClockInterface
 *
 * Usage patterns:
 *   - $this->clock->now() — correct injection-based approach
 *   - ClockAwareTrait — trait that injects ClockInterface
 *   - #[AutowireServiceClosure('clock')] — DI wiring
 *
 * Anti-patterns detected (testability issues):
 *   - new \DateTime() / new \DateTimeImmutable() without arguments
 *   - date() calls in service/entity classes
 *   - time() calls in service/entity classes
 *   - strtotime('now') or strtotime('today') patterns
 *   - Carbon::now() / Carbon::today() (Carbon is fine in tests but problematic in services)
 *   - new \DateTimeImmutable('now') — testable with mockable if injected, but static
 *
 * Clock service registration:
 *   - services.yaml: clock service alias to NativeClock
 *   - Clock component auto-registered in Symfony 6.3+
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ClockAntiPattern {
  file: string;
  class: string;
  line: number;
  pattern: string;
  code: string;
}

interface ClockUsage {
  file: string;
  class: string;
  usesClockAwareTrait: boolean;
  usesClockInterface: boolean;
  usesNow: boolean;
}

const ANTI_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /new\s+\\?DateTime\s*\(\s*\)/g,           label: 'new \\DateTime()' },
  { regex: /new\s+\\?DateTimeImmutable\s*\(\s*\)/g,  label: 'new \\DateTimeImmutable()' },
  { regex: /new\s+\\?DateTimeImmutable\s*\(\s*'now'/g, label: "new \\DateTimeImmutable('now')" },
  { regex: /\bdate\s*\(/g,                            label: 'date()' },
  { regex: /\btime\s*\(\s*\)/g,                       label: 'time()' },
  { regex: /\bstrtotime\s*\(\s*['"](?:now|today)/g,  label: "strtotime('now')" },
  { regex: /Carbon\s*::\s*(?:now|today|createFromTimestamp)\s*\(/g, label: 'Carbon::now()' },
];

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function isTestFile(filePath: string): boolean {
  return filePath.includes('/tests/') || filePath.includes('/test/') ||
         filePath.endsWith('Test.php') || filePath.endsWith('Spec.php');
}

function scanForAntiPatterns(appPath: string): ClockAntiPattern[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: ClockAntiPattern[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    if (isTestFile(file)) continue;

    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // Skip if it's a fixture or migration (they're allowed to use raw dates)
    if (content.includes('extends Fixture') || content.includes('AbstractMigration')) continue;

    const lines = content.split('\n');
    for (const { regex, label } of ANTI_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        // Find line number
        const beforeMatch = content.slice(0, match.index);
        const lineNo      = beforeMatch.split('\n').length;
        const codeLine    = (lines[lineNo - 1] ?? '').trim();

        // Skip comments
        if (codeLine.startsWith('//') || codeLine.startsWith('*')) continue;

        results.push({
          file: path.relative(appPath, file),
          class: classM[1],
          line: lineNo,
          pattern: label,
          code: codeLine.slice(0, 80),
        });
      }
    }
  }
  return results;
}

function scanClockUsages(appPath: string): ClockUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: ClockUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const usesClockAwareTrait = content.includes('ClockAwareTrait');
    const usesClockInterface  = content.includes('ClockInterface') || content.includes(': ClockInterface');
    const usesNow             = content.includes('->now()') || content.includes('->sleep(');

    if (!usesClockAwareTrait && !usesClockInterface && !usesNow) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    results.push({
      file: path.relative(appPath, file),
      class: classM[1],
      usesClockAwareTrait,
      usesClockInterface,
      usesNow,
    });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listClockConfig(appPath: string): McpToolResult {
  try {
    const antiPatterns = scanForAntiPatterns(appPath);
    const usages       = scanClockUsages(appPath);

    if (antiPatterns.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Clock component usage or anti-patterns found.\n\nInstall:\n  composer require symfony/clock\n\nInject into services:\n  class MyService\n  {\n    use ClockAwareTrait;\n\n    public function getAge(): int\n    {\n      return $this->clock->now()->diff($birthDate)->y;\n    }\n  }\n\nThis makes all time-dependent logic testable with MockClock.',
        }],
      };
    }

    let text = `Symfony Clock Configuration\n${'='.repeat(55)}\n`;

    if (usages.length > 0) {
      text += `\nClock-aware classes (${usages.length}):\n`;
      for (const u of usages) {
        const method = u.usesClockAwareTrait ? 'ClockAwareTrait' :
                       u.usesClockInterface  ? 'ClockInterface' : 'now()';
        text += `  ${u.class.padEnd(40)} [${method}]  (${u.file})\n`;
      }
    }

    if (antiPatterns.length > 0) {
      // Group by pattern type for summary
      const byPattern = new Map<string, number>();
      for (const p of antiPatterns) byPattern.set(p.pattern, (byPattern.get(p.pattern) ?? 0) + 1);

      text += `\n⚠ Clock anti-patterns (${antiPatterns.length} occurrences):\n`;
      for (const [pattern, count] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
        text += `  ${pattern.padEnd(40)} ${count}x\n`;
      }

      text += `\nDetails (first 20):\n`;
      for (const p of antiPatterns.slice(0, 20)) {
        text += `  [${p.pattern}] ${p.class}:${p.line}  ${p.file}\n`;
        text += `    ${p.code}\n`;
      }
      if (antiPatterns.length > 20) {
        text += `  ... and ${antiPatterns.length - 20} more\n`;
      }
    } else {
      text += `\n✓ No clock anti-patterns detected\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getClockStats(appPath: string): McpToolResult {
  try {
    const antiPatterns = scanForAntiPatterns(appPath);
    const usages       = scanClockUsages(appPath);

    const byPattern = new Map<string, number>();
    for (const p of antiPatterns) byPattern.set(p.pattern, (byPattern.get(p.pattern) ?? 0) + 1);

    let text = `Clock Statistics\n${'='.repeat(40)}\n\n`;
    text += `Clock-aware classes:    ${usages.length}\n`;
    text += `  ClockAwareTrait:      ${usages.filter((u) => u.usesClockAwareTrait).length}\n`;
    text += `  ClockInterface:       ${usages.filter((u) => u.usesClockInterface).length}\n`;
    text += `Anti-patterns total:    ${antiPatterns.length}\n`;
    for (const [pattern, count] of byPattern) {
      text += `  ${pattern.padEnd(35)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getClockTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_clock_config',
      description: 'Show Symfony Clock component: ClockAwareTrait/ClockInterface usage, clock anti-patterns (new \\DateTime(), date(), time(), strtotime, Carbon::now() in service classes), testability issue detection, occurrence count by pattern type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_clock_stats',
      description: 'Show Clock statistics: clock-aware class count, ClockAwareTrait vs ClockInterface count, anti-pattern count by type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
