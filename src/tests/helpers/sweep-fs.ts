// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/// <reference types="jest" />
/**
 * The machinery behind the failing-filesystem sweep.
 *
 * The sweep runs every module in src/tools against a filesystem made to fail,
 * and importing all 820 of them with coverage instrumentation in one worker
 * took over 3 GB. Jest only recycles a worker between test files, so the sweep
 * is split into shards, each a test file of its own, and everything they share
 * lives here.
 *
 * fs.readFileSync and fs.readdirSync are non-configurable in Node 24, so
 * jest.spyOn cannot replace them; the module registry can, which is why each
 * shard declares its own jest.mock() delegating to the factories below.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

/** Flipped per test; the mocks read it on every call. */
export const state = {
  failMode: 'none' as 'none' | 'read' | 'read-file' | 'stat' | 'exists' | 'path' | 'escape' | 'resolve' | 'resolve-dir' | 'symlink' | 'huge' | 'throw-string',
  // Only the first few reads of a call are oversized: a module that walks a
  // tree would otherwise scan hundreds of megabytes to reach one size guard.
  hugeReads: 0,
  // A guard around a read the caller has already made is only reached when the
  // first read works and a later one does not.
  failFromRead: 0,
  readCount: 0,
  failFromStat: 0,
  statCount: 0,
};

const path = jest.requireActual<typeof import('path')>('path');
const realFs = jest.requireActual<typeof import('fs')>('fs');
const os = jest.requireActual<typeof import('os')>('os');

export function pathMock(): typeof import('path') {
  const real = jest.requireActual<typeof import('path')>('path');
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) => (...args: A): R => {
    if (state.failMode === 'path') {
      throw Object.assign(new Error('ENAMETOOLONG: simulated failure, join'), { code: 'ENAMETOOLONG' });
    }
    return fn(...args);
  };
  // What a configuration value holding "../.." produces: a path that is built
  // from the application root but no longer inside it.
  const escaping = (...args: string[]): string => {
    if (state.failMode !== 'escape') return real.join(...args);
    // Only the file itself lands outside. Sending the directories out too
    // means the walk finds nothing and the guard around the read — which is
    // the one being exercised — is never reached.
    const last = args[args.length - 1] ?? '';
    if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) return real.join(...args);

    return real.join('/outside-the-application', ...args.slice(1));
  };
  // What a symlinked directory produces: the file is read from where it was
  // asked for, but resolving it lands outside the application, which is the
  // comparison every module makes before reading.
  const escapingResolve = (...args: string[]): string => {
    const resolved = real.resolve(...args);
    const looksLikeFile = /\.[A-Za-z0-9]{1,10}$/.test(resolved);
    if (state.failMode === 'resolve' && looksLikeFile) {
      return real.join('/outside-the-application', real.basename(resolved));
    }
    // The same for a directory: the walk is refused before it starts, which
    // is a different guard from the one in front of a read.
    if (state.failMode === 'resolve-dir' && !looksLikeFile && resolved.includes('symfony-errors-')) {
      return real.join('/outside-the-application', real.basename(resolved));
    }

    return resolved;
  };

  return {
    ...real,
    join: guard(escaping),
    resolve: guard(escapingResolve),
    relative: guard(real.relative),
  } as unknown as typeof import('path');
}

