// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications for the console, the scheduler, the built cache, the CLI
 * tooling and the front-end bundles.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-console-'));
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

describe('the console and what runs beside it', () => {
  test('commands with aliases, hidden ones, arguments and every option mode', async () => {
    const app = appWith('console', {
      'src/Command/ImportCommand.php': [
        '<?php',
        'namespace App\\Command;',
        '',
        'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
        'use Symfony\\Component\\Console\\Command\\Command;',
        'use Symfony\\Component\\Console\\Input\\InputArgument;',
        'use Symfony\\Component\\Console\\Input\\InputInterface;',
        'use Symfony\\Component\\Console\\Input\\InputOption;',
        'use Symfony\\Component\\Console\\Output\\OutputInterface;',
        '',
        '#[AsCommand(',
        '    name: "app:import",',
        '    description: "Imports the catalogue from a CSV export",',
        '    aliases: ["app:catalogue-import", "import"],',
        '    hidden: false,',
        ')]',
        'class ImportCommand extends Command',
        '{',
        '    protected function configure(): void',
        '    {',
        '        $this',
        '            ->setHelp("Reads the export and writes products")',
        '            ->addArgument("file", InputArgument::REQUIRED, "Path to the CSV export")',
        '            ->addArgument("locale", InputArgument::OPTIONAL, "Locale to import", "en")',
        '            ->addArgument("tags", InputArgument::IS_ARRAY, "Tags to apply")',
        '            ->addOption("dry-run", "d", InputOption::VALUE_NONE, "Do not write anything")',
        '            ->addOption("batch", "b", InputOption::VALUE_OPTIONAL, "Rows per batch", 500)',
        '            ->addOption("channel", "c", InputOption::VALUE_REQUIRED, "Sales channel")',
        '            ->addOption("skip", "s", InputOption::VALUE_IS_ARRAY | InputOption::VALUE_OPTIONAL, "Columns to skip");',
        '    }',
        '',
        '    protected function execute(InputInterface $input, OutputInterface $output): int',
        '    {',
        '        return Command::SUCCESS;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Command/MaintenanceCommand.php': [
        '<?php',
        'namespace App\\Command;',
        '',
        'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
        'use Symfony\\Component\\Console\\Command\\Command;',
        '',
        '#[AsCommand(name: "app:internal", description: "Internal maintenance", hidden: true)]',
        'class MaintenanceCommand extends Command',
        '{',
        '}',
      ].join('\n') + '\n',
      'src/Command/NamelessCommand.php': [
        '<?php',
        'namespace App\\Command;',
        '',
        'use Symfony\\Component\\Console\\Command\\Command;',
        '',
        'class NamelessCommand extends Command',
        '{',
        '    protected function configure(): void',
        '    {',
        '        $this->setName("app:nameless");',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Command/notaclass.php': '<?php\n\n// a file in the command directory with no class in it\nreturn [];\n',
    });

    const text = await runModule('commands.js', app, ['app:import', 'import', 'app:internal']);
    expect(text).toContain('app:import');
  });

  test('scheduled messages, by cron expression and by duration', async () => {
    const app = appWith('scheduler-cron', {
      'config/packages/scheduler.yaml': [
        'framework:',
        '    scheduler:',
        '        schedules:',
        '            default:',
        '                transport: scheduler_default',
      ].join('\n') + '\n',
      'src/Scheduler/CronSchedule.php': [
        '<?php',
        'namespace App\\Scheduler;',
        '',
        'use App\\Message\\Digest;',
        'use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;',
        'use Symfony\\Component\\Scheduler\\RecurringMessage;',
        'use Symfony\\Component\\Scheduler\\Schedule;',
        'use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;',
        '',
        '#[AsSchedule("default")]',
        'final class CronSchedule implements ScheduleProviderInterface',
        '{',
        '    public function getSchedule(): Schedule',
        '    {',
        '        return (new Schedule())',
        '            ->add(RecurringMessage::cron("*/5 * * * *", new Digest()))',
        '            ->add(RecurringMessage::cron("0 3 * * 1-5", new Digest()))',
        '            ->add(RecurringMessage::cron("0 0 1 * *", new Digest()))',
        '            ->add(RecurringMessage::cron("@daily", new Digest()))',
        '            ->add(RecurringMessage::cron("not a cron expression", new Digest()))',
        '            ->add(RecurringMessage::cron("99 99 99 99 99", new Digest()))',
        '            ->add(RecurringMessage::every("PT30S", new Digest()))',
        '            ->add(RecurringMessage::every("PT5M", new Digest()))',
        '            ->add(RecurringMessage::every("PT2H", new Digest()))',
        '            ->add(RecurringMessage::every("1 day", new Digest()))',
        '            ->add(RecurringMessage::every("30 seconds", new Digest()));',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Message/Digest.php': '<?php\n\nnamespace App\\Message;\n\nfinal class Digest\n{\n}\n',
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('cache pools named in the environment rather than in configuration', async () => {
    const files: Record<string, string> = {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        prefix_seed: acme/prod',
        '        pools:',
        '            app.cache.catalogue:',
        '                adapter: cache.adapter.redis',
        '                default_lifetime: 3600',
        '                tags: true',
        '            app.cache.namespaced:',
        '                adapter: cache.adapter.filesystem',
        '                namespace: catalogue',
        '            app.cache.broken: "not an object"',
      ].join('\n') + '\n',
      '.env': [
        'REDIS_URL=redis://redis:6379',
        'MEMCACHED_URL=memcached://memcached:11211',
      ].join('\n') + '\n',
    };
    for (let i = 0; i < 3; i++) {
      files[`var/cache/prod/pools/app/entry-${i}.php`] = `<?php\n\nreturn ["${'x'.repeat(1000)}"];\n`;
    }

    const text = await runModule('cache-inspector.js', appWith('cache-env', files), ['prod']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a project set up for the Symfony CLI and a platform', async () => {
    const app = appWith('symfony-cli', {
      '.symfony.local.yaml': [
        'http:',
        '    document_root: public',
        '    passthru: index.php',
        '    port: 8000',
        '    preferred_port: 8000',
        '    allow_http: true',
        '    no_tls: false',
        '',
        'workers:',
        '    messenger_consume_async:',
        '        cmd: ["symfony", "console", "messenger:consume", "async"]',
        '        watch: ["config", "src", "templates", "vendor"]',
        '    build_assets:',
        '        cmd: ["npm", "run", "watch"]',
        '',
        'proxy:',
        '    domains: [acme]',
      ].join('\n') + '\n',
      '.platform.app.yaml': [
        'name: app',
        'type: "php:8.3"',
        'build:',
        '    flavor: composer',
        'dependencies:',
        '    php:',
        '        composer/composer: "^2"',
        'web:',
        '    locations:',
        '        "/":',
        '            root: "public"',
        '            passthru: "/index.php"',
        'disk: 2048',
        'mounts:',
        '    "/var": { source: local, source_path: var }',
        'hooks:',
        '    build: |',
        '        set -x -e',
        '        composer install --no-dev',
        '    deploy: |',
        '        php bin/console cache:clear',
        'crons:',
        '    snapshot:',
        '        spec: "0 5 * * *"',
        '        cmd: croncape php bin/console app:import',
      ].join('\n') + '\n',
      '.platform/routes.yaml': [
        '"https://{default}/":',
        '    type: upstream',
        '    upstream: "app:http"',
        '"https://www.{default}/":',
        '    type: redirect',
        '    to: "https://{default}/"',
      ].join('\n') + '\n',
      '.platform/services.yaml': [
        'db:',
        '    type: postgresql:16',
        '    disk: 2048',
        'cache:',
        '    type: redis:7.0',
      ].join('\n') + '\n',
      'symfony.lock': JSON.stringify({
        'symfony/framework-bundle': { version: '7.0', recipe: { repo: 'github.com/symfony/recipes', ref: 'abc' } },
      }, null, 2) + '\n',
    });

    const text = await runModule('symfony-cli.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('translations shipped to the browser', async () => {
    const app = appWith('ux-translator', {
      'config/packages/ux_translator.yaml': [
        'ux_translator:',
        '    dump_path: "%kernel.project_dir%/var/translations"',
      ].join('\n') + '\n',
      'assets/translations/index.js': "export const localeFallbacks = { en: null, es: 'en' };\n",
      'assets/translations/configuration.js': "export default { locales: ['en', 'es'], defaultLocale: 'en' };\n",
      'assets/translations/messages.js': "export const cart_title = { id: 'cart.title', translations: { en: { message: 'Your cart' } } };\n",
      'assets/controllers/cart_controller.js': [
        "import { Controller } from '@hotwired/stimulus';",
        "import { trans, cart_title } from '../translations';",
        '',
        'export default class extends Controller {',
        '    connect() { this.element.textContent = trans(cart_title); }',
        '}',
      ].join('\n') + '\n',
      'translations/messages.en.yaml': 'cart.title: Your cart\ncart.empty: Nothing here\n',
      'translations/messages.es.yaml': 'cart.title: Tu cesta\n',
      'templates/cart.html.twig': '<div>{{ "cart.title"|trans }}</div>\n',
    }, { 'symfony/ux-translator': '^2.17' });

    const text = await runModule('symfony-ux-translator.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('an application served by NGINX Unit', async () => {
    const app = appWith('unit', {
      'docker/unit.json': JSON.stringify({
        listeners: {
          '*:8080': { pass: 'routes' },
        },
        routes: [
          { match: { uri: '~^/(?!index\\.php)' }, action: { share: '/var/www/html/public$uri', fallback: { pass: 'applications/symfony' } } },
        ],
        applications: {
          symfony: {
            type: 'php',
            root: '/var/www/html/public',
            script: 'index.php',
            processes: { max: 16, spare: 4, idle_timeout: 60 },
            limits: { timeout: 30, requests: 1000 },
            options: {
              admin: { memory_limit: '256M', 'opcache.enable': '1', 'display_errors': '0' },
            },
            user: 'www-data',
          },
        },
        access_log: '/dev/stdout',
      }, null, 2) + '\n',
      'docker-compose.yml': [
        'services:',
        '    app:',
        '        image: unit:1.32.1-php8.3',
        '        volumes:',
        '            - ./docker/unit.json:/docker-entrypoint.d/unit.json:ro',
        '        ports:',
        '            - "8080:8080"',
      ].join('\n') + '\n',
    });

    const text = await runModule('nginx-unit-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('tests that stand in for their collaborators', async () => {
    const app = appWith('self-shunting', {
      'tests/Unit/ImporterTest.php': [
        '<?php',
        'namespace App\\Tests\\Unit;',
        '',
        'use App\\Service\\ImporterInterface;',
        'use PHPUnit\\Framework\\TestCase;',
        '',
        'class ImporterTest extends TestCase implements ImporterInterface',
        '{',
        '    private array $calls = [];',
        '',
        '    public function import(string $file): void',
        '    {',
        '        $this->calls[] = $file;',
        '    }',
        '',
        '    public function testItRecordsTheCall(): void',
        '    {',
        '        $this->import("catalogue.csv");',
        '        $this->assertSame(["catalogue.csv"], $this->calls);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'tests/Unit/MailerTest.php': [
        '<?php',
        'namespace App\\Tests\\Unit;',
        '',
        'use PHPUnit\\Framework\\TestCase;',
        'use Symfony\\Component\\Mailer\\MailerInterface;',
        'use Symfony\\Component\\Mime\\RawMessage;',
        '',
        'final class MailerTest extends TestCase',
        '{',
        '    public function testItSendsWithADouble(): void',
        '    {',
        '        $mailer = new class implements MailerInterface {',
        '            public array $sent = [];',
        '            public function send(RawMessage $message, $envelope = null): void',
        '            {',
        '                $this->sent[] = $message;',
        '            }',
        '        };',
        '',
        '        $mailer->send(new RawMessage("hello"));',
        '        $this->assertCount(1, $mailer->sent);',
        '    }',
        '',
        '    public function testItUsesAMock(): void',
        '    {',
        '        $mock = $this->createMock(MailerInterface::class);',
        '        $mock->expects($this->once())->method("send");',
        '        $mock->send(new RawMessage("hi"));',
        '    }',
        '}',
      ].join('\n') + '\n',
      'phpunit.xml.dist': '<?xml version="1.0"?>\n<phpunit bootstrap="tests/bootstrap.php"><testsuites><testsuite name="unit"><directory>tests</directory></testsuite></testsuites></phpunit>\n',
    }, { 'phpunit/phpunit': '^11.0' });

    const text = await runModule('phpunit-self-shunting.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('embeddables used twice, and one nobody uses', async () => {
    const app = appWith('embeddable', {
      'src/Entity/Address.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Embeddable]',
        'class Address',
        '{',
        '    #[ORM\\Column(length: 255)]',
        '    private string $street = "";',
        '',
        '    #[ORM\\Column(length: 32)]',
        '    private string $postalCode = "";',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Money.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Embeddable]',
        'class Money',
        '{',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $amount = 0;',
        '',
        '    #[ORM\\Column(length: 3)]',
        '    private string $currency = "EUR";',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Unused.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Embeddable]',
        'class Unused',
        '{',
        '    #[ORM\\Column]',
        '    private ?int $value = null;',
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
        '    #[ORM\\Embedded(class: Address::class, columnPrefix: "billing_")]',
        '    private Address $billingAddress;',
        '',
        '    #[ORM\\Embedded(class: Address::class, columnPrefix: false)]',
        '    private Address $shippingAddress;',
        '',
        '    #[ORM\\Embedded(class: Money::class)]',
        '    private Money $credit;',
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
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Embedded(class: Money::class, columnPrefix: "total_")]',
        '    private Money $total;',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('doctrine-embeddable.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('API Platform operations written as their own attributes', async () => {
    const app = appWith('api-operations', {
      'src/Entity/Article.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiResource;',
        'use ApiPlatform\\Metadata\\Delete;',
        'use ApiPlatform\\Metadata\\Get;',
        'use ApiPlatform\\Metadata\\GetCollection;',
        'use ApiPlatform\\Metadata\\Patch;',
        'use ApiPlatform\\Metadata\\Post;',
        '',
        '#[ApiResource]',
        "#[GetCollection(uriTemplate: '/articles', path: '/articles', normalizationContext: ['groups' => ['article:list']])]",
        "#[Get(path: '/articles/{id}', name: 'article_get', normalizationContext: ['groups' => ['article:read', 'article:detail']], security: \"is_granted('ROLE_USER')\")]",
        "#[Post(path: '/articles', denormalizationContext: ['groups' => ['article:write']], security: \"is_granted('ROLE_EDITOR')\")]",
        "#[Patch(path: '/articles/{id}', denormalizationContext: ['groups' => ['article:write']])]",
        "#[Delete(path: '/articles/{id}', security: \"is_granted('ROLE_ADMIN')\")]",
        'class Article',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Comment.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use ApiPlatform\\Metadata\\ApiFilter;',
        'use ApiPlatform\\Metadata\\ApiResource;',
        'use ApiPlatform\\Doctrine\\Orm\\Filter\\OrderFilter;',
        'use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;',
        'use ApiPlatform\\Doctrine\\Orm\\Filter\\DateFilter;',
        '',
        "#[ApiResource(normalizationContext: ['groups' => ['comment:read']], denormalizationContext: ['groups' => ['comment:write']])]",
        "#[ApiFilter(SearchFilter::class, properties: ['body' => 'partial', 'author' => 'exact'])]",
        "#[ApiFilter(OrderFilter::class, properties: ['createdAt' => 'DESC'], arguments: ['orderParameterName' => 'order'])]",
        '#[ApiFilter(DateFilter::class, properties: [\'createdAt\'])]',
        'class Comment',
        '{',
        '    public int $id = 0;',
        '}',
      ].join('\n') + '\n',
      'config/packages/api_platform.yaml': [
        'api_platform:',
        '    title: Acme',
        '    version: 1.0.0',
        '    defaults:',
        "        normalization_context: { groups: ['default:read'] }",
        "        denormalization_context: { groups: ['default:write'] }",
      ].join('\n') + '\n',
    }, { 'api-platform/core': '^3.2' });

    const text = await runModule('api-platform.js', app, ['Article', 'article:read']);
    expect(text).toContain('Article');
  });
});
