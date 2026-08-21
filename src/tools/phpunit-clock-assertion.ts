/**
 * PHPUnit Clock Assertion Static Analyzer
 *
 * Scans tests/**\/*.php for Symfony Clock mock assertion patterns:
 *
 * - ClockSensitiveTrait used without calling MockClock::modify() or MockClock::sleep()
 * - Time-dependent assertions (assertGreaterThan(time(), ...)) without clock injection
 * - new \DateTime() / new \DateTimeImmutable() without arguments in test context
 * - sleep() / usleep() in test code — use clock mocking instead
 * - ClockInterface dependency not injected (hardcoded new SystemClock())
 * - Missing use ClockSensitiveTrait in test class that tests time-sensitive logic
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpunitClockAssertionInfo {
  file: string;
  type: 'trait' | 'assertion' | 'datetime' | 'sleep' | 'injection' | 'missing-trait';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzeClockFile(filePath: string, appPath: string): PhpunitClockAssertionInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const results: PhpunitClockAssertionInfo[] = [];

  const hasClockSensitiveTrait = content.includes('ClockSensitiveTrait');
  const hasModify = content.includes('->modify(');
  const hasSleep = content.includes('->sleep(');

  // trait used without MockClock calls
  if (hasClockSensitiveTrait && !hasModify && !hasSleep) {
    results.push({
      file: relFile,
      type: 'trait',
      issues: ['ClockSensitiveTrait used but neither ->modify() nor ->sleep() is called — clock is never advanced'],
    });
  }

  // time-dependent assertions
  const assertionIssues: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/assertGreaterThan\(time\(/.test(line) || /assertLessThan\(time\(/.test(line)) {
      assertionIssues.push(`Line ${lineNo}: time()-based assertion without clock injection — test may be flaky`);
    }
  }
  if (assertionIssues.length > 0) {
    results.push({ file: relFile, type: 'assertion', issues: assertionIssues });
  }

  // new \DateTime() / new \DateTimeImmutable() without arguments
  const datetimeIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/new\s+\\?DateTime\(\s*\)/.test(line) || /new\s+\\?DateTimeImmutable\(\s*\)/.test(line)) {
      datetimeIssues.push(`Line ${lineNo}: new DateTime()/DateTimeImmutable() with no argument — not mockable, ties test to wall clock`);
    }
  }
  if (datetimeIssues.length > 0) {
    results.push({ file: relFile, type: 'datetime', issues: datetimeIssues });
  }

  // sleep() / usleep() in test code
  const sleepIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/\bsleep\(/.test(line) || /\busleep\(/.test(line)) {
      sleepIssues.push(`Line ${lineNo}: sleep()/usleep() call — use ClockSensitiveTrait with ->sleep() instead`);
    }
  }
  if (sleepIssues.length > 0) {
    results.push({ file: relFile, type: 'sleep', issues: sleepIssues });
  }

  // hardcoded new SystemClock()
  const injectionIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/new\s+\\?SystemClock\(/.test(line)) {
      injectionIssues.push(`Line ${lineNo}: new SystemClock() — inject ClockInterface instead of hardcoding the implementation`);
    }
  }
  if (injectionIssues.length > 0) {
    results.push({ file: relFile, type: 'injection', issues: injectionIssues });
  }

  // missing ClockSensitiveTrait when time-sensitive logic present
  const hasTimeSensitive = /\btime\(\)/.test(content) || /\bDateTime\b/.test(content);
  if (hasTimeSensitive && !hasClockSensitiveTrait) {
    results.push({
      file: relFile,
      type: 'missing-trait',
      issues: ['Test uses time() or DateTime but does not use ClockSensitiveTrait — clock cannot be mocked'],
    });
  }

  return results;
}

export function listPhpunitClockAssertion(appPath: string): McpToolResult {
  try {
    const testsDir = path.join(appPath, 'tests');
    const phpFiles = scanDirRecursive(testsDir, '.php');

    if (phpFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP test files found in tests/.' }] };
    }

    const allIssues: PhpunitClockAssertionInfo[] = [];
    for (const file of phpFiles) {
      allIssues.push(...analyzeClockFile(file, appPath));
    }

    if (allIssues.length === 0) {
      return {
        content: [{ type: 'text', text: `No clock assertion issues found in ${phpFiles.length} test file(s). ✓` }],
      };
    }

    const byFile = new Map<string, PhpunitClockAssertionInfo[]>();
    for (const issue of allIssues) {
      const existing = byFile.get(issue.file) ?? [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }

    let text = `PHPUnit Clock Assertion Issues\n${'='.repeat(50)}\n`;
    text += `\nTest files scanned: ${phpFiles.length}  Files with issues: ${byFile.size}  Total: ${allIssues.length}\n`;

    for (const [file, issues] of byFile) {
      text += `\n${file} (${issues.length}):\n`;
      for (const info of issues) {
        text += `  [${info.type}]\n`;
        for (const issue of info.issues) {
          text += `    - ${issue}\n`;
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

export function getPhpunitClockAssertionStats(appPath: string): McpToolResult {
  try {
    const testsDir = path.join(appPath, 'tests');
    const phpFiles = scanDirRecursive(testsDir, '.php');

    const allIssues: PhpunitClockAssertionInfo[] = [];
    for (const file of phpFiles) {
      allIssues.push(...analyzeClockFile(file, appPath));
    }

    const counts: Record<string, number> = {
      trait: 0,
      assertion: 0,
      datetime: 0,
      sleep: 0,
      injection: 0,
      'missing-trait': 0,
    };
    for (const info of allIssues) {
      counts[info.type] = (counts[info.type] ?? 0) + 1;
    }

    const totalIssues = allIssues.reduce((sum, info) => sum + info.issues.length, 0);

    let text = `PHPUnit Clock Assertion Statistics\n${'='.repeat(45)}\n\n`;
    text += `Test files scanned:       ${phpFiles.length}\n`;
    text += `Total issue groups:       ${allIssues.length}\n`;
    text += `Total individual issues:  ${totalIssues}\n\n`;
    text += `By pattern type:\n`;
    text += `  trait (unused MockClock):     ${counts['trait']}\n`;
    text += `  assertion (time()-based):     ${counts['assertion']}\n`;
    text += `  datetime (no-arg DateTime):   ${counts['datetime']}\n`;
    text += `  sleep (sleep/usleep calls):   ${counts['sleep']}\n`;
    text += `  injection (new SystemClock):  ${counts['injection']}\n`;
    text += `  missing-trait:                ${counts['missing-trait']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpunitClockAssertionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_clock_assertion',
      description: 'Scan tests/**/*.php for Symfony Clock mock assertion issues: ClockSensitiveTrait without MockClock calls, time()-based assertions, no-arg DateTime/DateTimeImmutable, sleep()/usleep() calls, hardcoded SystemClock, and tests missing ClockSensitiveTrait',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_clock_assertion_stats',
      description: 'Show statistics for PHPUnit clock assertion issues grouped by pattern type: trait/assertion/datetime/sleep/injection/missing-trait counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
