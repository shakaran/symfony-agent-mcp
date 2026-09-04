// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The conditions each remaining report is waiting for.
 *
 * A memory adapter that is not first in the chain, a dead-letter transport
 * nothing routes to, transports at both ends of the priority range, an
 * example environment file with a key the local one lacks, Assert\Valid on
 * a scalar and on a collection. Each of these is one branch, and each
 * branch is a function of its own.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-conditions-'));
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

describe('the condition each report waits for', () => {
  test('a chain whose memory adapter is not first, wrapped in a tag-aware one', async () => {
    const app = appWith('chain-order', {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        pools:',
        '            app.cache.badorder:',
        '                adapter: cache.adapter.chain',
        '                providers:',
        '                    - cache.adapter.filesystem',
        '                    - cache.adapter.redis',
        '                    - cache.adapter.array',
        '            app.cache.deep:',
        '                adapter: cache.adapter.chain',
        '                providers:',
        '                    - cache.adapter.filesystem',
        '                    - cache.adapter.redis',
        '                    - cache.adapter.memcached',
        '                    - cache.adapter.pdo',
        '            app.cache.tagwrapped:',
        '                adapter: cache.adapter.redis_tag_aware',
        '                provider: cache.adapter.filesystem',
        '                tags: true',
        '            app.cache.empty_chain:',
        '                adapter: cache.adapter.chain',
      ].join('\n') + '\n',
      'src/Cache/Wrapped.php': [
        '<?php',
        'namespace App\\Cache;',
        '',
        'use Symfony\\Component\\Cache\\Adapter\\ChainAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\FilesystemAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\ArrayAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter;',
        '',
        'class Wrapped',
        '{',
        '    public function build(): TagAwareAdapter',
        '    {',
        '        return new TagAwareAdapter(new ChainAdapter([',
        '            new FilesystemAdapter("acme", 3600),',
        '            new ArrayAdapter(30),',
        '        ]));',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-cache-chain.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('transports at both ends of the priority range, and a dead letter nobody uses', async () => {
    const app = appWith('messenger-ends', {
      'config/packages/messenger.yaml': [
        'framework:',
        '    messenger:',
        '        transports:',
        '            async_critical:',
        '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/critical"',
        '                options:',
        '                    priority: 20',
        '                retry_strategy:',
        '                    max_retries: 25',
        '            async_low:',
        '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/low"',
        '                options:',
        '                    priority: 1',
        '            async_lowest:',
        '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/lowest"',
        '                options:',
        '                    priority: 0',
        '            async_high:',
        '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/high"',
        '                options:',
        '                    priority: 15',
        '            failed_orphan:',
        '                dsn: "doctrine://default?queue_name=failed_orphan"',
        '            failed_second_orphan:',
        '                dsn: "doctrine://default?queue_name=failed_second"',
      ].join('\n') + '\n',
      'docker/supervisor/worker.conf': [
        '[program:messenger]',
        'command=php bin/console messenger:consume async_critical async_low --time-limit=3600',
        'numprocs=2',
      ].join('\n') + '\n',
    }, { 'symfony/messenger': '^7.0' });

    const results = await Promise.all([
      runModule('symfony-messenger-priority.js', app),
      runModule('symfony-messenger-failures.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('an example environment file with keys the local one has not', async () => {
    const app = appWith('env-example', {
      '.env': 'APP_ENV=prod\nAPP_SECRET=0123456789abcdef\n',
      '.env.example': [
        'APP_ENV=prod',
        'APP_SECRET=',
        'DATABASE_URL=',
        'MAILER_DSN=',
        'REDIS_URL=',
        'SENTRY_DSN=',
      ].join('\n') + '\n',
      '.env.local': [
        'APP_ENV=dev',
        'APP_SECRET=localsecret',
        'DATABASE_URL=postgresql://acme:hunter2@127.0.0.1:5432/acme',
      ].join('\n') + '\n',
      'config/packages/framework.yaml': 'framework:\n    secret: "%env(APP_SECRET)%"\n',
      'src/Kernel.php': '<?php\n\nnamespace App;\n\nuse Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;\nuse Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;\n\nclass Kernel extends BaseKernel\n{\n    use MicroKernelTrait;\n}\n',
    });

    const text = await runModule('symfony-enlighten-analysis.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Assert\\Valid on a scalar and on a collection', async () => {
    const app = appWith('validator-cascade', {
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\Common\\Collections\\Collection;',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Validator\\Constraints as Assert;',
        '',
        '#[ORM\\Entity]',
        'class Order',
        '{',
        '    #[Assert\\Valid]',
        '    #[ORM\\Column(type: "string", length: 64)]',
        '    private string $reference = "";',
        '',
        '    #[Assert\\Valid]',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $quantity = 0;',
        '',
        '    #[Assert\\Valid]',
        '    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: "order")]',
        '    private Collection $lines;',
        '',
        '    #[Assert\\Valid]',
        '    #[ORM\\ManyToOne(targetEntity: Customer::class)]',
        '    private ?Customer $customer = null;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Line.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Line\n{\n}\n',
      'src/Entity/Customer.php': '<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Customer\n{\n}\n',
    }, { 'doctrine/orm': '^3.0', 'symfony/validator': '^7.0' });

    const text = await runModule('symfony-validator-cascade.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('two custom platforms and two custom types, one busier than the other', async () => {
    const app = appWith('custom-platform', {
      'src/Doctrine/Platform/FirstPlatform.php': [
        '<?php',
        'namespace App\\Doctrine\\Platform;',
        '',
        'use Doctrine\\DBAL\\Platforms\\PostgreSQLPlatform;',
        '',
        'class FirstPlatform extends PostgreSQLPlatform',
        '{',
        '    public function getName(): string { return "first"; }',
        '    public function getVarcharTypeDeclarationSQL(array $column): string { return "CITEXT"; }',
        '    public function getClobTypeDeclarationSQL(array $column): string { return "TEXT"; }',
        '    public function getBooleanTypeDeclarationSQL(array $column): string { return "BOOLEAN"; }',
        '    protected function initializeDoctrineTypeMappings(): void { parent::initializeDoctrineTypeMappings(); }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Platform/SecondPlatform.php': [
        '<?php',
        'namespace App\\Doctrine\\Platform;',
        '',
        'use Doctrine\\DBAL\\Platforms\\MySQLPlatform;',
        '',
        'class SecondPlatform extends MySQLPlatform',
        '{',
        '    public function getName(): string { return "second"; }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Type/FirstType.php': [
        '<?php',
        'namespace App\\Doctrine\\Type;',
        '',
        'use Doctrine\\DBAL\\Platforms\\AbstractPlatform;',
        'use Doctrine\\DBAL\\Types\\Type;',
        '',
        'class FirstType extends Type',
        '{',
        '    public const NAME = "first";',
        '',
        '    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string { return "TEXT"; }',
        '    public function convertToPHPValue($value, AbstractPlatform $platform) { return $value; }',
        '    public function convertToDatabaseValue($value, AbstractPlatform $platform) { return $value; }',
        '    public function requiresSQLCommentHint(AbstractPlatform $platform): bool { return true; }',
        '    public function getName(): string { return self::NAME; }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Type/SecondType.php': [
        '<?php',
        'namespace App\\Doctrine\\Type;',
        '',
        'use Doctrine\\DBAL\\Platforms\\AbstractPlatform;',
        'use Doctrine\\DBAL\\Types\\Type;',
        '',
        'class SecondType extends Type',
        '{',
        '    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string { return "INT"; }',
        '    public function getName(): string { return "second"; }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/Registrar.php': [
        '<?php',
        'namespace App\\Doctrine;',
        '',
        'use Doctrine\\DBAL\\Types\\Type;',
        '',
        'class Registrar',
        '{',
        '    public function register(): void',
        '    {',
        '        Type::addType("first", \\App\\Doctrine\\Type\\FirstType::class);',
        '        Type::overrideType("datetime", \\App\\Doctrine\\Type\\SecondType::class);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    dbal:',
        '        types:',
        '            first: App\\Doctrine\\Type\\FirstType',
        '            second: App\\Doctrine\\Type\\SecondType',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-custom-platform.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a compose file the inspector reads, with two services and a vendor volume', async () => {
    const app = appWith('compose', {
      'compose.yaml': [
        'services:',
        '  app:',
        '    image: acme/app:1.4.0',
        '    environment:',
        '      APP_ENV: prod',
        '      APP_SECRET: 0123456789abcdef0123456789abcdef',
        '      DATABASE_PASSWORD: hunter2',
        '    volumes:',
        '      - ./:/var/www/html',
        '      - ./vendor:/var/www/html/vendor',
        '    ports:',
        '      - "8080:8080"',
        '  worker:',
        '    image: acme/app:1.4.0',
        '    environment:',
        '      REDIS_PASSWORD: hunter2',
        '    volumes:',
        '      - ./vendor:/var/www/html/vendor',
      ].join('\n') + '\n',
      'docker-compose.yaml': [
        'services:',
        '  app:',
        '    image: acme/app:1.4.0',
        '    environment:',
        '      MAILER_DSN: "smtp://acme:hunter2@smtp.example.com:25"',
        '      APP_ENV: prod',
        '    volumes:',
        '      - ./vendor:/var/www/html/vendor',
        '      - ./var:/var/www/html/var',
        '  db:',
        '    image: postgres:16',
        '    environment:',
        '      POSTGRES_PASSWORD: hunter2',
      ].join('\n') + '\n',
      'Dockerfile': 'FROM php:8.3-fpm\nWORKDIR /var/www/html\nCOPY . .\nUSER www-data\n',
    });

    const text = await runModule('docker-inspector.js', app, ['app', 'worker']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a form whose fields match its entity, and two of the same type', async () => {
    const app = appWith('forms-matching', {
      'src/Entity/Product.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Product',
        '{',
        '    #[ORM\\Column(length: 64)]',
        '    private string $sku = "";',
        '',
        '    #[ORM\\Column(length: 255)]',
        '    private string $name = "";',
        '',
        '    #[ORM\\Column(type: "text")]',
        '    private string $description = "";',
        '',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $stock = 0;',
        '}',
      ].join('\n') + '\n',
      'src/Form/ProductType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use App\\Entity\\Product;',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\IntegerType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextareaType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
        '',
        'class ProductType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder',
        '            ->add("sku", TextType::class, ["label" => "SKU", "required" => true, "help" => "Stock keeping unit"])',
        '            ->add("name", TextType::class, ["label" => "Name", "required" => true])',
        '            ->add("description", TextareaType::class, ["required" => false, "attr" => ["rows" => 5]])',
        '            ->add("stock", IntegerType::class, ["required" => true, "attr" => ["min" => 0]]);',
        '    }',
        '',
        '    public function configureOptions(OptionsResolver $resolver): void',
        '    {',
        '        $resolver->setDefaults(["data_class" => Product::class]);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Form/SearchType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        '',
        'class SearchType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder',
        '            ->add("term", TextType::class, ["required" => false])',
        '            ->add("category", TextType::class, ["required" => false])',
        '            ->add("brand", TextType::class);',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('forms.js', app, ['ProductType', 'SearchType']);
    expect(text.length).toBeGreaterThan(0);
  });
});
