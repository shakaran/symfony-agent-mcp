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
