// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface SagaInfo {
  file: string;
  type: 'saga' | 'process-manager' | 'correlation' | 'compensation' | 'timeout';
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

function buildSagaInfos(appPath: string): SagaInfo[] {
  const results: SagaInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    const relFile = path.relative(appPath, file);

    const isSaga = (content.includes('Saga') || content.includes('ProcessManager') || content.includes('process_manager')) &&
      (content.includes('correlationId') || content.includes('correlation_id') || content.includes('correlationKey'));

    if (!isSaga && !content.includes('#[AsMessageHandler')) continue;

    if (content.includes('#[AsMessageHandler') && (content.includes('correlationId') || content.includes('sagaId') || content.includes('processId'))) {
      const issues: string[] = [];

      const hasStorage = content.includes('$this->repository') || content.includes('->find(') || content.includes('->load(') ||
        content.includes('SagaRepository') || content.includes('sagaStore');

      if (!hasStorage) {
        issues.push('Saga/process manager without persistent storage — saga state must survive process restarts; use a Doctrine repository or dedicated saga store');
      }

      const hasCompensation = content.includes('compensat') || content.includes('rollback') || content.includes('undo') || content.includes('Cancelled') || content.includes('Failed');
      if (!hasCompensation) {
        issues.push('Saga without compensation/rollback handlers — distributed sagas must define compensating transactions for each step to maintain consistency on failure');
      }

      const hasTimeout = content.includes('timeout') || content.includes('Timeout') || content.includes('expire') || content.includes('DelayedMessage');
      if (!hasTimeout) {
        issues.push('Saga without timeout handling — long-running sagas can stall indefinitely if a participant never responds; add a timeout message to trigger compensation');
      }

      const hasIdempotency = content.includes('idempotent') || content.includes('idempotency') || content.includes('->has(') || content.includes('already');
      if (!hasIdempotency) {
        issues.push('Saga handler may not be idempotent — message retries can trigger the same saga step multiple times; check if step was already applied before executing');
      }

      results.push({ file: relFile, type: 'saga', pattern: 'Saga/Process manager handler', issues });
    }

    const correlationMatches = [...content.matchAll(/correlationId\s*=\s*(['"`]?[^;'"` ]{1,100}['"`]?)/g)];
    if (correlationMatches.length > 0) {
      const hasUuid = content.includes('Uuid') || content.includes('uuid') || content.includes('random_bytes') || content.includes('Ulid');
      if (!hasUuid) {
        results.push({ file: relFile, type: 'correlation', pattern: 'correlation ID without UUID', issues: ['Correlation ID not using UUID/ULID — use Symfony UID or ramsey/uuid for globally unique, collision-safe correlation IDs'] });
      }
    }
  }

  return results;
}

export function listSymfonyMessengerSagas(appPath: string): McpToolResult {
  try {
    const infos = buildSagaInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Saga/Process Manager patterns found (no correlationId with message handlers).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Messenger Saga/Process Manager Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerSagasStats(appPath: string): McpToolResult {
  try {
    const infos = buildSagaInfos(appPath);
    let text = `Saga Statistics\n${'='.repeat(40)}\n\n`;
    text += `Sagas:           ${infos.filter((i) => i.type === 'saga').length}\n`;
    text += `Correlation IDs: ${infos.filter((i) => i.type === 'correlation').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyMessengerSagasTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_messenger_sagas', description: 'Detect Saga/Process Manager patterns in Messenger handlers; warns on missing persistent storage, no compensation/rollback handlers, no timeout handling, non-idempotent saga steps, correlation IDs without UUID/ULID', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_messenger_sagas_stats', description: 'Statistics for sagas: saga/correlation count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
