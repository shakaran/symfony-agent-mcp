import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ConnectionRetryInfo {
  file: string;
  type: 'middleware' | 'config' | 'listener' | 'ping';
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

function buildConnectionRetryInfos(appPath: string): ConnectionRetryInfo[] {
  const results: ConnectionRetryInfo[] = [];
  const srcDir = path.join(appPath, 'src');

  const dbalYaml = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  if (fs.existsSync(dbalYaml)) {
    let content = '';
    try { content = fs.readFileSync(dbalYaml, 'utf-8'); } catch { /* ignore */ }

    const hasPersistent = content.includes('persistent: true') || content.includes("persistent: 'true'");
    const hasServerVersion = content.includes('server_version');
    const issues: string[] = [];

    if (hasPersistent) {
      issues.push('Persistent connections (persistent: true) in PHP-FPM — persistent connections are per-worker, cannot reconnect per-request, may hold stale transactions');
    }
    if (!hasServerVersion) {
      issues.push('server_version not set in doctrine.dbal — Doctrine may execute extra version-detection queries on boot');
    }
    results.push({ file: 'config/packages/doctrine.yaml', type: 'config', pattern: 'DBAL configuration', issues });
  }

  if (!fs.existsSync(srcDir)) return results;

  let hasResetListener = false;
  let hasReconnectMiddleware = false;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath) ?? '';
    if (!content) continue;

    const relFile = path.relative(appPath, file);
    const issues: string[] = [];

    if (content.includes('AbstractReconnectingMiddleware') || content.includes('ReconnectingMiddleware') ||
        (content.includes('MiddlewareInterface') && (content.includes('reconnect') || content.includes('Reconnect')))) {
      hasReconnectMiddleware = true;
      const catchsAll = /catch\s*\(\s*\\?Exception/.test(content) || /catch\s*\(\s*\\?Throwable/.test(content);
      if (!catchsAll) {
        issues.push('Reconnect middleware may not catch all exception types — PDOException extends RuntimeException but some drivers throw DriverException directly');
      }
      results.push({ file: relFile, type: 'middleware', pattern: 'ReconnectingMiddleware', issues });
    }

    const isWorkerReset = content.includes('WorkerMessageHandledEvent') || content.includes('ResetServicesListener') ||
      (content.includes('onWorkerMessage') && (content.includes('EntityManagerInterface') || content.includes('->close()')));
    if (isWorkerReset) {
      hasResetListener = true;
      results.push({ file: relFile, type: 'listener', pattern: 'Worker EM reset listener', issues: [] });
    }

    const hasPing = (content.includes("executeQuery('SELECT 1'") || content.includes('ping()')) &&
      content.includes('Connection');
    if (hasPing) {
      const afterException = content.includes('catch') && content.includes('ping');
      if (!afterException) {
        issues.push('DB ping/SELECT 1 performed outside exception handler — adds extra query overhead on every request');
      }
      results.push({ file: relFile, type: 'ping', pattern: 'SELECT 1 / ping()', issues });
    }
  }

  const hasMessengerWorker = fs.existsSync(path.join(appPath, 'config', 'packages', 'messenger.yaml'));
  if (hasMessengerWorker && !hasResetListener && !hasReconnectMiddleware) {
    results.push({
      file: 'config/packages/messenger.yaml',
      type: 'config',
      pattern: 'Messenger worker without connection reset',
      issues: ['Messenger worker detected but no EntityManager reset listener or reconnect middleware — MySQL disconnects after 8 hours of inactivity, causing worker failure'],
    });
  }

  return results;
}

export function listDoctrineConnectionRetry(appPath: string): McpToolResult {
  try {
    const infos = buildConnectionRetryInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine connection retry/reconnect patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Connection Retry Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineConnectionRetryStats(appPath: string): McpToolResult {
  try {
    const infos = buildConnectionRetryInfos(appPath);
    let text = `Connection Retry Statistics\n${'='.repeat(40)}\n\n`;
    text += `Middlewares:  ${infos.filter((i) => i.type === 'middleware').length}\n`;
    text += `Configs:      ${infos.filter((i) => i.type === 'config').length}\n`;
    text += `Listeners:    ${infos.filter((i) => i.type === 'listener').length}\n`;
    text += `Ping checks:  ${infos.filter((i) => i.type === 'ping').length}\n`;
    text += `Issues:       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineConnectionRetryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_connection_retry', description: 'Detect DB connection retry/reconnect patterns; warns on persistent connections in FPM, no EM reset in worker, reconnect middleware catching too few exceptions, ping outside exception handler', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_connection_retry_stats', description: 'Statistics for connection retry: middleware/config/listener/ping count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
