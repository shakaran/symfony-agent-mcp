// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Every advertised tool must be callable.
 *
 * The tool list and the handler map are built in two different places: each
 * module exports its own definitions, and server.ts registers the handlers.
 * Nothing tied the two together, so a definition could name a tool that no
 * handler answered to and the only symptom was "Unknown tool" at call time —
 * after the client had already offered it to the user.
 *
 * Three tools shipped that way: a plural lost from get_php_dnf_types_stats,
 * and two "list my own definitions" entries that were never implemented.
 * This test is the thing that would have caught them.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const serverPath = (): string => path.resolve(__dirname, '../../dist/server.js');

/** Tool names registered as handlers in server.ts. */
function registeredHandlers(): Set<string> {
  const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf-8');
  return new Set([...src.matchAll(/handlers\.set\(\s*'([^']+)'/g)].map((m) => m[1]));
}

/** Tool names the server advertises with dynamic discovery switched off. */
function advertisedTools(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn('node', [serverPath()], {
      env: {
        ...process.env,
        SYMFONY_MCP_STARTUP_AUDIT: 'false',
        SYMFONY_MCP_AUDIT: 'false',
        SYMFONY_MCP_ANOMALY: 'false',
        SYMFONY_MCP_RATE_LIMIT: '0',
        SYMFONY_MCP_DYNAMIC_TOOLS: 'false',
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('timed out waiting for tools/list'));
    }, 20000);
    timer.unref();

    proc.stderr.on('data', () => { /* suppress server logs */ });
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (msg.id === 2) {
            clearTimeout(timer);
            proc.kill();
            resolve((msg.result?.tools ?? []).map((t) => t.name));
          }
        } catch {
          // partial line
        }
      }
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'integrity-test', version: '1.0.0' },
      },
    }) + '\n');

    setTimeout(() => {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    }, 800);
  });
}

/** The initialize result, which is where `instructions` is published. */
function initializeResult(): Promise<{ instructions?: string; serverInfo?: { name: string } }> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn('node', [serverPath()], {
      env: {
        ...process.env,
        SYMFONY_MCP_STARTUP_AUDIT: 'false',
        SYMFONY_MCP_AUDIT: 'false',
        SYMFONY_MCP_ANOMALY: 'false',
        SYMFONY_MCP_RATE_LIMIT: '0',
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('timed out waiting for initialize'));
    }, 20000);
    timer.unref();

    proc.stderr.on('data', () => { /* suppress server logs */ });
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
          if (msg.id === 1) {
            clearTimeout(timer);
            proc.kill();
            resolve((msg.result ?? {}) as { instructions?: string });
          }
        } catch {
          // partial line
        }
      }
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'integrity-test', version: '1.0.0' },
      },
    }) + '\n');
  });
}

/** The five discovery meta-tools are handlers that the static list omits. */
const DISCOVERY_META_TOOLS = [
  'list_tool_categories', 'search_tools', 'activate_category',
  'get_active_tools', 'deactivate_category',
];

describe('tool registry integrity', () => {
  let advertised: string[];

  beforeAll(async () => {
    if (!fs.existsSync(serverPath())) return;
    advertised = await advertisedTools();
  }, 30000);

  test('every advertised tool has a handler', () => {
    if (!fs.existsSync(serverPath())) return;
    const handlers = registeredHandlers();

    const orphans = advertised.filter((name) => !handlers.has(name));

    // Naming each one: a bare count tells whoever broke it nothing.
    expect(orphans).toEqual([]);
  });

  test('every handler is either advertised or a discovery meta-tool', () => {
    if (!fs.existsSync(serverPath())) return;
    const advertisedSet = new Set(advertised);

    const hidden = [...registeredHandlers()]
      .filter((name) => !advertisedSet.has(name) && !DISCOVERY_META_TOOLS.includes(name));

    expect(hidden).toEqual([]);
  });

  test('no tool name is advertised twice', () => {
    if (!fs.existsSync(serverPath())) return;

    const seen = new Set<string>();
    const duplicates = advertised.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));

    expect(duplicates).toEqual([]);
  });

  test('the advertised list is not empty', () => {
    if (!fs.existsSync(serverPath())) return;
    expect(advertised.length).toBeGreaterThan(1000);
  });
});

describe('initialize instructions', () => {
  // Without these a client sees five tools and no way to learn the other ~1,670
  // exist — dynamic mode hides them from tools/list by design. Directories that
  // introspect the server report it as a five-tool server too.
  let result: { instructions?: string; serverInfo?: { name: string } };

  beforeAll(async () => {
    if (!fs.existsSync(serverPath())) return;
    result = await initializeResult();
  }, 30000);

  test('the server publishes instructions', () => {
    if (!fs.existsSync(serverPath())) return;
    expect(result.instructions).toBeTruthy();
  });

  test('they state the real tool count rather than the five advertised', () => {
    if (!fs.existsSync(serverPath())) return;
    const count = /(\d+) tools across/.exec(result.instructions ?? '');

    expect(count).not.toBeNull();
    expect(Number(count?.[1])).toBeGreaterThan(1000);
  });

  test('they name every discovery meta-tool, so the client can act on them', () => {
    if (!fs.existsSync(serverPath())) return;

    for (const tool of DISCOVERY_META_TOOLS) {
      expect(result.instructions).toContain(tool);
    }
  });
});
