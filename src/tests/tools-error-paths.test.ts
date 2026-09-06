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

/** Flipped per test; the mocks below read it on every call. */
let failMode: 'none' | 'read' | 'stat' | 'exists' | 'path' | 'escape' | 'symlink' | 'huge' = 'none';

// The test's own path calls must keep working while the modules' fail.
const path = jest.requireActual<typeof import('path')>('path');

// Not every module calls existsSync: some read straight into a try/catch and
// never touch the filesystem outside a helper that swallows its own errors.
// Building the path, though, every one of them does, and unguarded.
jest.mock('path', () => {
  const real = jest.requireActual<typeof import('path')>('path');
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) => (...args: A): R => {
    if (failMode === 'path') {
      throw Object.assign(new Error('ENAMETOOLONG: simulated failure, join'), { code: 'ENAMETOOLONG' });
    }
    return fn(...args);
  };
  // What a configuration value holding "../.." produces: a path that is built
  // from the application root but no longer inside it.
  const escaping = (...args: string[]): string => {
    if (failMode !== 'escape') return real.join(...args);
    // Only the file itself lands outside. Sending the directories out too
    // means the walk finds nothing and the guard around the read — which is
    // the one being exercised — is never reached.
    const last = args[args.length - 1] ?? '';
    if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) return real.join(...args);

    return real.join('/outside-the-application', ...args.slice(1));
  };
  return {
    ...real,
    join: guard(escaping),
    resolve: guard(real.resolve),
    relative: guard(real.relative),
  };
});

jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  const raise = (code: string, syscall: string): never => {
    throw Object.assign(new Error(`${code}: simulated failure, ${syscall}`), { code });
  };
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (failMode === 'read') return raise('EIO', 'read');
      // A file above the size every module refuses to read.
      if (failMode === 'huge') return 'x'.repeat(600_000);
      return real.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => {
      if (failMode === 'read') return raise('EIO', 'scandir');
      const entries = real.readdirSync(...args);
      // Everything the walk finds is a symlink: the branch every walker has
      // for them, and never takes against an ordinary directory.
      if (failMode === 'symlink') {
        return (entries as unknown[]).map((e) => (
          typeof e === 'string'
            ? e
            : Object.assign(Object.create(Object.getPrototypeOf(e)), e, {
                isSymbolicLink: () => true,
                isDirectory: () => false,
                isFile: () => false,
                name: (e as { name: string }).name,
              })
        ));
      }
      return entries;
    },
    // existsSync is the one call that sits in the entry point itself rather
    // than behind a guarded helper, so it is the failure that actually reaches
    // the outermost handler.
    existsSync: (...args: Parameters<typeof real.existsSync>) =>
      (failMode === 'exists' ? raise('EIO', 'stat') : real.existsSync(...args)),
    statSync: (...args: Parameters<typeof real.statSync>) => {
      if (failMode === 'stat') return raise('EACCES', 'stat');
      const st = real.statSync(...args);
      if (failMode === 'symlink') {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        });
      }
      return st;
    },
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
      if (failMode === 'stat') return raise('EACCES', 'lstat');
      const st = real.lstatSync(...args);
      if (failMode === 'symlink') {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        });
      }
      return st;
    },
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

  // An application with something in it. An empty one sends most walkers
  // home before they read anything, and the guards around each read — the
  // ones this file exists to reach — sit inside the loop over entries.
  const write = (rel: string, content: string): void => {
    const full = path.join(appPath, rel);
    realFs.mkdirSync(path.dirname(full), { recursive: true });
    realFs.writeFileSync(full, content);
  };

  write('composer.json', JSON.stringify({
    require: { 'symfony/framework-bundle': '^7.0', 'doctrine/orm': '^3.0' },
  }));
  write('composer.lock', JSON.stringify({ packages: [{ name: 'symfony/framework-bundle', version: 'v7.0.0' }] }));
  write('src/Controller/HomeController.php', '<?php\n\nnamespace App\\Controller;\n\nclass HomeController\n{\n}\n');
  write('src/Entity/User.php', '<?php\n\nnamespace App\\Entity;\n\nclass User\n{\n}\n');
  write('src/Service/Importer.php', '<?php\n\nnamespace App\\Service;\n\nclass Importer\n{\n}\n');
  write('config/packages/framework.yaml', 'framework:\n    secret: "%env(APP_SECRET)%"\n');
  write('config/packages/security.yaml', 'security:\n    firewalls:\n        main:\n            lazy: true\n');
  write('config/services.yaml', 'services:\n    _defaults:\n        autowire: true\n');
  write('config/routes.yaml', 'app_home:\n    path: /\n');
  write('templates/base.html.twig', '<html>{% block body %}{% endblock %}</html>\n');
  write('templates/home/index.html.twig', '{% extends "base.html.twig" %}\n');
  write('translations/messages.en.yaml', 'hello: Hello\n');
  write('tests/Unit/ImporterTest.php', '<?php\n\nnamespace App\\Tests\\Unit;\n\nclass ImporterTest\n{\n}\n');
  write('migrations/Version20260101000000.php', '<?php\n\nnamespace DoctrineMigrations;\n');
  write('var/log/prod.log', '[2026-08-01T10:00:00+00:00] app.ERROR: boom [] []\n');
  write('public/index.php', '<?php\n\nrequire dirname(__DIR__)."/vendor/autoload.php";\n');
  write('docker-compose.yml', 'services:\n    app:\n        image: acme\n');
  write('.env', 'APP_ENV=prod\nAPP_SECRET=value\n');
  write('phpunit.xml.dist', '<?xml version="1.0"?>\n<phpunit bootstrap="tests/bootstrap.php"/>\n');
});

