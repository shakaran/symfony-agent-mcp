/**
 * Symfony Messenger Competing Consumers Inspector
 *
 * Scans config/packages/messenger.yaml for transports with concurrency settings.
 * Checks .env* for MESSENGER_TRANSPORT_DSN and worker count variables.
 * Looks for supervisord.conf, docker-compose.yml for messenger:consume definitions.
 * Flags: single worker for high-load transport, no concurrency limit, missing --limit.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CompetingConsumerInfo {
  transport: string;
  workers: number;
  concurrency: number;
  issues: string[];
}

function readFileSafe(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

interface TransportDef {
  name: string;
  dsn: string;
  options: Map<string, string>;
}

function parseMessengerTransports(content: string): TransportDef[] {
  const transports: TransportDef[] = [];
  const lines = content.split('\n');
  let inTransports = false;
  let currentTransport: TransportDef | null = null;
  let inOptions = false;

  for (const line of lines) {
    if (/^\s+transports\s*:/.test(line)) { inTransports = true; continue; }
    if (/^\s+routing\s*:/.test(line) || /^\s+buses\s*:/.test(line)) { inTransports = false; continue; }
    if (!inTransports) continue;

    // New transport name (4-6 spaces indent)
    const tNameMatch = /^(\s{4,8})(\w{1,80})\s*:/.exec(line);
    if (tNameMatch) {
      const indent = tNameMatch[1].length;
      if (indent <= 8) {
        if (currentTransport) transports.push(currentTransport);
        currentTransport = { name: tNameMatch[2], dsn: '', options: new Map() };
        inOptions = false;
      }
    }

    if (!currentTransport) continue;

    // DSN
    const dsnMatch = /\bdsn\s*:\s*(.+)$/.exec(line);
    if (dsnMatch) currentTransport.dsn = dsnMatch[1].trim().replace(/^['"]|['"]$/g, '');

    // Options section
    if (/\boptions\s*:/.test(line)) { inOptions = true; continue; }

    // concurrency option
    if (inOptions || /\bconcurrency\s*:/.test(line)) {
      const concurrencyMatch = /\bconcurrency\s*:\s*(\d+)/.exec(line);
      if (concurrencyMatch) currentTransport.options.set('concurrency', concurrencyMatch[1]);
    }

    // prefetch_count
    const prefetchMatch = /\bprefetch_count\s*:\s*(\d+)/.exec(line);
    if (prefetchMatch) currentTransport.options.set('prefetch_count', prefetchMatch[1]);
  }

  if (currentTransport) transports.push(currentTransport);
  return transports;
}

function countWorkersForTransport(transportName: string, appPath: string): number {
  let workerCount = 1; // default assumption

  // Check supervisord.conf
  const supervisordFiles = [
    path.join(appPath, 'supervisord.conf'),
    path.join(appPath, 'docker', 'supervisord.conf'),
    path.join(appPath, 'config', 'supervisord.conf'),
  ];
  for (const supervisordFile of supervisordFiles) {
    const content = readFileSafe(supervisordFile, appPath);
    if (!content) continue;
    if (!content.includes(transportName) && !content.includes('messenger:consume')) continue;

    // Count numprocs for messenger:consume
    const sections = content.split(/\[program:/);
    for (const section of sections) {
      if (!section.includes('messenger:consume')) continue;
      const numprocsMatch = /\bnumprocs\s*=\s*(\d+)/.exec(section);
      if (numprocsMatch) {
        workerCount = Math.max(workerCount, parseInt(numprocsMatch[1], 10));
      }
    }
  }

  // Check docker-compose.yml
  const dockerComposeFiles = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
    path.join(appPath, 'docker', 'docker-compose.yml'),
  ];
  for (const dcFile of dockerComposeFiles) {
    const content = readFileSafe(dcFile, appPath);
    if (!content) continue;
    if (!content.includes('messenger:consume')) continue;

    // Check for replicas or scale
    const replicasMatch = /replicas\s*:\s*(\d+)/.exec(content);
    if (replicasMatch) {
      workerCount = Math.max(workerCount, parseInt(replicasMatch[1], 10));
    }
  }

  // Check env for WORKER_COUNT
  let rootEntries: string[] = [];
  try { rootEntries = fs.readdirSync(appPath); } catch { rootEntries = []; }
  for (const entry of rootEntries) {
    if (!entry.startsWith('.env')) continue;
    const full = path.join(appPath, entry);
    const content = readFileSafe(full, appPath);
    if (!content) continue;
    const workerMatch = /WORKER_COUNT\s*=\s*(\d+)/.exec(content);
    if (workerMatch) {
      workerCount = Math.max(workerCount, parseInt(workerMatch[1], 10));
      break;
    }
  }

  return workerCount;
}

function checkLimitOption(transportName: string, appPath: string): boolean {
  // Check supervisor, docker-compose for --limit flag
  const filesToCheck = [
    path.join(appPath, 'supervisord.conf'),
    path.join(appPath, 'docker', 'supervisord.conf'),
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
    path.join(appPath, 'Makefile'),
  ];
  for (const f of filesToCheck) {
    const content = readFileSafe(f, appPath);
    if (!content) continue;
    if (content.includes('--limit') || content.includes('-l ')) return true;
  }
  return false;
}

function buildCompetingConsumerInfos(appPath: string): CompetingConsumerInfo[] {
  const infos: CompetingConsumerInfo[] = [];

  // Load messenger config
  const messengerFiles = [
    path.join(appPath, 'config', 'packages', 'messenger.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'messenger.yaml'),
  ];

  for (const messengerFile of messengerFiles) {
    const content = readFileSafe(messengerFile, appPath);
    if (!content) continue;

    const transports = parseMessengerTransports(content);

    for (const transport of transports) {
      const concurrency = parseInt(transport.options.get('concurrency') ?? '0', 10);
      const workers = countWorkersForTransport(transport.name, appPath);
      const hasLimit = checkLimitOption(transport.name, appPath);
      const issues: string[] = [];

      if (workers <= 1) {
        issues.push(`Only ${workers} worker for transport "${transport.name}" — consider multiple workers for high-load transports`);
      }
      if (concurrency === 0) {
        issues.push(`No concurrency option set for transport "${transport.name}" — set options.concurrency to limit parallel message processing`);
      }
      if (!hasLimit) {
        issues.push(`No --limit option detected for messenger:consume — add --limit=N to recycle workers and prevent memory leaks`);
      }

      infos.push({ transport: transport.name, workers, concurrency, issues });
    }
  }

  return infos;
}

export function listSymfonyMessengerCompetingConsumers(appPath: string): McpToolResult {
  try {
    const infos = buildCompetingConsumerInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Messenger transports found in config/packages/messenger.yaml.' }] };
    }

    const withIssues = infos.filter(i => i.issues.length > 0);
    let text = `Symfony Messenger Competing Consumers\n${'='.repeat(55)}\n\n`;
    text += `Transports found: ${infos.length}  (${withIssues.length} with issues)\n\n`;

    for (const info of infos) {
      text += `  Transport: ${info.transport}\n`;
      text += `    Workers:     ${info.workers}\n`;
      text += `    Concurrency: ${info.concurrency === 0 ? 'not set' : info.concurrency}\n`;
      for (const issue of info.issues) {
        text += `    ! ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerCompetingConsumersStats(appPath: string): McpToolResult {
  try {
    const infos = buildCompetingConsumerInfos(appPath);
    const withIssues = infos.filter(i => i.issues.length > 0).length;
    const singleWorker = infos.filter(i => i.workers <= 1).length;
    const noConcurrency = infos.filter(i => i.concurrency === 0).length;
    const noLimit = infos.filter(i => i.issues.some(s => s.includes('--limit'))).length;
    const totalWorkers = infos.reduce((s, i) => s + i.workers, 0);

    let text = `Symfony Messenger Competing Consumers Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total transports:     ${infos.length}\n`;
    text += `  With issues:        ${withIssues}\n`;
    text += `  Single worker:      ${singleWorker}\n`;
    text += `  No concurrency:     ${noConcurrency}\n`;
    text += `  No --limit flag:    ${noLimit}\n`;
    text += `  Total workers:      ${totalWorkers}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerCompetingConsumersTools(): Array<{ name: string; description: string; inputSchema: object }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_messenger_competing_consumers',
      description: 'List Symfony Messenger transports with worker and concurrency analysis: detected worker counts from supervisord/docker-compose, issues with single workers or missing --limit',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_messenger_competing_consumers_stats',
      description: 'Get Symfony Messenger competing consumer statistics: transport counts, single-worker warnings, missing concurrency limits, total worker count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
