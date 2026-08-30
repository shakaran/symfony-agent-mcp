// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A sixth batch, written from the settings each analyser complains about:
 * APM agents, log files, metrics and architecture tools, Rector PHP sets,
 * sockets, response headers, bundle extensions and pipeline files.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function apmAndLogs(root: string): void {
  put(root, 'php.ini', [
    '[PHP]',
    'memory_limit = 256M',
    'display_errors = Off',
    'error_reporting = E_ALL',
    'date.timezone = UTC',
    '',
    '[elastic_apm]',
    'extension = elastic_apm.so',
    'elastic_apm.enabled = 1',
    'elastic_apm.server_url = http://apm.internal:8200',
    'elastic_apm.service_name = Acme Storefront',
    'elastic_apm.secret_token = 7f3d9a2b6c1e4508aa11',
    'elastic_apm.api_key = QUJDREVGR0hJSktMTU5PUFFS',
    'elastic_apm.transaction_sample_rate = 1.0',
    'elastic_apm.log_level = debug',
    'elastic_apm.environment = production',
  ].join('\n') + '\n');

  put(root, 'docker/php/conf.d/apm.ini', [
    '[elastic_apm]',
    'elastic_apm.server_url = https://apm.example.com:8200',
    'elastic_apm.service_name = acme-worker',
    'elastic_apm.transaction_sample_rate = 0.1',
    'elastic_apm.log_level = warning',
  ].join('\n') + '\n');

  put(root, '.env.prod', [
    'APP_ENV=prod',
    'APP_DEBUG=0',
    'ELASTIC_APM_SERVER_URL=http://apm.internal:8200',
    'ELASTIC_APM_SERVICE_NAME=acme-storefront',
    'ELASTIC_APM_SECRET_TOKEN=7f3d9a2b6c1e4508aa11',
    'ELASTIC_APM_TRANSACTION_SAMPLE_RATE=1.0',
    'ELASTIC_APM_ENVIRONMENT=production',
    'SENTRY_DSN=https://abc123@o1.ingest.sentry.io/42',
    'SENTRY_TRACES_SAMPLE_RATE=1.0',
  ].join('\n') + '\n');

  const logLines = [
    '[2026-08-01T10:00:01.111111+00:00] request.INFO: Matched route "app_home". {"route":"app_home"} []',
    '[2026-08-01T10:00:02.222222+00:00] security.NOTICE: User logged in {"user":"buyer@example.com"} []',
    '[2026-08-01T10:00:03.333333+00:00] doctrine.WARNING: Slow query: 1.4s {"sql":"SELECT * FROM orders"} []',
    '[2026-08-01T10:00:04.444444+00:00] request.ERROR: Uncaught PHP Exception RuntimeException: "boom" at Service.php line 42 {"exception":"[object] (RuntimeException)"} []',
    '[2026-08-01T10:00:05.555555+00:00] php.CRITICAL: Fatal error: Allowed memory size exhausted {"file":"Kernel.php"} []',
    '[2026-08-01T10:00:06.666666+00:00] app.DEBUG: Payload {"password":"hunter2","token":"7f3d9a2b6c1e"} []',
  ].join('\n') + '\n';

  put(root, 'var/log/prod.log', logLines);
  put(root, 'var/log/dev.log', logLines + logLines);
  put(root, 'var/log/test.log', logLines);
  put(root, 'var/log/deprecation.log', '[2026-08-01T10:00:07.000000+00:00] deprecation.INFO: Since symfony/http-kernel 6.4: not passing a Request is deprecated. [] []\n');
}