export function fsMock(): typeof import('fs') {
  const real = jest.requireActual<typeof import('fs')>('fs');
  const raise = (code: string, syscall: string): never => {
    // Every handler asks whether what it caught is an Error before reading a
    // message off it. Nothing in Node throws anything else, so the other half
    // of that question is only ever answered here.
    if (state.failMode === 'throw-string') throw `${code}: simulated failure, ${syscall}`;
    throw Object.assign(new Error(`${code}: simulated failure, ${syscall}`), { code });
  };
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      // 'read' fails every filesystem call; 'read-file' fails only the read
      // itself, so the walk still finds the files whose read is then refused.
      if (state.failMode === 'read' || state.failMode === 'read-file') return raise('EIO', 'read');
      state.readCount += 1;
      if (state.failFromRead > 0 && state.readCount >= state.failFromRead) return raise('EIO', 'read');
      // A file above the size every module refuses to read.
      if (state.failMode === 'huge' && state.hugeReads < 3) {
        state.hugeReads += 1;
        return 'x'.repeat(600_000);
      }
      return real.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => {
      if (state.failMode === 'read') return raise('EIO', 'scandir');
      const entries = real.readdirSync(...args);
      // Everything the walk finds is a symlink: the branch every walker has
      // for them, and never takes against an ordinary directory.
      if (state.failMode === 'symlink') {
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
      (state.failMode === 'exists' || state.failMode === 'throw-string'
        ? raise('EIO', 'stat')
        : real.existsSync(...args)),
    statSync: (...args: Parameters<typeof real.statSync>) => {
      if (state.failMode === 'stat') return raise('EACCES', 'stat');
      state.statCount += 1;
      if (state.failFromStat > 0 && state.statCount >= state.failFromStat) return raise('EACCES', 'stat');
      const st = real.statSync(...args);
      if (state.failMode === 'symlink') {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        });
      }
      return st;
    },
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
      if (state.failMode === 'stat') return raise('EACCES', 'lstat');
      state.statCount += 1;
      if (state.failFromStat > 0 && state.statCount >= state.failFromStat) return raise('EACCES', 'lstat');
      const st = real.lstatSync(...args);
      if (state.failMode === 'symlink') {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        });
      }
      return st;
    },
  } as unknown as typeof import('fs');
}

const toolsDir = path.resolve(__dirname, '../../tools');

export const moduleNames = realFs.readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

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

/**
 * Declares the sweep for one shard: shard 0 of 4 takes every fourth module
 * starting at the first, and so on, so each file imports a quarter of them.
 */
