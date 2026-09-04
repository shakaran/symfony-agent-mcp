// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The reports that only run once there is something to report.
 *
 * A line like `text += list.map(...)` is a function of its own, and it is
 * reached only when the list has something in it. These applications give
 * each of those lists an entry: log files with every level, a form with
 * options and matching fields, an ini file with the settings the analyser
 * comments on, notifier channels written as a list, an env processor
 * nothing uses.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-callbacks-'));
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

async function runModule(name: string, appPath: string, argsets: unknown[][] = []): Promise<string> {
  const mod = await import(path.resolve(__dirname, '../tools', name.replace(/\.js$/, ''))) as Record<string, unknown>;
  const texts: string[] = [];

  for (const [, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const calls = fn.length === 1 ? [[appPath]] : (argsets.length > 0 ? argsets.map((a) => [appPath, ...a]) : [[appPath, '', '']]);
    for (const args of calls) {
      const returned = await Promise.resolve(fn(...args.slice(0, Math.max(fn.length, 1))));
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

describe('reports that need something to report', () => {
  test('log files with every level in them', async () => {
    const lines = [
      '[2026-08-01T10:00:01+00:00] request.INFO: Matched route "app_home" {"route":"app_home"} []',
      '[2026-08-01T10:00:02+00:00] security.NOTICE: User logged in {"user":"buyer@example.com","password":"hunter2"} []',
      '[2026-08-01T10:00:03+00:00] doctrine.WARNING: Slow query 1.4s {"sql":"SELECT 1"} []',
      '[2026-08-01T10:00:04+00:00] request.ERROR: Uncaught exception {"exception":"RuntimeException"} []',
      '[2026-08-01T10:00:05+00:00] php.CRITICAL: Allowed memory exhausted {"file":"Kernel.php"} []',
      '[2026-08-01T10:00:06+00:00] app.DEBUG: token=0123456789abcdef0123456789abcdef []',
    ].join('\n') + '\n';

    const app = appWith('logs', {
      'var/log/prod.log': lines,
      'var/log/dev.log': lines + lines,
      'var/log/test.log': lines,
    });

    const text = await runModule('logs.js', app, [
      ['prod'],
      ['prod.log', 20],
      ['prod.log', 'ERROR'],
      ['dev.log'],
    ]);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a form with options, matching fields and repeated types', async () => {
    const app = appWith('forms', {
      'src/Form/OrderType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use App\\Entity\\Order;',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\CheckboxType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\ChoiceType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
        '',
        'class OrderType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder',
        '            ->add("reference", TextType::class, ["required" => true, "label" => "Reference", "help" => "Order reference", "trim" => true])',
        '            ->add("customerName", TextType::class, ["required" => false, "empty_data" => ""])',
        '            ->add("status", ChoiceType::class, ["choices" => ["Open" => 1, "Closed" => 2], "expanded" => true, "multiple" => false])',
        '            ->add("gift", CheckboxType::class, ["required" => false])',
        '            ->add("notes", TextType::class, ["required" => false]);',
        '    }',
        '',
        '    public function configureOptions(OptionsResolver $resolver): void',
        '    {',
        '        $resolver->setDefaults(["data_class" => Order::class, "csrf_protection" => true]);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Form/CustomerType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use App\\Entity\\Customer;',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
        '',
        'class CustomerType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder',
        '            ->add("reference", TextType::class, ["required" => true])',
        '            ->add("customerName", TextType::class)',
        '            ->add("email", TextType::class, ["label" => "Email"]);',
        '    }',
        '',
        '    public function configureOptions(OptionsResolver $resolver): void',
        '    {',
        '        $resolver->setDefaults(["data_class" => Customer::class]);',
        '    }',
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
        '    #[ORM\\Column(length: 64)]',
        '    private string $reference = "";',
        '',
        '    #[ORM\\Column(length: 255)]',
        '    private string $customerName = "";',
        '',
        '    #[ORM\\Column(type: "integer")]',
        '    private int $status = 1;',
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
        '    #[ORM\\Column(length: 64)]',
        '    private string $reference = "";',
        '',
        '    #[ORM\\Column(length: 255)]',
        '    private string $customerName = "";',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('forms.js', app, [['OrderType'], ['CustomerType']]);
    expect(text.length).toBeGreaterThan(0);
  });

  test('an ini file with the settings the analysers comment on', async () => {
    const app = appWith('php-ini', {
      'php.ini': [
        '[PHP]',
        'max_execution_time = 0',
        'memory_limit = -1',
        'display_errors = On',
        'log_errors = Off',
        'expose_php = On',
        'post_max_size = 128M',
        'upload_max_filesize = 128M',
        'session.gc_maxlifetime = 864000',
        'session.cookie_httponly = 0',
        'session.cookie_secure = 0',
        'session.use_strict_mode = 0',
        'allow_url_fopen = On',
        'allow_url_include = On',
        'date.timezone = UTC',
        '',
        '[xdebug]',
        'xdebug.mode = debug,develop,coverage',
        'xdebug.start_with_request = yes',
        'xdebug.client_host = 0.0.0.0',
        'xdebug.client_port = 9003',
        'xdebug.log = /var/log/xdebug.log',
        'xdebug.max_nesting_level = 512',
        'xdebug.idekey = PHPSTORM',
      ].join('\n') + '\n',
      'docker/php.ini': [
        '[PHP]',
        'max_execution_time = 30',
        'log_errors = On',
        'session.gc_maxlifetime = 1440',
        '',
        '[xdebug]',
        'xdebug.mode = off',
        'xdebug.start_with_request = trigger',
        'xdebug.client_host = host.docker.internal',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('php-ini-analysis.js', app),
      runModule('php-xdebug-config.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('notifier channels written as a list, and a policy naming one that is not there', async () => {
    const app = appWith('notifier-channels', {
      'config/packages/notifier.yaml': [
        'framework:',
        '    notifier:',
        '        chat_transports:',
        '            - "slack://TOKEN0123456789@default?channel=alerts"',
        '            - "telegram://0123456789:AAAAaaaa@default?channel=@acme"',
        '        sms_transports:',
        '            twilio: "twilio://SID:TOKEN@default?from=%2B34600000000"',
        '            vonage: "vonage://KEY:SECRET@default?from=Acme"',
        '        email_transports:',
        '            - "smtp://acme:hunter2@smtp.example.com:25"',
        '        push_transports:',
        '            expo: "expo://TOKEN@default"',
        '        channel_policy:',
        '            urgent: ["chat/slack", "sms/twilio", "chat/missing"]',
        '            high: ["email", "push/expo"]',
        '            low: ["chat/nowhere"]',
      ].join('\n') + '\n',
    }, { 'symfony/notifier': '^7.0' });

    const text = await runModule('symfony-notifier-channels.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a custom env processor nothing uses, beside the ones that are used', async () => {
    const app = appWith('env-processors', {
      'config/packages/framework.yaml': [
        'framework:',
        '    secret: "%env(APP_SECRET)%"',
        '    trusted_proxies: "%env(TRUSTED_PROXIES)%"',
        '',
        'parameters:',
        '    app.debug: "%env(bool:APP_DEBUG)%"',
        '    app.workers: "%env(int:WORKERS)%"',
        '    app.rate: "%env(float:RATE)%"',
        '    app.locales: "%env(csv:LOCALES)%"',
        '    app.dsn: "%env(resolve:DATABASE_URL)%"',
        '    app.json: "%env(json:FEATURE_MAP)%"',
        '    app.chained: "%env(base64:trim:SIGNING_KEY)%"',
        '    app.file: "%env(file:SECRET_FILE)%"',
        '    app.required: "%env(require:MANDATORY)%"',
      ].join('\n') + '\n',
      'src/Env/UppercaseEnvProcessor.php': [
        '<?php',
        'namespace App\\Env;',
        '',
        'use Symfony\\Component\\DependencyInjection\\EnvVarProcessorInterface;',
        '',
        'class UppercaseEnvProcessor implements EnvVarProcessorInterface',
        '{',
        '    public function getEnv(string $prefix, string $name, \\Closure $getEnv): mixed',
        '    {',
        '        return strtoupper((string) $getEnv($name));',
        '    }',
        '',
        '    public static function getProvidedTypes(): array',
        '    {',
        '        return ["uppercase" => "string", "nobodyuses" => "string"];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    App\\Env\\UppercaseEnvProcessor:',
        '        tags: [container.env_var_processor]',
        '',
        '    App\\Service\\HeavyOne:',
        '        lazy: true',
        '',
        '    App\\Service\\HeavyTwo:',
        '        lazy: true',
        '',
        '    App\\Service\\Plain: ~',
      ].join('\n') + '\n',
      'src/Service/HeavyOne.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'final class HeavyOne',
        '{',
        '    public function __construct(private string $a, private string $b) {}',
        '}',
      ].join('\n') + '\n',
      'src/Service/HeavyTwo.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class HeavyTwo implements HeavyInterface',
        '{',
        '    public function run(): void { }',
        '}',
      ].join('\n') + '\n',
      'src/Service/HeavyInterface.php': '<?php\n\nnamespace App\\Service;\n\ninterface HeavyInterface\n{\n    public function run(): void;\n}\n',
      'src/Service/Plain.php': '<?php\n\nnamespace App\\Service;\n\nclass Plain\n{\n}\n',
    });

    const results = await Promise.all([
      runModule('symfony-env-processors.js', app),
      runModule('symfony-lazy-services.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a compose file with values to mask and a vendor volume', async () => {
    const app = appWith('docker', {
      'docker-compose.yml': [
        'services:',
        '    app:',
        '        image: acme/app:1.4.0',
        '        environment:',
        '            APP_ENV: prod',
        '            APP_SECRET: 0123456789abcdef0123456789abcdef',
        '            DATABASE_PASSWORD: hunter2',
        '            MAILER_DSN: "smtp://acme:hunter2@smtp.example.com:25"',
        '        volumes:',
        '            - ./:/var/www/html',
        '            - ./vendor:/var/www/html/vendor',
        '        depends_on:',
        '            - db',
        '        ports:',
        '            - "8080:8080"',
        '    worker:',
        '        image: acme/app:1.4.0',
        '        command: bin/console messenger:consume async',
        '        environment:',
        '            REDIS_PASSWORD: hunter2',
        '            APP_ENV: prod',
        '        volumes:',
        '            - ./vendor:/var/www/html/vendor',
        '    db:',
        '        image: postgres:16',
        '        environment:',
        '            POSTGRES_PASSWORD: hunter2',
        '        volumes:',
        '            - db-data:/var/lib/postgresql/data',
        '',
        'volumes:',
        '    db-data:',
      ].join('\n') + '\n',
      'Dockerfile': [
        'FROM php:8.3-fpm AS base',
        'RUN docker-php-ext-install pdo_pgsql opcache',
        'COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer',
        'WORKDIR /var/www/html',
        'COPY . .',
        'USER www-data',
      ].join('\n') + '\n',
    });

    const text = await runModule('docker-inspector.js', app, [['app'], ['worker']]);
    expect(text.length).toBeGreaterThan(0);
  });

  test('cache headers, trusted headers and actions that must not be stored', async () => {
    const app = appWith('http-cache', {
      'config/packages/framework.yaml': [
        'framework:',
        '    trusted_proxies: "192.168.0.0/16,10.0.0.0/8"',
        '    trusted_headers: "x-forwarded-for, x-forwarded-proto, x-forwarded-host"',
        '    http_cache:',
        '        enabled: true',
        '        debug: false',
        '        default_ttl: 3600',
        '        private_headers: ["Authorization", "Cookie"]',
        '        allow_reload: true',
      ].join('\n') + '\n',
      'src/Controller/CachedController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        'use Symfony\\Component\\HttpKernel\\Attribute\\Cache;',
        'use Symfony\\Component\\Routing\\Attribute\\Route;',
        '',
        'class CachedController extends AbstractController',
        '{',
        '    #[Route("/catalogue")]',
        '    #[Cache(public: true, maxage: 3600, smaxage: 7200, mustRevalidate: true)]',
        '    public function catalogue(): Response { return new Response("ok"); }',
        '',
        '    #[Route("/account")]',
        '    #[Cache(public: false, maxage: 0)]',
        '    public function account(): Response',
        '    {',
        '        $response = new Response("private");',
        '        $response->headers->set("Cache-Control", "no-store, no-cache, must-revalidate, private");',
        '',
        '        return $response;',
        '    }',
        '',
        '    #[Route("/invoices")]',
        '    public function invoices(): Response',
        '    {',
        '        $response = new Response("private");',
        '        $response->headers->set("Cache-Control", "no-store");',
        '',
        '        return $response;',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('http-cache.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