function analysisTools(root: string): void {
  put(root, 'phpmetrics.json', JSON.stringify({
    report: { html: 'var/metrics/index.html', json: 'var/metrics/report.json' },
    excluded: ['tests', 'Migrations'],
    includes: ['src'],
    failure: { 'bloater-risk': 20 },
  }, null, 2) + '\n');

  put(root, 'phparkitect.php', [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    'use Arkitect\\ClassSet;',
    'use Arkitect\\CLI\\Config;',
    'use Arkitect\\Expression\\ForClasses\\DependsOnlyOnTheseNamespaces;',
    'use Arkitect\\Expression\\ForClasses\\HaveNameMatching;',
    'use Arkitect\\Expression\\ForClasses\\NotDependsOnTheseNamespaces;',
    'use Arkitect\\Expression\\ForClasses\\ResideInOneOfTheseNamespaces;',
    'use Arkitect\\Rules\\Rule;',
    '',
    'return static function (Config $config): void {',
    '    $mvc = ClassSet::fromDir(__DIR__ . "/src");',
    '',
    '    $controllers = Rule::allClasses()',
    '        ->that(new ResideInOneOfTheseNamespaces("App\\\\Controller"))',
    '        ->should(new HaveNameMatching("*Controller"))',
    '        ->because("controllers are named after what they control");',
    '',
    '    $domain = Rule::allClasses()',
    '        ->that(new ResideInOneOfTheseNamespaces("App\\\\Domain"))',
    '        ->should(new NotDependsOnTheseNamespaces("App\\\\Controller", "Doctrine"))',
    '        ->because("the domain does not depend on delivery or persistence");',
    '',
    '    $entities = Rule::allClasses()',
    '        ->that(new ResideInOneOfTheseNamespaces("App\\\\Entity"))',
    '        ->should(new DependsOnlyOnTheseNamespaces("App\\\\Entity", "Doctrine", "DateTimeImmutable"))',
    '        ->because("entities stay free of services");',
    '',
    '    $config->add($mvc, $controllers, $domain, $entities);',
    '};',
  ].join('\n') + '\n');

  put(root, 'rector.php', [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    'use Rector\\Config\\RectorConfig;',
    '',
    'return RectorConfig::configure()',
    '    ->withPaths([__DIR__ . "/src", __DIR__ . "/tests"])',
    '    ->withSkip([__DIR__ . "/src/Migrations"])',
    '    ->withPhpSets(php74: true, php80: true, php81: true, php82: true)',
    '    ->withPreparedSets(deadCode: true, codeQuality: true, typeDeclarations: true, privatization: true)',
    '    ->withSets([',
    '        Rector\\Symfony\\Set\\SymfonySetList::SYMFONY_64,',
    '        Rector\\Doctrine\\Set\\DoctrineSetList::DOCTRINE_CODE_QUALITY,',
    '    ])',
    '    ->withImportNames()',
    '    ->withParallel(120, 8, 10);',
  ].join('\n') + '\n');

  put(root, 'azure-pipelines.yml', [
    'trigger:',
    '    branches:',
    '        include: [main]',
    '',
    'pool:',
    '    vmImage: ubuntu-latest',
    '',
    'variables:',
    '    phpVersion: "8.3"',
    '    DATABASE_URL: "postgresql://acme:hunter2@localhost:5432/acme"',
    '',
    'stages:',
    '    - stage: build',
    '      jobs:',
    '          - job: composer',
    '            steps:',
    '                - script: composer install --no-interaction',
    '                  displayName: Install',
    '                - script: vendor/bin/phpunit --coverage-clover var/clover.xml',
    '                  displayName: Tests',
    '                - task: PublishTestResults@2',
    '                  inputs:',
    '                      testResultsFiles: var/junit.xml',
    '    - stage: deploy',
    '      dependsOn: build',
    '      jobs:',
    '          - deployment: production',
    '            environment: production',
    '            strategy:',
    '                runOnce:',
    '                    deploy:',
    '                        steps:',
    '                            - script: ./deploy.sh',
  ].join('\n') + '\n');

  put(root, 'wrangler.toml', [
    'name = "acme-edge"',
    'main = "worker/index.js"',
    'compatibility_date = "2026-01-01"',
    'workers_dev = true',
    '',
    '[vars]',
    'API_BASE = "https://acme.example.com"',
    'API_TOKEN = "7f3d9a2b6c1e45089a11bb22cc33dd44"',
    '',
    '[[kv_namespaces]]',
    'binding = "CACHE"',
    'id = "0123456789abcdef0123456789abcdef"',
    '',
    '[env.production]',
    'route = "acme.example.com/*"',
    '',
    '[build]',
    'command = "npm run build"',
  ].join('\n') + '\n');

  put(root, 'config/packages/sentry.yaml', [
    'sentry:',
    '    dsn: "%env(SENTRY_DSN)%"',
    '    options:',
    '        environment: "%kernel.environment%"',
    '        release: "%env(APP_VERSION)%"',
    '        traces_sample_rate: 1.0',
    '        profiles_sample_rate: 1.0',
    '        send_default_pii: true',
    '        ignore_exceptions:',
    '            - Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException',
    '    tracing:',
    '        dbal:',
    '            enabled: true',
    '            connections: [default]',
    '        cache:',
    '            enabled: true',
    '        twig:',
    '            enabled: true',
    '    messenger:',
    '        enabled: true',
    '        capture_soft_fails: false',
  ].join('\n') + '\n');
}

