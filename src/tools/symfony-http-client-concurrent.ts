/**
 * Symfony HTTP Client Concurrent Request Inspector
 *
 * Scans src/**\/*.php for concurrent HTTP request patterns:
 *   - HttpClientInterface / $client->request()
 *   - ResponseInterface usage
 *   - ->toArray(), ->getContent(), ->stream() patterns
 *
 * Detects:
 *   - Proper concurrent patterns: requests batched before ->toArray()
 *   - foreach ($client->stream($responses)) streaming
 *   - Anti-pattern: ->toArray() immediately after each ->request() (blocking)
 *   - Missing ->cancel() for abandoned responses
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ConcurrentHttpInfo {
  file: string;
  pattern: 'stream' | 'toArray' | 'getStatusCode' | 'cancel';
  concurrent: boolean;
  issues: string[];
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

function detectPattern(content: string): 'stream' | 'toArray' | 'getStatusCode' | 'cancel' {
  if (content.includes('->stream(') || /foreach\s*\(\s*\$\w*[Cc]lient->stream/.test(content)) return 'stream';
  if (content.includes('->cancel(')) return 'cancel';
  if (content.includes('->getStatusCode(')) return 'getStatusCode';
  return 'toArray';
}

function detectConcurrent(content: string): boolean {
  // Concurrent pattern: multiple requests stored before calling ->toArray()
  // Look for arrays of responses or loops that batch requests
  const hasResponseArray = /\$responses\s*=\s*\[/.test(content) ||
    /\$\w*[Rr]esponses\[\]\s*=/.test(content) ||
    /\$\w*[Rr]esponses\s*\[\]\s*=/.test(content);

  const hasStream = /foreach\s*\(\s*\$\w*[Cc]lient->stream/.test(content);

  // Check for request in a loop without immediate toArray
  const requestInLoop = /for(?:each)?\s*\([^)]{1,200}\)\s*\{[^}]{0,400}->request\s*\(/s.test(content);

  return hasResponseArray || hasStream || requestInLoop;
}

function analyzeHttpClientFile(filePath: string, appPath: string): ConcurrentHttpInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasHttpClient = content.includes('HttpClientInterface') ||
    content.includes('HttpClient') ||
    (content.includes('->request(') && (content.includes('->toArray(') || content.includes('->getContent(')));

  if (!hasHttpClient) return null;
  if (content.includes('namespace Symfony\\Component\\HttpClient')) return null;

  const pattern = detectPattern(content);
  const concurrent = detectConcurrent(content);
  const issues: string[] = [];

  // Anti-pattern: ->toArray() immediately after ->request() in a loop (blocking, sequential)
  // Heuristic: toArray() and request() in same loop body without array collection
  if (pattern === 'toArray') {
    const blockingPattern = /->request\s*\([^)]{0,200}\)\s*(?:->\w+\s*\([^)]{0,100}\)\s*)*->toArray\s*\(/.test(content);
    if (blockingPattern && !concurrent) {
      issues.push('->toArray() called immediately after ->request() — blocks until response completes; collect all requests first, then call ->toArray() to enable concurrency');
    }
  }

  // Anti-pattern: ->getContent() immediately in loop (also blocking)
  if (content.includes('->getContent(') && !concurrent) {
    const blockingGet = /->request\s*\([^)]{0,200}\)\s*(?:->\w+\s*\([^)]{0,100}\)\s*)*->getContent\s*\(/.test(content);
    if (blockingGet) {
      issues.push('->getContent() called immediately after ->request() — sequential blocking; use stream() or batch requests before reading');
    }
  }

  // Flag: missing ->cancel() for abandoned responses
  if (content.includes('->request(') && !content.includes('->cancel(')) {
    if (content.includes('try') && content.includes('catch') && content.includes('break')) {
      issues.push('HTTP request with exception handling and break — consider ->cancel() on remaining responses to free connections');
    }
  }

  // Flag: no timeout set
  if (content.includes('->request(') && !content.includes('timeout') && !content.includes('max_duration')) {
    issues.push('HTTP requests without timeout option — set timeout or max_duration to avoid hanging requests');
  }

  return {
    file: path.relative(appPath, filePath),
    pattern,
    concurrent,
    issues,
  };
}

function buildConcurrentHttpInfos(appPath: string): ConcurrentHttpInfo[] {
  const srcDir = path.join(appPath, 'src');
  const results: ConcurrentHttpInfo[] = [];
  if (!fs.existsSync(srcDir)) return results;

  for (const file of collectPhpFiles(srcDir, srcDir)) {
    const info = analyzeHttpClientFile(file, appPath);
    if (info) results.push(info);
  }

  return results;
}

export function listSymfonyHttpClientConcurrent(appPath: string): McpToolResult {
  try {
    const infos = buildConcurrentHttpInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony HttpClient usage found in src/ PHP files.' }] };
    }

    const withIssues = infos.filter((i) => i.issues.length > 0);
    let text = `Symfony HTTP Client Concurrent Request Analysis\n${'='.repeat(55)}\n\n`;
    text += `Files using HttpClient: ${infos.length}  (with issues: ${withIssues.length})\n`;
    text += `Using concurrent patterns: ${infos.filter((i) => i.concurrent).length}\n\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `  ${info.file}\n`;
      text += `    Pattern:    ${info.pattern}\n`;
      text += `    Concurrent: ${info.concurrent ? 'yes' : 'no (sequential)'}\n`;
      for (const issue of info.issues) {
        text += `    [WARN] ${issue}\n`;
      }
      if (info.issues.length === 0) text += `    OK\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpClientConcurrentStats(appPath: string): McpToolResult {
  try {
    const infos = buildConcurrentHttpInfos(appPath);

    const concurrent = infos.filter((i) => i.concurrent).length;
    const sequential = infos.filter((i) => !i.concurrent).length;

    const byPattern: Record<string, number> = {};
    for (const info of infos) {
      byPattern[info.pattern] = (byPattern[info.pattern] ?? 0) + 1;
    }

    let text = `Symfony HTTP Client Concurrent Statistics\n${'='.repeat(45)}\n\n`;
    text += `Total files using HttpClient: ${infos.length}\n`;
    text += `  Concurrent patterns:  ${concurrent}\n`;
    text += `  Sequential patterns:  ${sequential}\n\n`;
    text += `By pattern:\n`;
    for (const [pattern, count] of Object.entries(byPattern).sort()) {
      text += `  ${pattern.padEnd(15)}  ${count}\n`;
    }
    text += `\nTotal issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyHttpClientConcurrentTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_http_client_concurrent',
      description: 'List Symfony HttpClient usage patterns: detects blocking ->toArray() immediately after ->request(), missing ->cancel() on abandoned responses, no timeout set, and identifies proper concurrent streaming patterns',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_http_client_concurrent_stats',
      description: 'Show Symfony HttpClient concurrency statistics: concurrent vs sequential count, breakdown by pattern (stream/toArray/getStatusCode/cancel), total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
