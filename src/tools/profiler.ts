// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Profiler Integration
 *
 * Reads profiler data from var/cache/dev/profiler/ to expose:
 *   - Recent profiled requests (token list)
 *   - Per-request details: URL, method, status, time, queries, exceptions
 *   - SQL queries and their execution times
 *   - Timeline events
 *   - Collector summaries (memory, time, DB, log, events)
 *
 * The Symfony profiler stores one gzipped JSON file per request token.
 * This tool reads those files directly — no HTTP calls to the profiler web UI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { McpToolResult } from '../server.js';


interface ProfilerToken {
  token: string;
  ip: string;
  method: string;
  url: string;
  time: number;
  parent: string;
  statusCode: number;
  virtualType: string;
}

interface ProfilerCollectors {
  time?: { duration: number; initTime?: number };
  memory?: { memory: number; memoryLimit: string };
  db?: { queries: ProfilerQuery[]; queryCount: number; time: number };
  logger?: { logs: ProfilerLog[]; errorCount: number; warningCount: number };
  events?: { calledListeners: ProfilerEvent[] };
  exception?: { hasException: boolean; message?: string; class?: string };
  request?: { requestHeaders: Record<string, string>; responseHeaders: Record<string, string>; statusCode: number };
}

interface ProfilerQuery {
  sql: string;
  executionMs: number;
  params?: unknown[];
  isSuccess?: boolean;
}

interface ProfilerLog {
  priority: string;
  message: string;
  channel?: string;
}

interface ProfilerEvent {
  event: string;
  caller: string;
  duration: number;
}

interface ProfilerEntry {
  token: string;
  method: string;
  url: string;
  statusCode: number;
  timestamp: number;
  durationMs: number;
  memoryMb: number;
  dbQueryCount: number;
  dbTimeMs: number;
  errorCount: number;
  hasException: boolean;
  exceptionMessage?: string;
}

// ─── Profiler file reading ─────────────────────────────────────────────────

function getProfilerDir(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'var', 'cache', 'dev', 'profiler'),
    path.join(appPath, 'var', 'cache', 'profiler'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function readProfilerIndex(profilerDir: string): ProfilerToken[] {
  const indexFile = path.join(profilerDir, 'index.csv');
  const tokens: ProfilerToken[] = [];

  if (!fs.existsSync(indexFile)) {
    // Fall back to reading token files directly
    return readTokensFromFiles(profilerDir);
  }

  try {
    const lines = fs.readFileSync(indexFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 6) continue;
      tokens.push({
        token: parts[0]?.trim() ?? '',
        ip: parts[1]?.trim() ?? '',
        method: parts[2]?.trim() ?? '',
        url: parts[3]?.trim() ?? '',
        time: parseInt(parts[4]?.trim() ?? '0', 10),
        parent: parts[5]?.trim() ?? '',
        statusCode: parseInt(parts[6]?.trim() ?? '200', 10),
        virtualType: parts[7]?.trim() ?? 'request',
      });
    }
  } catch {
    return readTokensFromFiles(profilerDir);
  }

  return tokens.reverse(); // Most recent first
}