function phpAndHeaders(root: string): void {
  put(root, 'src/Service/SocketClient.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class SocketClient',
    '{',
    '    public function fetch(string $payload): string',
    '    {',
    '        $socket = socket_create(AF_INET, SOCK_STREAM, SOL_TCP);',
    '        socket_set_option($socket, SOL_SOCKET, SO_RCVTIMEO, ["sec" => 5, "usec" => 0]);',
    '        socket_connect($socket, "0.0.0.0", 9501);',
    '        socket_write($socket, $payload, strlen($payload));',
    '        $answer = socket_read($socket, 2048);',
    '        socket_close($socket);',
    '',
    '        return $answer;',
    '    }',
    '',
    '    public function stream(): string',
    '    {',
    '        $stream = stream_socket_client("tls://payments.example.com:443", $errno, $errstr, 30);',
    '        stream_set_timeout($stream, 10);',
    '        $plain = stream_socket_client("tcp://localhost:11211", $errno, $errstr);',
    '        $legacy = fsockopen("ssl://legacy.example.com", 443, $errno, $errstr, 30);',
    '        $bare = fsockopen("127.0.0.1", 6379);',
    '',
    '        return (string) fread($stream, 1024);',
    '    }',
    '',
    '    public function server(): void',
    '    {',
    '        $server = stream_socket_server("tcp://0.0.0.0:8080", $errno, $errstr);',
    '        while ($conn = stream_socket_accept($server)) {',
    '            fwrite($conn, "ok");',
    '            fclose($conn);',
    '        }',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/SecurityHeadersListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
    'use Symfony\\Component\\HttpKernel\\Event\\ResponseEvent;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    '#[AsEventListener(event: KernelEvents::RESPONSE)]',
    'class SecurityHeadersListener',
    '{',
    '    public function __invoke(ResponseEvent $event): void',
    '    {',
    '        $headers = $event->getResponse()->headers;',
    '        $headers->set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(self), interest-cohort=()");',
    '        $headers->set("Feature-Policy", "geolocation none; camera none");',
    '        $headers->set("X-Content-Type-Options", "nosniff");',
    '        $headers->set("Referrer-Policy", "strict-origin-when-cross-origin");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'public/.htaccess', [
    '<IfModule mod_headers.c>',
    '    Header always set Permissions-Policy "geolocation=(), microphone=(), camera=()"',
    '    Header always set X-Frame-Options "DENY"',
    '    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"',
    '</IfModule>',
    '',
    '<IfModule mod_rewrite.c>',
    '    RewriteEngine On',
    '    RewriteCond %{REQUEST_FILENAME} !-f',
    '    RewriteRule ^(.*)$ index.php [QSA,L]',
    '</IfModule>',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/AcmeExtension.php', [
    '<?php',
    'namespace App\\DependencyInjection;',
    '',
    'use Symfony\\Component\\Config\\FileLocator;',
    'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\Extension;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\PrependExtensionInterface;',
    'use Symfony\\Component\\DependencyInjection\\Loader\\YamlFileLoader;',
    '',
    'class AcmeExtension extends Extension implements PrependExtensionInterface',
    '{',
    '    public function load(array $configs, ContainerBuilder $container): void',
    '    {',
    '        $configuration = new Configuration();',
    '        $config = $this->processConfiguration($configuration, $configs);',
    '',
    '        $loader = new YamlFileLoader($container, new FileLocator(__DIR__ . "/../../config"));',
    '        $loader->load("services.yaml");',
    '',
    '        $container->setParameter("acme.api_url", $config["api_url"]);',
    '    }',
    '',
    '    public function prepend(ContainerBuilder $container): void',
    '    {',
    '        $container->prependExtensionConfig("framework", ["http_client" => ["default_options" => ["timeout" => 5]]]);',
    '        $container->prependExtensionConfig("monolog", ["channels" => ["acme"]]);',
    '    }',
    '',
    '    public function getAlias(): string { return "acme"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/Configuration.php', [
    '<?php',
    'namespace App\\DependencyInjection;',
    '',
    'use Symfony\\Component\\Config\\Definition\\Builder\\TreeBuilder;',
    'use Symfony\\Component\\Config\\Definition\\ConfigurationInterface;',
    '',
    'class Configuration implements ConfigurationInterface',
    '{',
    '    public function getConfigTreeBuilder(): TreeBuilder',
    '    {',
    '        $treeBuilder = new TreeBuilder("acme");',
    '        $treeBuilder->getRootNode()',
    '            ->children()',
    '                ->scalarNode("api_url")->defaultValue("https://api.example.com")->end()',
    '                ->integerNode("timeout")->defaultValue(5)->min(1)->max(60)->end()',
    '                ->booleanNode("debug")->defaultFalse()->end()',
    '                ->arrayNode("channels")->scalarPrototype()->end()->end()',
    '            ->end();',
    '',
    '        return $treeBuilder;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/EmptyPrependExtension.php', [
    '<?php',
    'namespace App\\DependencyInjection;',
    '',
    'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\Extension;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\PrependExtensionInterface;',
    '',
    'class EmptyPrependExtension extends Extension implements PrependExtensionInterface',
    '{',
    '    public function load(array $configs, ContainerBuilder $container): void',
    '    {',
    '    }',
    '',
    '    public function prepend(ContainerBuilder $container): void',
    '    {',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/services_lazy.yaml', [
    'services:',
    '    _defaults:',
    '        autowire: true',
    '',
    '    App\\Service\\HeavyReportBuilder:',
    '        lazy: true',
    '',
    '    App\\Service\\LazyGhostCandidate:',
    '        lazy: "App\\\\Service\\\\ReportBuilderInterface"',
    '',
    '    App\\Service\\EagerButHeavy:',
    '        arguments: ["@doctrine.orm.entity_manager"]',
    '',
    '    App\\Service\\ProxiedService:',
    '        lazy: true',
    '        tags: [{ name: proxy, interface: App\\Service\\ReportBuilderInterface }]',
  ].join('\n') + '\n');

  put(root, 'config/services_parameters.yaml', [
    'parameters:',
    '    app.api_url: "%env(API_URL)%"',
    '    app.api_token: "7f3d9a2b6c1e45089a11bb22cc33dd44"',
    '    app.database_password: "hunter2"',
    '    app.timeout: 30',
    '    app.retries: 3',
    '    app.debug_mode: false',
    '    app.upload_max: "10M"',
    '    app.locales: [en, es, fr]',
    '    app.mailer_from: no-reply@example.com',
    '    app.secret_key: "%env(APP_SECRET)%"',
    '',
    'services:',
    '    App\\Service\\ApiClient:',
    '        arguments:',
    '            $baseUrl: "%app.api_url%"',
    '            $token: "%app.api_token%"',
    '            $timeout: "%app.timeout%"',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchSix(root: string): void {
  apmAndLogs(root);
  analysisTools(root);
  phpAndHeaders(root);
}
