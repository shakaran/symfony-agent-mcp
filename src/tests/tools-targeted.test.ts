// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * An application built for one module at a time.
 *
 * The sweep and the vocabulary matrix between them reach most of what the
 * analysers do. What is left is particular: a property with a hook and no
 * default value, a Behat step nobody calls, a service whose parent is
 * declared in another file, a migration with a description. Each of these
 * is one application written for one module, from what that module's own
 * source says it parses.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-targeted-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build an application from a map of relative path to content. */
function appWith(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: { 'symfony/framework-bundle': '^7.0' },
    }));
  }

  return dir;
}

/** Call every export of a module that takes an application path. */
async function runModule(name: string, appPath: string, extras: string[] = []): Promise<string> {
  const mod = await import(path.resolve(__dirname, '../tools', name.replace(/\.js$/, ''))) as Record<string, unknown>;
  const texts: string[] = [];

  for (const [, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const argsets = fn.length === 1 ? [[appPath]] : extras.map((e) => [appPath, e, e]);
    for (const args of argsets) {
      const returned = await Promise.resolve(fn(...args.slice(0, fn.length)));
      expect(returned).toBeDefined();
      if (returned && typeof returned === 'object' && 'content' in returned) {
        const content = (returned as { content: Array<{ text?: string }> }).content;
        expect(Array.isArray(content)).toBe(true);
        texts.push(content.map((c) => c.text ?? '').join('\n'));
      }
    }
  }

  return texts.join('\n');
}

describe('an application written for one module', () => {
  test('property hooks, in every shape the parser allows', async () => {
    const app = appWith('property-hooks', {
      'src/Domain/Temperature.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Temperature',
        '{',
        '    private float $raw = 0.0;',
        '',
        '    public float $celsius {',
        '        get => $this->raw;',
        '        set (float $value) {',
        '            if ($value < -273.15) { throw new \\InvalidArgumentException("below absolute zero"); }',
        '            $this->raw = $value;',
        '        }',
        '    }',
        '',
        '    public float $fahrenheit {',
        '        get {',
        '            $converted = $this->raw * 9 / 5 + 32;',
        '            $this->log("read");',
        '            $this->audit();',
        '            $this->touch();',
        '            $this->refresh();',
        '            $this->recalculate();',
        '            $this->persist();',
        '            return $converted;',
        '        }',
        '    }',
        '',
        '    public string $label {',
        '        get => sprintf("%.1f", $this->raw);',
        '        set => $this->raw = (float) $value;',
        '    }',
        '',
        '    private array $items {',
        '        get => $this->loadAll();',
        '    }',
        '',
        '    public static string $shared {',
        '        get => "shared";',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Domain/AbstractShape.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'abstract class AbstractShape',
        '{',
        '    abstract public float $area {',
        '        get;',
        '    }',
        '',
        '    public readonly string $name {',
        '        get => static::class;',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-property-hooks.js', app);
    expect(text).toContain('celsius');
  });

  test('Behat steps: defined, undefined, unused and too broad', async () => {
    const app = appWith('behat-steps', {
      'behat.yaml': 'default:\n    suites:\n        default:\n            paths: ["%paths.base%/features"]\n            contexts: [App\\Tests\\Behat\\FeatureContext]\n',
      'features/checkout.feature': [
        '@checkout',
        'Feature: Checkout',
        '',
        '    Background:',
        '        Given I am logged in as "buyer@example.com"',
        '',
        '    Scenario: Cart totals',
        '        Given I have 2 items in the cart',
        '        When I open the cart',
        '        Then I should see "2 items"',
        '        And a step that nothing defines at all',
        '',
        '    Scenario Outline: Prices',
        '        Given a product costing <price>',
        '        Then the total is <total>',
        '',
        '        Examples:',
        '            | price | total |',
        '            | 10    | 10    |',
      ].join('\n') + '\n',
      'features/bootstrap/FeatureContext.php': [
        '<?php',
        'namespace App\\Tests\\Behat;',
        '',
        'use Behat\\Behat\\Context\\Context;',
        '',
        'class FeatureContext implements Context',
        '{',
        '    /** @Given I am logged in as :email */',
        '    public function login(string $email): void { }',
        '',
        '    /** @Given I have :count items in the cart */',
        '    public function haveItems(int $count): void { }',
        '',
        '    /** @When I open the cart */',
        '    public function openCart(): void { }',
        '',
        '    /** @Then I should see :text */',
        '    public function shouldSee(string $text): void { }',
        '',
        '    /** @Given a product costing :price */',
        '    public function productCosting(int $price): void { }',
        '',
        '    /** @Then the total is :total */',
        '    public function totalIs(int $total): void { }',
        '',
        '    /** @Then /^.*$/ */',
        '    public function anythingAtAll(): void { }',
        '',
        '    /** @When nobody ever calls this one */',
        '    public function unused(): void { }',
        '}',
      ].join('\n') + '\n',
      'src/Behat/ExtraContext.php': [
        '<?php',
        'namespace App\\Behat;',
        '',
        'use Behat\\Step\\Given;',
        'use Behat\\Step\\Then;',
        '',
        'class ExtraContext',
        '{',
        '    #[Given("a product in stock")]',
        '    public function inStock(): void { }',
        '',
        '    #[Then("the order is placed")]',
        '    public function placed(): void { }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('behat-step-coverage.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('services with a parent declared elsewhere, and an abstract with no children', async () => {
    const app = appWith('abstract-services', {
      'config/services.yaml': [
        'services:',
        '    _defaults:',
        '        autowire: true',
        '',
        '    App\\Handler\\AbstractHandler:',
        '        abstract: true',
        '        calls:',
        '            - [setLogger, ["@logger"]]',
        '            - [setDispatcher, ["@event_dispatcher"]]',
        '        properties:',
        '            retries: 3',
        '',
        '    App\\Handler\\ConcreteHandler:',
        '        parent: App\\Handler\\AbstractHandler',
        '        calls:',
        '            - [setName, ["concrete"]]',
        '',
        '    App\\Handler\\BareHandler:',
        '        parent: App\\Handler\\AbstractHandler',
        '',
        '    App\\Handler\\OrphanHandler:',
        '        parent: App\\Handler\\DeclaredSomewhereElse',
        '',
        '    App\\Handler\\UnusedAbstract:',
        '        abstract: true',
      ].join('\n') + '\n',
      'config/services_test.yaml': [
        'services:',
        '    App\\Handler\\TestHandler:',
        '        parent: App\\Handler\\AbstractHandler',
        '        properties:',
        '            mock: true',
      ].join('\n') + '\n',
    });

    const text = await runModule('abstract-parent-services.js', app);
    expect(text).toContain('AbstractHandler');
  });

  test('migrations with descriptions, statements and a bare version', async () => {
    const migration = (version: string, description: string | null, statements: number): string => [
      '<?php',
      '',
      'declare(strict_types=1);',
      '',
      'namespace DoctrineMigrations;',
      '',
      'use Doctrine\\DBAL\\Schema\\Schema;',
      'use Doctrine\\Migrations\\AbstractMigration;',
      '',
      `final class Version${version} extends AbstractMigration`,
      '{',
      ...(description === null ? [] : [
        '    public function getDescription(): string',
        '    {',
        `        return '${description}';`,
        '    }',
        '',
      ]),
      '    public function up(Schema $schema): void',
      '    {',
      ...Array.from({ length: statements }, (_, i) => `        $this->addSql('ALTER TABLE t${i} ADD COLUMN c${i} INT NOT NULL');`),
      '    }',
      '',
      '    public function down(Schema $schema): void',
      '    {',
      '        $this->addSql(\'DROP TABLE t0\');',
      '    }',
      '}',
    ].join('\n') + '\n';

    const app = appWith('migrations', {
      'migrations/Version20260101120000.php': migration('20260101120000', 'Create the order tables', 3),
      'migrations/Version20260201120000.php': migration('20260201120000', null, 12),
      'src/Migrations/Version20250901090000.php': migration('20250901090000', 'Earlier, in the other directory', 1),
      'DoctrineMigrations/Version20250101000000.php': migration('20250101000000', 'Older still', 2),
      'migrations/NotAMigration.php': '<?php\n\nclass NotAMigration {}\n',
      'config/packages/doctrine.yaml': 'doctrine:\n    dbal:\n        url: "%env(DATABASE_URL)%"\n    orm:\n        auto_mapping: true\n',
      'config/packages/doctrine_migrations.yaml': [
        'doctrine_migrations:',
        '    migrations_paths:',
        '        DoctrineMigrations: "%kernel.project_dir%/migrations"',
        '    enable_profiler: false',
      ].join('\n') + '\n',
    });

    const text = await runModule('database.js', app, ['20260101120000', 'order']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a worker file including whatever the request asks for', async () => {
    const app = appWith('file-inclusion', {
      'src/Legacy/Loader.php': [
        '<?php',
        'namespace App\\Legacy;',
        '',
        'class Loader',
        '{',
        '    public function load(string $name): void',
        '    {',
        '        include $_GET["page"] . ".php";',
        '        include_once $_REQUEST["template"];',
        '        require $_POST["module"];',
        '        require_once __DIR__ . "/" . $name . ".php";',
        '        include "http://example.com/remote.php";',
        '        include $this->basePath . "/" . $name;',
        '        require_once __DIR__ . "/fixed.php";',
        '    }',
        '',
        '    public function safe(): void',
        '    {',
        '        require_once __DIR__ . "/../../vendor/autoload.php";',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-file-inclusion-security.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('login throttling, with and without a limiter behind it', async () => {
    const app = appWith('login-throttle', {
      'config/packages/security.yaml': [
        'security:',
        '    firewalls:',
        '        main:',
        '            login_throttling:',
        '                max_attempts: 3',
        '                interval: "15 minutes"',
        '        api:',
        '            login_throttling:',
        '                max_attempts: 500',
        '                limiter: app.login_limiter',
        '        loose:',
        '            login_throttling: ~',
        '        none:',
        '            lazy: true',
      ].join('\n') + '\n',
      'config/packages/rate_limiter.yaml': [
        'framework:',
        '    rate_limiter:',
        '        app.login_limiter:',
        '            policy: sliding_window',
        '            limit: 5',
        '            interval: "15 minutes"',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-login-throttle.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a worker configuration for Cloudflare and one for Vercel', async () => {
    const cloudflare = appWith('cloudflare', {
      'wrangler.toml': [
        'name = "acme-edge"',
        'main = "worker/index.js"',
        'account_id = "0123456789abcdef0123456789abcdef"',
        'workers_dev = true',
        '',
        '[vars]',
        'API_BASE = "https://api.example.com"',
        'STRIPE_SECRET = "sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0"',
        '',
        '[[kv_namespaces]]',
        'binding = "CACHE"',
        'id = "0123456789abcdef0123456789abcdef"',
        '',
        '[[r2_buckets]]',
        'binding = "MEDIA"',
        'bucket_name = "acme-media"',
        '',
        '[[routes]]',
        'pattern = "acme.example.com/*"',
        'zone_name = "example.com"',
        '',
        '[env.production]',
        'name = "acme-edge-prod"',
        '',
        '[build]',
        'command = "npm run build"',
      ].join('\n') + '\n',
      'worker/index.js': 'export default { async fetch(request, env) { return new Response("ok"); } };\n',
    });

    const vercel = appWith('vercel', {
      'vercel.json': JSON.stringify({
        version: 2,
        buildCommand: 'composer install --no-dev',
        outputDirectory: 'public',
        regions: ['fra1', 'iad1'],
        functions: {
          'api/index.php': { runtime: 'vercel-php@0.6.0', memory: 3008, maxDuration: 60 },
        },
        routes: [{ src: '/(.*)', dest: '/api/index.php' }],
        rewrites: [{ source: '/old', destination: '/new' }],
        redirects: [{ source: '/legacy', destination: '/', permanent: false }],
        env: {
          APP_ENV: 'prod',
          DATABASE_URL: 'postgresql://acme:hunter2@db.example.com:5432/acme',
          APP_SECRET: '0123456789abcdef0123456789abcdef',
        },
        crons: [{ path: '/api/cron', schedule: '* * * * *' }],
      }, null, 2) + '\n',
      'api/index.php': '<?php\n\nrequire dirname(__DIR__)."/vendor/autoload.php";\n',
    });

    const first = await runModule('cloudflare-config.js', cloudflare);
    const second = await runModule('vercel-deploy-config.js', vercel);

    expect(first.length + second.length).toBeGreaterThan(0);
  });

  test('a built cache directory with pools of different sizes', async () => {
    const files: Record<string, string> = {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        app: cache.adapter.filesystem',
        '        system: cache.adapter.system',
        '        pools:',
        '            app.cache.short:',
        '                adapter: cache.adapter.array',
        '                default_lifetime: 60',
        '            app.cache.long:',
        '                adapter: cache.adapter.filesystem',
        '                default_lifetime: 86400',
      ].join('\n') + '\n',
    };
    for (const env of ['dev', 'prod', 'test']) {
      for (const pool of ['app', 'system', 'doctrine', 'validator', 'serializer']) {
        for (let i = 0; i < 4; i++) {
          files[`var/cache/${env}/pools/${pool}/entry-${i}.php`] = `<?php\n\nreturn ["${'x'.repeat(200 * (i + 1))}", 1756000000];\n`;
        }
      }
      files[`var/cache/${env}/twig/aa/bbcc.php`] = '<?php\n\nclass __TwigTemplate_aa {}\n';
      files[`var/cache/${env}/App_KernelContainer.php`] = '<?php\n\nclass App_KernelContainer {}\n';
    }
    // One pool large enough to be reported in megabytes rather than kilobytes.
    files['var/cache/prod/pools/app/large.php'] = `<?php\n\nreturn "${'x'.repeat(1_400_000)}";\n`;

    const text = await runModule('cache-inspector.js', appWith('cache', files), ['prod', 'app']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a routing table pointing at transports that exist and one that does not', async () => {
    const app = appWith('messenger-routing', {
      'config/packages/messenger.yaml': [
        'framework:',
        '    messenger:',
        '        failure_transport: failed',
        '        transports:',
        '            async:',
        '                dsn: "%env(MESSENGER_TRANSPORT_DSN)%"',
        '            async_priority_high:',
        '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/high"',
        '            failed:',
        '                dsn: "doctrine://default?queue_name=failed"',
        '            sync:',
        '                dsn: "sync://"',
        '        routing:',
        '            "App\\Message\\SendInvoice": async',
        '            "App\\Message\\RebuildIndex": [async, async_priority_high]',
        '            "App\\Message\\AuditTrail":',
        '                - async',
        '                - sync',
        '            "App\\Message\\GoesNowhere": nowhere',
        '            "App\\Message\\*": async',
        "            '*': sync",
      ].join('\n') + '\n',
      'config/packages/prod/messenger.yaml': [
        'framework:',
        '    messenger:',
        '        routing:',
        '            "App\\Message\\SendInvoice": async_priority_high',
      ].join('\n') + '\n',
      'src/Message/SendInvoice.php': '<?php\n\nnamespace App\\Message;\n\nfinal class SendInvoice\n{\n}\n',
      'src/Message/RebuildIndex.php': '<?php\n\nnamespace App\\Message;\n\nfinal class RebuildIndex\n{\n}\n',
      'src/Message/NeverRouted.php': '<?php\n\nnamespace App\\Message;\n\nfinal class NeverRouted\n{\n}\n',
      'src/Service/Dispatcher.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Message\\NeverRouted;',
        'use App\\Message\\SendInvoice;',
        'use Symfony\\Component\\Messenger\\MessageBusInterface;',
        '',
        'class Dispatcher',
        '{',
        '    public function __construct(private MessageBusInterface $bus) {}',
        '',
        '    public function run(): void',
        '    {',
        '        $this->bus->dispatch(new SendInvoice());',
        '        $this->bus->dispatch(new NeverRouted());',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-messenger-routing-table.js', app);
    expect(text).toContain('async');
  });

  test('lazy services, with the classes they name', async () => {
    const app = appWith('lazy-ghost', {
      'config/services.yaml': [
        'services:',
        '    _defaults:',
        '        autowire: true',
        '',
        '    App\\Service\\HeavyReportBuilder:',
        '        lazy: true',
        '',
        '    App\\Service\\FinalCandidate:',
        '        lazy: true',
        '',
        '    App\\Service\\InterfaceProxy:',
        '        lazy: "App\\\\Service\\\\ReportBuilderInterface"',
        '',
        '    App\\Service\\EagerButHeavy:',
        '        arguments: ["@doctrine.orm.entity_manager"]',
        '',
        '    App\\Service\\MissingClass:',
        '        lazy: true',
      ].join('\n') + '\n',
      'src/Service/ReportBuilderInterface.php': '<?php\n\nnamespace App\\Service;\n\ninterface ReportBuilderInterface\n{\n    public function build(): string;\n}\n',
      'src/Service/HeavyReportBuilder.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class HeavyReportBuilder implements ReportBuilderInterface',
        '{',
        '    public function __construct(',
        '        private object $entityManager,',
        '        private object $cache,',
        '        private object $logger,',
        '        private object $httpClient,',
        '        private string $reportDir,',
        '        private int $retention = 90,',
        '    ) {}',
        '',
        '    public function build(): string { return $this->reportDir; }',
        '}',
      ].join('\n') + '\n',
      'src/Service/FinalCandidate.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'final class FinalCandidate',
        '{',
        '    public function __construct(private string $name) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/InterfaceProxy.php': '<?php\n\nnamespace App\\Service;\n\nclass InterfaceProxy implements ReportBuilderInterface\n{\n    public function build(): string { return ""; }\n}\n',
      'src/Service/EagerButHeavy.php': '<?php\n\nnamespace App\\Service;\n\nclass EagerButHeavy\n{\n    public function __construct(private object $em) {}\n}\n',
    });

    const text = await runModule('symfony-di-lazy-ghost.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('API Platform resources, in configuration and in attributes', async () => {
    const resource = (name: string, extra: string): string => [
      '<?php',
      'namespace App\\Entity;',
      '',
      'use ApiPlatform\\Metadata\\ApiFilter;',
      'use ApiPlatform\\Metadata\\ApiResource;',
      'use ApiPlatform\\Metadata\\Delete;',
      'use ApiPlatform\\Metadata\\Get;',
      'use ApiPlatform\\Metadata\\GetCollection;',
      'use ApiPlatform\\Metadata\\Post;',
      'use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;',
      'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
      '',
      extra,
      `class ${name}`,
      '{',
      `    #[Groups(['${name.toLowerCase()}:read'])]`,
      '    public int $id = 0;',
      '',
      `    #[Groups(['${name.toLowerCase()}:read', '${name.toLowerCase()}:write'])]`,
      '    public string $name = "";',
      '}',
    ].join('\n') + '\n';

    const app = appWith('api-platform', {
      'config/packages/api_platform.yaml': [
        'api_platform:',
        '    title: Acme API',
        '    version: 2.1.0',
        '    description: Everything the shop exposes',
        '    formats:',
        '        jsonld: ["application/ld+json"]',
        '        json: ["application/json"]',
        '        csv: ["text/csv"]',
        '    docs_formats:',
        '        jsonopenapi: ["application/vnd.openapi+json"]',
        '    defaults:',
        '        pagination_items_per_page: 25',
        '        pagination_client_items_per_page: true',
        '        stateless: true',
        '        cache_headers:',
        '            max_age: 60',
        '            shared_max_age: 3600',
        '    collection:',
        '        pagination:',
        '            items_per_page: 30',
        '            maximum_items_per_page: 100',
        '    graphql:',
        '        enabled: true',
        '        nesting_separator: __',
        '    swagger:',
        '        versions: [3]',
      ].join('\n') + '\n',
      'src/Entity/Product.php': resource('Product', [
        '#[ApiResource(',
        "    types: ['https://schema.org/Product'],",
        '    operations: [',
        "        new GetCollection(uriTemplate: '/products', normalizationContext: ['groups' => ['product:read']], paginationItemsPerPage: 50),",
        "        new Get(uriTemplate: '/products/{id}', normalizationContext: ['groups' => ['product:read', 'product:detail']], security: \"is_granted('ROLE_USER')\"),",
        "        new Post(uriTemplate: '/products', denormalizationContext: ['groups' => ['product:write']], security: \"is_granted('ROLE_ADMIN')\", securityMessage: 'Only admins'),",
        "        new Delete(uriTemplate: '/products/{id}', security: \"is_granted('ROLE_ADMIN')\"),",
        '    ],',
        "    normalizationContext: ['groups' => ['product:read']],",
        "    denormalizationContext: ['groups' => ['product:write']],",
        '    paginationEnabled: true,',
        "    order: ['name' => 'ASC'],",
        '    mercure: true,',
        '    messenger: true,',
        ')]',
        "#[ApiFilter(SearchFilter::class, properties: ['name' => 'partial'])]",
      ].join('\n')),
      'src/Entity/OpenResource.php': resource('OpenResource', [
        '#[ApiResource(',
        '    paginationEnabled: false,',
        '    security: null,',
        ')]',
      ].join('\n')),
      'src/ApiResource/LegacyResource.php': [
        '<?php',
        'namespace App\\ApiResource;',
        '',
        'use ApiPlatform\\Core\\Annotation\\ApiResource;',
        '',
        '/**',
        ' * @ApiResource(',
        ' *     collectionOperations={"get"={"method"="GET"}},',
        ' *     itemOperations={"get"={"method"="GET"}, "delete"={"security"="is_granted(\'ROLE_ADMIN\')"}},',
        ' *     normalizationContext={"groups"={"legacy:read"}}',
        ' * )',
        ' */',
        'class LegacyResource',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('api-platform.js', app, ['Product', 'product:read']);
    expect(text).toContain('Product');
  });

  test('profiles with no index, which is how a profiler directory usually looks', async () => {
    const zlib = await import('zlib');
    const files: Record<string, string> = {};
    const app = appWith('profiler-no-index', files);

    const write = (rel: string, content: Buffer): void => {
      const full = path.join(app, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };

    for (const [i, token] of ['aa11bb', 'cc22dd', 'ee33ff', 'aa44bb'].entries()) {
      const profile = {
        time: { duration: 100 + i, init_time: 5 },
        memory: { memory: 12_000_000 + i, memory_limit: 134_217_728 },
        db: { query_count: i * 7, time: 0.01 * i, queries: Array.from({ length: i * 3 }, (_, q) => ({ sql: `SELECT ${q} FROM t`, executionMS: 0.5 })) },
        logger: { error_count: i, warning_count: 1, logs: [{ message: 'a log line', priority: '400', channel: 'app' }] },
        exception: i === 1 ? { has_exception: true, class: 'DomainException', message: 'nope' } : { has_exception: false },
        request: { method: i % 2 === 0 ? 'GET' : 'POST', status_code: 200 + i, route: 'app_home' },
      };
      write(path.join('var/cache/dev/profiler', token.slice(-2), token.slice(-4, -2), token), zlib.gzipSync(Buffer.from(JSON.stringify(profile))));
    }
    // An entry that is not a profile at all, and a directory that is not two deep.
    write('var/cache/dev/profiler/README', Buffer.from('not a profile\n'));
    write('var/cache/dev/profiler/zz/short', Buffer.from('too short\n'));

    const text = await runModule('profiler.js', app, ['aa11bb', 'cc22dd']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a Netlify file with the sections the first one did not have', async () => {
    const app = appWith('netlify-more', {
      'netlify.toml': [
        '[build]',
        'base = "."',
        'command = "make build"',
        'publish = "public"',
        'ignore = "git diff --quiet HEAD^ HEAD ."',
        '',
        '[build.processing]',
        'skip_processing = false',
        '',
        '[build.processing.css]',
        'bundle = true',
        'minify = true',
        '',
        '[[plugins]]',
        'package = "@netlify/plugin-lighthouse"',
        '',
        '[[edge_functions]]',
        'function = "geolocate"',
        'path = "/api/*"',
        '',
        '[context.deploy-preview]',
        'command = "make preview"',
        '',
        '[context.deploy-preview.environment]',
        'APP_ENV = "dev"',
        'DEBUG_TOKEN = "0123456789abcdef0123456789abcdef"',
        '',
        '[[redirects]]',
        'from = "/docs/*"',
        'to = "https://docs.example.com/:splat"',
        'status = 301',
        'force = false',
        '',
        '[[headers]]',
        'for = "/assets/*"',
        '',
        '  [headers.values]',
        '  Cache-Control = "public, max-age=31536000, immutable"',
        '',
        '[functions."api/heavy"]',
        'memory = 3008',
        'timeout = 26',
      ].join('\n') + '\n',
    });

    const text = await runModule('netlify-deploy-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
