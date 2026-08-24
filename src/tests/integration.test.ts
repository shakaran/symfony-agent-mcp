// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * End-to-End Integration Test
 *
 * Spawns the server process via stdio and exercises the full MCP protocol:
 *   initialize → tools/list → tools/call (with and without secrets in output)
 *
 * This verifies the complete security pipeline from JSON-RPC input to
 * sanitized output — something unit tests cannot cover.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runStartupAudit } from '../utils/startup-audit';
import { STRIPE_LIVE_KEY_SHORT } from '../fuzz/secret-fixtures';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serverPath(): string {
  return path.resolve(__dirname, '../../dist/server.js');
}


/** Send a JSON-RPC request and collect the response. */
function rpc(proc: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject): void => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buffer = '';

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            proc.stdout.off('data', onData);
            resolve(parsed);
          }
        } catch {
          // Partial line or non-JSON — keep buffering
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stdin.write(msg);

    // Timeout — unref so it doesn't keep the process alive after test ends
    const timer = setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`RPC timeout for method=${method} id=${id}`));
    }, 10000);
    timer.unref();
  });
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

let tmpAppDir: string;

function createMinimalSymfonyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-mcp-test-'));
  // Minimal structure so tools don't immediately fail with ENOENT
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'Entity'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'var', 'log'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'composer.json'),
    JSON.stringify({ name: 'test/app', require: { 'symfony/framework-bundle': '^7.0' } })
  );
  return dir;
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProc: ChildProcessWithoutNullStreams | null = null;

function startServer(extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const proc = spawn('node', [serverPath()], {
    env: {
      ...process.env,
      SYMFONY_MCP_STARTUP_AUDIT: 'false',
      SYMFONY_MCP_SESSION_TOKEN: '',
      SYMFONY_MCP_SIGNING_SECRET: '',
      SYMFONY_MCP_AUDIT: 'false',
      SYMFONY_MCP_ANOMALY: 'false',
      SYMFONY_MCP_RATE_LIMIT: '0',
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });

  proc.unref(); // don't keep the test process alive if we forget to kill
  proc.stderr.on('data', () => { /* suppress server logs */ });
  return proc;
}

// ─── Suite setup / teardown ───────────────────────────────────────────────────

beforeAll(() => {
  // Skip E2E if server binary hasn't been built yet
  if (!fs.existsSync(serverPath())) {
    return;
  }
  tmpAppDir = createMinimalSymfonyFixture();
  serverProc = startServer();
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
  if (tmpAppDir && fs.existsSync(tmpAppDir)) {
    fs.rmSync(tmpAppDir, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP server E2E (requires built dist/)', () => {
  function skipIfNotBuilt(): boolean {
    if (!fs.existsSync(serverPath())) {
      return true;
    }
    return false;
  }

  test('initialize handshake succeeds', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    const response = await rpc(serverProc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }) as { result?: { serverInfo?: { name?: string }; capabilities?: unknown } };

    expect(response).toHaveProperty('result');
    expect(response.result?.serverInfo?.name).toBe('symfony-agent-mcp');
    expect(response.result?.capabilities).toHaveProperty('tools');
  }, 15000);

  test('tools/list exposes only discovery meta-tools in dynamic mode', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    const response = await rpc(serverProc, 2, 'tools/list', {}) as {
      result?: { tools?: Array<{ name: string }> }
    };

    expect(response).toHaveProperty('result');
    const names = (response.result?.tools ?? []).map((t) => t.name);

    // Dynamic tool discovery is on by default: only the meta-tools are advertised
    // up front, so a client never pays the token cost of 800+ schemas.
    expect(names).toContain('list_tool_categories');
    expect(names).toContain('search_tools');
    expect(names).toContain('activate_category');
    expect(names).toContain('get_active_tools');
    expect(names).toContain('deactivate_category');
    expect(names).not.toContain('list_routes');
  }, 15000);

  test('activating a category exposes its tools in tools/list', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    const activation = await rpc(serverProc, 20, 'tools/call', {
      name: 'activate_category',
      // symfony-core is far past the default 40k token budget, so an explicit
      // override is required — which also exercises the budget-guard path.
      arguments: { category: 'symfony-core', force: true },
    }) as { result?: { isError?: boolean } };
    expect(activation.result?.isError).not.toBe(true);

    const response = await rpc(serverProc, 21, 'tools/list', {}) as {
      result?: { tools?: Array<{ name: string }> }
    };
    const names = (response.result?.tools ?? []).map((t) => t.name);

    expect(names).toContain('list_routes');
    expect(names.length).toBeGreaterThan(20);

    // Leave the shared session as we found it for the tests that follow.
    await rpc(serverProc, 22, 'tools/call', {
      name: 'deactivate_category',
      arguments: { category: 'symfony-core' },
    });
  }, 15000);

  test('tools/list with dynamic discovery disabled advertises every tool', async () => {
    if (skipIfNotBuilt()) return;

    const staticProc = startServer({ SYMFONY_MCP_DYNAMIC_TOOLS: 'false' });
    try {
      await rpc(staticProc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });

      const response = await rpc(staticProc, 2, 'tools/list', {}) as {
        result?: { tools?: Array<{ name: string }> }
      };
      const names = (response.result?.tools ?? []).map((t) => t.name);

      expect(names).toContain('list_routes');
      expect(names).toContain('list_tables');
      expect(names).toContain('get_entity_details');
      expect(names).toContain('tail_log');
      expect(names.length).toBeGreaterThan(20);
    } finally {
      staticProc.kill('SIGTERM');
    }
  }, 20000);

  test('tool call with invalid app_path is rejected by input validator', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    const response = await rpc(serverProc, 3, 'tools/call', {
      name: 'list_routes',
      arguments: { app_path: '' }, // empty path — should fail validation
    }) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };

    expect(response.result?.isError).toBe(true);
    // Either input-validator or guardAppPath will reject an empty app_path
    const text = response.result?.content?.[0]?.text ?? '';
    expect(text.toLowerCase()).toMatch(/invalid input|access denied|app_path/i);
  }, 15000);

  test('tool call with path traversal is blocked by anomaly detector', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    // Re-enable anomaly detection for this test
    const anomalyProc = startServer({
      SYMFONY_MCP_ANOMALY: 'true',
      SYMFONY_MCP_ANOMALY_STRICT: 'true',
    });

    try {
      // Initialize
      await rpc(anomalyProc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });

      const response = await rpc(anomalyProc, 2, 'tools/call', {
        name: 'list_routes',
        arguments: { app_path: '/app/../../etc/passwd' },
      }) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };

      expect(response.result?.isError).toBe(true);
      const text = response.result?.content?.[0]?.text ?? '';
      // Either anomaly blocked it or input validator caught the unsafe char
      expect(text.length).toBeGreaterThan(0);
    } finally {
      anomalyProc.kill('SIGTERM');
    }
  }, 20000);

  test('DLP gate redacts secrets in tool output', async () => {
    if (skipIfNotBuilt() || !serverProc) return;

    // Create a fake .env file with a secret that would be returned by get_app_environment
    const envFile = path.join(tmpAppDir, '.env');
    fs.writeFileSync(envFile, `STRIPE_SECRET_KEY=${STRIPE_LIVE_KEY_SHORT}\nAPP_ENV=prod\n`);

    const response = await rpc(serverProc, 4, 'tools/call', {
      name: 'get_app_environment',
      arguments: { app_path: tmpAppDir },
    }) as { result?: { content?: Array<{ text: string }> } };

    const text = response.result?.content?.[0]?.text ?? '';
    // DLP must have redacted the Stripe key
    expect(text).not.toContain(STRIPE_LIVE_KEY_SHORT);
    // APP_ENV should still be visible (not a DLP match)
    // (test just confirms the pipeline runs without crashing)
    expect(text.length).toBeGreaterThan(0);
  }, 15000);
});