function readTokensFromFiles(profilerDir: string): ProfilerToken[] {
  const tokens: ProfilerToken[] = [];
  try {
    const entries = fs.readdirSync(profilerDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      // Symfony nests profiles two levels deep, not one:
      // <folder>/<last 2 chars>/<the 2 before those>/<token>
      // (Symfony\Component\HttpKernel\Profiler\FileProfilerStorage::getFilename)
      const outer = path.join(profilerDir, entry.name);
      try {
        for (const inner of fs.readdirSync(outer, { withFileTypes: true })) {
          if (inner.isSymbolicLink() || !inner.isDirectory()) continue;
          for (const file of fs.readdirSync(path.join(outer, inner.name))) {
            if (file.length < 6) continue;
            tokens.push({
              token: file,
              ip: '',
              method: '',
              url: '',
              time: 0,
              parent: '',
              statusCode: 0,
              virtualType: 'request',
            });
          }
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Skip
  }
  return tokens;
}

function readProfilerData(profilerDir: string, token: string): ProfilerCollectors | null {
  // Same layout as the walker above: the last two characters, then the two
  // before those. Reading `token.slice(0, 2)` one level deep never found a
  // profile Symfony had written.
  const filePath = path.join(profilerDir, token.slice(-2), token.slice(-4, -2), token);

  // Containment check: ensure the resolved path stays inside profilerDir
  const resolvedFilePath = path.resolve(filePath);
  const resolvedBase = path.resolve(profilerDir);
  if (!resolvedFilePath.startsWith(resolvedBase + path.sep)) return null;

  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath);
    let content: string;

    // Try gzip decompression first
    try {
      content = zlib.gunzipSync(raw).toString('utf-8');
    } catch {
      content = raw.toString('utf-8');
    }

    const data = JSON.parse(content) as Record<string, unknown>;
    return parseCollectors(data);
  } catch {
    return null;
  }
}

function parseCollectors(data: Record<string, unknown>): ProfilerCollectors {
  const collectors: ProfilerCollectors = {};

  // Time collector
  const timeData = data['time'] as Record<string, unknown> | undefined;
  if (timeData) {
    collectors.time = {
      duration: Number(timeData['duration'] ?? 0),
      initTime: Number(timeData['initTime'] ?? 0),
    };
  }

  // Memory collector
  const memData = data['memory'] as Record<string, unknown> | undefined;
  if (memData) {
    collectors.memory = {
      memory: Number(memData['memory'] ?? 0),
      memoryLimit: String(memData['memoryLimit'] ?? '-1'),
    };
  }

  // DB / Doctrine collector
  const dbData = (data['db'] ?? data['doctrine']) as Record<string, unknown> | undefined;
  if (dbData) {
    const rawQueries = (dbData['queries'] as Array<Record<string, unknown>>) ?? [];
    collectors.db = {
      queryCount: rawQueries.length,
      time: Number(dbData['time'] ?? 0),
      queries: rawQueries.slice(0, 20).map((q) => ({
        sql: String(q['sql'] ?? q['query'] ?? '').slice(0, 200),
        executionMs: Number(q['executionMS'] ?? q['executionMs'] ?? 0),
        params: (q['params'] as unknown[]) ?? [],
        isSuccess: q['error'] === undefined,
      })),
    };
  }

  // Logger collector
  const logData = data['logger'] as Record<string, unknown> | undefined;
  if (logData) {
    const logs = (logData['logs'] as Array<Record<string, unknown>>) ?? [];
    collectors.logger = {
      errorCount: Number(logData['error_count'] ?? logs.filter((l) => l['priority'] === '400').length),
      warningCount: Number(logData['warning_count'] ?? logs.filter((l) => l['priority'] === '300').length),
      logs: logs.slice(0, 10).map((l) => ({
        priority: String(l['priorityName'] ?? l['priority'] ?? 'INFO'),
        message: String(l['message'] ?? '').slice(0, 150),
        channel: String(l['channel'] ?? ''),
      })),
    };
  }

  // Exception collector
  const excData = data['exception'] as Record<string, unknown> | undefined;
  if (excData) {
    collectors.exception = {
      hasException: Boolean(excData['exception'] ?? excData['hasException']),
      message: String(excData['message'] ?? ''),
      class: String(excData['class'] ?? ''),
    };
  }

  // Request collector
  const reqData = data['request'] as Record<string, unknown> | undefined;
  if (reqData) {
    collectors.request = {
      requestHeaders: (reqData['request_headers'] as Record<string, string>) ?? {},
      responseHeaders: (reqData['response_headers'] as Record<string, string>) ?? {},
      statusCode: Number(reqData['status_code'] ?? 200),
    };
  }

  return collectors;
}

function buildEntry(token: ProfilerToken, collectors: ProfilerCollectors | null): ProfilerEntry {
  return {
    token: token.token,
    method: token.method || 'GET',
    url: token.url || '/',
    statusCode: token.statusCode || collectors?.request?.statusCode || 0,
    timestamp: token.time,
    durationMs: collectors?.time?.duration ?? 0,
    memoryMb: collectors?.memory ? Math.round(collectors.memory.memory / 1024 / 1024 * 10) / 10 : 0,
    dbQueryCount: collectors?.db?.queryCount ?? 0,
    dbTimeMs: collectors?.db ? Math.round(collectors.db.time * 1000) : 0,
    errorCount: collectors?.logger?.errorCount ?? 0,
    hasException: collectors?.exception?.hasException ?? false,
    exceptionMessage: collectors?.exception?.message,
  };
}

function formatTimestamp(ts: number): string {
  if (!ts) return 'unknown';
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listProfilerRequests(appPath: string, limit: number = 20): McpToolResult {
  try {
    const profilerDir = getProfilerDir(appPath);

    if (!profilerDir) {
      return {
        content: [{
          type: 'text',
          text: `Symfony Profiler data not found.\n\nExpected location: ${path.join(appPath, 'var', 'cache', 'dev', 'profiler')}\n\nMake sure:\n  1. APP_ENV=dev\n  2. APP_DEBUG=true\n  3. framework.profiler.enabled: true in config/packages/dev/web_profiler.yaml\n  4. You've made at least one HTTP request`,
        }],
      };
    }

    const allTokens = readProfilerIndex(profilerDir);
    const tokens = allTokens.slice(0, limit);

    if (tokens.length === 0) {
      return {
        content: [{ type: 'text', text: 'No profiler entries found. Make HTTP requests in dev environment to generate profiler data.' }],
      };
    }

    let text = `Recent Profiled Requests (${tokens.length} of ${allTokens.length}):\n${'─'.repeat(80)}\n\n`;
    text += `Token       Time                Method  Status  Duration  DB     Errors  URL\n`;
    text += `${'─'.repeat(80)}\n`;

    for (const tok of tokens) {
      const col = tok.time ? readProfilerData(profilerDir, tok.token) : null;
      const entry = buildEntry(tok, col);
      const timeStr = formatTimestamp(entry.timestamp);
      const dur = entry.durationMs ? `${entry.durationMs}ms` : '-';
      const db = entry.dbQueryCount ? `${entry.dbQueryCount}q` : '-';
      const err = entry.hasException ? `EXC` : entry.errorCount > 0 ? `${entry.errorCount}` : '-';
      const url = entry.url.length > 30 ? entry.url.slice(0, 27) + '...' : entry.url;

      text += `${entry.token.slice(0, 8).padEnd(12)}${timeStr.padEnd(22)}`;
      text += `${entry.method.padEnd(8)}${String(entry.statusCode || '-').padEnd(8)}`;
      text += `${dur.padEnd(10)}${db.padEnd(7)}${err.padEnd(8)}${url}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading profiler: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProfilerDetails(appPath: string, token: string): McpToolResult {
  try {
    const profilerDir = getProfilerDir(appPath);

    if (!profilerDir) {
      return {
        content: [{ type: 'text', text: 'Profiler data directory not found (var/cache/dev/profiler/).' }],
        isError: true,
      };
    }

    const collectors = readProfilerData(profilerDir, token);
    if (!collectors) {
      return {
        content: [{ type: 'text', text: `Profiler token "${token}" not found.` }],
        isError: true,
      };
    }

    let text = `Profiler Token: ${token}\n${'='.repeat(50)}\n\n`;

    if (collectors.time) {
      text += `Performance:\n`;
      text += `  Total duration: ${collectors.time.duration}ms\n`;
      if (collectors.time.initTime) text += `  Init time:      ${collectors.time.initTime}ms\n`;
    }

    if (collectors.memory) {
      text += `\nMemory:\n`;
      text += `  Peak usage: ${Math.round(collectors.memory.memory / 1024 / 1024 * 10) / 10} MB\n`;
      text += `  Limit:      ${collectors.memory.memoryLimit}\n`;
    }

    if (collectors.db) {
      text += `\nDatabase:\n`;
      text += `  Queries: ${collectors.db.queryCount}\n`;
      text += `  Time:    ${Math.round(collectors.db.time * 1000)}ms\n`;

      if (collectors.db.queries.length > 0) {
        text += `\n  Top queries:\n`;
        for (const q of collectors.db.queries.slice(0, 5)) {
          text += `    [${q.executionMs.toFixed(2)}ms] ${q.sql.slice(0, 120)}\n`;
        }
      }
    }

    if (collectors.logger) {
      text += `\nLogs:\n`;
      text += `  Errors:   ${collectors.logger.errorCount}\n`;
      text += `  Warnings: ${collectors.logger.warningCount}\n`;

      if (collectors.logger.logs.length > 0) {
        text += `\n  Recent log entries:\n`;
        for (const log of collectors.logger.logs.slice(0, 5)) {
          text += `    [${log.priority}] ${log.channel ? `(${log.channel}) ` : ''}${log.message}\n`;
        }
      }
    }

    if (collectors.exception?.hasException) {
      text += `\nException:\n`;
      text += `  Class:   ${collectors.exception.class}\n`;
      text += `  Message: ${collectors.exception.message}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading profiler token: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProfilerQueries(appPath: string, token: string): McpToolResult {
  try {
    const profilerDir = getProfilerDir(appPath);

    if (!profilerDir) {
      return {
        content: [{ type: 'text', text: 'Profiler data directory not found.' }],
        isError: true,
      };
    }

    const collectors = readProfilerData(profilerDir, token);
    if (!collectors) {
      return {
        content: [{ type: 'text', text: `Token "${token}" not found.` }],
        isError: true,
      };
    }

    if (!collectors.db || collectors.db.queryCount === 0) {
      return {
        content: [{ type: 'text', text: `No SQL queries recorded for token "${token}".` }],
      };
    }

    const { queries, queryCount, time } = collectors.db;
    let text = `SQL Queries for ${token} (${queryCount} total, ${Math.round(time * 1000)}ms total):\n${'─'.repeat(60)}\n\n`;

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      text += `[${i + 1}] ${q.executionMs.toFixed(2)}ms\n`;
      text += `    ${q.sql}\n\n`;
    }

    if (queryCount > queries.length) {
      text += `... and ${queryCount - queries.length} more queries.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading profiler queries: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getProfilerStats(appPath: string): McpToolResult {
  try {
    const profilerDir = getProfilerDir(appPath);

    if (!profilerDir) {
      return {
        content: [{ type: 'text', text: 'Profiler data directory not found (var/cache/dev/profiler/).' }],
      };
    }

    const tokens = readProfilerIndex(profilerDir);

    let text = `Symfony Profiler Statistics\n${'='.repeat(40)}\n\n`;
    text += `Profiler directory: ${profilerDir}\n`;
    text += `Total tokens:       ${tokens.length}\n`;

    if (tokens.length > 0) {
      const withTime = tokens.filter((t) => t.time > 0);
      if (withTime.length > 0) {
        const oldest = Math.min(...withTime.map((t) => t.time));
        const newest = Math.max(...withTime.map((t) => t.time));
        text += `Period:             ${formatTimestamp(oldest)} → ${formatTimestamp(newest)}\n`;
      }

      // Status code breakdown
      const statusCodes = tokens.reduce<Record<number, number>>((acc, t) => {
        if (t.statusCode) acc[t.statusCode] = (acc[t.statusCode] ?? 0) + 1;
        return acc;
      }, {});

      if (Object.keys(statusCodes).length > 0) {
        text += `\nStatus codes:\n`;
        for (const [code, count] of Object.entries(statusCodes).sort()) {
          text += `  HTTP ${code}: ${count}\n`;
        }
      }

      // Method breakdown
      const methods = tokens.reduce<Record<string, number>>((acc, t) => {
        if (t.method) acc[t.method] = (acc[t.method] ?? 0) + 1;
        return acc;
      }, {});

      if (Object.keys(methods).length > 0) {
        text += `\nHTTP methods:\n`;
        for (const [method, count] of Object.entries(methods).sort(([, a], [, b]) => b - a)) {
          text += `  ${method}: ${count}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading profiler stats: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getProfilerTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'list_profiler_requests',
      description: 'List recent profiled HTTP requests from var/cache/dev/profiler/ with URL, status, duration, query count',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          limit: { type: 'number', description: 'Max requests to show (default: 20)' },
        },
        required: ['app_path'],
      },
    },
    {
      name: 'get_profiler_details',
      description: 'Get full profiler data for a specific token: performance, memory, DB queries, logs, and exceptions',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          token: { type: 'string', description: 'Profiler token (8+ hex chars from list_profiler_requests)' },
        },
        required: ['app_path', 'token'],
      },
    },
    {
      name: 'get_profiler_queries',
      description: 'List all SQL queries for a profiled request with execution times',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          token: { type: 'string', description: 'Profiler token' },
        },
        required: ['app_path', 'token'],
      },
    },
    {
      name: 'get_profiler_stats',
      description: 'Get profiler statistics: total requests profiled, date range, status code and HTTP method distribution',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
