/* eslint-disable @typescript-eslint/no-require-imports --
 * The SIGUSR2 handler is registered at import time and only outside tests, so
 * reaching it means re-requiring the module through an isolated registry.
 */

/**
 * Audit logger paths that only occur in a running server.
 *
 * A key wiped after its TTL, a SIGUSR2 rotation, a rename that fails halfway
 * through re-encryption. None of these happen during a normal test run, so
 * each is forced: a fake clock, an emitted signal, a spy that makes the
 * filesystem fail.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

// fs.renameSync is non-configurable in Node 24, so it cannot be spied on.
// Overriding it through the module registry lets the atomic swap fail on
// demand while every other fs call stays real.
let mockRenameFails = false;
jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike): void => {
      if (mockRenameFails) throw new Error('EXDEV: cross-device link not permitted');
      real.renameSync(from, to);
    },
  };
});
import * as os from 'os';
import * as path from 'path';

import {
  withAudit,
  rotateAuditKey,
  reencryptAuditLog,
  getAuditKeyConfig,
  resetAuditLogger,
} from '../utils/audit-logger';

const ENV_KEYS = [
  'SYMFONY_MCP_AUDIT', 'SYMFONY_MCP_AUDIT_LOG', 'SYMFONY_MCP_AUDIT_KEY',
  'SYMFONY_MCP_AUDIT_KEY_PREV', 'SYMFONY_MCP_AUDIT_KEY_TTL_DAYS',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let logPath: string;
let stderrSpy: jest.SpyInstance;

const key = (): string => crypto.randomBytes(32).toString('base64');
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-forced-'));
  logPath = path.join(tmpDir, 'audit.log');
  process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  resetAuditLogger();
});

afterEach(() => {
  resetAuditLogger();
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('previous key wiped once its TTL expires', () => {
  test('the in-memory backup is cleared and the operator is told', () => {
    jest.useFakeTimers();
    try {
      process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
      process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '1';
      resetAuditLogger();

      rotateAuditKey();
      expect(getAuditKeyConfig().hasPrevKey).toBe(true);

      // One day later the retained key must be gone from memory.
      jest.advanceTimersByTime(86_400_000 + 1000);

      expect(getAuditKeyConfig().hasPrevKey).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('wiped from memory'));
    } finally {
      jest.useRealTimers();
    }
  });

  test('the timer is clamped so a very long TTL still schedules', () => {
    jest.useFakeTimers();
    try {
      process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
      process.env['SYMFONY_MCP_AUDIT_KEY_TTL_DAYS'] = '100000'; // past setTimeout's max
      resetAuditLogger();

      expect(() => rotateAuditKey()).not.toThrow();
      expect(getAuditKeyConfig().hasPrevKey).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('re-encryption that fails while swapping the file in', () => {
  test('the temporary file is cleaned up and the error propagates', async () => {
    process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
    resetAuditLogger();
    await withAudit('recorded', '/app', async () => ({ ok: true }));
    await settle();

    const before = fs.readdirSync(tmpDir);

    mockRenameFails = true;
    try {
      expect(() => reencryptAuditLog(key())).toThrow(/EXDEV/);
    } finally {
      mockRenameFails = false;
    }

    // No .tmp left behind: the rollback removed it.
    const after = fs.readdirSync(tmpDir);
    expect(after.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(after.sort()).toEqual(before.sort());
  });
});

describe('SIGUSR2 rotation handler', () => {
  test('a server outside test mode rotates its key on the signal', () => {
    const prevNodeEnv = process.env['NODE_ENV'];
    const listenersBefore = process.listenerCount('SIGUSR2');

    jest.isolateModules(() => {
      process.env['NODE_ENV'] = 'production';
      process.env['SYMFONY_MCP_AUDIT_LOG'] = logPath;
      process.env['SYMFONY_MCP_AUDIT_KEY'] = key();
      try {
        const mod = require('../utils/audit-logger') as typeof import('../utils/audit-logger');
        mod.resetAuditLogger();

        // Importing outside test mode registers the handler.
        expect(process.listenerCount('SIGUSR2')).toBeGreaterThan(listenersBefore);

        process.emit('SIGUSR2' as NodeJS.Signals);

        expect(mod.getAuditKeyConfig().hasPrevKey).toBe(true);
        mod.resetAuditLogger();
      } finally {
        if (prevNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = prevNodeEnv;
      }
    });

    // Leave the process as we found it.
    process.removeAllListeners('SIGUSR2');
  });
});