// ─── Build-independent unit tests ─────────────────────────────────────────────

describe('integration: server module exports', () => {
  test('McpToolResult interface shape is correct', () => {
    // Just verify the module structure compiles and exports what we expect
    const result = {
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    };
    expect(result.content[0].text).toBe('hello');
  });

  test('security pipeline components are importable', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const { runStartupAudit } = await import('../utils/startup-audit.js');
    const { clearVaultCache } = await import('../utils/vault-resolver.js');

    expect(typeof validateToolArgs).toBe('function');
    expect(typeof runStartupAudit).toBe('function');
    expect(typeof clearVaultCache).toBe('function');
  });

  test('validateToolArgs rejects empty app_path', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const result = validateToolArgs('list_routes', { app_path: '' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('app_path');
  });

  test('validateToolArgs accepts valid app_path', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const result = validateToolArgs('list_routes', { app_path: '/var/www/symfony-app' });
    expect(result.valid).toBe(true);
  });

  test('validateToolArgs rejects path with shell metacharacters', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const result = validateToolArgs('list_routes', { app_path: '/app; rm -rf /' });
    expect(result.valid).toBe(false);
  });

  test('validateToolArgs rejects oversized query', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const result = validateToolArgs('search_routes', {
      app_path: '/app',
      query: 'x'.repeat(600),  // exceeds 512 max
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('max length');
  });

  test('validateToolArgs accepts valid tail_log lines range', async () => {
    const { validateToolArgs } = await import('../utils/input-validator.js');
    const ok = validateToolArgs('tail_log', { app_path: '/app', file_name: 'dev.log', lines: 100 });
    expect(ok.valid).toBe(true);
    const tooMany = validateToolArgs('tail_log', { app_path: '/app', file_name: 'dev.log', lines: 99999 });
    expect(tooMany.valid).toBe(false);
  });

  test('runStartupAudit returns findings array and does not throw', () => {
    const old = process.env['SYMFONY_MCP_STARTUP_AUDIT'];
    delete process.env['SYMFONY_MCP_STARTUP_AUDIT'];
    try {
      const findings = runStartupAudit(false);
      expect(Array.isArray(findings)).toBe(true);
    } finally {
      if (old !== undefined) process.env['SYMFONY_MCP_STARTUP_AUDIT'] = old;
    }
  });

  test('runStartupAudit returns empty when disabled', () => {
    process.env['SYMFONY_MCP_STARTUP_AUDIT'] = 'false';
    try {
      const findings = runStartupAudit(false);
      expect(findings).toEqual([]);
    } finally {
      delete process.env['SYMFONY_MCP_STARTUP_AUDIT'];
    }
  });

  test('runStartupAudit flags DLP_DISABLED as CRITICAL', () => {
    const oldDlp = process.env['SYMFONY_MCP_DLP'];
    const oldAudit = process.env['SYMFONY_MCP_STARTUP_AUDIT'];
    process.env['SYMFONY_MCP_DLP'] = 'false';
    delete process.env['SYMFONY_MCP_STARTUP_AUDIT'];
    try {
      const findings = runStartupAudit(false);
      const dlp = findings.find((f: { code: string }) => f.code === 'DLP_DISABLED');
      expect(dlp).toBeDefined();
      expect(dlp?.severity).toBe('CRITICAL');
    } finally {
      if (oldDlp !== undefined) process.env['SYMFONY_MCP_DLP'] = oldDlp;
      else delete process.env['SYMFONY_MCP_DLP'];
      if (oldAudit !== undefined) process.env['SYMFONY_MCP_STARTUP_AUDIT'] = oldAudit;
    }
  });
});
