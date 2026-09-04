// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A fifth set: a profile whose logger counts nothing itself, services with
 * tags to count, a class with both promoted and declared properties,
 * snapshots named after their test, PHPStan rules registered in the neon,
 * and two listeners on the same event at the same priority written as
 * string keys.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-conditions5-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string | Buffer>, require_: Record<string, string> = {}): string {
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

describe('the fifth set', () => {
  test('a profile whose logger collector counts nothing itself', async () => {
    const token = 'bb22cc';
    const profile = {
      time: { duration: 42.5 },
      memory: { memory: 8_000_000, memory_limit: 134_217_728 },
      logger: {
        logs: [
          { message: 'first', priority: '400', priorityName: 'ERROR', channel: 'request' },
          { message: 'second', priority: '400', priorityName: 'ERROR', channel: 'app' },
          { message: 'third', priority: '300', priorityName: 'WARNING', channel: 'doctrine' },
          { message: 'fourth', priority: '200', priorityName: 'INFO', channel: 'request' },
        ],
      },
      request: { method: 'GET', status_code: 200, route: 'app_home' },
    };

    const app = appWith('profiler-counts', {
      [path.join('var/cache/dev/profiler', token.slice(-2), token.slice(-4, -2), token)]: zlib.gzipSync(Buffer.from(JSON.stringify(profile))),
      'var/cache/dev/profiler/index.csv': `${token},127.0.0.1,GET,http://localhost/,1756000000,,200,request\n`,
    });

    const text = await runModule('profiler.js', app, [token]);
    expect(text.length).toBeGreaterThan(0);
  });

  test('services with tags to count, and a class with promoted and declared properties', async () => {
    const app = appWith('services-and-serializer', {
      'config/services.yaml': [
        'services:',
        '    _defaults:',
        '        autowire: true',
        '        autoconfigure: true',
        '',
        '    App\\Handler\\One:',
        '        tags: ["app.handler", "app.reporter"]',
        '',
        '    App\\Handler\\Two:',
        '        tags: ["app.handler"]',
        '',
        '    App\\Handler\\Three:',
        '        tags: [{ name: app.handler, priority: 5 }, { name: kernel.event_listener, event: kernel.request }]',
        '',
        '    App\\Handler\\Four:',
        '        tags: ["kernel.event_listener"]',
        '        public: true',
        '        lazy: true',
      ].join('\n') + '\n',
      'src/Handler/One.php': '<?php\n\nnamespace App\\Handler;\n\nclass One\n{\n}\n',
      'src/Handler/Two.php': '<?php\n\nnamespace App\\Handler;\n\nclass Two\n{\n}\n',
      'src/Handler/Three.php': '<?php\n\nnamespace App\\Handler;\n\nclass Three\n{\n}\n',
      'src/Handler/Four.php': '<?php\n\nnamespace App\\Handler;\n\nclass Four\n{\n}\n',
      'src/Dto/Mixed.php': [
        '<?php',
        'namespace App\\Dto;',
        '',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        'use Symfony\\Component\\Serializer\\Annotation\\SerializedName;',
        '',
        'final class MixedDto',
        '{',
        "    #[Groups(['read'])]",
        '    public int $id = 0;',
        '',
        "    #[Groups(['read', 'write'])]",
        '    #[SerializedName("display_name")]',
        '    public string $name = "";',
        '',
        '    public function __construct(',
        "        #[Groups(['read'])]",
        '        public readonly string $reference = "",',
        "        #[Groups(['write'])]",
        '        public readonly string $note = "",',
        "        #[Groups(['read'])]",
        '        public readonly int $id2 = 0,',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('services.js', app, ['app.handler']),
      runModule('serializer.js', app, ['read']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('snapshots named after their test, and PHPStan rules registered in the neon', async () => {
    const app = appWith('snapshots-and-rules', {
      'tests/Unit/OrderSnapshotTest.php': [
        '<?php',
        'namespace App\\Tests\\Unit;',
        '',
        'use PHPUnit\\Framework\\TestCase;',
        '',
        'class OrderSnapshotTest extends TestCase',
        '{',
        '    public function testMatches(): void',
        '    {',
        '        $this->assertMatchesJsonSnapshot(["id" => 1, "createdAt" => date("c")]);',
        '    }',
        '',
        '    public function testAlsoMatches(): void',
        '    {',
        '        $this->assertMatchesTextSnapshot("value " . uniqid());',
        '    }',
        '}',
      ].join('\n') + '\n',
      'tests/Unit/__snapshots__/OrderSnapshotTest__testMatches__1.json': '{"id":1}\n',
      'tests/Unit/__snapshots__/OrderSnapshotTest__testAlsoMatches__1.txt': 'value\n',
      'tests/Unit/__snapshots__/OrphanTest__testGone__1.json': '{"gone":true}\n',
      'phpstan.neon': [
        'parameters:',
        '    level: 8',
        '    paths:',
        '        - src',
        '',
        'services:',
        '    -',
        '        class: App\\PHPStan\\NoDirectManagerRule',
        '        tags: [phpstan.rules.rule]',
        '    -',
        '        class: App\\PHPStan\\UnregisteredRule',
        '        tags: [phpstan.rules.rule]',
      ].join('\n') + '\n',
      'src/PHPStan/NoDirectManagerRule.php': [
        '<?php',
        'namespace App\\PHPStan;',
        '',
        'use PhpParser\\Node;',
        'use PHPStan\\Analyser\\Scope;',
        'use PHPStan\\Rules\\Rule;',
        '',
        '/** @implements Rule<Node\\Expr\\MethodCall> */',
        'class NoDirectManagerRule implements Rule',
        '{',
        '    public function getNodeType(): string { return Node\\Expr\\MethodCall::class; }',
        '    public function processNode(Node $node, Scope $scope): array { return []; }',
        '}',
      ].join('\n') + '\n',
      'src/PHPStan/NotInTheNeonRule.php': [
        '<?php',
        'namespace App\\PHPStan;',
        '',
        'use PhpParser\\Node;',
        'use PHPStan\\Analyser\\Scope;',
        'use PHPStan\\Rules\\Rule;',
        '',
        'class NotInTheNeonRule implements Rule',
        '{',
        '    public function getNodeType(): string { return Node::class; }',
        '    public function processNode(Node $node, Scope $scope): array { return []; }',
        '}',
      ].join('\n') + '\n',
    }, { 'phpstan/phpstan': '^1.10', 'spatie/phpunit-snapshot-assertions': '^5.1' });

    const results = await Promise.all([
      runModule('phpunit-snapshot.js', app),
      runModule('phpstan-custom-rules.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('two listeners on the same event at the same priority, written as string keys', async () => {
    const app = appWith('priority-conflict', {
      'src/EventSubscriber/FirstSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        '',
        'class FirstSubscriber implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return [',
        '            "kernel.request" => ["onRequest", 100],',
        '            "kernel.response" => ["onResponse", -10],',
        '        ];',
        '    }',
        '',
        '    public function onRequest($event): void { }',
        '    public function onResponse($event): void { }',
        '}',
      ].join('\n') + '\n',
      'src/EventSubscriber/SecondSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        '',
        'class SecondSubscriber implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return [',
        '            "kernel.request" => ["onRequest", 100],',
        '            "kernel.terminate" => ["onTerminate", 0],',
        '        ];',
        '    }',
        '',
        '    public function onRequest($event): void { }',
        '    public function onTerminate($event): void { }',
        '}',
      ].join('\n') + '\n',
      'src/EventListener/AttributeListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
        '',
        '#[AsEventListener(event: "kernel.request", priority: 100)]',
        'class AttributeListener',
        '{',
        '    public function __invoke($event): void { }',
        '}',
      ].join('\n') + '\n',
      'src/EventListener/SecondAttributeListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
        '',
        '#[AsEventListener(event: "kernel.response", priority: 100)]',
        'class SecondAttributeListener',
        '{',
        '    public function __invoke($event): void { }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('event-priority-conflicts.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a repository whose methods walk relations in a loop', async () => {
    const app = appWith('n-plus-one', {
      'src/Repository/OrderRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class OrderRepository extends ServiceEntityRepository',
        '{',
        '    public function withCustomers(): array',
        '    {',
        '        $orders = $this->findAll();',
        '        foreach ($orders as $order) {',
        '            $order->getCustomer()->getName();',
        '        }',
        '',
        '        return $orders;',
        '    }',
        '',
        '    public function withLines(): array',
        '    {',
        '        $orders = $this->findBy(["status" => "open"]);',
        '        foreach ($orders as $order) {',
        '            foreach ($order->getLines() as $line) {',
        '                $line->getProduct()->getName();',
        '            }',
        '        }',
        '',
        '        return $orders;',
        '    }',
        '',
        '    public function joined(): array',
        '    {',
        '        return $this->createQueryBuilder("o")',
        '            ->addSelect("c")',
        '            ->leftJoin("o.customer", "c")',
        '            ->getQuery()',
        '            ->getResult();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Repository/LineRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class LineRepository extends ServiceEntityRepository',
        '{',
        '    public function all(): array',
        '    {',
        '        $lines = $this->findAll();',
        '        foreach ($lines as $line) {',
        '            $line->getOrder()->getReference();',
        '        }',
        '',
        '        return $lines;',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('repository-analyzer.js', app, ['OrderRepository']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('subscribers that flush inside a listener and load metadata without asking the platform', async () => {
    const app = appWith('subscriber-bodies', {
      'src/EventSubscriber/FlushingSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\Common\\EventSubscriber;',
        'use Doctrine\\ORM\\Event\\LoadClassMetadataEventArgs;',
        'use Doctrine\\ORM\\Event\\PostPersistEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        'class FlushingSubscriber implements EventSubscriber',
        '{',
        '    public function getSubscribedEvents(): array',
        '    {',
        '        return [Events::postPersist, Events::loadClassMetadata];',
        '    }',
        '',
        '    public function postPersist(PostPersistEventArgs $args): void',
        '    {',
        '        $manager = $args->getObjectManager();',
        '        $manager->persist(new \\App\\Entity\\Audit());',
        '        $manager->flush();',
        '    }',
        '',
        '    public function loadClassMetadata(LoadClassMetadataEventArgs $args): void',
        '    {',
        '        $metadata = $args->getClassMetadata();',
        '        $metadata->setPrimaryTable(["name" => "prefixed_" . $metadata->getTableName()]);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/EventSubscriber/CarefulSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\Common\\EventSubscriber;',
        'use Doctrine\\ORM\\Event\\LoadClassMetadataEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        'class CarefulSubscriber implements EventSubscriber',
        '{',
        '    public function getSubscribedEvents(): array',
        '    {',
        '        return [Events::loadClassMetadata];',
        '    }',
        '',
        '    public function loadClassMetadata(LoadClassMetadataEventArgs $args): void',
        '    {',
        '        $platform = $args->getEntityManager()->getConnection()->getDatabasePlatform();',
        '        if ($platform->getName() !== "postgresql") { return; }',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Audit.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Audit\n{\n}\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-event-subscribers.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('bundles whose classes match an installed package, and tracing with two exporters', async () => {
    const app = appWith('bundles-and-tracing', {
      'composer.json': JSON.stringify({
        require: {
          'symfony/framework-bundle': '^7.0',
          'nelmio/cors-bundle': '^2.4',
          'open-telemetry/opentelemetry-auto-symfony': '^1.0',
        },
        'require-dev': { 'symfony/maker-bundle': '^1.55', 'phpunit/phpunit': '^11.0' },
        autoload: { 'psr-4': { 'App\\': 'src/' } },
      }, null, 2) + '\n',
      'composer.lock': JSON.stringify({
        'content-hash': '0'.repeat(32),
        packages: [
          { name: 'symfony/framework-bundle', version: 'v7.0.3', autoload: { 'psr-4': { 'Symfony\\Bundle\\FrameworkBundle\\': '' } } },
          { name: 'nelmio/cors-bundle', version: '2.4.0', autoload: { 'psr-4': { 'Nelmio\\CorsBundle\\': '' } } },
        ],
        'packages-dev': [
          { name: 'symfony/maker-bundle', version: 'v1.55.0', autoload: { 'psr-4': { 'Symfony\\Bundle\\MakerBundle\\': '' } } },
        ],
      }, null, 2) + '\n',
      'config/bundles.php': [
        '<?php',
        '',
        'return [',
        "    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],",
        "    Nelmio\\CorsBundle\\NelmioCorsBundle::class => ['all' => true],",
        "    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ['dev' => true],",
        '];',
      ].join('\n') + '\n',
      'config/packages/open_telemetry.yml': [
        'open_telemetry:',
        '    traces:',
        '        exporters:',
        '            jaeger: { endpoint: "http://jaeger:14268/api/traces" }',
        '            zipkin: { endpoint: "http://zipkin:9411/api/v2/spans" }',
        '    metrics:',
        '        exporters:',
        '            prometheus: { endpoint: "http://prometheus:9090" }',
      ].join('\n') + '\n',
      '.env': 'OTEL_TRACES_EXPORTER=jaeger,zipkin\nOTEL_SERVICE_NAME=acme\n',
    });

    const results = await Promise.all([
      runModule('bundles.js', app, ['NelmioCorsBundle']),
      runModule('opentelemetry-config.js', app),
      runModule('composer.js', app, ['nelmio/cors-bundle']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });
});
