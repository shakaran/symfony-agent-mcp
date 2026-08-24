// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Every module's outermost error handler.
 *
 * Each analyser wraps its work so an internal failure comes back as a result
 * the client can read, rather than an exception escaping to the transport.
 * That wrapper is the single largest block of untested code in src/tools —
 * around 840 statements — and the sweep never reaches it, because the modules
 * turn out to be robust: a missing file, a file where a directory belongs,
 * unparseable JSON and broken YAML are all handled without anything throwing.
 *
 * The only way to a handler that catches genuine failure is to cause genuine
 * failure. Here the filesystem is made to fail, which is not contrived: a
 * revoked permission, a disk error, or a directory that vanishes between two
 * calls all surface exactly this way.
 *
 * fs.readFileSync and fs.readdirSync are non-configurable in Node 24, so
 * jest.spyOn cannot replace them; the module registry can, which is why this
 * lives in its own file with its own mock.
 */

import * as path from 'path';

/** Flipped per test; the mock below reads it on every call. */
let failMode: 'none' | 'read' | 'stat' = 'none';

jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  const raise = (code: string, syscall: string): never => {
    throw Object.assign(new Error(`${code}: simulated failure, ${syscall}`), { code });
  };
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) =>
      (failMode === 'read' ? raise('EIO', 'read') : real.readFileSync(...args)),
    readdirSync: (...args: Parameters<typeof real.readdirSync>) =>
      (failMode === 'read' ? raise('EIO', 'scandir') : real.readdirSync(...args)),
    statSync: (...args: Parameters<typeof real.statSync>) =>
      (failMode === 'stat' ? raise('EACCES', 'stat') : real.statSync(...args)),
    lstatSync: (...args: Parameters<typeof real.lstatSync>) =>
      (failMode === 'stat' ? raise('EACCES', 'lstat') : real.lstatSync(...args)),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = jest.requireActual<typeof import('fs')>('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = jest.requireActual<typeof import('os')>('os');

const toolsDir = path.resolve(__dirname, '../tools');

const moduleNames = realFs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

let appPath: string;

beforeAll(() => {
  appPath = realFs.mkdtempSync(path.join(os.tmpdir(), 'symfony-errors-'));
  realFs.writeFileSync(path.join(appPath, 'composer.json'), JSON.stringify({
    require: { 'symfony/framework-bundle': '^7.0' },
  }));
  realFs.mkdirSync(path.join(appPath, 'src'), { recursive: true });
  realFs.mkdirSync(path.join(appPath, 'config', 'packages'), { recursive: true });
});

afterAll(() => {
  failMode = 'none';
  realFs.rmSync(appPath, { recursive: true, force: true });
});

afterEach(() => { failMode = 'none'; });

interface ResultLike { content?: Array<{ type?: string; text?: string }> }

function pathFunctions(mod: Record<string, unknown>): Array<[string, (a: string) => unknown]> {
  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function' && (v as (a: string) => unknown).length === 1)
    .map(([k, v]) => [k, v as (a: string) => unknown]);
}

describe('every module survives a failing filesystem', () => {
  describe.each(moduleNames)('%s', (name) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: Record<string, any>;

    beforeAll(async () => {
      mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
    });

    test('a read that fails mid-analysis comes back as a result', async () => {
      failMode = 'read';

      for (const [, fn] of pathFunctions(mod)) {
        const returned = await Promise.resolve(fn(appPath));

        expect(returned).toBeDefined();
        const r = returned as ResultLike;
        if (typeof returned === 'object' && 'content' in (returned as object)) {
          expect(Array.isArray(r.content)).toBe(true);
        }
      }
    });

    test('a stat that fails is handled too', async () => {
      failMode = 'stat';

      for (const [, fn] of pathFunctions(mod)) {
        await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
      }
    });
  });
});
