import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface HttpClientRetryConfig {
  client: string;
  maxRetries?: number;
  retryCodes: number[];
  hasExponentialBackoff: boolean;
  hasDelayConfig: boolean;
  source: 'yaml' | 'php';
  issues: string[];
}

function loadYamlRetryConfigs(appPath: string): HttpClientRetryConfig[] {
  const configs: HttpClientRetryConfig[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'framework.yaml'),
    path.join(appPath, 'config', 'packages', 'http_client.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const framework = (raw['framework'] ?? raw) as Record<string, unknown>;
    const httpClient = (framework['http_client'] ?? {}) as Record<string, unknown>;
    const scopes = (httpClient['scopes'] ?? {}) as Record<string, unknown>;
    for (const [name, scopeConfig] of Object.entries(scopes)) {
      const sc = (scopeConfig ?? {}) as Record<string, unknown>;
      const retry = (sc['retry_failed'] ?? null) as Record<string, unknown> | null;
      if (!retry) continue;
      const maxRetries = retry['max_retries'] ? Number(retry['max_retries']) : undefined;
      const retryCodes = Array.isArray(retry['retry_on_status']) ? (retry['retry_on_status'] as number[]) : [];
      const hasExponentialBackoff = retry['backoff_strategy'] === 'exponential' || !!retry['delay'];
      const hasDelayConfig = !!retry['delay'] || !!retry['max_delay'];
      const issues: string[] = [];
      if (maxRetries && maxRetries > 5) issues.push(`max_retries=${maxRetries} is high — risk of cascading failures under load`);
      if (retryCodes.includes(401) || retryCodes.includes(403)) issues.push('Retrying 401/403 responses — auth failures should not be retried');
      configs.push({ client: name, maxRetries, retryCodes, hasExponentialBackoff, hasDelayConfig, source: 'yaml', issues });
    }
  }
  return configs;
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

function scanPhpRetryUsage(appPath: string): HttpClientRetryConfig[] {
  const configs: HttpClientRetryConfig[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return configs;
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath); if (content === null) continue;
    if (!content.includes('RetryableHttpClient') && !content.includes('GenericRetryStrategy')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    const maxM = /maxRetries\s*:\s*(\d+)/.exec(content);
    const hasExponentialBackoff = content.includes('ExponentialBackoff') || content.includes('ExponentialBackOffStrategy');
    const issues: string[] = [];
    configs.push({ client: classM?.[1] ?? '(file)', maxRetries: maxM ? Number(maxM[1]) : undefined, retryCodes: [], hasExponentialBackoff, hasDelayConfig: false, source: 'php', issues });
  }
  return configs;
}

export function listHttpClientRetry(appPath: string): McpToolResult {
  try {
    const yamlConfigs = loadYamlRetryConfigs(appPath);
    const phpConfigs = scanPhpRetryUsage(appPath);
    const all = [...yamlConfigs, ...phpConfigs];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No RetryableHttpClient / retry_failed configuration found.\n\nExample in framework.yaml:\n  framework:\n    http_client:\n      scopes:\n        api.example.com:\n          retry_failed:\n            max_retries: 3\n            retry_on_status: [500, 502, 503]\n            backoff_strategy: exponential' }] };
    const totalIssues = all.reduce((s, c) => s + c.issues.length, 0);
    let text = `HttpClient Retry Strategy\n${'='.repeat(55)}\n\nRetry configs: ${all.length}  Issues: ${totalIssues}\n`;
    for (const c of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const retries = c.maxRetries !== undefined ? `maxRetries: ${c.maxRetries}` : 'maxRetries: default';
      const codes = c.retryCodes.length > 0 ? `  codes: ${c.retryCodes.join(',')}` : '';
      const backoff = c.hasExponentialBackoff ? '  exponential' : '  fixed';
      text += `\n  ${c.client}  ${retries}${codes}${backoff}  [${c.source}]\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHttpClientRetryStats(appPath: string): McpToolResult {
  try {
    const all = [...loadYamlRetryConfigs(appPath), ...scanPhpRetryUsage(appPath)];
    let text = `HttpClient Retry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Retry configs: ${all.length}\n  With exponential backoff: ${all.filter((c) => c.hasExponentialBackoff).length}\n  From YAML: ${all.filter((c) => c.source === 'yaml').length}\nIssues: ${all.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getHttpClientRetryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_http_client_retry', description: 'Show RetryableHttpClient/retry_failed configuration: max_retries, retry_on_status codes, backoff strategy, high retry count warning, 401/403 retry warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_http_client_retry_stats', description: 'Show HttpClient retry statistics: config count, exponential backoff count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