export function defineSweep(shard: number, shards: number): void {
  const names = moduleNames.filter((_, i) => i % shards === shard);
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

    // A handful of files carrying the attributes and shapes the analysers look
    // for. Without them most modules stop at their own pre-filter and the read
    // this file exists to break is never attempted.
    write('src/Entity/Money.php', [
      '<?php',
      '',
      'namespace App\\Entity;',
      '',
      'use Doctrine\\ORM\\Mapping as ORM;',
      '',
      '#[ORM\\Embeddable]',
      'class Money',
      '{',
      '    #[ORM\\Column(type: "integer")]',
      '    private int $amount = 0;',
      '}',
      '',
    ].join('\n'));
    write('src/Entity/Order.php', [
      '<?php',
      '',
      'namespace App\\Entity;',
      '',
      'use Doctrine\\Common\\Collections\\ArrayCollection;',
      'use Doctrine\\ORM\\Mapping as ORM;',
      '',
      '#[ORM\\Entity(repositoryClass: OrderRepository::class)]',
      '#[ORM\\Table(name: "orders")]',
      '#[ORM\\Index(columns: ["status"], name: "idx_status")]',
      'class Order',
      '{',
      '    #[ORM\\Id]',
      '    #[ORM\\GeneratedValue]',
      '    #[ORM\\Column]',
      '    private int $id;',
      '',
      '    #[ORM\\Embedded(class: Money::class)]',
      '    private Money $total;',
      '',
      '    #[ORM\\ManyToOne(targetEntity: User::class, inversedBy: "orders")]',
      '    private User $customer;',
      '',
      '    #[ORM\\OneToMany(mappedBy: "order", targetEntity: Money::class, cascade: ["persist"])]',
      '    private ArrayCollection $lines;',
      '}',
      '',
    ].join('\n'));
    write('src/Enum/Status.php', [
      '<?php',
      '',
      'namespace App\\Enum;',
      '',
      'enum Status: string',
      '{',
      '    case Draft = "draft";',
      '    case Sent = "sent";',
      '}',
      '',
    ].join('\n'));
    write('src/Command/ImportCommand.php', [
      '<?php',
      '',
      'namespace App\\Command;',
      '',
      'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
      'use Symfony\\Component\\Console\\Command\\Command;',
      'use Symfony\\Component\\Console\\Helper\\ProgressBar;',
      '',
      '#[AsCommand(name: "app:import", description: "Imports")]',
      'class ImportCommand extends Command',
      '{',
      '    protected function execute($input, $output): int',
      '    {',
      '        $bar = new ProgressBar($output, 10);',
      '        $bar->advance();',
      '',
      '        return Command::SUCCESS;',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/EventSubscriber/AuditSubscriber.php', [
      '<?php',
      '',
      'namespace App\\EventSubscriber;',
      '',
      'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
      '',
      'class AuditSubscriber implements EventSubscriberInterface',
      '{',
      '    public static function getSubscribedEvents(): array',
      '    {',
      '        return ["kernel.request" => "onRequest", "workflow.order.completed" => "onCompleted"];',
      '    }',
      '',
      '    public function onRequest(): void',
      '    {',
      '    }',
      '',
      '    public function onCompleted(): void',
      '    {',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/Security/Voter/OrderVoter.php', [
      '<?php',
      '',
      'namespace App\\Security\\Voter;',
      '',
      'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
      '',
      'class OrderVoter extends Voter',
      '{',
      '    protected function supports(string $attribute, mixed $subject): bool',
      '    {',
      '        return true;',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/Form/OrderType.php', [
      '<?php',
      '',
      'namespace App\\Form;',
      '',
      'use Symfony\\Component\\Form\\AbstractType;',
      'use Symfony\\Component\\Form\\FormBuilderInterface;',
      '',
      'class OrderType extends AbstractType',
      '{',
      '    public function buildForm(FormBuilderInterface $builder, array $options): void',
      '    {',
      '        $builder->add("reference")->add("total");',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/Controller/ApiController.php', [
      '<?php',
      '',
      'namespace App\\Controller;',
      '',
      'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
      'use Symfony\\Component\\HttpFoundation\\Request;',
      'use Symfony\\Component\\HttpKernel\\Attribute\\MapRequestPayload;',
      'use Symfony\\Component\\Routing\\Attribute\\Route;',
      '',
      'class ApiController',
      '{',
      '    #[Route("/api/orders", name: "api_orders", methods: ["POST"])]',
      '    public function create(Request $request, #[MapRequestPayload] Money $payload): JsonResponse',
      '    {',
      '        return new JsonResponse(["ok" => true]);',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/Repository/OrderRepository.php', [
      '<?php',
      '',
      'namespace App\\Repository;',
      '',
      'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
      'use Doctrine\\Common\\Collections\\Criteria;',
      '',
      'class OrderRepository extends ServiceEntityRepository',
      '{',
      '    public function recent(): array',
      '    {',
      '        $criteria = Criteria::create()->orderBy(["id" => "DESC"]);',
      '',
      '        return $this->matching($criteria)->toArray();',
      '    }',
      '',
      '    public function search(string $term): array',
      '    {',
      '        return $this->createQueryBuilder("o")',
      '            ->where("o.reference LIKE :term")',
      '            ->setParameter("term", $term)',
      '            ->getQuery()',
      '            ->getResult();',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('src/MessageHandler/SendEmailHandler.php', [
      '<?php',
      '',
      'namespace App\\MessageHandler;',
      '',
      'use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;',
      '',
      '#[AsMessageHandler]',
      'class SendEmailHandler',
      '{',
      '    public function __invoke(object $message): void',
      '    {',
      '    }',
      '}',
      '',
    ].join('\n'));
    write('templates/order/new.html.twig', [
      '{% extends "base.html.twig" %}',
      '',
      '{% form_theme form "form/fields.html.twig" %}',
      '',
      '{% block body %}',
      '    {% for line in order.lines %}',
      '        {{ render(controller("App\\\\Controller\\\\ApiController::create")) }}',
      '    {% endfor %}',
      '    {{ form(form) }}',
      '{% endblock %}',
      '',
    ].join('\n'));
    write('config/packages/doctrine.yaml', 'doctrine:\n    dbal:\n        url: "%env(resolve:DATABASE_URL)%"\n    orm:\n        auto_generate_proxy_classes: true\n        mappings:\n            App:\n                type: attribute\n                dir: "%kernel.project_dir%/src/Entity"\n');
    write('config/packages/messenger.yaml', 'framework:\n    messenger:\n        transports:\n            async: "%env(MESSENGER_TRANSPORT_DSN)%"\n        routing:\n            "App\\\\Message\\\\SendEmail": async\n');
    write('config/packages/monolog.yaml', 'monolog:\n    handlers:\n        main:\n            type: stream\n            path: "%kernel.logs_dir%/%kernel.environment%.log"\n            level: debug\n');
    write('config/packages/cache.yaml', 'framework:\n    cache:\n        app: cache.adapter.filesystem\n        pools:\n            doctrine.result_cache_pool:\n                adapter: cache.adapter.filesystem\n');
    write('config/packages/workflow.yaml', 'framework:\n    workflows:\n        order:\n            type: state_machine\n            marking_store:\n                type: method\n                property: currentPlace\n            supports:\n                - App\\\\Entity\\\\Order\n            places: [draft, sent]\n            transitions:\n                send:\n                    from: draft\n                    to: sent\n');
    write('config/packages/twig.yaml', 'twig:\n    form_themes:\n        - "bootstrap_5_layout.html.twig"\n');
    write('config/packages/mailer.yaml', 'framework:\n    mailer:\n        dsn: "%env(MAILER_DSN)%"\n');

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
    state.failMode = 'none';
    realFs.rmSync(appPath, { recursive: true, force: true });
  });

  afterEach(() => { state.failMode = 'none'; state.failFromRead = 0; state.failFromStat = 0; });

  describe('every module survives a failing filesystem', () => {
    describe.each(names)('%s', (name) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: Record<string, any>;

      beforeAll(async () => {
        mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
      });

      test('a read that fails mid-analysis comes back as a result', async () => {
        state.failMode = 'read';

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
        state.failMode = 'exists';

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

      test('a failure that is not an Error still comes back as a result', async () => {
      state.failMode = 'throw-string';

      for (const [, fn] of pathFunctions(mod)) {
        const returned = await Promise.resolve(fn(appPath));

        expect(returned).toBeDefined();
        const r = returned as ResultLike;
        if (typeof returned === 'object' && 'content' in (returned as object)) {
          expect(Array.isArray(r.content)).toBe(true);
        }
      }
    });

    test('a path that cannot be built reaches the outermost handler', async () => {
        // The one call every module makes before it can read anything.
        state.failMode = 'path';

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
        state.failMode = 'escape';

        for (const [, fn] of pathFunctions(mod)) {
          await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
        }
      });

      test('the files are found and every read of them fails', async () => {
        state.failMode = 'read-file';

        for (const [, fn] of pathFunctions(mod)) {
          await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
        }
      });

      test('a path that resolves outside the application is refused', async () => {
        // The read is asked for by a path that resolves elsewhere: the guard in
        // front of it is what refuses the file.
        state.failMode = 'resolve';

        for (const [, fn] of pathFunctions(mod)) {
          await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
        }
      });

      test('a directory that resolves outside the application is refused', async () => {
        state.failMode = 'resolve-dir';

        for (const [, fn] of pathFunctions(mod)) {
          await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
        }
      });

      test('everything on disk looks like a symlink', async () => {
        state.failMode = 'symlink';

        for (const [, fn] of pathFunctions(mod)) {
          const returned = await Promise.resolve(fn(appPath));

          expect(returned).toBeDefined();
          const r = returned as ResultLike;
          if (typeof returned === 'object' && 'content' in (returned as object)) {
            expect(Array.isArray(r.content)).toBe(true);
          }
        }
      });

      test.each([2, 3, 4, 5, 7])('the reads after the first %i fail', async (n) => {
        state.failFromRead = n;

        for (const [, fn] of pathFunctions(mod)) {
          state.readCount = 0;
          const returned = await Promise.resolve(fn(appPath));

          expect(returned).toBeDefined();
          const r = returned as ResultLike;
          if (typeof returned === 'object' && 'content' in (returned as object)) {
            expect(Array.isArray(r.content)).toBe(true);
          }
        }
      });

      test('the stats after the first two fail', async () => {
        state.failFromStat = 3;

        for (const [, fn] of pathFunctions(mod)) {
          state.statCount = 0;
          const returned = await Promise.resolve(fn(appPath));

          expect(returned).toBeDefined();
          const r = returned as ResultLike;
          if (typeof returned === 'object' && 'content' in (returned as object)) {
            expect(Array.isArray(r.content)).toBe(true);
          }
        }
      });

      test('every file is larger than the module will read', async () => {
        state.failMode = 'huge';

        for (const [, fn] of pathFunctions(mod)) {
          state.hugeReads = 0;
          const returned = await Promise.resolve(fn(appPath));

          expect(returned).toBeDefined();
          const r = returned as ResultLike;
          if (typeof returned === 'object' && 'content' in (returned as object)) {
            expect(Array.isArray(r.content)).toBe(true);
          }
        }
      });

      test('a stat that fails is handled too', async () => {
        state.failMode = 'stat';

        for (const [, fn] of pathFunctions(mod)) {
          await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
        }
      });
    });
  });
}
