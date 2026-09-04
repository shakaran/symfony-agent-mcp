// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications for the modules that read attributes.
 *
 * A Doctrine attribute is written through its alias — #[ORM\Column] — and a
 * good number of these modules also accept the bare form, so each class here
 * carries both spellings between them.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-attributes-'));
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
      require: { 'symfony/framework-bundle': '^7.0', 'doctrine/orm': '^3.0', ...require_ },
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

describe('what the attributes say', () => {
  test('composite keys, versions and second level cache on entities', async () => {
    const app = appWith('entity-attributes', {
      'src/Entity/OrderLine.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[Entity]',
        '#[ORM\\Entity]',
        '#[ORM\\Table(name: "order_line")]',
        '#[Cache(usage: "READ_ONLY")]',
        '#[ORM\\Cache(usage: "READ_ONLY", region: "lines")]',
        'class OrderLine',
        '{',
        '    #[Id]',
        '    #[ORM\\Id]',
        '    #[ORM\\ManyToOne(targetEntity: Order::class)]',
        '    private ?Order $order = null;',
        '',
        '    #[Id]',
        '    #[ORM\\Id]',
        '    #[Column(type: "integer")]',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $position = 0;',
        '',
        '    #[Version]',
        '    #[ORM\\Version]',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $version = 1;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Column(type: "datetime", options: ["default" => "CURRENT_TIMESTAMP"])]',
        '    #[Version]',
        '    private $lockVersion;',
        '}',
      ].join('\n') + '\n',
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        second_level_cache:',
        '            enabled: true',
        '            regions:',
        '                lines:',
        '                    lifetime: 600',
        '        query_cache_driver:',
        '            type: pool',
        '            pool: cache.doctrine.query',
        '        result_cache_driver:',
        '            type: pool',
        '            pool: cache.doctrine.result',
        '        metadata_cache_driver:',
        '            type: pool',
        '            pool: cache.doctrine.metadata',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('doctrine-composite-primary-keys.js', app),
      runModule('doctrine-entity-lock.js', app),
      runModule('doctrine-cache.js', app),
      runModule('doctrine-query-cache.js', app),
      runModule('doctrine-slc.js', app),
      runModule('doctrine-entity-graph.js', app, ['Order']),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('documents in MongoDB, with references and embedded ones', async () => {
    const app = appWith('odm', {
      'src/Document/Product.php': [
        '<?php',
        'namespace App\\Document;',
        '',
        'use Doctrine\\ODM\\MongoDB\\Mapping\\Annotations as MongoDB;',
        '',
        '#[Document]',
        '#[MongoDB\\Document(collection: "products")]',
        '#[MongoDB\\Index(keys: ["sku" => "asc"], options: ["unique" => true])]',
        'class Product',
        '{',
        '    #[MongoDB\\Id]',
        '    private ?string $id = null;',
        '',
        '    #[MongoDB\\Field(type: "string")]',
        '    private string $sku = "";',
        '',
        '    #[ReferenceMany(targetDocument: Variant::class)]',
        '    #[MongoDB\\ReferenceMany(targetDocument: Variant::class, cascade: ["persist"])]',
        '    private $variants;',
        '',
        '    #[ReferenceOne(targetDocument: Category::class)]',
        '    #[MongoDB\\ReferenceOne(targetDocument: Category::class)]',
        '    private $category;',
        '',
        '    #[EmbedMany(targetDocument: Attribute::class)]',
        '    #[MongoDB\\EmbedMany(targetDocument: Attribute::class)]',
        '    private $attributes;',
        '}',
      ].join('\n') + '\n',
      'src/Document/Attribute.php': [
        '<?php',
        'namespace App\\Document;',
        '',
        'use Doctrine\\ODM\\MongoDB\\Mapping\\Annotations as MongoDB;',
        '',
        '#[EmbeddedDocument]',
        '#[MongoDB\\EmbeddedDocument]',
        'class Attribute',
        '{',
        '    #[MongoDB\\Field(type: "string")]',
        '    private string $name = "";',
        '}',
      ].join('\n') + '\n',
      'src/Document/Upload.php': [
        '<?php',
        'namespace App\\Document;',
        '',
        'use Doctrine\\ODM\\MongoDB\\Mapping\\Annotations as MongoDB;',
        '',
        '#[File]',
        '#[MongoDB\\File(bucketName: "uploads")]',
        'class Upload',
        '{',
        '    #[MongoDB\\Id]',
        '    private ?string $id = null;',
        '}',
      ].join('\n') + '\n',
      'config/packages/doctrine_mongodb.yaml': [
        'doctrine_mongodb:',
        '    connections:',
        '        default:',
        '            server: "%env(MONGODB_URL)%"',
        '    default_database: acme',
        '    document_managers:',
        '        default:',
        '            auto_mapping: true',
        '            mappings:',
        '                App:',
        '                    type: attribute',
        '                    dir: "%kernel.project_dir%/src/Document"',
      ].join('\n') + '\n',
    }, { 'doctrine/mongodb-odm-bundle': '^4.7' });

    const text = await runModule('doctrine-odm-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('cache warmers, tagged and attributed', async () => {
    const app = appWith('warmers', {
      'src/Cache/RouterWarmer.php': [
        '<?php',
        'namespace App\\Cache;',
        '',
        'use Symfony\\Component\\DependencyInjection\\Attribute\\AsTaggedItem;',
        'use Symfony\\Component\\HttpKernel\\CacheWarmer\\CacheWarmerInterface;',
        '',
        '#[AsTaggedItem(index: "router", priority: 100)]',
        'class RouterWarmer implements CacheWarmerInterface',
        '{',
        '    public function isOptional(): bool { return false; }',
        '',
        '    public function warmUp(string $cacheDir, ?string $buildDir = null): array',
        '    {',
        '        return [];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Cache/TranslationWarmer.php': [
        '<?php',
        'namespace App\\Cache;',
        '',
        'use Symfony\\Component\\HttpKernel\\CacheWarmer\\CacheWarmerInterface;',
        '',
        'class TranslationWarmer implements CacheWarmerInterface',
        '{',
        '    public function isOptional(): bool { return true; }',
        '',
        '    public function warmUp(string $cacheDir, ?string $buildDir = null): array',
        '    {',
        '        return ["translations"];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    App\\Cache\\TranslationWarmer:',
        '        tags:',
        '            - { name: kernel.cache_warmer, priority: 10 }',
        '',
        '    App\\Cache\\RouterWarmer:',
        '        tags: [kernel.cache_warmer]',
      ].join('\n') + '\n',
    });

    const text = await runModule('cache-warmers.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Behat contexts with hooks before and after each scenario', async () => {
    const app = appWith('behat-contexts', {
      'behat.yaml': [
        'default:',
        '    suites:',
        '        default:',
        '            contexts:',
        '                - App\\Tests\\Behat\\FeatureContext',
        '                - App\\Tests\\Behat\\ApiContext',
      ].join('\n') + '\n',
      'features/bootstrap/FeatureContext.php': [
        '<?php',
        'namespace App\\Tests\\Behat;',
        '',
        'use Behat\\Behat\\Context\\Context;',
        'use Behat\\Behat\\Hook\\Scope\\AfterScenarioScope;',
        'use Behat\\Behat\\Hook\\Scope\\BeforeScenarioScope;',
        '',
        'class FeatureContext implements Context',
        '{',
        '    /**',
        '     * @BeforeScenario',
        '     */',
        '    public function reset(BeforeScenarioScope $scope): void { }',
        '',
        '    /**',
        '     * @AfterScenario @database',
        '     */',
        '    public function rollback(AfterScenarioScope $scope): void { }',
        '',
        '    /**',
        '     * @Given I am on the home page',
        '     */',
        '    public function onHomePage(): void { }',
        '}',
      ].join('\n') + '\n',
      'tests/Behat/ApiContext.php': [
        '<?php',
        'namespace App\\Tests\\Behat;',
        '',
        'use Behat\\Behat\\Context\\Context;',
        'use Behat\\Hook\\BeforeScenario;',
        'use Behat\\Step\\Given;',
        '',
        'class ApiContext implements Context',
        '{',
        '    #[BeforeScenario]',
        '    public function bootKernel(): void { }',
        '',
        '    #[Given("I send a GET request to :path")]',
        '    public function get(string $path): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'behat/behat': '^3.14' });

    const text = await runModule('behat-contexts.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('API Platform properties and state processors', async () => {
    const app = appWith('api-attributes', {
      'src/Entity/Book.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiProperty;',
        'use ApiPlatform\\Metadata\\ApiResource;',
        '',
        '#[ApiResource]',
        'class Book',
        '{',
        "    #[ApiProperty(identifier: true, description: 'The book identifier')]",
        '    public int $id = 0;',
        '',
        "    #[ApiProperty(openapiContext: ['type' => 'string', 'example' => '978-3-16-148410-0'])]",
        '    public string $isbn = "";',
        '',
        '    #[ApiProperty(writable: false, readable: true)]',
        '    public string $slug = "";',
        '',
        '    #[ApiProperty(security: "is_granted(\'ROLE_ADMIN\')")]',
        '    public string $internalNote = "";',
        '}',
      ].join('\n') + '\n',
      'src/State/BookProcessor.php': [
        '<?php',
        'namespace App\\State;',
        '',
        'use ApiPlatform\\Metadata\\Operation;',
        'use ApiPlatform\\State\\ProcessorInterface;',
        'use Symfony\\Component\\DependencyInjection\\Attribute\\AsDecorator;',
        '',
        '#[AsDecorator("api_platform.doctrine.orm.state.persist_processor")]',
        'final class BookProcessor implements ProcessorInterface',
        '{',
        '    public function __construct(private ProcessorInterface $inner) {}',
        '',
        '    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): mixed',
        '    {',
        '        return $this->inner->process($data, $operation, $uriVariables, $context);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/State/BookProvider.php': [
        '<?php',
        'namespace App\\State;',
        '',
        'use ApiPlatform\\Metadata\\Operation;',
        'use ApiPlatform\\State\\ProviderInterface;',
        '',
        'final class BookProvider implements ProviderInterface',
        '{',
        '    public function provide(Operation $operation, array $uriVariables = [], array $context = []): iterable',
        '    {',
        '        return [];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/api_platform.yaml': 'api_platform:\n    title: Acme\n    version: 1.0.0\n',
    }, { 'api-platform/core': '^3.2' });

    const results = await Promise.all([
      runModule('api-platform-openapi-context.js', app),
      runModule('api-platform-state.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('encrypted columns, in both spellings', async () => {
    const app = appWith('encryption', {
      'src/Entity/Patient.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use DoctrineEncryptBundle\\Configuration\\Encrypted;',
        '',
        '#[ORM\\Entity]',
        'class Patient',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[Encrypted]',
        '    #[ORM\\Column(type: "text")]',
        '    private string $medicalHistory = "";',
        '',
        '    /**',
        '     * @Encrypted',
        '     */',
        '    #[ORM\\Column(length: 32)]',
        '    private string $nationalId = "";',
        '',
        '    #[ORM\\Column(length: 180)]',
        '    private string $email = "";',
        '}',
      ].join('\n') + '\n',
      'config/packages/doctrine_encrypt.yaml': [
        'ambta_doctrine_encrypt:',
        '    encryptor_class: Halite',
        '    secret_directory_path: "%kernel.project_dir%/config/secrets"',
      ].join('\n') + '\n',
    }, { 'ambta/doctrine-encrypt-bundle': '^5.3' });

    const text = await runModule('doctrine-encryption.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
