// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A tenth batch: the vocabulary that guards the most branches.
 *
 * Counting the checks that stand in front of statements the suite never
 * reaches puts framework namespaces first by a distance — a hundred and
 * fifty of them ask whether a file declares "namespace Symfony\", which an
 * application that only holds App\ classes never answers yes to. The rest
 * of this file is the same exercise for the next fifty or so: cache
 * adapters, System V IPC, worker commands, locale routes, hydrators and
 * the third-party services the integration modules look for.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Code living in a framework namespace, as a bundle developed in-tree does. */
function frameworkNamespaces(root: string): void {
  put(root, 'src/Bundle/AcmeBundle/DependencyInjection/AcmeBundleExtension.php', [
    '<?php',
    '',
    'namespace Symfony\\Bundle\\AcmeBundle\\DependencyInjection;',
    '',
    'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\Extension;',
    '',
    'class AcmeBundleExtension extends Extension',
    '{',
    '    public function load(array $configs, ContainerBuilder $container): void',
    '    {',
    '        $container->setParameter("acme_bundle.enabled", true);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Bundle/AcmeBundle/EventListener/BundleListener.php', [
    '<?php',
    '',
    'namespace Symfony\\Bundle\\AcmeBundle\\EventListener;',
    '',
    'use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;',
    '',
    'class BundleListener',
    '{',
    '    public function onKernelRequest(RequestEvent $event): void',
    '    {',
    '        if (!$event->isMainRequest()) { return; }',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/Vendored/AcmeHydrator.php', [
    '<?php',
    '',
    'namespace Doctrine\\ORM\\Internal\\Hydration\\Acme;',
    '',
    'use Doctrine\\ORM\\Internal\\Hydration\\AbstractHydrator;',
    '',
    'class AcmeHydrator extends AbstractHydrator',
    '{',
    '    protected function hydrateAllData(): array',
    '    {',
    '        $rows = [];',
    '        while ($row = $this->statement()->fetchAssociative()) {',
    '            $this->hydrateRowData($row, $rows);',
    '        }',
    '',
    '        return $rows;',
    '    }',
    '',
    '    protected function hydrateRowData(array $row, array &$result): void',
    '    {',
    '        $result[] = $row;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/ApiResource/Vendored/AcmeStateProvider.php', [
    '<?php',
    '',
    'namespace ApiPlatform\\State\\Acme;',
    '',
    'use ApiPlatform\\Metadata\\Operation;',
    'use ApiPlatform\\State\\ProviderInterface;',
    'use ApiPlatform\\State\\Pagination\\PaginatorInterface;',
    '',
    'final class AcmeStateProvider implements ProviderInterface',
    '{',
    '    public function provide(Operation $operation, array $uriVariables = [], array $context = []): iterable',
    '    {',
    '        return [];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Tests/Vendored/AcmeTestCase.php', [
    '<?php',
    '',
    'namespace PHPUnit\\Framework\\Acme;',
    '',
    'use PHPUnit\\Framework\\TestCase;',
    '',
    'abstract class AcmeTestCase extends TestCase',
    '{',
    '    protected function setUp(): void',
    '    {',
    '        parent::setUp();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Monolog/Vendored/AcmeProcessor.php', [
    '<?php',
    '',
    'namespace Monolog\\Processor\\Acme;',
    '',
    'class AcmeProcessor',
    '{',
    '    public function __invoke(array $record): array',
    '    {',
    '        $record["extra"]["acme"] = true;',
    '',
    '        return $record;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Twig/Vendored/AcmeExtension.php', [
    '<?php',
    '',
    'namespace Twig\\Extension\\Acme;',
    '',
    'use Twig\\Extension\\AbstractExtension;',
    'use Twig\\TwigFilter;',
    '',
    'class AcmeExtension extends AbstractExtension',
    '{',
    '    public function getFilters(): array',
    '    {',
    '        return [new TwigFilter("acme", static fn (string $v): string => $v)];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Cache adapters, IPC, workers, locales and file handling. */
function systemVocabulary(root: string): void {
  put(root, 'config/packages/cache_adapters.yaml', [
    'framework:',
    '    cache:',
    '        prefix_seed: acme',
    '        default_redis_provider: "redis://localhost:6379"',
    '        default_memcached_provider: "memcached://127.0.0.1:11211"',
    '        pools:',
    '            app.cache.redis:',
    '                adapter: cache.adapter.redis',
    '            app.cache.apcu:',
    '                adapter: cache.adapter.apcu',
    '            app.cache.memcached:',
    '                adapter: cache.adapter.memcached',
    '            app.cache.filesystem:',
    '                adapter: cache.adapter.filesystem',
    '            app.cache.array:',
    '                adapter: cache.adapter.array',
    '            app.cache.pdo:',
    '                adapter: cache.adapter.pdo',
    '',
    'services:',
    '    app.redis.sentinel:',
    '        class: Redis',
    '        factory: ["Symfony\\\\Component\\\\Cache\\\\Adapter\\\\RedisAdapter", createConnection]',
    '        arguments:',
    '            - "redis+sentinel://localhost:26379/mymaster"',
    '            -',
    '                redis_sentinel: mymaster',
    '                retry_interval: 100',
    '                timeout: 5',
  ].join('\n') + '\n');

  put(root, 'src/Service/SystemIpc.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class SystemIpc',
    '{',
    '    public function pipe(string $payload): array',
    '    {',
    '        $key = ftok(__FILE__, "b");',
    '        $queue = msg_get_queue($key, 0666);',
    '        msg_send($queue, 1, $payload, true, false);',
    '        msg_receive($queue, 1, $type, 4096, $message, true, MSG_IPC_NOWAIT);',
    '        msg_stat_queue($queue);',
    '        msg_remove_queue($queue);',
    '',
    '        $semaphore = sem_get($key, 1, 0666, 1);',
    '        sem_acquire($semaphore, true);',
    '        sem_release($semaphore);',
    '        sem_remove($semaphore);',
    '',
    '        posix_mkfifo("/tmp/acme.fifo", 0644);',
    '        $fifo = fopen("/dev/shm/acme.fifo", "r+");',
    '        stream_set_blocking($fifo, false);',
    '',
    '        $file = new \\SplFileObject("/dev/null", "w");',
    '        $file->fwrite(json_encode(["ok" => true], JSON_THROW_ON_ERROR));',
    '',
    '        return [$message, $type];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/routes/locale.yaml', [
    'app_localized_home:',
    '    path: /{_locale}/',
    '    controller: App\\Controller\\HomeController::index',
    '    requirements:',
    '        _locale: "en|es|fr"',
    '    defaults:',
    '        _locale: en',
    '',
    'app_localized_product:',
    '    path: /{_locale}/product/{slug}',
    '    controller: App\\Controller\\ProductController::show',
    '    requirements:',
    '        _locale: "en|es|fr"',
    '        slug: "[a-z0-9-]+"',
  ].join('\n') + '\n');

  put(root, 'docker/supervisor/worker.conf', [
    '[program:messenger-consume]',
    'command=php /var/www/html/bin/console messenger:consume async async_priority_high --time-limit=3600 --memory-limit=128M',
    'user=www-data',
    'numprocs=4',
    'process_name=%(program_name)s_%(process_num)02d',
    'autostart=true',
    'autorestart=true',
    'startsecs=0',
    'stdout_logfile=/dev/stdout',
    'stdout_logfile_maxbytes=0',
    'stderr_logfile=/dev/stderr',
    'stderr_logfile_maxbytes=0',
    '',
    '[program:scheduler]',
    'command=php /var/www/html/bin/console messenger:consume scheduler_default',
    'autorestart=true',
  ].join('\n') + '\n');

  put(root, 'docker/php/opcache.ini', [
    'opcache.enable=1',
    'opcache.enable_cli=0',
    'opcache.memory_consumption=256',
    'opcache.max_accelerated_files=20000',
    'opcache.validate_timestamps=0',
    'opcache.preload=/var/www/html/config/preload.php',
    'opcache.preload_user=www-data',
    'opcache.jit=tracing',
    'opcache.jit_buffer_size=100M',
  ].join('\n') + '\n');

  put(root, 'crontab', [
    '# m h dom mon dow command',
    '*/5 * * * * www-data php /var/www/html/bin/console app:import --quiet',
    '0 3 * * * www-data php /var/www/html/bin/console app:cleanup >> /var/log/cron.log 2>&1',
    '@daily www-data php /var/www/html/bin/console messenger:stop-workers',
  ].join('\n') + '\n');
}

/** The third-party services the integration modules gate on. */
function integrations(root: string): void {
  put(root, 'src/Integration/Payments.php', [
    '<?php',
    'namespace App\\Integration;',
    '',
    'use Stripe\\StripeClient;',
    'use Stripe\\Webhook;',
    '',
    'class Payments',
    '{',
    '    public function __construct(private StripeClient $stripe) {}',
    '',
    '    public function charge(string $customer, int $amount): void',
    '    {',
    '        $this->stripe->paymentIntents->create([',
    '            "customer" => $customer,',
    '            "amount" => $amount,',
    '            "currency" => "eur",',
    '            "automatic_payment_methods" => ["enabled" => true],',
    '        ]);',
    '    }',
    '',
    '    public function webhook(string $payload, string $signature): void',
    '    {',
    '        Webhook::constructEvent($payload, $signature, $_ENV["STRIPE_WEBHOOK_SECRET"]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Integration/Platforms.php', [
    '<?php',
    'namespace App\\Integration;',
    '',
    'use Google\\Cloud\\Storage\\StorageClient;',
    'use Aws\\CloudFront\\CloudFrontClient;',
    'use Github\\Client as GitHubClient;',
    'use Shopify\\Clients\\Rest as ShopifyClient;',
    'use MicrosoftAzure\\Storage\\Blob\\BlobRestProxy;',
    '',
    'class Platforms',
    '{',
    '    public function google(): StorageClient',
    '    {',
    '        return new StorageClient(["keyFilePath" => "%kernel.project_dir%/config/google-key.json"]);',
    '    }',
    '',
    '    public function cloudfront(): CloudFrontClient',
    '    {',
    '        return new CloudFrontClient(["region" => "eu-west-1", "version" => "latest"]);',
    '    }',
    '',
    '    public function github(string $accessToken): GitHubClient',
    '    {',
    '        $client = new GitHubClient();',
    '        $client->authenticate($accessToken, null, GitHubClient::AUTH_ACCESS_TOKEN);',
    '',
    '        return $client;',
    '    }',
    '',
    '    public function shopify(): ShopifyClient',
    '    {',
    '        return new ShopifyClient("acme.myshopify.com", $_ENV["SHOPIFY_ACCESS_TOKEN"]);',
    '    }',
    '',
    '    public function azure(): BlobRestProxy',
    '    {',
    '        return BlobRestProxy::createBlobService($_ENV["AZURE_STORAGE_CONNECTION_STRING"]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/mercure.yaml', [
    'mercure:',
    '    hubs:',
    '        default:',
    '            url: "%env(MERCURE_URL)%"',
    '            public_url: "%env(MERCURE_PUBLIC_URL)%"',
    '            jwt:',
    '                secret: "%env(MERCURE_JWT_SECRET)%"',
    '                publish: ["*"]',
    '                subscribe: ["{topic}"]',
  ].join('\n') + '\n');

  put(root, '.env.integrations', [
    'STRIPE_SECRET_KEY=sk_test_your_key_here',
    'STRIPE_WEBHOOK_SECRET=whsec_your_secret_here',
    'MAILGUN_API_KEY=key\x2d0123456789abcdef0123456789abcdef',
    'MAILGUN_DOMAIN=mg.example.com',
    'ALGOLIA_APP_ID=ACME123',
    'ALGOLIA_API_KEY=0123456789abcdef0123456789abcdef',
    'SHOPIFY_ACCESS_TOKEN=shpat\x5f0123456789abcdef0123456789abcdef',
    'GITHUB_ACCESS_TOKEN=ghp\x5f0123456789abcdef0123456789abcdef0123',
    'AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=abc123=="',
    'MERCURE_URL=http://mercure/.well-known/mercure',
    'MERCURE_JWT_SECRET=your_jwt_secret_here',
    'GOOGLE_APPLICATION_CREDENTIALS=/var/www/html/config/google-key.json',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchTen(root: string): void {
  frameworkNamespaces(root);
  systemVocabulary(root);
  integrations(root);
}
