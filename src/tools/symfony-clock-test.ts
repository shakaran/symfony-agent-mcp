/**
 * Symfony Clock Test Inspector
 *
 * Scans tests/ for:
 *   - ClockMock usage, ClockSensitiveTrait, MockClock
 *   - $clock->modify(), sleep() calls, time()/date() in test code
 *   - ClockMock::register() and ClockMock::reset() calls
 *
 * Warns: sleep() in test (non-deterministic), time()/date() without ClockMock,
 * ClockSensitiveTrait with service that doesn't inject ClockInterface,
 * ClockMock::register() without ClockMock::reset() in tearDown.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ClockTestInfo {
  file: string;
  class: string;
  hasClockMock: boolean;
  hasClockSensitiveTrait: boolean;
  hasSleepCall: boolean;
  hasRawTimeCall: boolean;
  hasClockReset: boolean;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function scanClockTests(appPath: string): ClockTestInfo[] {
  const testsDir = path.join(appPath, 'tests');
  const results: ClockTestInfo[] = [];

  if (!fs.existsSync(testsDir)) return results;

  for (const file of getAllPhpFiles(testsDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const hasClockMock = content.includes('ClockMock') || content.includes('MockClock');
    const hasClockSensitiveTrait = content.includes('ClockSensitiveTrait');
    const hasClock = hasClockMock || hasClockSensitiveTrait || content.includes('ClockInterface') ||
      content.includes('->modify(');

    // Also catch raw time calls in any test file
    const hasRawTimeCall = /\btime\s*\(\s*\)|\bdate\s*\(|\bmicrotime\s*\(|\bstrtotime\s*\(/.test(content);
    const hasSleepCall = /\bsleep\s*\(\s*\d{1,6}\s*\)|\busleep\s*\(\s*\d{1,9}\s*\)/.test(content);

    if (!hasClock && !hasSleepCall && !hasRawTimeCall) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    const className = classMatch ? classMatch[1] : path.basename(file, '.php');

    const hasClockRegister = /ClockMock::register\s*\(/.test(content);
    const hasClockReset = /ClockMock::reset\s*\(/.test(content);

    const issues: string[] = [];

    if (hasSleepCall) {
      issues.push('sleep()/usleep() in test — makes tests slow and non-deterministic; use ClockMock instead');
    }

    if (hasRawTimeCall && !hasClockMock && !hasClockSensitiveTrait) {
      issues.push('time()/date()/strtotime() without ClockMock — test results depend on actual system time');
    }

    if (hasClockSensitiveTrait) {
      // Check if the service under test injects ClockInterface
      if (!content.includes('ClockInterface') && !content.includes('clock')) {
        issues.push('ClockSensitiveTrait used but tested service may not inject ClockInterface — trait may have no effect');
      }
    }

    if (hasClockRegister && !hasClockReset) {
      issues.push('ClockMock::register() without ClockMock::reset() in tearDown — clock state leaks to other tests');
    }

    results.push({
      file: path.relative(appPath, file),
      class: className,
      hasClockMock,
      hasClockSensitiveTrait,
      hasSleepCall,
      hasRawTimeCall,
      hasClockReset,
      issues,
    });
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listClockTests(appPath: string): McpToolResult {
  try {
    const items = scanClockTests(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No clock-related test patterns found in tests/.' }] };
    }

    let text = `Clock Test Patterns\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} test file(s) with clock/time usage:\n\n`;

    for (const item of items) {
      text += `  ${item.class}  (${item.file})\n`;
      text += `    ClockMock:             ${item.hasClockMock ? 'yes' : 'no'}\n`;
      text += `    ClockSensitiveTrait:   ${item.hasClockSensitiveTrait ? 'yes' : 'no'}\n`;
      text += `    sleep() calls:         ${item.hasSleepCall ? 'YES (issue)' : 'no'}\n`;
      text += `    Raw time() calls:      ${item.hasRawTimeCall ? 'yes' : 'no'}\n`;
      text += `    ClockMock::reset():    ${item.hasClockReset ? 'yes' : 'no'}\n`;
      if (item.issues.length > 0) {
        text += `    Issues:\n`;
        for (const issue of item.issues) {
          text += `      - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getClockTestStats(appPath: string): McpToolResult {
  try {
    const items = scanClockTests(appPath);

    const withClockMock = items.filter((i) => i.hasClockMock).length;
    const withSleep = items.filter((i) => i.hasSleepCall).length;
    const withRawTime = items.filter((i) => i.hasRawTimeCall && !i.hasClockMock).length;
    const withIssues = items.filter((i) => i.issues.length > 0).length;

    let text = `Clock Test Stats\n${'='.repeat(40)}\n\n`;
    text += `Files with clock/time usage: ${items.length}\n`;
    text += `Using ClockMock:             ${withClockMock}\n`;
    text += `With sleep() calls:          ${withSleep}\n`;
    text += `Unguarded time() calls:      ${withRawTime}\n`;
    text += `Files with issues:           ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getClockTestTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_clock_tests',
      description: 'Scan tests/ for clock test patterns: ClockMock, ClockSensitiveTrait, sleep() usage, unguarded time() calls, missing ClockMock::reset()',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_clock_test_stats',
      description: 'Statistics for clock test patterns: ClockMock usage, sleep() count, unguarded time() calls, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
