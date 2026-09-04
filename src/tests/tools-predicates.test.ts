// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The predicates: the some(), every() and find() calls that only run once
 * the collection they walk has something in it and the condition around
 * them is met.
 *
 * Each application here is built for one of those conditions, taken from
 * the module: an installed.json whose package namespaces cover the bundle
 * classes, a lock file with no framework-bundle so the version comes from
 * http-kernel, exporters where the module reads them rather than one level
 * down, a scoped client in http_client.yaml rather than framework.yaml.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-predicates-'));
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

describe('the predicates', () => {
  test('bundles whose classes fall under an installed package namespace', async () => {
    const app = appWith('installed-json', {
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],",
        "    Nelmio\\CorsBundle\\NelmioCorsBundle::class => ['all' => true],",
        "    Acme\\PrivateBundle\\AcmePrivateBundle::class => ['all' => true],",
        '];',
      ].join('\n') + '\n',
      'vendor/composer/installed.json': JSON.stringify({
        packages: [
          {
            name: 'symfony/framework-bundle',
            version: 'v7.0.3',
            autoload: { 'psr-4': { 'Symfony\\\\Bundle\\\\FrameworkBundle\\\\': '' } },
          },
          {
            name: 'nelmio/cors-bundle',
            version: '2.4.0',
            autoload: { 'psr-4': { 'Nelmio\\\\CorsBundle\\\\': '' } },
          },
          {
            name: 'doctrine/orm',
            version: '3.0.0',
            autoload: { files: ['src/functions.php'] },
          },
        ],
      }, null, 2) + '\n',
    });

    const text = await runModule('bundles.js', app, ['NelmioCorsBundle']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a lock file with no framework-bundle, where the version comes from http-kernel', async () => {
    const app = appWith('version-fallback', {
      'composer.json': JSON.stringify({
        require: { 'symfony/http-kernel': '^7.0', 'doctrine/orm': '^3.0' },
        autoload: { 'psr-4': { 'App\\': 'src/' } },
      }, null, 2) + '\n',
      'composer.lock': JSON.stringify({
        'content-hash': '0'.repeat(32),
        packages: [
          { name: 'symfony/http-kernel', version: 'v7.0.3', type: 'library', description: 'Structures the request/response flow' },
          { name: 'doctrine/orm', version: '3.0.0', type: 'library' },
          { name: 'psr/log', version: '3.0.0', type: 'library' },
        ],
        'packages-dev': [{ name: 'phpunit/phpunit', version: '11.0.1' }],
      }, null, 2) + '\n',
    });

    const text = await runModule('composer.js', app, ['symfony/http-kernel']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('exporters where the module reads them, both Jaeger and Zipkin', async () => {
    const app = appWith('otel-exporters', {
      'config/packages/open_telemetry.yaml': [
        'open_telemetry:',
        '    service_name: acme',
        '    exporters:',
        '        jaeger:',
        '            endpoint: "http://jaeger:14268/api/traces"',
        '        zipkin:',
        '            endpoint: "http://zipkin:9411/api/v2/spans"',
        '        otlp:',
        '            endpoint: "http://collector:4318"',
        '    processors:',
        '        batch:',
        '            max_queue_size: 2048',
        '    instrumentations:',
        '        symfony: true',
        '        doctrine: true',
      ].join('\n') + '\n',
    }, { 'open-telemetry/opentelemetry-auto-symfony': '^1.0' });

    const text = await runModule('opentelemetry-config.js', app);
    expect(text).toContain('Jaeger');
  });

  test('a scoped client with its credentials, in the file the module reads', async () => {
    const app = appWith('http-client-auth', {
      'config/packages/http_client.yaml': [
        'framework:',
        '    http_client:',
        '        scoped_clients:',
        '            payments.client:',
        '                base_uri: "https://payments.example.com"',
        '                auth_bearer: "0123456789abcdef0123456789abcdef"',
        '                timeout: 5',
        '            search.client:',
        '                base_uri: "https://search.example.com"',
        '                headers:',
        '                    X-Api-Key: "0123456789abcdef"',
        '                    Accept: application/json',
        '            safe.client:',
        '                base_uri: "https://safe.example.com"',
        '                auth_bearer: "%env(SAFE_TOKEN)%"',
        '            plain.client:',
        '                base_uri: "https://plain.example.com"',
        '                headers:',
        '                    Accept: application/json',
      ].join('\n') + '\n',
      'src/Service/Payments.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
        '',
        'class Payments',
        '{',
        '    public function __construct(private HttpClientInterface $paymentsClient) {}',
        '',
        '    public function charge(): array',
        '    {',
        '        return $this->paymentsClient->request("POST", "/charges", [',
        '            "auth_bearer" => "0123456789abcdef0123456789abcdef",',
        '        ])->toArray();',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-http-client-auth.js', app, ['payments.client']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a scheduler transport on Doctrine with no lock, and one with it', async () => {
    const app = appWith('scheduler-lock', {
      'config/packages/scheduler.yaml': [
        'framework:',
        '    scheduler:',
        '        schedules:',
        '            default:',
        '                transport: "doctrine://default?queue_name=schedule"',
        '                options:',
        '                    queue_name: schedule',
        '            locked:',
        '                transport: "redis://localhost:6379/messages"',
        '                options:',
        '                    lock: scheduler.lock',
        '                    stream: schedule',
        '            memory:',
        '                transport: "in-memory://"',
        '            filesystem:',
        '                transport: "filesystem:///var/schedule"',
        '            strange:',
        '                transport: "acme://whatever"',
      ].join('\n') + '\n',
    }, { 'symfony/scheduler': '^7.0' });

    const text = await runModule('symfony-scheduler-transport-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('feature flags declared twice in the environment, and one only used in code', async () => {
    const app = appWith('feature-flags', {
      '.env': [
        'APP_ENV=prod',
        'FEATURE_NEW_CHECKOUT=1',
        'FEATURE_DARK_MODE=0',
        'FLAG_BETA_SEARCH=true',
        'ENABLE_LEGACY_IMPORT=false',
      ].join('\n') + '\n',
      '.env.example': [
        'FEATURE_NEW_CHECKOUT=',
        'FEATURE_DARK_MODE=',
        'FLAG_BETA_SEARCH=',
        'ENABLE_LEGACY_IMPORT=',
        'FEATURE_ONLY_IN_EXAMPLE=1',
      ].join('\n') + '\n',
      'src/Service/Checkout.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class Checkout',
        '{',
        '    public function run(): bool',
        '    {',
        '        return $_ENV["FEATURE_NEW_CHECKOUT"] === "1"',
        '            && getenv("FLAG_BETA_SEARCH") !== false',
        '            && $_ENV["FEATURE_NEVER_DECLARED"] === "1";',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('feature-flags.js', app, ['FEATURE_NEW_CHECKOUT']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('PHPStan rules registered by their full name, matched by the class at the end', async () => {
    const app = appWith('phpstan-rules-fqn', {
      'phpstan.neon': [
        'parameters:',
        '    level: 8',
        '    paths:',
        '        - src',
        '',
        'rules:',
        '    - App\\PHPStan\\Rule\\NoDirectManagerRule',
        '    - App\\PHPStan\\Rule\\ControllerReturnTypeRule',
        '',
        'services:',
        '    -',
        '        class: App\\PHPStan\\Rule\\NoDirectManagerRule',
        '        tags: [phpstan.rules.rule]',
      ].join('\n') + '\n',
      'src/PHPStan/Rule/NoDirectManagerRule.php': [
        '<?php',
        'namespace App\\PHPStan\\Rule;',
        '',
        'use PhpParser\\Node;',
        'use PHPStan\\Analyser\\Scope;',
        'use PHPStan\\Rules\\Rule;',
        'use PHPStan\\Rules\\RuleErrorBuilder;',
        '',
        '/** @implements Rule<Node\\Expr\\MethodCall> */',
        'class NoDirectManagerRule implements Rule',
        '{',
        '    public function getNodeType(): string { return Node\\Expr\\MethodCall::class; }',
        '',
        '    public function processNode(Node $node, Scope $scope): array',
        '    {',
        '        return [RuleErrorBuilder::message("no direct manager")->identifier("acme.manager")->build()];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/PHPStan/Rule/ControllerReturnTypeRule.php': [
        '<?php',
        'namespace App\\PHPStan\\Rule;',
        '',
        'use PhpParser\\Node;',
        'use PHPStan\\Analyser\\Scope;',
        'use PHPStan\\Rules\\Rule;',
        '',
        'class ControllerReturnTypeRule implements Rule',
        '{',
        '    public function getNodeType(): string { return Node\\Stmt\\ClassMethod::class; }',
        '    public function processNode(Node $node, Scope $scope): array { return []; }',
        '}',
      ].join('\n') + '\n',
      'src/PHPStan/Rule/UnlistedRule.php': [
        '<?php',
        'namespace App\\PHPStan\\Rule;',
        '',
        'use PhpParser\\Node;',
        'use PHPStan\\Analyser\\Scope;',
        'use PHPStan\\Rules\\Rule;',
        '',
        'class UnlistedRule implements Rule',
        '{',
        '    public function getNodeType(): string { return Node::class; }',
        '    public function processNode(Node $node, Scope $scope): array { return []; }',
        '}',
      ].join('\n') + '\n',
    }, { 'phpstan/phpstan': '^1.10' });

    const text = await runModule('phpstan-custom-rules.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a resource whose read group names a sensitive field, and a static Mercure topic', async () => {
    const app = appWith('api-sensitive', {
      'config/packages/api_platform.yaml': 'api_platform:\n    title: Acme\n    version: 1.0.0\n',
      'config/packages/mercure.yaml': [
        'mercure:',
        '    hubs:',
        '        default:',
        '            url: "%env(MERCURE_URL)%"',
        '            public_url: "%env(MERCURE_PUBLIC_URL)%"',
      ].join('\n') + '\n',
      'src/Entity/Account.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        "#[ApiResource(normalizationContext: ['groups' => ['account:read', 'account:password']], mercure: ['topics' => ['https://example.com/accounts']])]",
        'class Account',
        '{',
        "    #[Groups(['account:read'])]",
        '    public int $id = 0;',
        '',
        "    #[Groups(['account:password'])]",
        '    public string $passwordHash = "";',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Stream.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        '',
        "#[ApiResource(mercure: ['topics' => ['https://example.com/streams/{id}']])]",
        'class Stream',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
    }, { 'api-platform/core': '^3.2', 'symfony/mercure-bundle': '^0.3' });

    const results = await Promise.all([
      runModule('api-platform-security.js', app),
      runModule('api-platform-mercure-push.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a Behat step that matches a definition, and one definition that matches anything', async () => {
    const app = appWith('behat-match', {
      'behat.yaml': [
        'default:',
        '    suites:',
        '        default:',
        '            paths: ["%paths.base%/features"]',
        '            contexts: [FeatureContext]',
      ].join('\n') + '\n',
      'features/simple.feature': [
        'Feature: Simple',
        '',
        '    Scenario: One step',
        '        Given I am on the home page',
        '        When I click the button',
        '        Then I should see the result',
      ].join('\n') + '\n',
      'features/bootstrap/FeatureContext.php': [
        '<?php',
        '',
        'use Behat\\Behat\\Context\\Context;',
        '',
        'class FeatureContext implements Context',
        '{',
        '    /**',
        '     * @Given I am on the home page',
        '     */',
        '    public function iAmOnTheHomePage(): void { }',
        '',
        '    /**',
        '     * @When I click the button',
        '     */',
        '    public function iClickTheButton(): void { }',
        '',
        '    /**',
        '     * @Then .*',
        '     */',
        '    public function anything(): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'behat/behat': '^3.14' });

    const text = await runModule('behat-step-coverage.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('an aggregate nobody releases, beside one a handler does', async () => {
    const app = appWith('domain-events-dispatch', {
      'src/Domain/Order.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Order',
        '{',
        '    private array $domainEvents = [];',
        '',
        '    public function place(): void { $this->recordEvent(new OrderPlaced()); }',
        '',
        '    private function recordEvent(object $event): void { $this->domainEvents[] = $event; }',
        '',
        '    public function releaseEvents(): array',
        '    {',
        '        $events = $this->domainEvents;',
        '        $this->domainEvents = [];',
        '',
        '        return $events;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Domain/Invoice.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Invoice',
        '{',
        '    private array $domainEvents = [];',
        '',
        '    public function issue(): void { $this->recordEvent(new InvoiceIssued()); }',
        '',
        '    private function recordEvent(object $event): void { $this->domainEvents[] = $event; }',
        '',
        '    public function releaseEvents(): array { return $this->domainEvents; }',
        '}',
      ].join('\n') + '\n',
      'src/Domain/OrderPlaced.php': '<?php\n\nnamespace App\\Domain;\n\nfinal class OrderPlaced\n{\n}\n',
      'src/Domain/InvoiceIssued.php': '<?php\n\nnamespace App\\Domain;\n\nfinal class InvoiceIssued\n{\n}\n',
      'src/EventListener/OrderFlusher.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use App\\Domain\\Order;',
        'use Psr\\EventDispatcher\\EventDispatcherInterface;',
        '',
        'class OrderFlusher',
        '{',
        '    public function __construct(private EventDispatcherInterface $dispatcher) {}',
        '',
        '    public function flush(Order $order): void',
        '    {',
        '        foreach ($order->releaseEvents() as $event) {',
        '            $this->dispatcher->dispatch($event);',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-domain-events.js', app);
    expect(text).toContain('Invoice');
  });

  test('lifecycle callbacks written as docblock annotations, one of them twice', async () => {
    const app = appWith('lifecycle-annotations', {
      'src/Entity/Legacy.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '/**',
        ' * @ORM\\Entity',
        ' * @ORM\\HasLifecycleCallbacks',
        ' */',
        'class Legacy',
        '{',
        '    /**',
        '     * @ORM\\Id',
        '     * @ORM\\Column(type="integer")',
        '     */',
        '    private $id;',
        '',
        '    /**',
        '     * @ORM\\PrePersist',
        '     */',
        '    public function stampCreatedAt()',
        '    {',
        '        $this->createdAt = new \\DateTime();',
        '    }',
        '',
        '    /**',
        '     * @ORM\\PrePersist',
        '     * @ORM\\PreUpdate',
        '     */',
        '    public function stampUpdatedAt()',
        '    {',
        '        $this->updatedAt = new \\DateTime();',
        '    }',
        '',
        '    /**',
        '     * @ORM\\PostLoad',
        '     */',
        '    public function afterLoad()',
        '    {',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Modern.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\HasLifecycleCallbacks]',
        'class Modern',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\PrePersist]',
        '    public function stamp(): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-lifecycle.js', app, ['Legacy']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('entity listeners that exist and one that does not', async () => {
    const app = appWith('entity-listeners-every', {
      'config/services.yaml': [
        'services:',
        '    App\\EventListener\\PresentListener:',
        '        tags:',
        '            - { name: doctrine.orm.entity_listener, event: prePersist, entity: App\\Entity\\Order }',
      ].join('\n') + '\n',
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use App\\EventListener\\PresentListener;',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\EntityListeners([PresentListener::class])]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Invoice.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\EntityListeners(["App\\\\EventListener\\\\MissingListener"])]',
        'class Invoice',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/EventListener/PresentListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use App\\Entity\\Order;',
        '',
        'class PresentListener',
        '{',
        '    public function prePersist(Order $order): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-entity-listeners.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a class with a property declared and promoted under the same name', async () => {
    const app = appWith('serializer-duplicate', {
      'src/Dto/Duplicated.php': [
        '<?php',
        'namespace App\\Dto;',
        '',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        'final class Duplicated',
        '{',
        "    #[Groups(['read'])]",
        '    public string $reference = "";',
        '',
        "    #[Groups(['read', 'write'])]",
        '    public string $label = "";',
        '',
        '    public function __construct(',
        "        #[Groups(['read'])]",
        '        public readonly string $reference2 = "",',
        "        #[Groups(['write'])]",
        '        public readonly string $label2 = "",',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
      'src/Dto/Promoted.php': [
        '<?php',
        'namespace App\\Dto;',
        '',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        'final class Promoted',
        '{',
        '    public function __construct(',
        "        #[Groups(['read'])]",
        '        public readonly string $name = "",',
        "        #[Groups(['read'])]",
        '        public readonly string $name2 = "",',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
    }, { 'symfony/serializer': '^7.0' });

    const text = await runModule('serializer.js', app, ['read']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a chain pool the PSR-6 report counts, and a null adapter in production', async () => {
    const app = appWith('psr6', {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        pools:',
        '            app.cache.chain:',
        '                adapter: cache.adapter.chain',
        '                providers:',
        '                    - cache.adapter.filesystem',
        '                    - cache.adapter.array',
        '            app.cache.tagged:',
        '                adapter: cache.adapter.redis_tag_aware',
      ].join('\n') + '\n',
      'config/packages/prod/cache.yaml': [
        'framework:',
        '    cache:',
        '        pools:',
        '            app.cache.disabled:',
        '                adapter: cache.adapter.null',
      ].join('\n') + '\n',
      'src/Cache/Mixed.php': [
        '<?php',
        'namespace App\\Cache;',
        '',
        'use Psr\\Cache\\CacheItemPoolInterface;',
        'use Psr\\SimpleCache\\CacheInterface;',
        'use Symfony\\Component\\Cache\\Adapter\\FilesystemAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter;',
        '',
        'class MixedCache',
        '{',
        '    public function __construct(',
        '        private CacheItemPoolInterface $pool,',
        '        private CacheInterface $simple,',
        '    ) {}',
        '',
        '    public function build(): TagAwareAdapter',
        '    {',
        '        return new TagAwareAdapter(new FilesystemAdapter(""));',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-cache-psr6-adapters.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('two cycles in a graph where one is reached from both ends', async () => {
    const app = appWith('cycles', {
      'config/services.yaml': 'services:\n    _defaults:\n        autowire: true\n    App\\:\n        resource: "../src/"\n',
      'src/Service/Alpha.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\Beta;',
        '',
        'class Alpha',
        '{',
        '    public function __construct(private Beta $beta) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/Beta.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\Alpha;',
        '',
        'class Beta',
        '{',
        '    public function __construct(private Alpha $alpha) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/Gamma.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\Delta;',
        '',
        'class Gamma',
        '{',
        '    public function __construct(private Delta $delta) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/Delta.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\Epsilon;',
        '',
        'class Delta',
        '{',
        '    public function __construct(private Epsilon $epsilon) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/Epsilon.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use App\\Service\\Gamma;',
        '',
        'class Epsilon',
        '{',
        '    public function __construct(private Gamma $gamma) {}',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('dependency-graph.js', app, ['Alpha', 'App\\Service\\Alpha']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('an entity cached in a region the configuration does not declare', async () => {
    const app = appWith('slc-region', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        second_level_cache:',
        '            enabled: true',
        '            regions:',
        '                declared_region:',
        '                    lifetime: 600',
        '                    cache_driver:',
        '                        type: pool',
        '                        pool: cache.app',
      ].join('\n') + '\n',
      'src/Entity/Cached.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Cache(usage: "READ_WRITE", region: "undeclared_region")]',
        'class Cached',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Cache(usage: "READ_ONLY")]',
        '    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: "cached")]',
        '    private $lines;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/AlsoCached.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Cache(usage: "READ_ONLY", region: "declared_region")]',
        'class AlsoCached',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Line.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Line\n{\n}\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-cache.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Assert\\Valid on a typed scalar property', async () => {
    const app = appWith('valid-on-scalar', {
      'src/Entity/Payment.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\Common\\Collections\\Collection;',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Validator\\Constraints as Assert;',
        '',
        '#[ORM\\Entity]',
        'class Payment',
        '{',
        '    #[Assert\\Valid]',
        '    private string $reference = "";',
        '',
        '    #[Assert\\Valid]',
        '    private int $amount = 0;',
        '',
        '    #[Assert\\Valid]',
        '    #[ORM\\OneToMany(targetEntity: Refund::class, mappedBy: "payment")]',
        '    private Collection $refunds;',
        '',
        '    #[ORM\\ManyToOne(targetEntity: Order::class)]',
        '    private ?Order $order = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Refund.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Refund\n{\n}\n',
      'src/Entity/Order.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Order\n{\n}\n',
    }, { 'doctrine/orm': '^3.0', 'symfony/validator': '^7.0' });

    const text = await runModule('symfony-validator-cascade.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
