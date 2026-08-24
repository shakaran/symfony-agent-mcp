// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A small but realistic Symfony application on disk, for the tool suites.
 *
 * The tools under src/tools/ read files and parse them. Feeding them an empty
 * directory only proves they do not crash; to exercise the parsing that
 * actually matters — and where every defect found so far has lived — they need
 * source that looks like the real thing, including the shapes they are meant
 * to flag.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Write a file, creating parent directories as needed. */
function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * Creates the fixture and returns its path. Caller removes it.
 */
export function createSymfonyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-fixture-'));

  put(root, 'composer.json', JSON.stringify({
    name: 'acme/demo',
    type: 'project',
    require: {
      php: '>=8.2',
      'symfony/framework-bundle': '^7.0',
      'symfony/console': '^7.0',
      'doctrine/orm': '^3.0',
      'symfony/messenger': '^7.0',
      'api-platform/core': '^3.2',
      'symfony/twig-bundle': '^7.0',
    },
    'require-dev': { 'phpunit/phpunit': '^11.0', 'symfony/maker-bundle': '^1.0' },
    autoload: { 'psr-4': { 'App\\\\': 'src/' } },
  }, null, 2));

  put(root, 'composer.lock', JSON.stringify({
    packages: [
      { name: 'symfony/framework-bundle', version: 'v7.1.0' },
      { name: 'doctrine/orm', version: '3.2.0' },
    ],
    'packages-dev': [{ name: 'phpunit/phpunit', version: '11.2.0' }],
  }, null, 2));

  put(root, 'bin/console', '#!/usr/bin/env php\n<?php\n');
  put(root, 'symfony.lock', '{}');

  put(root, '.env', [
    'APP_ENV=dev',
    'APP_SECRET=0123456789abcdef0123456789abcdef',
    'DATABASE_URL="mysql://app:hunter2@127.0.0.1:3306/app?serverVersion=8.0"',
    'MESSENGER_TRANSPORT_DSN=doctrine://default',
    'MAILER_DSN=smtp://localhost:1025',
  ].join('\n') + '\n');

  // ── config ────────────────────────────────────────────────────────────────
  put(root, 'config/packages/framework.yaml', [
    'framework:',
    '    secret: "%env(APP_SECRET)%"',
    '    session:',
    '        handler_id: null',
    '        cookie_secure: auto',
    '        cookie_samesite: lax',
    '    php_errors:',
    '        log: true',
    '    trusted_proxies: "127.0.0.1,10.0.0.0/8"',
    '    trusted_headers: "x-forwarded-for,x-forwarded-proto"',
  ].join('\n') + '\n');

  put(root, 'config/packages/security.yaml', [
    'security:',
    '    password_hashers:',
    '        App\\Entity\\User: "auto"',
    '    providers:',
    '        app_user_provider:',
    '            entity:',
    '                class: App\\Entity\\User',
    '                property: email',
    '    firewalls:',
    '        dev:',
    '            pattern: ^/(_(profiler|wdt)|css|images|js)/',
    '            security: false',
    '        main:',
    '            lazy: true',
    '            provider: app_user_provider',
    '    access_control:',
    '        - { path: ^/admin, roles: ROLE_ADMIN }',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine.yaml', [
    'doctrine:',
    '    dbal:',
    '        url: "%env(resolve:DATABASE_URL)%"',
    '        charset: utf8',
    '    orm:',
    '        auto_generate_proxy_classes: true',
    '        naming_strategy: doctrine.orm.naming_strategy.underscore_number_aware',
  ].join('\n') + '\n');

  put(root, 'config/routes.yaml', [
    'app_home:',
    '    path: /',
    '    controller: App\\Controller\\HomeController::index',
  ].join('\n') + '\n');

  put(root, 'config/services.yaml', [
    'parameters:',
    '    app.upload_dir: "%kernel.project_dir%/var/uploads"',
    'services:',
    '    _defaults:',
    '        autowire: true',
    '        autoconfigure: true',
    '    App\\:',
    '        resource: "../src/"',
  ].join('\n') + '\n');

  put(root, 'config/bundles.php', [
    '<?php',
    'return [',
    '    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ["all" => true],',
    '];',
  ].join('\n') + '\n');

  // ── source ────────────────────────────────────────────────────────────────
  put(root, 'src/Kernel.php', [
    '<?php',
    'namespace App;',
    'use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;',
    'class Kernel extends BaseKernel { use MicroKernelTrait; }',
  ].join('\n') + '\n');

  put(root, 'src/Controller/HomeController.php', [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    'use Symfony\\Component\\HttpFoundation\\Response;',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    'class HomeController extends AbstractController',
    '{',
    '    #[Route("/", name: "app_home", methods: ["GET"])]',
    '    public function index(Request $request): Response',
    '    {',
    '        return $this->render("home/index.html.twig", ["env" => $_ENV["APP_ENV"]]);',
    '    }',
    '',
    '    #[Route("/health", name: "app_health")]',
    '    public function health(): Response',
    '    {',
    '        return $this->json(["status" => "ok", "php" => PHP_VERSION]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/User.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity(repositoryClass: UserRepository::class)]',
    '#[ORM\\Table(name: "users")]',
    'class User',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Column(length: 180, unique: true)]',
    '    private ?string $email = null;',
    '',
    '    #[ORM\\OneToMany(targetEntity: Order::class, mappedBy: "user")]',
    '    private Collection $orders;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Command/ImportCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
    'use Symfony\\Component\\Console\\Command\\Command;',
    'use Symfony\\Component\\Process\\Process;',
    '',
    '#[AsCommand(name: "app:import", description: "Imports data")]',
    'class ImportCommand extends Command',
    '{',
    '    protected function execute($input, $output): int',
    '    {',
    '        $process = new Process(["ls", "-la"]);',
    '        $process->setTimeout(0);',
    '        $process->run();',
    '        return Command::SUCCESS;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventSubscriber/RequestSubscriber.php', [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    'use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;',
    '',
    'class RequestSubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents(): array',
    '    {',
    '        return [RequestEvent::class => "onKernelRequest"];',
    '    }',
    '',
    '    public function onKernelRequest(RequestEvent $event): void {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/UserType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    '',
    'class UserType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder->add("email")->add("plainPassword");',
    '    }',
    '}',
  ].join('\n') + '\n');

  // ── templates, migrations, translations, tests, logs ──────────────────────
  put(root, 'templates/base.html.twig', [
    '<!DOCTYPE html>',
    '<html><head><title>{% block title %}Demo{% endblock %}</title></head>',
    '<body>{% block body %}{% endblock %}</body></html>',
  ].join('\n') + '\n');

  put(root, 'templates/home/index.html.twig',
    '{% extends "base.html.twig" %}\n{% block body %}{{ env|raw }}{% endblock %}\n');

  put(root, 'migrations/Version20260101000000.php', [
    '<?php',
    'namespace DoctrineMigrations;',
    'use Doctrine\\Migrations\\AbstractMigration;',
    'final class Version20260101000000 extends AbstractMigration',
    '{',
    '    public function up($schema): void',
    '    {',
    '        $this->addSql("CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY)");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'translations/messages.en.yaml', 'app:\n    title: "Demo"\n    greeting: "Hello"\n');
  put(root, 'translations/messages.es.yaml', 'app:\n    title: "Demo"\n');

  put(root, 'tests/Controller/HomeControllerTest.php', [
    '<?php',
    'namespace App\\Tests\\Controller;',
    'use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;',
    'class HomeControllerTest extends WebTestCase',
    '{',
    '    public function testIndex(): void',
    '    {',
    '        $client = static::createClient();',
    '        $client->request("GET", "/");',
    '        $this->assertResponseIsSuccessful();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'phpunit.xml.dist',
    '<?xml version="1.0"?>\n<phpunit bootstrap="tests/bootstrap.php"><testsuites>' +
    '<testsuite name="Project"><directory>tests</directory></testsuite></testsuites></phpunit>\n');

  put(root, 'var/log/dev.log',
    '[2026-08-24T10:00:00+00:00] request.INFO: Matched route "app_home". [] []\n' +
    '[2026-08-24T10:00:01+00:00] security.DEBUG: Checking for authenticator support. [] []\n');

  put(root, 'public/index.php', '<?php\nuse App\\Kernel;\nrequire_once dirname(__DIR__)."/vendor/autoload_runtime.php";\n');

  return root;
}

/** Remove a fixture created by createSymfonyFixture. */
export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * A Symfony application doing the things the tools exist to flag.
 *
 * The sweep against the well-formed fixture exercises the parsing but not the
 * reporting: half of each module is the branch that runs once a problem is
 * found. This fixture contains those problems — injection-shaped queries,
 * shelled-out commands, unescaped output, weak hashing, permissive CORS,
 * debug left on — so those branches run too.
 *
 * Credential-shaped strings are assembled from fragments at runtime, the same
 * way src/fuzz/secret-fixtures.ts does it, so no literal that a scanner would
 * flag ever appears in this file.
 */
export function createProblematicFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-problems-'));
  const tok = (...parts: string[]): string => parts.join('');

  put(root, 'composer.json', JSON.stringify({
    name: 'acme/legacy',
    require: {
      php: '>=7.4',
      'symfony/framework-bundle': '^5.4',
      'doctrine/orm': '^2.10',
      'symfony/serializer': '^5.4',
      'symfony/messenger': '^5.4',
    },
  }, null, 2));
  put(root, 'bin/console', '#!/usr/bin/env php\n<?php\n');

  put(root, '.env', [
    'APP_ENV=prod',
    'APP_DEBUG=1',
    `APP_SECRET=${tok('ThisIs', 'NotASecret', '000000')}`,
    'DATABASE_URL="mysql://root:root@127.0.0.1:3306/legacy"',
    `STRIPE_KEY=${tok('sk', '_', 'live', '_', 'abcdefghijklmnopqrstuvwx')}`,
    'CORS_ALLOW_ORIGIN=*',
  ].join('\n') + '\n');

  put(root, 'config/packages/framework.yaml', [
    'framework:',
    '    secret: "hardcoded-secret-value"',
    '    session:',
    '        cookie_secure: false',
    '        cookie_httponly: false',
    '        cookie_samesite: none',
    '    csrf_protection: false',
    '    trusted_proxies: "*"',
  ].join('\n') + '\n');

  put(root, 'config/packages/nelmio_cors.yaml', [
    'nelmio_cors:',
    '    defaults:',
    '        allow_origin: ["*"]',
    '        allow_credentials: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine.yaml', [
    'doctrine:',
    '    dbal:',
    '        url: "mysql://root:root@127.0.0.1:3306/legacy"',
    '        charset: utf8',
    '        driver: pdo_mysql',
    '        options:',
    '            !php/const PDO::ATTR_STRINGIFY_FETCHES: true',
    '    orm:',
    '        auto_generate_proxy_classes: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/security.yaml', [
    'security:',
    '    encoders:',
    '        App\\Entity\\User:',
    '            algorithm: md5',
    '    firewalls:',
    '        main:',
    '            security: false',
    '    access_control: []',
  ].join('\n') + '\n');

  put(root, 'src/Controller/LegacyController.php', [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    'use Symfony\\Component\\HttpFoundation\\Response;',
    '',
    'class LegacyController extends AbstractController',
    '{',
    '    public function search(Request $request): Response',
    '    {',
    '        $term = $request->query->get("q");',
    '        // Raw concatenated SQL',
    '        $sql = "SELECT * FROM users WHERE name LIKE \'%" . $term . "%\'";',
    '        $rows = $this->connection->query($sql)->fetchAll();',
    '',
    '        // Shelling out',
    '        $out = shell_exec("grep -r " . $term . " /var/log");',
    '        exec("ls " . $term, $result);',
    '        system("cat /etc/passwd");',
    '        passthru($term);',
    '',
    '        // Dangerous constructs',
    '        eval("$x = 1;");',
    '        $data = unserialize($request->request->get("payload"));',
    '        extract($_GET);',
    '        $file = file_get_contents($request->query->get("url"));',
    '',
    '        // Weak hashing for a password',
    '        $hash = md5($request->request->get("password"));',
    '        $other = sha1($request->request->get("password"));',
    '',
    `        $key = "${'sk'}${'_'}${'live'}${'_'}0123456789abcdefghijklmn";`,
    '',
    '        return new Response($out . $hash . $other . $file . $key . json_encode($rows) . $data);',
    '    }',
    '',
    '    public function upload(Request $request): Response',
    '    {',
    '        $f = $_FILES["file"]["tmp_name"];',
    '        move_uploaded_file($f, "/var/www/public/uploads/" . $_FILES["file"]["name"]);',
    '        $img = imagecreatefromstring(file_get_contents($f));',
    '        return new Response("ok");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Order.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    'class Order',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\Column]',
    '    private $id;',
    '',
    '    // No index on a column used for lookups',
    '    #[ORM\\Column(type: "string")]',
    '    private $reference;',
    '',
    '    #[ORM\\ManyToOne(targetEntity: User::class)]',
    '    private $user;',
    '',
    '    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: "order", fetch: "EAGER")]',
    '    private $lines;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Repository/OrderRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'class OrderRepository',
    '{',
    '    public function findByRef($ref)',
    '    {',
    '        $dql = "SELECT o FROM App\\Entity\\Order o WHERE o.reference = \'" . $ref . "\'";',
    '        return $this->getEntityManager()->createQuery($dql)->getResult();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/legacy/list.html.twig', [
    '{% for row in rows %}',
    '    {{ row.name|raw }}',
    '    <a href="{{ row.url }}">{{ row.title|raw }}</a>',
    '{% endfor %}',
    '{{ dump(rows) }}',
  ].join('\n') + '\n');

  put(root, 'public/index.php', [
    '<?php',
    'ini_set("display_errors", 1);',
    'error_reporting(E_ALL);',
    '$kernel = new App\\Kernel("prod", true);',
  ].join('\n') + '\n');

  put(root, 'var/log/prod.log',
    '[2026-08-24T10:00:00+00:00] request.CRITICAL: Uncaught PHP Exception ' +
    'Doctrine\\DBAL\\Exception: "SQLSTATE[42S02]" at Connection.php line 1 [] []\n');

  return root;
}

/**
 * Adds the ecosystem files many tool modules look for.
 *
 * A Symfony application in the wild carries more than PHP: container files,
 * CI definitions, asset tooling, static-analysis configuration. Several dozen
 * modules read exactly those, and without them their analysis never runs.
 * Applied to either fixture.
 */
export function addEcosystemFiles(root: string): void {
  put(root, 'docker-compose.yml', [
    'services:',
    '    php:',
    '        build: ./docker/php',
    '        environment:',
    '            APP_ENV: dev',
    '        volumes:',
    '            - ./:/var/www',
    '        ports:',
    '            - "9000:9000"',
    '    database:',
    '        image: mysql:8.0',
    '        environment:',
    '            MYSQL_ROOT_PASSWORD: root',
    '        ports:',
    '            - "3306:3306"',
  ].join('\n') + '\n');

  put(root, 'docker/php/Dockerfile', [
    'FROM php:8.3-fpm',
    'RUN docker-php-ext-install pdo_mysql opcache',
    'COPY php.ini /usr/local/etc/php/conf.d/app.ini',
    'USER root',
  ].join('\n') + '\n');

  put(root, 'docker/php/php.ini', [
    'memory_limit = 256M',
    'opcache.enable = 1',
    'opcache.validate_timestamps = 1',
    'display_errors = Off',
    'expose_php = On',
  ].join('\n') + '\n');

  put(root, '.github/workflows/ci.yml', [
    'name: CI',
    'on: [push, pull_request]',
    'jobs:',
    '    test:',
    '        runs-on: ubuntu-latest',
    '        steps:',
    '            - uses: actions/checkout@v4',
    '            - run: composer install',
    '            - run: vendor/bin/phpunit',
  ].join('\n') + '\n');

  put(root, '.gitlab-ci.yml', [
    'stages: [test]',
    'phpunit:',
    '    stage: test',
    '    script:',
    '        - composer install',
    '        - vendor/bin/phpunit',
  ].join('\n') + '\n');

  put(root, 'Jenkinsfile', [
    'pipeline {',
    '    agent any',
    '    environment {',
    '        APP_ENV = "test"',
    '    }',
    '    stages {',
    '        stage("Test") { steps { sh "vendor/bin/phpunit" } }',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'package.json', JSON.stringify({
    name: 'acme-assets',
    devDependencies: { '@symfony/webpack-encore': '^4.0', webpack: '^5.0' },
    scripts: { dev: 'encore dev', build: 'encore production' },
  }, null, 2));

  put(root, 'webpack.config.js', [
    "const Encore = require('@symfony/webpack-encore');",
    "Encore.setOutputPath('public/build/')",
    "    .setPublicPath('/build')",
    "    .addEntry('app', './assets/app.js')",
    '    .enableSingleRuntimeChunk()',
    '    .enableVersioning();',
    'module.exports = Encore.getWebpackConfig();',
  ].join('\n') + '\n');

  put(root, 'assets/app.js', "import './styles/app.css';\nconsole.log('app');\n");
  put(root, 'assets/styles/app.css', 'body { margin: 0; }\n');
  put(root, 'importmap.php', "<?php\nreturn [\n    'app' => ['path' => './assets/app.js', 'entrypoint' => true],\n];\n");

  put(root, 'phpstan.neon', 'parameters:\n    level: 6\n    paths:\n        - src\n');
  put(root, 'phpunit.xml', '<?xml version="1.0"?>\n<phpunit colors="true"/>\n');
  put(root, '.php-cs-fixer.dist.php', "<?php\nreturn (new PhpCsFixer\\Config())->setRules(['@Symfony' => true]);\n");
  put(root, 'rector.php', "<?php\nuse Rector\\Config\\RectorConfig;\nreturn static function (RectorConfig $c): void {};\n");
  put(root, '.env.local', 'APP_ENV=dev\n');
  put(root, 'Makefile', 'test:\n\tvendor/bin/phpunit\n');
  put(root, '.gitignore', "/vendor/\n/var/\n/.env.local\n");
  put(root, 'features/home.feature', 'Feature: Home\n  Scenario: Visit\n    Given I am on "/"\n');
  put(root, 'public/.htaccess', 'RewriteEngine On\n');
  put(root, 'public/robots.txt', 'User-agent: *\nDisallow:\n');
}

/**
 * A valid Symfony application with nothing in it.
 *
 * The empty directory in the sweep is not a Symfony project at all, so most
 * modules bail at their first guard and their "I looked and found nothing"
 * branch never runs. This is a real project — composer.json declaring the
 * framework, bin/console, the standard directories — that simply contains no
 * routes, no entities, no messenger transports and no findings.
 *
 * It is what reaches the several hundred `if (!somethingFound)` branches.
 */
export function createSkeletonFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-skeleton-'));

  put(root, 'composer.json', JSON.stringify({
    name: 'acme/skeleton',
    type: 'project',
    require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
    autoload: { 'psr-4': { 'App\\\\': 'src/' } },
  }, null, 2));
  put(root, 'composer.lock', JSON.stringify({ packages: [], 'packages-dev': [] }, null, 2));
  put(root, 'bin/console', '#!/usr/bin/env php\n<?php\n');
  put(root, 'symfony.lock', '{}');
  put(root, '.env', 'APP_ENV=dev\n');
  put(root, 'config/services.yaml', "services:\n    _defaults:\n        autowire: true\n");
  put(root, 'config/routes.yaml', "# no routes\n");
  put(root, 'config/bundles.php', "<?php\nreturn [];\n");
  put(root, 'src/Kernel.php', "<?php\nnamespace App;\nclass Kernel {}\n");
  put(root, 'public/index.php', "<?php\n");
  put(root, 'templates/base.html.twig', '<!DOCTYPE html><html></html>\n');
  put(root, 'tests/.gitkeep', '');
  put(root, 'migrations/.gitkeep', '');
  put(root, 'translations/.gitkeep', '');
  put(root, 'var/log/.gitkeep', '');

  return root;
}

/**
 * Bulk content, for the thresholds.
 *
 * Several hundred guards compare a count against a number — "more than ten
 * controllers", "over fifty routes", "at least twenty entities" — and a
 * fixture with one of each never reaches them. This adds enough of each kind
 * to cross the thresholds the modules actually use.
 */
export function addBulkContent(root: string, count = 25): void {
  for (let i = 0; i < count; i++) {
    put(root, `src/Controller/Generated${i}Controller.php`, [
      '<?php',
      'namespace App\\Controller;',
      '',
      'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
      'use Symfony\\Component\\HttpFoundation\\Response;',
      'use Symfony\\Component\\Routing\\Attribute\\Route;',
      '',
      `class Generated${i}Controller extends AbstractController`,
      '{',
      `    #[Route("/generated/${i}", name: "app_generated_${i}", methods: ["GET", "POST"])]`,
      `    public function index${i}(): Response`,
      '    {',
      `        return $this->render("generated/item${i}.html.twig");`,
      '    }',
      '}',
    ].join('\n') + '\n');

    put(root, `src/Entity/Generated${i}.php`, [
      '<?php',
      'namespace App\\Entity;',
      '',
      'use Doctrine\\ORM\\Mapping as ORM;',
      '',
      '#[ORM\\Entity]',
      `#[ORM\\Table(name: "generated_${i}")]`,
      `class Generated${i}`,
      '{',
      '    #[ORM\\Id]',
      '    #[ORM\\GeneratedValue]',
      '    #[ORM\\Column]',
      '    private ?int $id = null;',
      '',
      '    #[ORM\\Column(length: 255)]',
      '    private string $label;',
      '',
      '    #[ORM\\ManyToOne(targetEntity: User::class, fetch: "EAGER")]',
      '    private $owner;',
      '}',
    ].join('\n') + '\n');

    put(root, `src/Service/Generated${i}Service.php`, [
      '<?php',
      'namespace App\\Service;',
      '',
      `class Generated${i}Service`,
      '{',
      '    public function __construct(private $dependency) {}',
      `    public function handle${i}(array $input): array { return $input; }`,
      '}',
    ].join('\n') + '\n');

    put(root, `templates/generated/item${i}.html.twig`,
      `{% extends "base.html.twig" %}\n{% block body %}{{ item${i} }}{% endblock %}\n`);

    put(root, `tests/Generated${i}Test.php`, [
      '<?php',
      'namespace App\\Tests;',
      'use PHPUnit\\Framework\\TestCase;',
      `class Generated${i}Test extends TestCase`,
      '{',
      `    public function testGenerated${i}(): void { $this->assertTrue(true); }`,
      '}',
    ].join('\n') + '\n');
  }

  // Routes and translations in bulk too.
  const routes = ['# generated routes'];
  for (let i = 0; i < count; i++) {
    routes.push(`app_yaml_${i}:`, `    path: /yaml/${i}`, `    controller: App\\Controller\\Generated${i}Controller::index${i}`);
  }
  put(root, 'config/routes/generated.yaml', routes.join('\n') + '\n');

  const messages = ['generated:'];
  for (let i = 0; i < count; i++) messages.push(`    key_${i}: "Value ${i}"`);
  put(root, 'translations/generated.en.yaml', messages.join('\n') + '\n');
  put(root, 'translations/generated.es.yaml', messages.slice(0, count / 2).join('\n') + '\n');
}

/**
 * Symbolic links inside the tree, and one pointing out of it.
 *
 * 761 of the uncovered guards in src/tools are `entry.isSymbolicLink()`: every
 * directory walker checks for links and skips them, and a fixture without a
 * single link never runs that branch. A further 191 are `content === null`,
 * which is what the guarded reader returns when a path resolves outside the
 * application — exactly what the escaping link below produces.
 *
 * This is also the shape that matters most for safety: a link out of the tree
 * is how a traversal would be attempted in the first place.
 */
export function addSymlinks(root: string, outsideTarget: string): void {
  const link = (from: string, to: string): void => {
    const full = path.join(root, from);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    try {
      fs.symlinkSync(to, full);
    } catch {
      // Platforms without symlink permission simply skip this coverage.
    }
  };

  // Links to files inside the project, in the directories walkers scan.
  link('src/Controller/LinkedController.php', path.join(root, 'src/Controller/HomeController.php'));
  link('src/Entity/LinkedEntity.php', path.join(root, 'src/Entity/User.php'));
  link('src/Service/LinkedService.php', path.join(root, 'src/Kernel.php'));
  link('templates/linked.html.twig', path.join(root, 'templates/base.html.twig'));
  link('config/packages/linked.yaml', path.join(root, 'config/packages/framework.yaml'));
  link('tests/LinkedTest.php', path.join(root, 'tests/Controller/HomeControllerTest.php'));

  // A linked directory, which walkers must not follow into.
  link('src/LinkedDir', path.join(root, 'src/Controller'));

  // Links that escape the application: the guarded reader refuses these and
  // returns null, which is the branch 191 guards are waiting for.
  link('src/Controller/EscapingController.php', outsideTarget);
  link('config/packages/escaping.yaml', outsideTarget);

  // A broken link: the target never existed.
  link('src/Service/BrokenLink.php', path.join(root, 'src/Service/DoesNotExist.php'));
}

/**
 * PHP files that declare no class.
 *
 * 244 uncovered guards are `!classMatch` — the parsers extract a class name
 * and take a different path when there is none. Every file in the fixtures so
 * far declares one, so that path never ran. Real applications are full of
 * these: bootstraps, returned configuration arrays, function libraries,
 * files that are only a namespace declaration.
 *
 * Also adds files under a Symfony namespace, which 53 guards look for, and
 * files that are empty or unreadable, for the null-content branches.
 */
export function addClasslessFiles(root: string): void {
  put(root, 'src/bootstrap.php', [
    '<?php',
    '',
    'use Symfony\\Component\\Dotenv\\Dotenv;',
    '',
    'require dirname(__DIR__) . "/vendor/autoload.php";',
    '',
    'if (!isset($_SERVER["APP_ENV"])) {',
    '    (new Dotenv())->bootEnv(dirname(__DIR__) . "/.env");',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/functions.php', [
    '<?php',
    '',
    'namespace App;',
    '',
    'function slugify(string $value): string',
    '{',
    '    return strtolower(preg_replace("/[^A-Za-z0-9]+/", "-", $value));',
    '}',
    '',
    'function money(int $cents): string',
    '{',
    '    return number_format($cents / 100, 2) . " EUR";',
    '}',
    '',
    'const APP_DEFAULT_LOCALE = "en";',
  ].join('\n') + '\n');

  put(root, 'config/parameters.php', [
    '<?php',
    '',
    'return [',
    '    "app.locale" => "en",',
    '    "app.retention_days" => 30,',
    '    "app.features" => ["beta" => false],',
    '];',
  ].join('\n') + '\n');

  put(root, 'src/Component/BundleAlias.php', [
    '<?php',
    '',
    'namespace Symfony\\Component\\Legacy;',
    '',
    '// A file living under a Symfony namespace, which some analysers treat',
    '// as vendor code rather than application code.',
    'interface LegacyMarker {}',
  ].join('\n') + '\n');

  put(root, 'src/Bridge/DoctrineAlias.php', [
    '<?php',
    '',
    'namespace Doctrine\\Bundle\\Legacy;',
    '',
    'interface LegacyDoctrineMarker {}',
  ].join('\n') + '\n');

  // Only an opening tag: no namespace, no class, no statements.
  put(root, 'src/Service/EmptyStub.php', '<?php\n');
  put(root, 'src/Entity/OnlyNamespace.php', '<?php\n\nnamespace App\\Entity;\n');

  // A zero-byte file, which several readers treat separately from a missing one.
  put(root, 'src/Controller/ZeroBytes.php', '');
  put(root, 'config/packages/empty.yaml', '');
  put(root, 'templates/empty.html.twig', '');
}

/**
 * A file the reader cannot read.
 *
 * Several hundred guards handle a null from the guarded reader. A file with no
 * read permission produces exactly that, without needing a symlink the
 * directory walkers would skip first.
 */
export function addUnreadableFiles(root: string): void {
  const make = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    try {
      fs.chmodSync(full, 0o000);
    } catch {
      // Running as root, or a filesystem without permissions: skip.
    }
  };

  make('src/Service/Unreadable.php', '<?php\nclass Unreadable {}\n');
  make('config/packages/unreadable.yaml', 'framework: ~\n');
  make('templates/unreadable.html.twig', '{% block body %}{% endblock %}\n');
}

/** Restore permissions so the fixture can be removed. */
export function restorePermissions(root: string): void {
  for (const rel of [
    'src/Service/Unreadable.php',
    'config/packages/unreadable.yaml',
    'templates/unreadable.html.twig',
  ]) {
    try {
      fs.chmodSync(path.join(root, rel), 0o644);
    } catch {
      // Already gone or never created.
    }
  }
}
