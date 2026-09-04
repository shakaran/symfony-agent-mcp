// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * More conditions: an application where every namespace is right, CORS
 * origins as a comma-separated string, a lock file with the packages
 * installed, tags with and without a consumer, two cycles in the graph,
 * and the profiler bundles left on in production.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-conditions2-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string>, require_: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: { 'symfony/framework-bundle': '^7.0', ...require_ },
      autoload: { 'psr-4': { 'App\\': 'src/' } },
    }, null, 2));
  }

  return dir;
}

async function runModule(name: string, appPath: string, extras: string[] = []): Promise<string> {
  const mod = await import(path.resolve(__dirname, '../tools', name.replace(/\.js$/, ''))) as Record<string, unknown>;
  const texts: string[] = [];

  for (const [, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const calls = fn.length === 1 ? [[appPath]] : (extras.length > 0 ? extras.map((e) => [appPath, e, e]) : [[appPath, '', '']]);
    for (const args of calls) {
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

describe('more conditions', () => {
  test('an application whose namespaces all match the autoload map', async () => {
    const app = appWith('namespaces-clean', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        autoload: { 'psr-4': { 'App\\': 'src/' } },
        'autoload-dev': { 'psr-4': { 'App\\Tests\\': 'tests/' } },
      }, null, 2) + '\n',
      'src/Controller/HomeController.php': '<?php\n\nnamespace App\\Controller;\n\nclass HomeController\n{\n}\n',
      'src/Service/Importer.php': '<?php\n\nnamespace App\\Service;\n\nclass Importer\n{\n}\n',
      'src/Entity/Order.php': '<?php\n\nnamespace App\\Entity;\n\nclass Order\n{\n}\n',
      'tests/Unit/ImporterTest.php': '<?php\n\nnamespace App\\Tests\\Unit;\n\nclass ImporterTest\n{\n}\n',
    });

    const text = await runModule('php-namespace-consistency.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('CORS origins written as one comma-separated string', async () => {
    const app = appWith('cors', {
      'config/packages/nelmio_cors.yaml': [
        'nelmio_cors:',
        '    defaults:',
        '        origin_regex: true',
        '        allow_origin: "https://acme.example.com,https://admin.example.com"',
        '        allow_methods: "GET,POST,PUT,PATCH,DELETE"',
        '        allow_headers: "Content-Type,Authorization"',
        '        expose_headers: "Link,X-Total-Count"',
        '        max_age: 3600',
        '        allow_credentials: true',
        '    paths:',
        '        "^/api/":',
        '            allow_origin: ["*"]',
        '            allow_headers: ["*"]',
        '            allow_methods: [GET, POST]',
        '            max_age: 0',
        '        "^/admin/":',
        '            allow_origin: "https://admin.example.com"',
      ].join('\n') + '\n',
    }, { 'nelmio/cors-bundle': '^2.4' });

    const text = await runModule('cors.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('bundles with the packages installed behind them', async () => {
    const app = appWith('bundles', {
      'composer.json': JSON.stringify({
        require: {
          'symfony/framework-bundle': '^7.0',
          'doctrine/doctrine-bundle': '^2.11',
          'nelmio/cors-bundle': '^2.4',
        },
        'require-dev': {
          'symfony/web-profiler-bundle': '^7.0',
          'symfony/maker-bundle': '^1.55',
          'phpunit/phpunit': '^11.0',
        },
        autoload: { 'psr-4': { 'App\\': 'src/' } },
      }, null, 2) + '\n',
      'composer.lock': JSON.stringify({
        'content-hash': '0'.repeat(32),
        packages: [
          { name: 'symfony/framework-bundle', version: 'v7.0.3', autoload: { 'psr-4': { 'Symfony\\Bundle\\FrameworkBundle\\': '' } } },
          { name: 'doctrine/doctrine-bundle', version: '2.11.3', autoload: { 'psr-4': { 'Doctrine\\Bundle\\DoctrineBundle\\': '' } } },
          { name: 'nelmio/cors-bundle', version: '2.4.0', autoload: { 'psr-4': { 'Nelmio\\CorsBundle\\': '' } } },
          { name: 'symfony/http-kernel', version: 'v7.0.3', autoload: { 'psr-4': { 'Symfony\\Component\\HttpKernel\\': '' } } },
        ],
        'packages-dev': [
          { name: 'symfony/web-profiler-bundle', version: 'v7.0.3', autoload: { 'psr-4': { 'Symfony\\Bundle\\WebProfilerBundle\\': '' } } },
          { name: 'symfony/maker-bundle', version: 'v1.55.0', autoload: { 'psr-4': { 'Symfony\\Bundle\\MakerBundle\\': '' } } },
        ],
      }, null, 2) + '\n',
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],",
        "    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],",
        "    Nelmio\\CorsBundle\\NelmioCorsBundle::class => ['all' => true],",
        "    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['all' => true],",
        "    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ['all' => true],",
        "    Symfony\\Bundle\\DebugBundle\\DebugBundle::class => ['prod' => true],",
        '];',
      ].join('\n') + '\n',
      'src/Kernel.php': '<?php\n\nnamespace App;\n\nuse Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;\nuse Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;\n\nclass Kernel extends BaseKernel\n{\n    use MicroKernelTrait;\n}\n',
    });

    const results = await Promise.all([
      runModule('bundles.js', app, ['FrameworkBundle']),
      runModule('kernel-analysis.js', app),
      runModule('composer.js', app, ['symfony/http-kernel']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a manifest with development packages and no lock beside it', async () => {
    const app = appWith('composer-dev-only', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/http-kernel': '^7.0' },
        'require-dev': {
          'phpunit/phpunit': '^11.0',
          'phpstan/phpstan': '^1.10',
          'symfony/maker-bundle': '^1.55',
        },
        autoload: { 'psr-4': { 'App\\': 'src/' } },
      }, null, 2) + '\n',
    });

    const text = await runModule('composer.js', app, ['phpunit/phpunit']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('cache pools for the system and for Doctrine', async () => {
    const app = appWith('cache-pools', {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        app: cache.adapter.redis',
        '        system: cache.adapter.system',
        '        pools:',
        '            cache.system.metadata:',
        '                adapter: cache.adapter.system',
        '            cache.system.annotations:',
        '                adapter: cache.adapter.system',
        '            doctrine.result_cache_pool:',
        '                adapter: cache.app',
        '            doctrine.system_cache_pool:',
        '                adapter: cache.system',
        '            app.cache.custom:',
        '                adapter: cache.adapter.redis',
        '                default_lifetime: 600',
      ].join('\n') + '\n',
    });

    const text = await runModule('cache-pools.js', app, ['cache.system.metadata']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('tags with a consumer and tags with none', async () => {
    const app = appWith('container-tags', {
      'config/services.yaml': [
        'services:',
        '    _defaults:',
        '        autowire: true',
        '',
        '    App\\Handler\\FirstHandler:',
        '        tags: [{ name: app.handler, priority: 10 }]',
        '',
        '    App\\Handler\\SecondHandler:',
        '        tags: [{ name: app.handler, priority: 5 }]',
        '',
        '    App\\Reporter\\Unconsumed:',
        '        tags: [{ name: app.reporter }]',
        '',
        '    App\\Handler\\Registry:',
        '        arguments:',
        '            - !tagged_iterator app.handler',
        '',
        '    App\\Handler\\Locator:',
        '        arguments:',
        '            - !tagged_locator { tag: app.handler, index_by: key }',
      ].join('\n') + '\n',
      'src/Handler/Registry.php': [
        '<?php',
        'namespace App\\Handler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Attribute\\AutowireIterator;',
        'use Symfony\\Component\\DependencyInjection\\Attribute\\TaggedIterator;',
        '',
        'class Registry',
        '{',
        '    public function __construct(',
        '        #[TaggedIterator("app.handler")]',
        '        private iterable $handlers,',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
      'src/Handler/Locator.php': [
        '<?php',
        'namespace App\\Handler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Attribute\\TaggedLocator;',
        'use Symfony\\Component\\DependencyInjection\\ServiceLocator;',
        '',
        'class Locator',
        '{',
        '    public function __construct(',
        '        #[TaggedLocator("app.handler", indexAttribute: "key")]',
        '        private ServiceLocator $handlers,',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
      'src/Handler/FirstHandler.php': '<?php\n\nnamespace App\\Handler;\n\nclass FirstHandler\n{\n}\n',
      'src/Handler/SecondHandler.php': '<?php\n\nnamespace App\\Handler;\n\nclass SecondHandler\n{\n}\n',
      'src/Reporter/Unconsumed.php': '<?php\n\nnamespace App\\Reporter;\n\nclass Unconsumed\n{\n}\n',
      'src/DependencyInjection/Compiler/HandlerPass.php': [
        '<?php',
        'namespace App\\DependencyInjection\\Compiler;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;',
        'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
        '',
        'class HandlerPass implements CompilerPassInterface',
        '{',
        '    public function process(ContainerBuilder $container): void',
        '    {',
        '        foreach ($container->findTaggedServiceIds("app.handler") as $id => $tags) { }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('container-tags.js', app, ['app.handler']),
      runModule('services.js', app, ['app.handler']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('two cycles in the dependency graph', async () => {
    const app = appWith('two-cycles', {
      'src/Service/A.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class A',
        '{',
        '    public function __construct(private B $b) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/B.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class B',
        '{',
        '    public function __construct(private A $a) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/C.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class C',
        '{',
        '    public function __construct(private D $d) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/D.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class D',
        '{',
        '    public function __construct(private E $e) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/E.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class E',
        '{',
        '    public function __construct(private C $c) {}',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('dependency-graph.js', app, ['App\\Service\\A', 'A']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('entities cached in a region nobody declared, and hydrators half registered', async () => {
    const app = appWith('cache-and-hydrators', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        second_level_cache:',
        '            enabled: true',
        '            regions:',
        '                declared:',
        '                    lifetime: 600',
        '        hydrators:',
        '            column: App\\Doctrine\\Hydrator\\ColumnHydrator',
        '    dbal:',
        '        url: "%env(DATABASE_URL)%"',
      ].join('\n') + '\n',
      'src/Entity/Cached.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Cache(usage: "READ_ONLY", region: "undeclared")]',
        'class Cached',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/AlsoCached.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Cache(usage: "READ_WRITE", region: "declared")]',
        'class AlsoCached',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Hydrator/ColumnHydrator.php': [
        '<?php',
        'namespace App\\Doctrine\\Hydrator;',
        '',
        'use Doctrine\\ORM\\Internal\\Hydration\\AbstractHydrator;',
        '',
        'class ColumnHydrator extends AbstractHydrator',
        '{',
        '    protected function hydrateAllData(): array { return []; }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Hydrator/UnregisteredHydrator.php': [
        '<?php',
        'namespace App\\Doctrine\\Hydrator;',
        '',
        'use Doctrine\\ORM\\Internal\\Hydration\\AbstractHydrator;',
        '',
        'class UnregisteredHydrator extends AbstractHydrator',
        '{',
        '    protected function hydrateAllData(): array { return []; }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const results = await Promise.all([
      runModule('doctrine-cache.js', app),
      runModule('doctrine-custom-hydrators.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('lifecycle callbacks declared twice, and entity relations to graph', async () => {
    const app = appWith('lifecycle-graph', {
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\HasLifecycleCallbacks]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\ManyToOne(targetEntity: Customer::class, inversedBy: "orders")]',
        '    private ?Customer $customer = null;',
        '',
        '    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: "order", cascade: ["persist", "remove"])]',
        '    private $lines;',
        '',
        '    #[ORM\\ManyToMany(targetEntity: Tag::class)]',
        '    private $tags;',
        '',
        '    #[ORM\\PrePersist]',
        '    public function stamp(): void { }',
        '',
        '    #[ORM\\PrePersist]',
        '    public function alsoStamp(): void { }',
        '',
        '    #[ORM\\PreUpdate]',
        '    public function touch(): void { }',
        '',
        '    #[ORM\\PostLoad]',
        '    public function afterLoad(): void { }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Customer.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Customer',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\OneToMany(targetEntity: Order::class, mappedBy: "customer")]',
        '    private $orders;',
        '',
        '    #[ORM\\OneToOne(targetEntity: Address::class, cascade: ["persist"])]',
        '    private ?Address $address = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Line.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Line\n{\n    #[ORM\\ManyToOne(targetEntity: Order::class, inversedBy: "lines")]\n    private ?Order $order = null;\n}\n',
      'src/Entity/Tag.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Tag\n{\n}\n',
      'src/Entity/Address.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Address\n{\n}\n',
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        entity_managers:',
        '            default:',
        '                connection: default',
        '                filters:',
        '                    soft_delete:',
        '                        class: App\\Doctrine\\SoftDeleteFilter',
        '                        enabled: true',
        '                    tenant:',
        '                        class: App\\Doctrine\\TenantFilter',
        '                        enabled: true',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const results = await Promise.all([
      runModule('doctrine-lifecycle.js', app, ['Order']),
      runModule('doctrine-entity-graph.js', app, ['Order']),
      runModule('doctrine-orm-config.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });
});
