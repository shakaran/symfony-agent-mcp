/**
 * withAudit's synchronous path, the default log location, and read failures.
 *
 * withAudit accepts both synchronous and async work, and each has its own
 * error handling. Every existing test passes an async function, so the
 * synchronous throw path — the one that records the failure and re-throws —
 * had never run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// os.homedir() is non-configurable in Node 24, so it cannot be spied on
// directly. Overriding it through the module registry keeps the rest of `os`
// intact and, more importantly, keeps this test out of the developer's real
// home directory.
let mockHomedir: string | null = null;
jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: (): string => mockHomedir ?? real.homedir() };
});

import {
  withAudit,
  readRecentAuditEntries,
  getAuditLogPath,
  resetAuditLogger,
} from '../utils/audit-logger';

const ENV_KEYS = ['SYMFONY_MCP_AUDIT', 'SYMFONY_MCP_AUDIT_LOG', 'SYMFONY_MCP_AUDIT_KEY'];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let logPath: string;
let stderrSpy: jest.SpyInstance;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env['SYMFONY_MCP_AUDIT'];
  delete process.env['SYMFONY_MCP_AUDIT_KEY'];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sync-'));
  logPath = path.join(tmpDir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('withAudit — synchronous work', () => {
  test('returns a synchronous result unchanged', () => {
    expect(withAudit('list_routes', '/app', () => ({ ok: true }))).toEqual({ ok: true });
  });

  test('records a synchronous throw and re-throws it', async () => {
    expect(() =>
      withAudit('list_routes', '/app', () => { throw new Error('sync boom'); })
    ).toThrow('sync boom');
    await settle();

    const e = readRecentAuditEntries(10).pop()!;
    expect(e.tool).toBe('list_routes');
    expect(e.success).toBe(false);
    expect(e.errorMsg).toContain('sync boom');
  });

  test('a synchronous failure still records a duration and hashed path', async () => {
    expect(() =>
      withAudit('list_tables', '/var/www/secret', () => { throw new Error('x'); })
    ).toThrow();
    await settle();

    const e = readRecentAuditEntries(10).pop()!;
    expect(typeof e.durationMs).toBe('number');
    expect(e.appHash).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(e)).not.toContain('secret');
  });

  test('a synchronous result flagged isError is recorded as a failure', async () => {
    withAudit('list_routes', '/app', () => ({
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    }));
    await settle();

    expect(readRecentAuditEntries(10).pop()!.success).toBe(false);
  });
});

describe('default log location', () => {
  test('falls back to ~/.symfony-agent-mcp/audit.log when none is configured', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-home-'));
    delete process.env['SYMFONY_MCP_AUDIT_LOG'];
    mockHomedir = fakeHome;
    resetAuditLogger();

    try {
      const p = getAuditLogPath();
      expect(p).toBe(path.join(fakeHome, '.symfony-agent-mcp', 'audit.log'));

      await withAudit('list_routes', '/app', async () => ({ ok: true }));
      await settle();
      expect(fs.existsSync(p!)).toBe(true);
    } finally {
      resetAuditLogger();
      mockHomedir = null;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('logging switched off', () => {
  test('getAuditLogPath reports no file', () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';
    resetAuditLogger();

    expect(getAuditLogPath()).toBeNull();
  });

  test('nothing is written and the result still comes back', async () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';
    resetAuditLogger();

    expect(await withAudit('list_routes', '/app', async () => ({ ok: true })))
      .toEqual({ ok: true });
    await settle();

    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('a synchronous throw still propagates with logging off', () => {
    process.env['SYMFONY_MCP_AUDIT'] = 'false';
    resetAuditLogger();

    expect(() =>
      withAudit('list_routes', '/app', () => { throw new Error('still thrown'); })
    ).toThrow('still thrown');
  });
});

describe('reading a log that cannot be read', () => {
  test('returns an empty list when the log path is a directory', () => {
    const dirAsLog = path.join(tmpDir, 'log-as-dir');
    fs.mkdirSync(dirAsLog, { recursive: true });
    process.env['SYMFONY_MCP_AUDIT_LOG'] = dirAsLog;
    resetAuditLogger();

    expect(readRecentAuditEntries(10)).toEqual([]);
  });
});
