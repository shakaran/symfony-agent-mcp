// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony HTTP Kernel Test Pattern Inspector
 *
 * Scans tests/**\/*.php for Symfony HTTP kernel test patterns:
 *   - KernelTestCase vs WebTestCase misuse (createClient() in KernelTestCase)
 *   - Missing self::ensureKernelShutdown() before self::bootKernel() in the same test
 *   - $client->restart() absent between requests that modify authentication state
 *   - Static $client property reused across tests without reset (test pollution)
 *   - assertResponseStatusCodeSame() never called after request (asserting nothing)
 *   - Missing $this->assertNull($this->getContainer()->get(...)) after kernel shutdown
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface HttpKernelTestInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectPhpFiles(dir: string, base: string): string[] {
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
    if (stat.isDirectory()) results.push(...collectPhpFiles(full, base));
    else if (entry.endsWith('.php')) results.push(full);
  }
  return results;
}

// ─── Analysis helpers ─────────────────────────────────────────────────────────

function extractTestMethods(lines: string[]): Array<{ name: string; startLine: number; body: string }> {
  const methods: Array<{ name: string; startLine: number; body: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match test methods: public function test*//** @test */
    const methodMatch = /public\s+function\s+(test\w+)\s*\(/.exec(line);
    if (methodMatch) {
      const name = methodMatch[0];
      const startLine = i + 1;
      // Collect method body
      let depth = 0;
      const bodyLines: string[] = [];
      let j = i;
      let started = false;
      while (j < lines.length) {
        const l = lines[j];
        for (const ch of l) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        bodyLines.push(l);
        if (started && depth <= 0) break;
        j++;
      }
      methods.push({ name, startLine, body: bodyLines.join('\n') });
      i = j + 1;
      continue;
    }
    i++;
  }

  return methods;
}

