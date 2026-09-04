// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications for the quality tooling and the last of the security
 * configuration: fixtures, recipes, GrumPHP, benchmarks, opcache, JWT,
 * SMS notifiers, user providers and repositories.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-quality-'));
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

describe('the tooling around the code', () => {
  test('fixtures in groups, with dependencies between them', async () => {
    const app = appWith('fixtures', {
      'src/DataFixtures/UserFixtures.php': [
        '<?php',
        'namespace App\\DataFixtures;',
        '',
        'use Doctrine\\Bundle\\FixturesBundle\\Fixture;',
        'use Doctrine\\Bundle\\FixturesBundle\\FixtureGroupInterface;',
        'use Doctrine\\Persistence\\ObjectManager;',
        '',
        'class UserFixtures extends Fixture implements FixtureGroupInterface',
        '{',
        '    public static function getGroups(): array',
        '    {',
        '        return ["users", "dev", "test"];',
        '    }',
        '',
        '    public function load(ObjectManager $manager): void',
        '    {',
        '        $this->addReference("user-1", new \\App\\Entity\\User());',
        '        $manager->flush();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/DataFixtures/OrderFixtures.php': [
        '<?php',
        'namespace App\\DataFixtures;',
        '',
        'use Doctrine\\Bundle\\FixturesBundle\\Fixture;',
        'use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;',
        'use Doctrine\\Persistence\\ObjectManager;',
        '',
        'class OrderFixtures extends Fixture implements DependentFixtureInterface',
        '{',
        '    public function getDependencies(): array',
        '    {',
        '        return [UserFixtures::class];',
        '    }',
        '',
        '    public function load(ObjectManager $manager): void',
        '    {',
        '        $user = $this->getReference("user-1", \\App\\Entity\\User::class);',
        '        $manager->flush();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/DataFixtures/UngroupedFixtures.php': [
        '<?php',
        'namespace App\\DataFixtures;',
        '',
        'use Doctrine\\Bundle\\FixturesBundle\\Fixture;',
        'use Doctrine\\Persistence\\ObjectManager;',
        '',
        'class UngroupedFixtures extends Fixture',
        '{',
        '    public function load(ObjectManager $manager): void { }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/doctrine-fixtures-bundle': '^3.5' });

    const text = await runModule('database-fixture-groups.js', app, ['users']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a lock file full of recipes, some of them unapplied', async () => {
    const app = appWith('flex', {
      'symfony.lock': JSON.stringify({
        'doctrine/doctrine-bundle': {
          version: '2.11',
          recipe: { repo: 'github.com/symfony/recipes', branch: 'main', version: '2.10', ref: 'a1b2c3' },
          files: ['config/packages/doctrine.yaml', 'src/Entity/.gitignore'],
        },
        'symfony/framework-bundle': {
          version: '7.0',
          recipe: { repo: 'github.com/symfony/recipes', branch: 'main', version: '6.4', ref: 'd4e5f6' },
          files: ['config/packages/framework.yaml', 'public/index.php'],
        },
        'symfony/maker-bundle': { version: '1.55' },
        'acme/private-bundle': {
          version: '1.0',
          recipe: { repo: 'github.com/acme/recipes-private', branch: 'main', version: '1.0', ref: 'aaa' },
        },
      }, null, 2) + '\n',
      'config/packages/doctrine.yaml': 'doctrine:\n    dbal:\n        url: "%env(DATABASE_URL)%"\n',
      'config/packages/framework.yaml': 'framework:\n    secret: "%env(APP_SECRET)%"\n',
      'public/index.php': '<?php\n\nrequire dirname(__DIR__)."/vendor/autoload.php";\n',
    });

    const text = await runModule('flex-recipes.js', app, ['doctrine/doctrine-bundle']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('GrumPHP with its tasks, and a benchmark suite beside it', async () => {
    const app = appWith('grumphp', {
      'grumphp.yml': [
        'grumphp:',
        '    process_timeout: 120',
        '    stop_on_failure: false',
        '    ignore_unstaged_changes: false',
        '    hooks_dir: ~',
        '    tasks:',
        '        phpcs:',
        '            standard: PSR12',
        '            ignore_patterns: ["src/Migrations"]',
        '        phpstan:',
        '            configuration: phpstan.neon',
        '            level: 8',
        '        phpunit:',
        '            config_file: phpunit.xml.dist',
        '            always_execute: true',
        '        composer:',
        '            no_check_publish: true',
        '        yamllint: ~',
        '        jsonlint: ~',
        '        git_commit_message:',
        '            max_subject_width: 72',
        '            case_insensitive: false',
        '    testsuites:',
        '        quick:',
        '            tasks: [phpcs, jsonlint]',
      ].join('\n') + '\n',
      'benchmarks/ImportBench.php': [
        '<?php',
        'namespace App\\Benchmarks;',
        '',
        'use PhpBench\\Attributes as Bench;',
        '',
        'class ImportBench',
        '{',
        '    #[Bench\\Revs(1000)]',
        '    #[Bench\\Iterations(5)]',
        '    #[Bench\\Warmup(1)]',
        '    public function benchImport(): void',
        '    {',
        '    }',
        '',
        '    /**',
        '     * @Revs(100)',
        '     * @Iterations(3)',
        '     */',
        '    public function benchLegacy(): void',
        '    {',
        '    }',
        '}',
      ].join('\n') + '\n',
      'phpbench.json': JSON.stringify({
        $schema: 'vendor/phpbench/phpbench/phpbench.schema.json',
        'runner.bootstrap': 'vendor/autoload.php',
        'runner.path': 'benchmarks',
        'runner.iterations': 5,
        'runner.revs': 1000,
        'report.outputs': { 'acme-html': { extends: 'html' } },
      }, null, 2) + '\n',
    }, { 'phpro/grumphp': '^2.5', 'phpbench/phpbench': '^1.2' });

    const results = await Promise.all([
      runModule('grumphp-config.js', app),
      runModule('phpbench-config.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('opcache settings that are almost right', async () => {
    const app = appWith('opcache', {
      'php.ini': [
        '[opcache]',
        'opcache.enable=1',
        'opcache.enable_cli=0',
        'opcache.memory_consumption=64',
        'opcache.interned_strings_buffer=8',
        'opcache.max_accelerated_files=4000',
        'opcache.validate_timestamps=1',
        'opcache.revalidate_freq=2',
        'opcache.save_comments=1',
        'opcache.fast_shutdown=1',
        'opcache.max_wasted_percentage=5',
      ].join('\n') + '\n',
      'docker/php.ini': [
        '[opcache]',
        'opcache.enable=1',
        'opcache.memory_consumption=256',
        'opcache.max_accelerated_files=20000',
        'opcache.validate_timestamps=0',
        'opcache.preload=/var/www/html/config/preload.php',
        'opcache.preload_user=www-data',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-opcache-settings.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('JWT authentication with keys, TTL and a cookie', async () => {
    const app = appWith('jwt', {
      'config/packages/lexik_jwt_authentication.yaml': [
        'lexik_jwt_authentication:',
        '    secret_key: "%kernel.project_dir%/config/jwt/private.pem"',
        '    public_key: "%kernel.project_dir%/config/jwt/public.pem"',
        '    pass_phrase: "hunter2"',
        '    token_ttl: 31536000',
        '    clock_skew: 30',
        '    encoder:',
        '        signature_algorithm: RS256',
        '    token_extractors:',
        '        authorization_header:',
        '            enabled: true',
        '            prefix: Bearer',
        '        query_parameter:',
        '            enabled: true',
        '            name: token',
        '        cookie:',
        '            enabled: false',
      ].join('\n') + '\n',
      'config/packages/security.yaml': [
        'security:',
        '    firewalls:',
        '        login:',
        '            pattern: ^/api/login',
        '            stateless: true',
        '            json_login:',
        '                check_path: /api/login_check',
        '                success_handler: lexik_jwt_authentication.handler.authentication_success',
        '                failure_handler: lexik_jwt_authentication.handler.authentication_failure',
        '        api:',
        '            pattern: ^/api',
        '            stateless: true',
        '            jwt: ~',
        '            refresh_jwt:',
        '                check_path: /api/token/refresh',
        '    access_control:',
        '        - { path: ^/api/login, roles: PUBLIC_ACCESS }',
        '        - { path: ^/api, roles: IS_AUTHENTICATED_FULLY }',
      ].join('\n') + '\n',
      'config/jwt/private.pem': '-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot a real key, a fixture\n-----END ENCRYPTED PRIVATE KEY-----\n',
      'config/jwt/public.pem': '-----BEGIN PUBLIC KEY-----\nnot a real key, a fixture\n-----END PUBLIC KEY-----\n',
    }, { 'lexik/jwt-authentication-bundle': '^3.0' });

    const text = await runModule('jwt-auth.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('SMS notifiers, one of them with the credentials in the file', async () => {
    const app = appWith('sms', {
      'config/packages/notifier.yaml': [
        'framework:',
        '    notifier:',
        '        texter_transports:',
        '            twilio: "twilio://SID:TOKEN@default?from=%2B34600000000"',
        '            vonage: "%env(VONAGE_DSN)%"',
        '            sns: "sns://ACCESS:SECRET@default?region=eu-west-1"',
        '        channel_policy:',
        '            urgent: ["sms/twilio", "chat/slack"]',
        '        admin_recipients:',
        '            - { phone: "+34600000001" }',
      ].join('\n') + '\n',
      '.env': 'VONAGE_DSN=vonage://KEY:SECRET@default?from=Acme\n',
      'src/Service/Alerts.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Notifier\\Message\\SmsMessage;',
        'use Symfony\\Component\\Notifier\\TexterInterface;',
        '',
        'class Alerts',
        '{',
        '    public function __construct(private TexterInterface $texter) {}',
        '',
        '    public function send(string $phone): void',
        '    {',
        '        $this->texter->send(new SmsMessage($phone, "Your order has shipped"));',
        '        $this->texter->send(new SmsMessage($_GET["phone"], $_GET["body"]));',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'symfony/twilio-notifier': '^7.0', 'symfony/vonage-notifier': '^7.0' });

    const text = await runModule('symfony-notifier-sms.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('user providers: entity, memory, chain and a custom one', async () => {
    const app = appWith('user-providers', {
      'config/packages/security.yaml': [
        'security:',
        '    providers:',
        '        app_user_provider:',
        '            entity:',
        '                class: App\\Entity\\User',
        '                property: email',
        '        in_memory:',
        '            memory:',
        '                users:',
        '                    admin: { password: "$2y$13$hashedhashedhashed", roles: [ROLE_ADMIN] }',
        '        api_provider:',
        '            id: App\\Security\\ApiUserProvider',
        '        all_users:',
        '            chain:',
        '                providers: [app_user_provider, in_memory, api_provider]',
        '    firewalls:',
        '        main:',
        '            provider: all_users',
        '        api:',
        '            provider: api_provider',
        '        orphan:',
        '            lazy: true',
      ].join('\n') + '\n',
      'src/Security/ApiUserProvider.php': [
        '<?php',
        'namespace App\\Security;',
        '',
        'use Symfony\\Component\\Security\\Core\\Exception\\UserNotFoundException;',
        'use Symfony\\Component\\Security\\Core\\User\\UserInterface;',
        'use Symfony\\Component\\Security\\Core\\User\\UserProviderInterface;',
        '',
        'class ApiUserProvider implements UserProviderInterface',
        '{',
        '    public function loadUserByIdentifier(string $identifier): UserInterface',
        '    {',
        '        throw new UserNotFoundException();',
        '    }',
        '',
        '    public function refreshUser(UserInterface $user): UserInterface { return $user; }',
        '',
        '    public function supportsClass(string $class): bool { return true; }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/User.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Security\\Core\\User\\PasswordAuthenticatedUserInterface;',
        'use Symfony\\Component\\Security\\Core\\User\\UserInterface;',
        '',
        '#[ORM\\Entity]',
        'class User implements UserInterface, PasswordAuthenticatedUserInterface',
        '{',
        '    #[ORM\\Column(length: 180, unique: true)]',
        '    private string $email = "";',
        '',
        '    public function getUserIdentifier(): string { return $this->email; }',
        '    public function getRoles(): array { return ["ROLE_USER"]; }',
        '    public function getPassword(): ?string { return null; }',
        '    public function eraseCredentials(): void { }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-security-user-provider.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('repositories from the plain one to the one doing everything', async () => {
    const app = appWith('repositories', {
      'src/Repository/PlainRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        'use Doctrine\\Persistence\\ManagerRegistry;',
        '',
        'class PlainRepository extends ServiceEntityRepository',
        '{',
        '    public function __construct(ManagerRegistry $registry)',
        '    {',
        '        parent::__construct($registry, \\App\\Entity\\Plain::class);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Repository/BusyRepository.php': [
        '<?php',
        'namespace App\\Repository;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
        '',
        'class BusyRepository extends ServiceEntityRepository',
        '{',
        '    public function complicated(array $filters): array',
        '    {',
        '        return $this->createQueryBuilder("b")',
        '            ->select("b", "c", "d", "e")',
        '            ->leftJoin("b.customer", "c")',
        '            ->leftJoin("c.addresses", "d")',
        '            ->innerJoin("b.lines", "e")',
        '            ->where("b.createdAt > :from")',
        '            ->andWhere("c.country IN (:countries)")',
        '            ->andWhere("e.quantity > :minimum")',
        '            ->andWhere("b.total BETWEEN :low AND :high")',
        '            ->andWhere("b.status != :cancelled")',
        '            ->orderBy("b.createdAt", "DESC")',
        '            ->addOrderBy("c.name", "ASC")',
        '            ->groupBy("b.id")',
        '            ->having("COUNT(e.id) > 1")',
        '            ->setMaxResults(200)',
        '            ->getQuery()',
        '            ->getResult();',
        '    }',
        '',
        '    public function everything(): array { return $this->findAll(); }',
        '',
        '    public function raw(string $status): array',
        '    {',
        '        $sql = "SELECT * FROM busy WHERE status = \'" . $status . "\'";',
        '',
        '        return $this->getEntityManager()->getConnection()->fetchAllAssociative($sql);',
        '    }',
        '',
        '    public function paged(int $page): array',
        '    {',
        '        return $this->createQueryBuilder("b")',
        '            ->setFirstResult($page * 50)',
        '            ->setMaxResults(50)',
        '            ->getQuery()',
        '            ->getResult();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Repository/NotARepository.php': '<?php\n\nnamespace App\\Repository;\n\nclass NotARepository\n{\n}\n',
    }, { 'doctrine/orm': '^3.0' });

    const text = await runModule('repository-analyzer.js', app, ['BusyRepository']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('rate limiter policies, each of them once', async () => {
    const app = appWith('limiter-policy', {
      'config/packages/rate_limiter.yaml': [
        'framework:',
        '    rate_limiter:',
        '        anonymous:',
        '            policy: fixed_window',
        '            limit: 60',
        '            interval: "1 minute"',
        '        authenticated:',
        '            policy: sliding_window',
        '            limit: 5000',
        '            interval: "1 hour"',
        '        uploads:',
        '            policy: token_bucket',
        '            limit: 10',
        '            rate: { interval: "5 minutes", amount: 2 }',
        '        internal:',
        '            policy: no_limit',
        '        misconfigured:',
        '            policy: sliding_window',
        '            limit: 0',
        '        enormous:',
        '            policy: fixed_window',
        '            limit: 1000000',
        '            interval: "1 second"',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-rate-limiter-policy.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