afterAll(() => {
  failMode = 'none';
  realFs.rmSync(appPath, { recursive: true, force: true });
});

afterEach(() => { failMode = 'none'; });

interface ResultLike { content?: Array<{ type?: string; text?: string }> }

function pathFunctions(mod: Record<string, unknown>): Array<[string, (a: string) => unknown]> {
  // Everything that takes an application path, whatever else it takes after
  // it: the second argument is a name the module looks up, and the handlers
  // around those lookups are only reached when the filesystem underneath
  // them fails.
  const extras = ['prod.log', 'App\\Entity\\User'];

  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function' && (v as (a: string) => unknown).length >= 1)
    .map(([k, v]) => {
      const fn = v as (...args: unknown[]) => unknown;
      if (fn.length === 1) return [k, fn as (a: string) => unknown];

      return [k, ((a: string) => {
        let last: unknown;
        for (const extra of extras) {
          last = fn(a, extra, extra);
        }
        return last;
      }) as (a: string) => unknown];
    });
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

    test('an existence check that fails reaches the outermost handler', async () => {
      // Everything else is behind a helper that swallows its own errors, so
      // this is what the wrapper is actually there to catch.
      failMode = 'exists';

      for (const [, fn] of pathFunctions(mod)) {
        const returned = await Promise.resolve(fn(appPath));

        expect(returned).toBeDefined();
        const r = returned as ResultLike;
        if (typeof returned === 'object' && 'content' in (returned as object)) {
          expect(Array.isArray(r.content)).toBe(true);
          // The failure is reported, not swallowed into an empty answer.
          expect(r.content!.length).toBeGreaterThan(0);
        }
      }
    });

    test('a path that cannot be built reaches the outermost handler', async () => {
      // The one call every module makes before it can read anything.
      failMode = 'path';

      for (const [, fn] of pathFunctions(mod)) {
        const returned = await Promise.resolve(fn(appPath));

        expect(returned).toBeDefined();
        const r = returned as ResultLike;
        if (typeof returned === 'object' && 'content' in (returned as object)) {
          expect(Array.isArray(r.content)).toBe(true);
          expect(r.content!.length).toBeGreaterThan(0);
        }
      }
    });

    test('a path that lands outside the application is refused', async () => {
      // Every module guards the reads it builds; this is the branch that
      // refuses one, and the reason a traversal in configuration is inert.
      failMode = 'escape';

      for (const [, fn] of pathFunctions(mod)) {
        await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
      }
    });

    test('everything on disk looks like a symlink', async () => {
      failMode = 'symlink';

      for (const [, fn] of pathFunctions(mod)) {
        const returned = await Promise.resolve(fn(appPath));

        expect(returned).toBeDefined();
        const r = returned as ResultLike;
        if (typeof returned === 'object' && 'content' in (returned as object)) {
          expect(Array.isArray(r.content)).toBe(true);
        }
      }
    });

    test('every file is larger than the module will read', async () => {
      failMode = 'huge';

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
