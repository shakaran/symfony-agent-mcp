/**
 * Symfony HTTP Client Mock Inspector
 *
 * Scans tests/ and src/Tests/ for:
 *   - MockHttpClient, MockResponse, FixtureResponse, ScopingHttpClient usage
 *   - Real HttpClient/HttpClientInterface injection (anti-pattern in tests)
 *   - MockHttpClient with array of fixed responses (may exhaust)
 *   - MockResponse with body factory callback
 *
 * Warns: real HTTP client in tests, fixed response array exhaustion risk,
 * MockResponse without status code, missing request count assertion.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface HttpClientMockInfo {
  file: string;
  class: string;
  hasMockClient: boolean;
  hasFixedResponseArray: boolean;
  hasResponseFactory: boolean;
  assertsRequestCount: boolean;
  hasRealClient: boolean;
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

function scanHttpClientMocks(appPath: string): HttpClientMockInfo[] {
  const dirs = [
    path.join(appPath, 'tests'),
    path.join(appPath, 'src', 'Tests'),
  ];

  const results: HttpClientMockInfo[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of getAllPhpFiles(dir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const hasMockClient = content.includes('MockHttpClient') || content.includes('MockResponse') ||
        content.includes('FixtureResponse');
      const hasRealClient = /HttpClientInterface\s+\$\w{1,80}|new\s+CurlHttpClient|new\s+NativeHttpClient|createClient\s*\(\s*\)/.test(content) &&
        !hasMockClient;

      if (!hasMockClient && !hasRealClient) continue;

      const classMatch = /class\s+(\w{1,100})/.exec(content);
      const className = classMatch ? classMatch[1] : path.basename(file, '.php');

      // Detect fixed array of responses: new MockHttpClient([...])
      const hasFixedResponseArray = /new\s+MockHttpClient\s*\(\s*\[/.test(content);

      // Detect factory callback: new MockHttpClient(function|fn(
      const hasResponseFactory = /new\s+MockHttpClient\s*\(\s*(?:function|\$\w{1,80}|fn\s*\()/.test(content) ||
        /new\s+MockHttpClient\s*\(\s*\[[\s\S]{0,500}function/.test(content);

      // Detect request count assertion
      const assertsRequestCount = /getRequestsCount|assertSame.*getRequestsCount|assertCount.*getRequests|->assertCount/.test(content) ||
        /requestsCount|requestCount/.test(content);

      const issues: string[] = [];

      if (hasRealClient && !hasMockClient) {
        issues.push('Test injects real HttpClient — creates external HTTP dependency in tests (slow, flaky)');
      }

      if (hasFixedResponseArray) {
        // Check if there's a loop making more requests than responses
        const requestCalls = (content.match(/->request\s*\(/g) ?? []).length;
        const responseMatches = (content.match(/new\s+MockResponse\s*\(/g) ?? []).length;
        if (requestCalls > responseMatches) {
          issues.push(`${requestCalls} request() call(s) but only ${responseMatches} MockResponse(s) — fixed array may exhaust`);
        }
      }

      // MockResponse without status code
      if (/new\s+MockResponse\s*\(\s*['"`$[]/.test(content) && !/new\s+MockResponse\s*\([^)]{0,300}(?:200|201|204|301|302|400|401|403|404|500)/.test(content)) {
        issues.push('MockResponse without explicit status code — defaults to 200, may miss error case testing');
      }

      if (hasMockClient && !assertsRequestCount) {
        issues.push('MockHttpClient used without asserting request count — outgoing HTTP calls may be silently skipped');
      }

      results.push({
        file: path.relative(appPath, file),
        class: className,
        hasMockClient,
        hasFixedResponseArray,
        hasResponseFactory,
        assertsRequestCount,
        hasRealClient,
        issues,
      });
    }
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listHttpClientMocks(appPath: string): McpToolResult {
  try {
    const items = scanHttpClientMocks(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No HTTP client mock usage found in tests/.' }] };
    }

    let text = `HTTP Client Mock Usage\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} test file(s) with HTTP client usage:\n\n`;

    for (const item of items) {
      text += `  ${item.class}  (${item.file})\n`;
      text += `    Has MockHttpClient:      ${item.hasMockClient ? 'yes' : 'no'}\n`;
      text += `    Has real client:         ${item.hasRealClient ? 'YES (risk)' : 'no'}\n`;
      text += `    Fixed response array:    ${item.hasFixedResponseArray ? 'yes' : 'no'}\n`;
      text += `    Response factory:        ${item.hasResponseFactory ? 'yes' : 'no'}\n`;
      text += `    Asserts request count:   ${item.assertsRequestCount ? 'yes' : 'no'}\n`;
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

export function getHttpClientMockStats(appPath: string): McpToolResult {
  try {
    const items = scanHttpClientMocks(appPath);

    const withMock = items.filter((i) => i.hasMockClient).length;
    const withRealClient = items.filter((i) => i.hasRealClient).length;
    const withIssues = items.filter((i) => i.issues.length > 0).length;
    const withAssertCount = items.filter((i) => i.assertsRequestCount).length;

    let text = `HTTP Client Mock Stats\n${'='.repeat(40)}\n\n`;
    text += `Files with HTTP client:     ${items.length}\n`;
    text += `Using MockHttpClient:       ${withMock}\n`;
    text += `Using real HTTP client:     ${withRealClient}\n`;
    text += `Assert request count:       ${withAssertCount}\n`;
    text += `Files with issues:          ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getHttpClientMockTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_http_client_mocks',
      description: 'Scan tests/ for MockHttpClient / MockResponse usage: real client anti-patterns, fixed response array exhaustion, missing request count assertions',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_http_client_mock_stats',
      description: 'Statistics for HTTP client mock usage in tests: mock vs real client counts, assertion coverage, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
