import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface CircuitBreakerInfo {
  file: string;
  type: 'circuit-breaker' | 'retry' | 'fallback' | 'health-check' | 'config';
  pattern: string;
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

function buildCircuitBreakerInfos(appPath: string): CircuitBreakerInfo[] {
  const results: CircuitBreakerInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, file);

    const hasCircuitBreaker = content.includes('CircuitBreaker') || content.includes('circuit_breaker') ||
      content.includes('isAvailable()') || content.includes('recordSuccess()') || content.includes('recordFailure()') ||
      (content.includes('open') && content.includes('half-open') && content.includes('closed'));

    if (hasCircuitBreaker) {
      const issues: string[] = [];
      const hasTimeout = content.includes('timeout') || content.includes('Timeout') || content.includes('resetTimeout');
      const hasThreshold = content.includes('threshold') || content.includes('failureThreshold') || content.includes('maxFailures');

      if (!hasTimeout) {
        issues.push('Circuit breaker without reset timeout — circuit stays open forever; add a reset interval (e.g., 30s) to allow recovery');
      }
      if (!hasThreshold) {
        issues.push('Circuit breaker without failure threshold — set a failure count or rate threshold before opening the circuit');
      }

      const hasHalfOpen = content.includes('half') || content.includes('probe') || content.includes('HALF_OPEN');
      if (!hasHalfOpen) {
        issues.push('Circuit breaker missing half-open state — without it, the circuit never attempts recovery; implement HALF_OPEN to allow test requests after timeout');
      }

      results.push({ file: relFile, type: 'circuit-breaker', pattern: 'Circuit breaker', issues });
    }

    if (content.includes('#[AsMessageHandler') || content.includes('MessageHandlerInterface')) {
      const hasErrorHandling = content.includes('catch') || content.includes('try {');
      const hasRetryable = content.includes('RecoverableMessageHandlingException') || content.includes('UnrecoverableMessageHandlingException');
      const hasExternalCall = content.includes('$this->client') || content.includes('->request(') || content.includes('->send(');

      if (hasExternalCall && !hasCircuitBreaker && !hasRetryable) {
        results.push({ file: relFile, type: 'retry', pattern: 'handler with external call, no circuit breaker', issues: ['Messenger handler makes external calls without circuit breaker or UnrecoverableMessageHandlingException — if external service is down, messages retry indefinitely; add circuit breaker or throw UnrecoverableMessageHandlingException after N attempts'] });
      }

      if (hasExternalCall && hasErrorHandling && !hasRetryable) {
        results.push({ file: relFile, type: 'fallback', pattern: 'handler catches exception without retry control', issues: ['Handler catches exceptions without RecoverableMessageHandlingException/UnrecoverableMessageHandlingException — Messenger cannot distinguish retryable from permanent failures'] });
      }
    }
  }

  const messengerYaml = path.join(appPath, 'config', 'packages', 'messenger.yaml');
  if (fs.existsSync(messengerYaml)) {
    let content = '';
    try { content = fs.readFileSync(messengerYaml, 'utf-8'); } catch { /* skip */ }

    const hasRetry = content.includes('retry_strategy:');
    const hasFailure = content.includes('failure_transport:');

    if (!hasRetry && !hasFailure) {
      results.push({ file: 'config/packages/messenger.yaml', type: 'config', pattern: 'no retry/failure config', issues: ['Messenger has no retry_strategy or failure_transport — failed messages are discarded; add retry with exponential backoff and a failure queue'] });
    }

    if (hasRetry && !content.includes('max_retries:')) {
      results.push({ file: 'config/packages/messenger.yaml', type: 'config', pattern: 'retry without max_retries', issues: ['retry_strategy without max_retries — retries infinitely; set max_retries: 3 or similar to prevent infinite retry loops'] });
    }
  }

  return results;
}

export function listSymfonyMessengerCircuitBreaker(appPath: string): McpToolResult {
  try {
    const infos = buildCircuitBreakerInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No circuit breaker or Messenger retry patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Circuit Breaker Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerCircuitBreakerStats(appPath: string): McpToolResult {
  try {
    const infos = buildCircuitBreakerInfos(appPath);
    let text = `Circuit Breaker Statistics\n${'='.repeat(40)}\n\n`;
    text += `Circuit breakers: ${infos.filter((i) => i.type === 'circuit-breaker').length}\n`;
    text += `Retry patterns:   ${infos.filter((i) => i.type === 'retry').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerCircuitBreakerTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_messenger_circuit_breaker', description: 'Detect circuit breaker patterns in Messenger handlers; warns on missing reset timeout/threshold/half-open state, handlers with external calls without circuit breaker, missing retry_strategy or max_retries in messenger.yaml', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_messenger_circuit_breaker_stats', description: 'Statistics for circuit breaker: circuit-breaker/retry count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