// ─── File analysis ─────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, base: string): HttpKernelTestInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  // Only analyze test files with kernel/web test case
  const isKernelTest = /extends\s+KernelTestCase/.test(content);
  const isWebTest = /extends\s+WebTestCase/.test(content);
  if (!isKernelTest && !isWebTest) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: HttpKernelTestInfo[] = [];

  // Pattern 1: createClient() called in KernelTestCase (not WebTestCase)
  if (isKernelTest && !isWebTest) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/self\s*::\s*createClient\s*\(|static\s*::\s*createClient\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: i + 1,
          pattern: 'kernel-test-create-client',
          issue: 'createClient() called in KernelTestCase — createClient() is only available in WebTestCase (extends WebTestCase); KernelTestCase does not have this method and will throw a fatal error. Change "extends KernelTestCase" to "extends WebTestCase"',
          severity: 'high',
        });
      }
    }
  }

  // Pattern 2: Static $client property reused without reset
  if (/static\s+(?:protected|private|public)\s+\$client\b/.test(content)) {
    // Check if there is a tearDown/setUp that resets $client
    const hasTearDownReset = /tearDown\s*\(\s*\)[\s\S]{0,500}client\s*=\s*null/.test(content);
    const hasSetUpReset = /setUp\s*\(\s*\)[\s\S]{0,500}client\s*=\s*null/.test(content);
    if (!hasTearDownReset && !hasSetUpReset) {
      results.push({
        file: relFile,
        line: 1,
        pattern: 'static-client-no-reset',
        issue: 'Static $client property found without tearDown()/setUp() resetting it to null — static client is shared across all test methods in the class, causing test pollution (authenticated state, cookies, history); add tearDown(): void { self::$client = null; }',
        severity: 'high',
      });
    }
  }

  // Pattern 3 & 4: Per-method analysis
  const testMethods = extractTestMethods(lines);

  for (const method of testMethods) {
    const body = method.body;
    const methodLines = body.split('\n');

    // Pattern 3: bootKernel() without ensureKernelShutdown() before it
    if (/\bbootKernel\s*\(/.test(body)) {
      const bootIdx = methodLines.findIndex((l) => /\bbootKernel\s*\(/.test(l));
      if (bootIdx > 0) {
        // Check if ensureKernelShutdown() appears before bootKernel()
        const precedingBody = methodLines.slice(0, bootIdx).join('\n');
        if (!/ensureKernelShutdown\s*\(/.test(precedingBody)) {
          results.push({
            file: relFile,
            line: method.startLine + bootIdx,
            pattern: 'boot-kernel-no-shutdown',
            issue: 'bootKernel() called without preceding self::ensureKernelShutdown() — calling bootKernel() when a kernel is already running throws an exception; add self::ensureKernelShutdown() before each bootKernel() call',
            severity: 'high',
          });
        }
      }
    }

    // Pattern 4: Request made but assertResponseStatusCodeSame() never called
    const hasRequest = /\$client\s*->\s*request\s*\(/.test(body);
    const hasAssert = /assertResponseStatusCodeSame\s*\(|assertResponseIsSuccessful\s*\(|assertResponseRedirects\s*\(/.test(body);
    if (hasRequest && !hasAssert) {
      const requestIdx = methodLines.findIndex((l) => /\$client\s*->\s*request\s*\(/.test(l));
      results.push({
        file: relFile,
        line: method.startLine + (requestIdx >= 0 ? requestIdx : 0),
        pattern: 'request-no-status-assert',
        issue: 'HTTP request made via $client->request() without any response status assertion (assertResponseStatusCodeSame/assertResponseIsSuccessful/assertResponseRedirects) — the test may pass silently even if the controller throws a 500 error; add assertResponseStatusCodeSame(200) or similar',
        severity: 'medium',
      });
    }

    // Pattern 5: Authentication-modifying requests without $client->restart()
    const hasLogin = /->request\s*\([^)]{0,100}login|->submit\s*\([^)]{0,100}login/.test(body);
    const hasLogout = /->request\s*\([^)]{0,100}logout/.test(body);
    const hasMultipleRequests = (body.match(/\$client\s*->\s*request\s*\(/g) ?? []).length > 1;
    if ((hasLogin || hasLogout) && hasMultipleRequests && !/\$client\s*->\s*restart\s*\(/.test(body)) {
      results.push({
        file: relFile,
        line: method.startLine,
        pattern: 'auth-no-client-restart',
        issue: 'Test method modifies authentication state (login/logout) with multiple requests but never calls $client->restart() between them — authentication state (session, cookies) persists across requests; call $client->restart() to reset the client between requests that change auth state',
        severity: 'medium',
      });
    }

    // Pattern 6: getContainer()->get() called after kernel shutdown
    if (/kernelShutdown\s*\(|->shutdown\s*\(/.test(body)) {
      const shutdownIdx = methodLines.findIndex((l) => /kernelShutdown\s*\(|->shutdown\s*\(/.test(l));
      if (shutdownIdx >= 0) {
        const postShutdown = methodLines.slice(shutdownIdx + 1).join('\n');
        if (/getContainer\s*\(\)\s*->\s*get\s*\(/.test(postShutdown)) {
          results.push({
            file: relFile,
            line: method.startLine + shutdownIdx,
            pattern: 'container-get-after-shutdown',
            issue: 'getContainer()->get() called after kernel shutdown — the container is no longer available after shutdown; verify that the test is not accidentally using a stale container reference after ensureKernelShutdown()',
            severity: 'medium',
          });
        }
      }
    }
  }

  return results;
}

function loadAll(appPath: string): HttpKernelTestInfo[] {
  const testsDir = path.join(appPath, 'tests');
  const files = collectPhpFiles(testsDir, appPath);
  const results: HttpKernelTestInfo[] = [];
  for (const f of files) results.push(...analyzeFile(f, appPath));
  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listSymfonyTestHttpKernel(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony HTTP kernel test issues found in tests/.\n\n' +
            'Checked: createClient() in KernelTestCase, missing ensureKernelShutdown() before bootKernel(), ' +
            'missing $client->restart() between auth-changing requests, static $client without tearDown reset, ' +
            'request without status assertion, getContainer()->get() after shutdown.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `Symfony HTTP Kernel Test Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

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

export function getSymfonyTestHttpKernelStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `Symfony HTTP Kernel Test Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
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

export function getSymfonyTestHttpKernelTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_test_http_kernel',
      description: 'Scan tests/**/*.php for Symfony HTTP kernel test issues: createClient() in KernelTestCase (fatal), missing ensureKernelShutdown() before bootKernel(), $client->restart() absent between auth-modifying requests, static $client without tearDown reset (test pollution), request without status code assertion, getContainer()->get() after shutdown',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_test_http_kernel_stats',
      description: 'Statistics for Symfony HTTP kernel test findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
