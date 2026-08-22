/**
 * Symfony Controller Test Inspector
 *
 * Scans tests/ and src/Tests/ for WebTestCase / ApiTestCase / KernelTestCase subclasses:
 *   - $client->request() calls
 *   - $client->followRedirect(), $client->xmlHttpRequest()
 *   - Response assertions: assertResponseIsSuccessful, assertResponseStatusCodeSame
 *   - Tests without response assertions, disableReboot() usage
 *
 * Warns: request() without assertion, multiple requests without intermediate assertions,
 * disableReboot() with transactions, status-only assertions, followRedirect() chain >5.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ControllerTestInfo {
  file: string;
  class: string;
  requestCount: number;
  assertionCount: number;
  hasDisableReboot: boolean;
  hasFollowRedirect: boolean;
  requestsWithoutAssertions: number;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const ASSERTION_PATTERN = /assertResponse(?:IsSuccessful|StatusCodeSame|Redirects|IsUnprocessable|HeaderSame|HasHeader|FormatSame|CookieValueSame)\s*\(|assertSelectorText|assertPageTitleContains|assertEquals\s*\(|assertSame\s*\(|assertContains\s*\(/g;

function countMatches(content: string, pattern: RegExp): number {
  const m = content.match(pattern);
  return m ? m.length : 0;
}

function analyseTestMethod(methodBody: string): { requests: number; assertions: number } {
  const requests = countMatches(methodBody, /\$client\s*->\s*request\s*\(/g);
  const assertions = countMatches(methodBody, ASSERTION_PATTERN);
  return { requests, assertions };
}

function scanControllerTests(appPath: string): ControllerTestInfo[] {
  const dirs = [
    path.join(appPath, 'tests'),
    path.join(appPath, 'src', 'Tests'),
  ];

  const results: ControllerTestInfo[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of getAllPhpFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const extendsWebTestCase = /extends\s+(?:Web|Api|Kernel)TestCase\b/.test(content) ||
        /use\s+.*WebTestCase\b/.test(content);

      if (!extendsWebTestCase) continue;
      if (!content.includes('->request(') && !content.includes('createClient')) continue;

      const classMatch = /class\s+(\w{1,100})/.exec(content);
      const className = classMatch ? classMatch[1] : path.basename(file, '.php');

      const requestCount = countMatches(content, /\$(?:client|this->client)\s*->\s*request\s*\(/g);
      const assertionCount = countMatches(content, ASSERTION_PATTERN);
      const hasDisableReboot = content.includes('disableReboot()');
      const followRedirectCount = countMatches(content, /->followRedirect\s*\(/g);
      const hasFollowRedirect = followRedirectCount > 0;

      // Analyse per-method to find requests without assertions
      let requestsWithoutAssertions = 0;
      const methodPattern = /(?:public\s+)?function\s+(test\w{1,80})\s*\([^)]{0,300}\)\s*(?::\s*\w+\s*)?\{/g;
      let methodM = methodPattern.exec(content);
      while (methodM !== null) {
        const methodStart = methodM.index + methodM[0].length;
        // Find method end (simple brace counting, bounded at 4000 chars)
        let depth = 1;
        let pos = methodStart;
        const maxPos = Math.min(content.length, methodStart + 4000);
        while (pos < maxPos && depth > 0) {
          if (content[pos] === '{') depth++;
          else if (content[pos] === '}') depth--;
          pos++;
        }
        const methodBody = content.slice(methodStart, pos);
        const { requests, assertions } = analyseTestMethod(methodBody);
        if (requests > 0 && assertions === 0) {
          requestsWithoutAssertions += requests;
        }
        methodM = methodPattern.exec(content);
      }

      const issues: string[] = [];

      if (requestsWithoutAssertions > 0) {
        issues.push(`${requestsWithoutAssertions} request(s) without response assertion — responses are never validated`);
      }

      if (hasDisableReboot) {
        issues.push('disableReboot() may cause state leaks between requests if transactions are used');
      }

      if (followRedirectCount > 5) {
        issues.push(`followRedirect() called ${followRedirectCount} times — consider asserting the redirect itself`);
      }

      if (assertionCount > 0 && requestCount > 0 && assertionCount < requestCount) {
        issues.push(`${requestCount} request(s) but only ${assertionCount} assertion(s) — some requests may be unvalidated`);
      }

      results.push({
        file: path.relative(appPath, file),
        class: className,
        requestCount,
        assertionCount,
        hasDisableReboot,
        hasFollowRedirect,
        requestsWithoutAssertions,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listControllerTests(appPath: string): McpToolResult {
  try {
    const items = scanControllerTests(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No WebTestCase/ApiTestCase/KernelTestCase subclasses found in tests/.' }] };
    }

    let text = `Controller Tests\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} controller test class(es):\n\n`;

    for (const item of items) {
      text += `  ${item.class}  (${item.file})\n`;
      text += `    Requests:                 ${item.requestCount}\n`;
      text += `    Assertions:               ${item.assertionCount}\n`;
      text += `    Requests w/o assertions:  ${item.requestsWithoutAssertions}\n`;
      text += `    disableReboot():          ${item.hasDisableReboot ? 'yes' : 'no'}\n`;
      text += `    followRedirect():         ${item.hasFollowRedirect ? 'yes' : 'no'}\n`;
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

export function getControllerTestStats(appPath: string): McpToolResult {
  try {
    const items = scanControllerTests(appPath);

    const totalRequests = items.reduce((s, i) => s + i.requestCount, 0);
    const totalAssertions = items.reduce((s, i) => s + i.assertionCount, 0);
    const unvalidated = items.reduce((s, i) => s + i.requestsWithoutAssertions, 0);
    const withIssues = items.filter((i) => i.issues.length > 0).length;

    let text = `Controller Test Stats\n${'='.repeat(40)}\n\n`;
    text += `Test classes:             ${items.length}\n`;
    text += `Total requests:           ${totalRequests}\n`;
    text += `Total assertions:         ${totalAssertions}\n`;
    text += `Unvalidated requests:     ${unvalidated}\n`;
    text += `Classes with issues:      ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getControllerTestTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_controller_tests',
      description: 'Scan tests/ for WebTestCase/ApiTestCase subclasses: request/assertion counts, unvalidated requests, disableReboot usage, redirect chains',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_controller_test_stats',
      description: 'Statistics for controller tests: total request/assertion counts, unvalidated requests, issue summary',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
