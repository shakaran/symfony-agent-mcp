// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Paths that end the process or need the filesystem to misbehave.
 *
 * runStartupAudit can refuse to start a server with CRITICAL findings, which
 * means calling process.exit — untestable without intercepting it. The path
 * guard's symlink rejection needs realpath to fail on a path that exists.
 * Both are forced here rather than left as the only untried code in the
 * startup sequence.
 */

import * as fs from 'fs';

// realpathSync is non-configurable in Node 24; overriding it through the
// module registry lets a path exist while resolving fails, which is what a
// permission-denied or looping symlink looks like from the guard's side.
let mockRealpathFailsFor: string | null = null;
jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...real,
    realpathSync: (p: fs.PathLike, opts?: unknown): string => {
      if (mockRealpathFailsFor !== null && String(p).includes(mockRealpathFailsFor)) {
        throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' });
      }
      return real.realpathSync(p, opts as never) as string;
    },
  };
});

import * as os from 'os';
import * as path from 'path';

import { runStartupAudit } from '../utils/startup-audit';
import { guardAppPath, resetGuardCache } from '../utils/app-guard';

const ENV_KEYS = [
  'SYMFONY_MCP_STARTUP_AUDIT', 'SYMFONY_MCP_DLP', 'SYMFONY_MCP_ALLOWED_PATHS',
];

let saved: Record<string, string | undefined>;
let tmpDir: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatal-paths-'));
  stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  mockRealpathFailsFor = null;
  resetGuardCache();
});

afterEach(() => {
  mockRealpathFailsFor = null;
  resetGuardCache();
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('startup audit refusing to start', () => {
  test('exits when asked to and a CRITICAL finding is present', () => {
    // DLP disabled is the CRITICAL the audit is designed to stop a start on.
    process.env['SYMFONY_MCP_DLP'] = 'false';

    const exitSpy = jest.spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    try {
      runStartupAudit(true);

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('does not exit when CRITICAL findings are present but exiting was not asked for', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    const exitSpy = jest.spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    try {
      runStartupAudit(false);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('does not exit when the findings are only warnings', () => {
    const exitSpy = jest.spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    try {
      // No CRITICAL: DLP stays on, so the audit reports but lets the start proceed.
      runStartupAudit(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('path guard — a path that exists but cannot be resolved', () => {
  function symfonyApp(name: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(path.join(dir, 'config', 'packages'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }));
    fs.writeFileSync(path.join(dir, 'bin', 'console'), '#!/usr/bin/env php');
    return dir;
  }

  test('is rejected as a broken or inaccessible symlink', () => {
    const app = symfonyApp('loop-app');
    mockRealpathFailsFor = 'loop-app';

    const r = guardAppPath(app);

    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/broken or inaccessible symlink/i);
  });

  test('an allowlist entry that cannot be resolved does not vouch for anything', () => {
    const app = symfonyApp('real-app');
    const other = symfonyApp('other-app');

    // The allowlist entry resolves fine; the app path does not.
    process.env['SYMFONY_MCP_ALLOWED_PATHS'] = other;
    mockRealpathFailsFor = 'real-app';
    resetGuardCache();

    expect(guardAppPath(app).allowed).toBe(false);
  });
});
