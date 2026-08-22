/**
 * Symfony HttpClient Decorator/Event Inspector
 *
 * Scans src/ PHP for classes implementing HttpClientInterface as decorators,
 * ResponseInterface interception, decorators calling wrapped->request(),
 * withOptions() propagation.
 *
 * Checks framework.yaml http_client for mock_response_factory config.
 *
 * Warns: HttpClient decorator without passing all options to inner client,
 * decorator that modifies response without checking status code first,
 * missing withOptions() propagation in decorator.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface HttpClientEventInfo {
  file: string;
  class: string;
  isDecorator: boolean;
  wrapsInnerClient: boolean;
  interceptsRequests: boolean;
  interceptsResponses: boolean;
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

function checkMockResponseFactory(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'test', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'framework.yml'),
  ];
  for (const file of candidates) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const httpClient = framework['http_client'] as Record<string, unknown> | undefined;
    if (!httpClient) continue;
    const mockFactory = httpClient['mock_response_factory'];
    if (mockFactory) return String(mockFactory);
  }
  return null;
}

function parseHttpClientDecorator(filePath: string, appPath: string): HttpClientEventInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isDecorator =
    (content.includes('HttpClientInterface') && content.includes('implements')) ||
    (content.includes('HttpClientInterface') && content.includes('__construct') && content.includes('HttpClientInterface $'));

  if (!isDecorator) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Symfony\\Component\\HttpClient')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;

  const wrapsInnerClient =
    content.includes('$this->client') ||
    content.includes('$this->httpClient') ||
    content.includes('$this->inner') ||
    content.includes('$this->decorated');

  const interceptsRequests = /public\s+function\s+request\s*\(/.test(content);
  const interceptsResponses =
    content.includes('ResponseInterface') &&
    (/public\s+function\s+stream\s*\(/.test(content) || interceptsRequests);

  const hasWithOptions = /public\s+function\s+withOptions\s*\(/.test(content);
  const hasAllOptionsPassthrough = content.includes('->withOptions(') || content.includes('withOptions');
  const hasStatusCheck =
    content.includes('->getStatusCode(') ||
    content.includes('getStatusCode()') ||
    content.includes('$response->getStatusCode');

  const issues: string[] = [];

  if (interceptsRequests && !hasWithOptions) {
    issues.push('HttpClient decorator implements request() but is missing withOptions() — options will not propagate to decorated client');
  }
  if (interceptsRequests && wrapsInnerClient && !hasAllOptionsPassthrough) {
    issues.push('Decorator may not pass all options to inner client — merged options can be silently lost');
  }
  if (interceptsResponses && !hasStatusCheck) {
    issues.push('Decorator intercepts responses but does not check getStatusCode() — modifying error responses may hide failures');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM[1],
    isDecorator,
    wrapsInnerClient,
    interceptsRequests,
    interceptsResponses,
    issues,
  };
}

export function listHttpClientEvents(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const results: HttpClientEventInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const r = parseHttpClientDecorator(file, appPath);
      if (r) results.push(r);
    }

    const mockFactory = checkMockResponseFactory(appPath);

    if (results.length === 0) {
      let text = 'No HttpClient decorator implementations found in src/.\n';
      if (mockFactory) {
        text += `\nmock_response_factory configured: ${mockFactory}\n`;
      }
      return { content: [{ type: 'text', text }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Symfony HttpClient Decorators\n${'='.repeat(55)}\n`;
    text += `\nDecorators: ${results.length}  Issues: ${totalIssues}\n`;
    if (mockFactory) text += `mock_response_factory: ${mockFactory}\n`;

    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${r.class}  (${r.file})\n`;
      text += `    Wraps inner: ${r.wrapsInnerClient ? 'yes' : 'no'}  Intercepts requests: ${r.interceptsRequests ? 'yes' : 'no'}  Intercepts responses: ${r.interceptsResponses ? 'yes' : 'no'}\n`;
      for (const issue of r.issues) {
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

export function getHttpClientEventStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: HttpClientEventInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const r = parseHttpClientDecorator(file, appPath);
        if (r) results.push(r);
      }
    }
    const mockFactory = checkMockResponseFactory(appPath);

    let text = `HttpClient Decorator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Decorator classes:            ${results.length}\n`;
    text += `  Wraps inner client:         ${results.filter((r) => r.wrapsInnerClient).length}\n`;
    text += `  Intercepts requests:        ${results.filter((r) => r.interceptsRequests).length}\n`;
    text += `  Intercepts responses:       ${results.filter((r) => r.interceptsResponses).length}\n`;
    text += `mock_response_factory:        ${mockFactory ?? 'not configured'}\n`;
    text += `Issues detected:              ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHttpClientEventTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_http_client_events',
      description: 'Show Symfony HttpClient decorator implementations: HttpClientInterface decorators, inner client wrapping, request/response interception, withOptions() propagation; warns on missing withOptions, options not passed to inner, response modified without status check; checks mock_response_factory config',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_http_client_event_stats',
      description: 'Show HttpClient decorator statistics: decorator count, inner-wrapping count, request/response interception count, mock_response_factory presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
