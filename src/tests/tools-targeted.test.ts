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

  test('a CircleCI pipeline with caching, parallelism and a secret in the file', async () => {
    const app = appWith('circleci', {
      '.circleci/config.yml': [
        'version: 2.1',
        '',
        'orbs:',
        '  php: circleci/php@1.1.0',
        '',
        'executors:',
        '  php:',
        '      docker:',
        '      - image: cimg/php:8.3',
        '      - image: cimg/postgres:16.2',
        '        environment:',
        '      POSTGRES_PASSWORD: hunter2',
        '',
        'jobs:',
        '  test:',
        '      executor: php',
        '      parallelism: 4',
        '      environment:',
        '      APP_ENV: test',
        '      STRIPE_SECRET: sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0',
        '      steps:',
        '      - checkout',
        '      - restore_cache:',
        '      keys:',
        '          - composer-v1-{{ checksum "composer.lock" }}',
        '      - run:',
        '      name: Install',
        '      command: composer install --no-interaction',
        '      - save_cache:',
        '      key: composer-v1-{{ checksum "composer.lock" }}',
        '      paths:',
        '          - vendor',
        '      - run:',
        '      name: Tests',
        '      command: vendor/bin/phpunit --coverage-clover var/clover.xml',
        '      - store_test_results:',
        '      path: var/test-results',
        '  deploy:',
        '      executor: php',
        '      steps:',
        '      - run: ./deploy.sh',
        '',
        'workflows:',
        '  build-and-deploy:',
        '      jobs:',
        '      - test',
        '      - deploy:',
        '      requires: [test]',
        '      filters:',
        '          branches:',
        '              only: main',
      ].join('\n') + '\n',
    });

    const text = await runModule('circleci-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a DBAL configuration with pooling, SSL and several connections', async () => {
    const app = appWith('dbal', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    dbal:',
        '        default_connection: default',
        '        connections:',
        '            default:',
        '                url: "%env(resolve:DATABASE_URL)%"',
        '                driver: pdo_pgsql',
        '                server_version: "16"',
        '                charset: utf8',
        '                use_savepoints: true',
        '                logging: true',
        '                profiling: true',
        '                options:',
        '                    1002: "SET NAMES utf8"',
        '                mapping_types:',
        '                    enum: string',
        '            reporting:',
        '                url: "mysql://reporting:hunter2@replica:3306/acme"',
        '                driver: pdo_mysql',
        '                server_version: "5.7"',
        '                charset: latin1',
        '                slaves:',
        '                    replica_one:',
        '                        host: replica-1',
        '            legacy:',
        '                driver: pdo_sqlite',
        '                path: "%kernel.project_dir%/var/legacy.db"',
        '    orm:',
        '        default_entity_manager: default',
        '        entity_managers:',
        '            default:',
        '                connection: default',
        '                auto_mapping: true',
        '            reporting:',
        '                connection: reporting',
        '                mappings:',
        '                    Reporting:',
        '                        type: attribute',
        '                        dir: "%kernel.project_dir%/src/Reporting"',
        '                        prefix: App\\Reporting',
      ].join('\n') + '\n',
    });

    const text = await runModule('dbal-config.js', app, ['default', 'reporting']);
    const second = await runModule('doctrine-multi-connection.js', app, ['default']);
    const third = await runModule('doctrine-orm-config.js', app);
    expect((text + second + third).length).toBeGreaterThan(0);
  });

  test('user impersonation, configured and used', async () => {
    const app = appWith('impersonation', {
      'config/packages/security.yaml': [
        'security:',
        '    role_hierarchy:',
        '        ROLE_ADMIN: [ROLE_USER, ROLE_ALLOWED_TO_SWITCH]',
        '    firewalls:',
        '        main:',
        '            lazy: true',
        '            switch_user: true',
        '        support:',
        '            pattern: ^/support',
        '            switch_user:',
        '                role: ROLE_SUPPORT',
        '                parameter: _impersonate',
        '        api:',
        '            stateless: true',
        '    access_control:',
        '        - { path: ^/admin, roles: ROLE_ADMIN }',
      ].join('\n') + '\n',
      'src/EventListener/ImpersonationListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use Symfony\\Component\\Security\\Http\\Event\\SwitchUserEvent;',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'use Symfony\\Component\\HttpKernel\\KernelEvents;',
        '',
        'class ImpersonationListener implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return [SwitchUserEvent::class => "onSwitchUser"];',
        '    }',
        '',
        '    public function onSwitchUser(SwitchUserEvent $event): void',
        '    {',
        '        $this->auditLogger->info("impersonation", ["target" => $event->getTargetUser()->getUserIdentifier()]);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'templates/admin/users.html.twig': [
        '{% if is_granted("ROLE_ALLOWED_TO_SWITCH") %}',
        '    <a href="{{ path("app_home", {_switch_user: user.email}) }}">Impersonate</a>',
        '    <a href="{{ path("app_home", {_switch_user: "_exit"}) }}">Stop</a>',
        '{% endif %}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-impersonation.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a lock file that disagrees with the manifest', async () => {
    const app = appWith('composer-drift', {
      'composer.json': JSON.stringify({
        name: 'acme/app',
        type: 'project',
        license: 'proprietary',
        minimumStability: 'stable',
        require: {
          php: '>=8.2',
          'symfony/framework-bundle': '^7.0',
          'doctrine/orm': '^3.0',
          'symfony/messenger': '7.0.*',
          'nelmio/cors-bundle': 'dev-main',
          'acme/private': '@dev',
        },
        'require-dev': {
          'phpunit/phpunit': '^11.0',
          'phpstan/phpstan': '*',
        },
        scripts: {
          'auto-scripts': { 'cache:clear': 'symfony-cmd' },
          test: 'phpunit',
        },
        config: { 'allow-plugins': { 'symfony/flex': true }, 'sort-packages': true },
        extra: { symfony: { 'allow-contrib': false, require: '7.0.*' } },
      }, null, 2) + '\n',
      'composer.lock': JSON.stringify({
        'content-hash': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        packages: [
          { name: 'symfony/framework-bundle', version: 'v7.0.3', time: '2024-01-30T08:00:00+00:00', license: ['MIT'] },
          { name: 'doctrine/orm', version: '3.0.0', time: '2024-01-15T08:00:00+00:00', license: ['MIT'] },
          { name: 'symfony/messenger', version: 'v7.0.0', time: '2023-11-29T08:00:00+00:00', license: ['MIT'] },
        ],
        'packages-dev': [
          { name: 'phpunit/phpunit', version: '11.0.1', time: '2024-02-04T08:00:00+00:00', license: ['BSD-3-Clause'] },
        ],
        'minimum-stability': 'stable',
        'prefer-stable': true,
      }, null, 2) + '\n',
    });

    const text = await runModule('composer.js', app, ['doctrine/orm', 'symfony']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('rate limiter storage, on a pool and on the filesystem', async () => {
    const app = appWith('limiter-storage', {
      'config/packages/framework.yaml': [
        'framework:',
        '    rate_limiter:',
        '        anonymous_api:',
        '            policy: sliding_window',
        '            limit: 100',
        '            interval: "60 minutes"',
        '            cache_pool: cache.rate_limiter',
        '        uploads:',
        '            policy: token_bucket',
        '            limit: 10',
        '            rate: { interval: "15 minutes", amount: 5 }',
        '            lock_factory: lock.factory',
        '        reports:',
        '            policy: fixed_window',
        '            limit: 5',
        '            interval: "1 hour"',
        '            storage_service: app.limiter_storage',
      ].join('\n') + '\n',
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        pools:',
        '            cache.rate_limiter:',
        '                adapter: cache.adapter.array',
        '            cache.other:',
        '                adapter: cache.adapter.redis',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    app.limiter_storage:',
        '        class: Symfony\\Component\\RateLimiter\\Storage\\CacheStorage',
        '        arguments: ["@cache.rate_limiter"]',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-rate-limiter-storage.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('scheduled tasks, as configuration and as a schedule provider', async () => {
    const app = appWith('scheduler-tasks', {
      'config/packages/scheduler.yaml': [
        'framework:',
        '    scheduler:',
        '        schedules:',
        '            default:',
        '                transport: scheduler_default',
        '                lock: true',
        '                state: cache.scheduler',
      ].join('\n') + '\n',
      'src/Scheduler/MainSchedule.php': [
        '<?php',
        'namespace App\\Scheduler;',
        '',
        'use App\\Message\\RebuildIndex;',
        'use App\\Message\\SendDigest;',
        'use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;',
        'use Symfony\\Component\\Scheduler\\RecurringMessage;',
        'use Symfony\\Component\\Scheduler\\Schedule;',
        'use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;',
        '',
        '#[AsSchedule("default")]',
        'final class MainSchedule implements ScheduleProviderInterface',
        '{',
        '    public function getSchedule(): Schedule',
        '    {',
        '        return (new Schedule())',
        '            ->add(RecurringMessage::every("5 minutes", new RebuildIndex()))',
        '            ->add(RecurringMessage::cron("0 3 * * *", new SendDigest()))',
        '            ->add(RecurringMessage::every("1 second", new RebuildIndex()))',
        '            ->stateful($this->cache)',
        '            ->lock($this->lockFactory->createLock("scheduler"));',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Message/RebuildIndex.php': '<?php\n\nnamespace App\\Message;\n\nfinal class RebuildIndex\n{\n}\n',
      'src/Message/SendDigest.php': '<?php\n\nnamespace App\\Message;\n\nfinal class SendDigest\n{\n}\n',
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a kernel with the micro trait and the bundles beside it', async () => {
    const app = appWith('kernel', {
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        '    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ["all" => true],',
        '    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ["all" => true],',
        '    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ["dev" => true, "test" => true],',
        '    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ["dev" => true],',
        '    Nelmio\\CorsBundle\\NelmioCorsBundle::class => ["all" => true],',
        '];',
      ].join('\n') + '\n',
      'src/Kernel.php': [
        '<?php',
        'namespace App;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        'use Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator;',
        'use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;',
        'use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;',
        '',
        'class Kernel extends BaseKernel',
        '{',
        '    use MicroKernelTrait;',
        '',
        '    public function getCacheDir(): string',
        '    {',
        '        return "/dev/shm/acme/cache/" . $this->environment;',
        '    }',
        '',
        '    public function getLogDir(): string',
        '    {',
        '        return "/dev/shm/acme/log";',
        '    }',
        '',
        '    public function getProjectDir(): string',
        '    {',
        '        return dirname(__DIR__);',
        '    }',
        '',
        '    protected function configureContainer(ContainerConfigurator $container): void',
        '    {',
        '        $container->import("../config/{packages}/*.yaml");',
        '        $container->import("../config/services.yaml");',
        '    }',
        '',
        '    protected function configureRoutes(RoutingConfigurator $routes): void',
        '    {',
        '        $routes->import("../config/{routes}/*.yaml");',
        '    }',
        '',
        '    protected function build(ContainerBuilder $container): void',
        '    {',
        '        $container->addCompilerPass(new \\App\\DependencyInjection\\Compiler\\TaggedHandlerPass());',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/DependencyInjection/Compiler/TaggedHandlerPass.php': [
        '<?php',
        'namespace App\\DependencyInjection\\Compiler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        '',
        'class TaggedHandlerPass implements CompilerPassInterface',
        '{',
        '    public function process(ContainerBuilder $container): void',
        '    {',
        '        foreach ($container->findTaggedServiceIds("app.handler") as $id => $tags) {',
        '            $container->getDefinition($id)->addMethodCall("setBus", []);',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('kernel-analysis.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a RoadRunner server, with workers, TLS and a supervisor', async () => {
    const app = appWith('roadrunner', {
      '.rr.yaml': [
        'version: "3"',
        '',
        'server:',
        '    command: "php public/index.php"',
        '    relay: pipes',
        '    env:',
        '        APP_RUNTIME: Runtime\\RoadRunnerSymfonyNyholm\\Runtime',
        '',
        'http:',
        '    address: 0.0.0.0:8080',
        '    middleware: ["static", "gzip", "headers"]',
        '    pool:',
        '        num_workers: 8',
        '        max_jobs: 0',
        '        supervisor:',
        '            max_worker_memory: 128',
        '            exec_ttl: 60s',
        '    ssl:',
        '        address: :8443',
        '        cert: /etc/ssl/acme.crt',
        '        key: /etc/ssl/acme.key',
        '    static:',
        '        dir: public',
        '        forbid: [".php", ".htaccess"]',
        '',
        'jobs:',
        '    pool:',
        '        num_workers: 4',
        '    pipelines:',
        '        default:',
        '            driver: memory',
        '',
        'metrics:',
        '    address: 127.0.0.1:2112',
        '',
        'logs:',
        '    mode: production',
        '    level: debug',
      ].join('\n') + '\n',
      'public/index.php': '<?php\n\nrequire dirname(__DIR__)."/vendor/autoload.php";\n',
    });

    const text = await runModule('symfony-roadrunner-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a framework.yaml holding what half the analysers read', async () => {
    const app = appWith('framework-wide', {
      'config/packages/framework.yaml': [
        'framework:',
        '    secret: "%env(APP_SECRET)%"',
        '    http_method_override: false',
        '    handle_all_throwables: true',
        '    error_controller: App\\Controller\\ErrorController::show',
        '    trusted_proxies: "127.0.0.1,REMOTE_ADDR"',
        '    trusted_headers: ["x-forwarded-for", "x-forwarded-proto"]',
        '    php_errors:',
        '        log: true',
        '    property_info:',
        '        enabled: true',
        '        with_constructor_extractor: true',
        '    property_access:',
        '        magic_call: true',
        '        throw_exception_on_invalid_index: false',
        '    serializer:',
        '        enabled: true',
        '        name_converter: serializer.name_converter.camel_case_to_snake_case',
        '    http_client:',
        '        default_options:',
        '            timeout: 30',
        '            max_duration: 0',
        '            max_redirects: 20',
        '            verify_peer: false',
        '            verify_host: false',
        '            headers:',
        '                User-Agent: acme/1.0',
        '        scoped_clients:',
        '            payments.client:',
        '                base_uri: "https://payments.example.com"',
        '                auth_bearer: "%env(PAYMENTS_TOKEN)%"',
        '                timeout: 5',
        '                retry_failed:',
        '                    max_retries: 3',
        '            legacy.client:',
        '                base_uri: "http://legacy.internal"',
        '                verify_peer: false',
        '    form:',
        '        legacy_error_messages: false',
        '    session:',
        '        handler_id: null',
        '        cookie_secure: auto',
        '        cookie_samesite: lax',
      ].join('\n') + '\n',
      'config/packages/twig.yaml': [
        'twig:',
        '    form_themes:',
        '        - "bootstrap_5_layout.html.twig"',
        '        - "form/fields.html.twig"',
        '    default_path: "%kernel.project_dir%/templates"',
      ].join('\n') + '\n',
      'templates/form/fields.html.twig': [
        '{% use "bootstrap_5_layout.html.twig" %}',
        '',
        '{% block form_row %}',
        '    <div class="mb-3">{{ form_label(form) }}{{ form_widget(form) }}</div>',
        '{% endblock %}',
        '',
        '{% block money_widget %}',
        '    <div class="input-group">{{ block("form_widget_simple") }}</div>',
        '{% endblock %}',
      ].join('\n') + '\n',
      'src/Controller/ErrorController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Component\\HttpFoundation\\Request;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        'use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;',
        'use Symfony\\Component\\Translation\\TranslatableMessage;',
        '',
        'class ErrorController',
        '{',
        '    public function show(Request $request, \\Throwable $exception): Response',
        '    {',
        '        $status = $exception instanceof HttpExceptionInterface ? $exception->getStatusCode() : 500;',
        '        $message = new TranslatableMessage("error.generic", ["%status%" => $status]);',
        '',
        '        return new Response($this->translator->trans($message) . $exception->getMessage(), $status);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/PropertyInfo/DocBlockExtractor.php': [
        '<?php',
        'namespace App\\PropertyInfo;',
        '',
        'use Symfony\\Component\\PropertyInfo\\PropertyTypeExtractorInterface;',
        'use Symfony\\Component\\PropertyInfo\\Type;',
        '',
        'class DocBlockExtractor implements PropertyTypeExtractorInterface',
        '{',
        '    public function getTypes(string $class, string $property, array $context = []): ?array',
        '    {',
        '        return [new Type(Type::BUILTIN_TYPE_STRING)];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Service/PaymentsClient.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
        '',
        'class PaymentsClient',
        '{',
        '    public function __construct(private HttpClientInterface $paymentsClient) {}',
        '',
        '    public function charge(): array',
        '    {',
        '        return $this->paymentsClient->request("POST", "/charges", ["timeout" => 2])->toArray();',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('symfony-error-controller.js', app),
      runModule('symfony-property-info.js', app),
      runModule('symfony-form-themes.js', app),
      runModule('http-client.js', app, ['payments.client']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('password hashers, from the strong one to the one nobody should use', async () => {
    const app = appWith('hashers', {
      'config/packages/security.yaml': [
        'security:',
        '    password_hashers:',
        '        Symfony\\Component\\Security\\Core\\User\\PasswordAuthenticatedUserInterface: "auto"',
        '        App\\Entity\\User:',
        '            algorithm: sodium',
        '            memory_cost: 65536',
        '            time_cost: 4',
        '        App\\Entity\\LegacyUser:',
        '            algorithm: bcrypt',
        '            cost: 4',
        '        App\\Entity\\AncientUser:',
        '            algorithm: md5',
        '            encode_as_base64: false',
        '            iterations: 1',
        '        App\\Entity\\MigratingUser:',
        '            algorithm: auto',
        '            migrate_from:',
        '                - bcrypt',
        '                - md5',
        '    providers:',
        '        app_user_provider:',
        '            entity:',
        '                class: App\\Entity\\User',
      ].join('\n') + '\n',
    });

    const text = await runModule('password-hashers.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a mailer DSN with failover, round robin and credentials in the file', async () => {
    const app = appWith('mailer-dsn', {
      'config/packages/mailer.yaml': [
        'framework:',
        '    mailer:',
        '        dsn: "failover(smtp://acme:hunter2@smtp1.example.com:25 sendmail://default)"',
        '        envelope:',
        '            sender: no-reply@example.com',
      ].join('\n') + '\n',
      '.env': [
        'APP_ENV=prod',
        'MAILER_DSN=roundrobin(ses+api://ACCESS:SECRET@default sendgrid+api://KEY@default)',
      ].join('\n') + '\n',
      '.env.local': 'MAILER_DSN=smtp://localhost:1025\n',
    });

    const text = await runModule('symfony-mailer-dsn-analysis.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('image handling without checks, and a parallel workflow used from PHP', async () => {
    const app = appWith('gd-and-workflow', {
      'src/Service/Thumbnails.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class Thumbnails',
        '{',
        '    public function make(string $upload): void',
        '    {',
        '        $image = imagecreatefromjpeg($upload);',
        '        $resized = imagecreatetruecolor(200, 200);',
        '        imagecopyresampled($resized, $image, 0, 0, 0, 0, 200, 200, imagesx($image), imagesy($image));',
        '        imagejpeg($resized, "/var/www/uploads/" . $_GET["name"] . ".jpg", 90);',
        '        imagedestroy($image);',
        '        imagedestroy($resized);',
        '',
        '        $png = imagecreatefrompng($_FILES["file"]["tmp_name"]);',
        '        imagealphablending($png, false);',
        '        imagesavealpha($png, true);',
        '        imagewebp($png, "/var/www/uploads/out.webp");',
        '    }',
        '',
        '    public function checked(string $upload): void',
        '    {',
        '        $info = getimagesize($upload);',
        '        if ($info === false || $info[0] > 4000 || $info[1] > 4000) { return; }',
        '        ini_set("memory_limit", "256M");',
        '        $image = imagecreatefromstring(file_get_contents($upload));',
        '        imagedestroy($image);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/workflow.yaml': [
        'framework:',
        '    workflows:',
        '        publication:',
        '            type: workflow',
        '            marking_store:',
        '                type: method',
        '                property: marking',
        '            supports: [App\\Entity\\Post]',
        '            initial_marking: [draft]',
        '            places: [draft, legal_review, copy_review, approved, published]',
        '            transitions:',
        '                submit:',
        '                    from: draft',
        '                    to: [legal_review, copy_review]',
        '                approve_legal:',
        '                    from: legal_review',
        '                    to: approved',
        '                approve_copy:',
        '                    from: copy_review',
        '                    to: approved',
        '                publish:',
        '                    from: [approved]',
        '                    to: published',
      ].join('\n') + '\n',
      'src/Service/Publication.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Workflow\\WorkflowInterface;',
        '',
        'class Publication',
        '{',
        '    public function __construct(private WorkflowInterface $publicationWorkflow) {}',
        '',
        '    public function advance(object $post): void',
        '    {',
        '        $marking = $this->publicationWorkflow->getMarking($post);',
        '        if ($marking->has("legal_review") && $marking->has("copy_review")) {',
        '            return;',
        '        }',
        '        foreach ($marking->getPlaces() as $place => $count) {',
        '            $this->log($place, $count);',
        '        }',
        '        if ($this->publicationWorkflow->can($post, "publish")) {',
        '            $this->publicationWorkflow->apply($post, "publish");',
        '        }',
        '    }',
        '',
        '    private function log(string $place, int $count): void { }',
        '}',
      ].join('\n') + '\n',
      'src/Service/BlindWorkflow.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Workflow\\WorkflowInterface;',
        '',
        'class BlindWorkflow',
        '{',
        '    public function __construct(private WorkflowInterface $publicationWorkflow) {}',
        '',
        '    public function go(object $post): void',
        '    {',
        '        if ($this->publicationWorkflow->can($post, "submit")) {',
        '            $this->publicationWorkflow->apply($post, "submit");',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('php-gd-security.js', app),
      runModule('symfony-workflow-parallel-transitions.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('an asset pipeline with an importmap, controllers and entrypoints', async () => {
    const app = appWith('asset-mapper', {
      'importmap.php': [
        '<?php',
        '',
        'return [',
        "    'app' => ['path' => './assets/app.js', 'entrypoint' => true],",
        "    'admin' => ['path' => './assets/admin.js', 'entrypoint' => true],",
        "    '@hotwired/stimulus' => ['version' => '3.2.2'],",
        "    '@hotwired/turbo' => ['version' => '8.0.4'],",
        "    'bootstrap' => ['version' => '5.3.3'],",
        "    'bootstrap/dist/css/bootstrap.min.css' => ['version' => '5.3.3', 'type' => 'css'],",
        "    'chart.js' => ['version' => '4.4.2', 'preload' => true],",
        "    'unpinned-package' => [],",
        '];',
      ].join('\n') + '\n',
      'assets/app.js': [
        "import './bootstrap.js';",
        "import 'bootstrap/dist/css/bootstrap.min.css';",
        "import { Application } from '@hotwired/stimulus';",
        '',
        'const app = Application.start();',
      ].join('\n') + '\n',
      'assets/admin.js': "import './styles/admin.css';\n",
      'assets/bootstrap.js': "import { startStimulusApp } from '@symfony/stimulus-bundle';\n\nconst app = startStimulusApp();\n",
      'assets/styles/admin.css': 'body { margin: 0; }\n',
      'assets/controllers.json': JSON.stringify({
        controllers: {
          '@symfony/ux-turbo': { turbo: { enabled: true, fetch: 'eager' } },
          '@symfony/ux-chartjs': { chart: { enabled: true, fetch: 'lazy', autoimport: { 'chart.js/auto': true } } },
        },
        entrypoints: [],
      }, null, 2) + '\n',
      'assets/controllers/hello_controller.js': [
        "import { Controller } from '@hotwired/stimulus';",
        '',
        'export default class extends Controller {',
        "    static targets = ['output'];",
        '    connect() { this.outputTarget.textContent = "hi"; }',
        '}',
      ].join('\n') + '\n',
      'config/packages/asset_mapper.yaml': [
        'framework:',
        '    asset_mapper:',
        '        paths:',
        '            assets/: ""',
        '        missing_import_mode: strict',
        '        public_prefix: /assets/',
      ].join('\n') + '\n',
      'public/assets/manifest.json': JSON.stringify({ 'app.js': '/assets/app-abc123.js' }, null, 2) + '\n',
    });

    const results = await Promise.all([
      runModule('asset-mapper.js', app, ['app']),
      runModule('importmap-config.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('resources pushed over Mercure, and the hub behind them', async () => {
    const app = appWith('mercure-push', {
      'config/packages/mercure.yaml': [
        'mercure:',
        '    hubs:',
        '        default:',
        '            url: "%env(MERCURE_URL)%"',
        '            public_url: "%env(MERCURE_PUBLIC_URL)%"',
        '            jwt:',
        '                secret: "%env(MERCURE_JWT_SECRET)%"',
        '                publish: ["*"]',
        '                subscribe: ["*"]',
      ].join('\n') + '\n',
      'config/packages/api_platform.yaml': [
        'api_platform:',
        '    title: Acme API',
        '    mercure:',
        '        hub_url: "%env(MERCURE_PUBLIC_URL)%"',
        '        include_type: true',
      ].join('\n') + '\n',
      '.env': 'MERCURE_URL=http://mercure/.well-known/mercure\nMERCURE_PUBLIC_URL=http://localhost/.well-known/mercure\n',
      'src/Entity/LiveOrder.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        '',
        '#[ApiResource(mercure: true)]',
        'class LiveOrder',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/PrivateOrder.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        '',
        "#[ApiResource(mercure: ['private' => true, 'topics' => ['https://example.com/orders']])]",
        'class PrivateOrder',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
      'src/Service/Publisher.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Mercure\\HubInterface;',
        'use Symfony\\Component\\Mercure\\Update;',
        '',
        'class Publisher',
        '{',
        '    public function __construct(private HubInterface $hub) {}',
        '',
        '    public function publish(string $payload): void',
        '    {',
        '        $this->hub->publish(new Update("https://example.com/orders", $payload, true));',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('api-platform-mercure-push.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a source tree the dependency graph can walk', async () => {
    const files: Record<string, string> = {
      'src/Controller/OrderController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use App\\Repository\\OrderRepository;',
        'use App\\Service\\OrderService;',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        '',
        'class OrderController extends AbstractController',
        '{',
        '    public function __construct(private OrderService $service, private OrderRepository $orders) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/OrderService.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Repository\\OrderRepository;',
        'use App\\Service\\PricingService;',
        'use Psr\\Log\\LoggerInterface;',
        '',
        'class OrderService',
        '{',
        '    public function __construct(',
        '        private OrderRepository $orders,',
        '        private PricingService $pricing,',
        '        private LoggerInterface $logger,',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/PricingService.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\OrderService;',
        '',
        'class PricingService',
        '{',
        '    // A cycle: the two services hold each other.',
        '    public function __construct(private OrderService $orders) {}',
        '}',
      ].join('\n') + '\n',
      'src/Repository/OrderRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class OrderRepository extends ServiceEntityRepository',
        '{',
        '}',
      ].join('\n') + '\n',
      'src/Command/ImportCommand.php': [
        '<?php',
        'namespace App\\Command;',
        '',
        'use App\\Service\\OrderService;',
        'use Symfony\\Component\\Console\\Command\\Command;',
        '',
        'class ImportCommand extends Command',
        '{',
        '    public function __construct(private OrderService $service) { parent::__construct(); }',
        '}',
      ].join('\n') + '\n',
      'src/Form/OrderType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use Symfony\\Component\\Form\\AbstractType;',
        '',
        'class OrderType extends AbstractType',
        '{',
        '}',
      ].join('\n') + '\n',
      'src/Service/Lonely.php': '<?php\n\nnamespace App\\Service;\n\nclass Lonely\n{\n}\n',
    };

    const text = await runModule('dependency-graph.js', appWith('dependency-graph', files), ['App\\Service\\OrderService', 'OrderService']);
    expect(text.length).toBeGreaterThan(0);
  });
});
