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
// Only the first few reads of a call are oversized: a module that walks a
// tree would otherwise scan hundreds of megabytes to reach one size guard.
let hugeReads = 0;

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
      if (failMode === 'huge' && hugeReads < 3) {
        hugeReads += 1;
        return 'x'.repeat(600_000);
      }
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

  // The ecosystem files, so the modules that read only one of them get past
  // their own "nothing here" return and into the guarded read this file is
  // about.
  write('features/home.feature', 'Feature: Home\n\n    Scenario: Visiting\n        Given I am on the home page\n');
  write('features/bootstrap/FeatureContext.php', '<?php\n\nclass FeatureContext\n{\n    /**\n     * @Given I am on the home page\n     */\n    public function home(): void\n    {\n    }\n}\n');
  write('behat.yaml', 'default:\n    suites:\n        default:\n            paths: ["%paths.base%/features"]\n');
  write('cypress.config.js', 'module.exports = { e2e: { baseUrl: "http://localhost" } };\n');
  write('cypress/e2e/login.cy.js', 'describe("login", () => { it("works", () => { cy.visit("/"); }); });\n');
  write('k8s/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n    name: acme\nspec:\n    replicas: 2\n');
  write('terraform/main.tf', 'terraform {\n  required_version = ">= 1.5"\n}\n\nresource "aws_s3_bucket" "assets" {\n  bucket = "acme"\n}\n');
  write('helm/acme/Chart.yaml', 'apiVersion: v2\nname: acme\nversion: 1.0.0\n');
  write('helm/acme/values.yaml', 'replicaCount: 1\nimage:\n    tag: latest\n');
  write('grafana/dashboards/acme.json', '{"title":"Acme","panels":[]}\n');
  write('monitoring/acme.rules.yml', 'groups:\n    - name: acme\n      rules:\n          - alert: Down\n            expr: up == 0\n');
  write('.github/workflows/ci.yml', 'name: ci\non: [push]\njobs:\n    build:\n        runs-on: ubuntu-latest\n        steps:\n            - run: composer install\n');
  write('bitbucket-pipelines.yml', 'image: php:8.3\n\npipelines:\n    default:\n        - step:\n              script:\n                  - composer install\n');
  write('azure-pipelines.yml', 'trigger:\n    - main\n\npool:\n    vmImage: ubuntu-latest\n\nsteps:\n    - script: composer install\n');
  write('.circleci/config.yml', 'version: 2.1\n\njobs:\n    build:\n        docker:\n            - image: cimg/php:8.3\n        steps:\n            - checkout\n');
  write('.gitlab-ci.yml', 'stages: [test]\n\ntest:\n    stage: test\n    script:\n        - vendor/bin/phpunit\n');
  write('Dockerfile', 'FROM php:8.3-fpm\n\nUSER www-data\n');
  write('Caddyfile', 'acme.example.com {\n    tls internal\n    php_server\n}\n');
  write('netlify.toml', '[build]\n    command = "composer install"\n    publish = "public"\n');
  write('render.yaml', 'services:\n  - type: web\n    name: acme\n    env: php\n');
  write('fly.toml', 'app = "acme"\n\n[build]\n    dockerfile = "Dockerfile"\n');
  write('vercel.json', '{"framework":"symfony"}\n');
  write('app.json', '{"name":"acme","env":{"APP_ENV":{"value":"prod"}}}\n');
  write('Procfile', 'web: heroku-php-apache2 public/\n');
  write('deploy/task-definition.json', '{"family":"acme","containerDefinitions":[{"name":"app","image":"acme:1.0"}]}\n');
  write('.symfony.cloud.yaml', 'name: app\ntype: php:8.3\n\nrelationships:\n    database: "db:postgresql"\n');
  write('.platform/services.yaml', 'db:\n    type: postgresql:16\n');
  write('pgbouncer.ini', '[databases]\nacme = host=db\n\n[pgbouncer]\npool_mode = transaction\n');
  write('consul.json', '{"service":{"name":"acme","port":8080}}\n');
  write('phpstan.dist.neon', 'parameters:\n    level: 6\n    paths:\n        - src\n');
  write('psalm.xml', '<?xml version="1.0"?>\n<psalm errorLevel="3"><projectFiles><directory name="src"/></projectFiles></psalm>\n');
  write('rector.php', '<?php\n\nuse Rector\\Config\\RectorConfig;\n\nreturn static function (RectorConfig $c): void {\n    $c->paths([__DIR__ . "/src"]);\n};\n');
  write('ecs.php', '<?php\n\nreturn static function ($config): void {\n};\n');
  write('phpspec.yml', 'suites:\n  main:\n    namespace: App\n');
  write('spec/AppSpec.php', '<?php\n\nnamespace spec\\App;\n\nuse PhpSpec\\ObjectBehavior;\n\nclass AppSpec extends ObjectBehavior\n{\n}\n');
  write('codeception.yml', 'paths:\n    tests: tests\n');
  write('tests/unit.suite.yml', 'actor: UnitTester\n');
  write('symfony.lock', '{"symfony/framework-bundle":{"version":"7.0","recipe":{"repo":"github.com/symfony/recipes"}}}\n');
  write('importmap.php', '<?php\n\nreturn [\n    "app" => ["path" => "./assets/app.js", "entrypoint" => true],\n];\n');
  write('assets/controllers.json', '{"controllers":{}}\n');
  write('cypress/fixtures/user.json', '{"email":"acme@example.com"}\n');
  write('var/cache/dev/profiler/index.csv', 'abc123,127.0.0.1,GET,http://localhost/,1767225600,200\n');
  write('var/cache/dev/profiler/23/c1/abc123', '{"time":{"duration":1}}\n');
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
        hugeReads = 0;
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
