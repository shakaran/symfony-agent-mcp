// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A second batch of content, for the modules whose analysers had nothing
 * to read: service discovery, end-to-end tests, log shipping, mutation
 * testing, vaults, static analysis and a handful of Symfony areas.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Consul, Loki, Promtail, Cypress, Infection, Netlify. */
function operations(root: string): void {
  put(root, 'consul.json', JSON.stringify({
    service: {
      name: 'acme-app',
      id: 'acme-app-1',
      tags: ['symfony', 'http', 'traefik.enable=true'],
      port: 8000,
      meta: { version: '1.4.0' },
      checks: [
        { http: 'http://localhost:8000/health', interval: '10s', timeout: '2s' },
        { tcp: 'localhost:8000', interval: '30s' },
      ],
    },
    datacenter: 'dc1',
    encrypt: 'k4ZQ2Zc5nqfP8yQ4c3n1Qw==',
  }, null, 2) + '\n');

  put(root, 'consul.hcl', [
    'service {',
    '    name = "acme-worker"',
    '    port = 9000',
    '    tags = ["worker"]',
    '    check {',
    '        args = ["/usr/local/bin/health"]',
    '        interval = "10s"',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'monitoring/loki-config.yaml', [
    'auth_enabled: false',
    'server:',
    '    http_listen_port: 3100',
    'schema_config:',
    '    configs:',
    '        - from: 2024-01-01',
    '          store: tsdb',
    '          object_store: filesystem',
    '          schema: v13',
    '          index:',
    '              prefix: index_',
    '              period: 24h',
    'limits_config:',
    '    retention_period: 744h',
    '    ingestion_rate_mb: 8',
    'compactor:',
    '    retention_enabled: true',
    '    working_directory: /loki/compactor',
  ].join('\n') + '\n');

  put(root, 'monitoring/promtail.yaml', [
    'server:',
    '    http_listen_port: 9080',
    'clients:',
    '    - url: http://loki:3100/loki/api/v1/push',
    'scrape_configs:',
    '    - job_name: symfony',
      '      static_configs:',
    '          - targets: [localhost]',
    '            labels:',
    '                job: symfony',
    '                env: prod',
    '                __path__: /var/log/symfony/*.log',
    '      pipeline_stages:',
    '          - json:',
    '                expressions:',
    '                    level: level',
    '                    channel: channel',
    '          - labels:',
    '                level:',
    '                channel:',
  ].join('\n') + '\n');

  put(root, 'cypress.config.js', [
    'const { defineConfig } = require("cypress");',
    '',
    'module.exports = defineConfig({',
    '    e2e: {',
    '        baseUrl: "http://localhost:8000",',
    '        specPattern: "cypress/e2e/**/*.cy.{js,ts}",',
    '        supportFile: "cypress/support/e2e.js",',
    '        defaultCommandTimeout: 8000,',
    '        retries: { runMode: 2, openMode: 0 },',
    '        video: false,',
    '        screenshotOnRunFailure: true,',
    '    },',
    '    viewportWidth: 1280,',
    '    viewportHeight: 800,',
    '    env: { apiUrl: "http://localhost:8000/api" },',
    '});',
  ].join('\n') + '\n');

  put(root, 'cypress/e2e/checkout.cy.js', [
    'describe("checkout", () => {',
    '    beforeEach(() => { cy.fixture("cart.json").as("cart"); });',
    '',
    '    it("completes an order", () => {',
    '        cy.visit("/cart");',
    '        cy.wait(2000);',
    '        cy.get(".btn-checkout").click();',
    '        cy.contains("Thank you");',
    '    });',
    '});',
  ].join('\n') + '\n');

  put(root, 'cypress/fixtures/cart.json', JSON.stringify({ items: [{ sku: 'A-1', qty: 2 }] }) + '\n');
  put(root, 'cypress/support/e2e.js', 'import "./commands";\n');

  put(root, 'infection.json', JSON.stringify({
    $schema: 'vendor/infection/infection/resources/schema.json',
    source: { directories: ['src'], excludes: ['Migrations', 'Kernel.php'] },
    logs: { text: 'var/infection-log.txt', json: 'var/infection-log.json', stryker: { badge: 'main' } },
    mutators: { '@default': true, TrueValue: { ignore: ['App\\Kernel::boot'] } },
    minMsi: 65,
    minCoveredMsi: 75,
    timeout: 10,
  }, null, 2) + '\n');

  put(root, 'var/infection-log.json', JSON.stringify({
    stats: { totalMutantsCount: 400, killedCount: 280, notCoveredCount: 60, escapedCount: 50, timedOutCount: 10, msi: 72.5, mutationCodeCoverage: 84.0, coveredCodeMsi: 79.1 },
    escaped: [
      { mutator: { mutatorName: 'GreaterThan', originalFilePath: 'src/Service/PriceCalculator.php', originalStartLine: 42 }, diff: '-        if ($qty > 10) {\n+        if ($qty >= 10) {' },
      { mutator: { mutatorName: 'TrueValue', originalFilePath: 'src/Service/FeatureFlags.php', originalStartLine: 18 }, diff: '-        return true;\n+        return false;' },
    ],
  }, null, 2) + '\n');
}

/** Vault secrets, PHPStan rules, PHPUnit extensions, ignore comments. */
function staticAnalysis(root: string): void {
  put(root, 'config/secrets/prod/prod.list.php', '<?php\n\nreturn ["DATABASE_URL", "MAILER_DSN", "STRIPE_SECRET"];\n');
  put(root, 'config/secrets/prod/prod.encrypt.public.php', '<?php\n\nreturn "\\x00\\x01public-key-bytes";\n');
  put(root, 'config/secrets/prod/DATABASE_URL.5f3a.php', '<?php\n\nreturn "encrypted-payload";\n');
  put(root, 'config/secrets/prod/MAILER_DSN.9c21.php', '<?php\n\nreturn "encrypted-payload";\n');
  put(root, 'config/secrets/dev/dev.decrypt.private.php', '<?php\n\nreturn "private-key-bytes";\n');

  put(root, 'phpstan.neon', [
    'parameters:',
    '    level: 8',
    '    paths:',
    '        - src',
    '        - tests',
    '    excludePaths:',
    '        - src/Migrations',
    '    treatPhpDocTypesAsCertain: false',
    '    checkMissingIterableValueType: true',
    '    ignoreErrors:',
    '        - "#Call to an undefined method#"',
    '        -',
    '            message: "#Cannot call method getId\\(\\) on App\\\\Entity\\\\User\\|null#"',
    '            path: src/Controller/ProfileController.php',
    '            count: 3',
    '    bootstrapFiles:',
    '        - tests/bootstrap.php',
    '    stubFiles:',
    '        - stubs/Redis.stub',
    '',
    'services:',
    '    -',
    '        class: App\\PHPStan\\NoDirectEntityManagerRule',
    '        tags: [phpstan.rules.rule]',
    '    -',
    '        class: App\\PHPStan\\ControllerReturnTypeRule',
    '        tags: [phpstan.rules.rule]',
    '',
    'includes:',
    '    - vendor/phpstan/phpstan-symfony/extension.neon',
  ].join('\n') + '\n');

  put(root, 'stubs/Redis.stub', '<?php\n\nclass Redis { public function get(string $key) {} }\n');
  put(root, 'tests/bootstrap.php', '<?php\n\nrequire dirname(__DIR__)."/vendor/autoload.php";\n');

  put(root, 'src/PHPStan/NoDirectEntityManagerRule.php', [
    '<?php',
    'namespace App\\PHPStan;',
    '',
    'use PhpParser\\Node;',
    'use PHPStan\\Analyser\\Scope;',
    'use PHPStan\\Rules\\Rule;',
    '',
    '/**',
    ' * @implements Rule<Node\\Expr\\MethodCall>',
    ' */',
    'class NoDirectEntityManagerRule implements Rule',
    '{',
    '    public function getNodeType(): string',
    '    {',
    '        return Node\\Expr\\MethodCall::class;',
    '    }',
    '',
    '    public function processNode(Node $node, Scope $scope): array',
    '    {',
    '        return [];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/PHPStan/ControllerReturnTypeRule.php', [
    '<?php',
    'namespace App\\PHPStan;',
    '',
    'use PhpParser\\Node;',
    'use PHPStan\\Analyser\\Scope;',
    'use PHPStan\\Rules\\Rule;',
    '',
    'class ControllerReturnTypeRule implements Rule',
    '{',
    '    public function getNodeType(): string { return Node\\Stmt\\ClassMethod::class; }',
    '    public function processNode(Node $node, Scope $scope): array { return []; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/Suppressed.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Suppressed',
    '{',
    '    /** @phpstan-ignore-next-line */',
    '    public function one(): void { $this->missing(); }',
    '',
    '    public function two(): void',
    '    {',
    '        $x = $this->missing(); // @phpstan-ignore-line',
    '        /** @psalm-suppress UndefinedMethod */',
    '        $this->alsoMissing();',
    '        $y = 1; /* @phpstan-ignore-line */',
    '    }',
    '',
    '    /**',
    '     * @psalm-suppress MixedReturnStatement',
    '     * @phpstan-ignore-next-line',
    '     */',
    '    public function three() { return $this->whatever(); }',
    '}',
  ].join('\n') + '\n');

  put(root, 'psalm.xml', [
    '<?xml version="1.0"?>',
    '<psalm errorLevel="3" resolveFromConfigFile="true" findUnusedBaselineEntry="true" findUnusedCode="false">',
    '    <projectFiles>',
    '        <directory name="src" />',
    '        <ignoreFiles><directory name="vendor" /></ignoreFiles>',
    '    </projectFiles>',
    '    <issueHandlers>',
    '        <MixedAssignment errorLevel="suppress" />',
    '        <PropertyNotSetInConstructor errorLevel="info" />',
    '    </issueHandlers>',
    '</psalm>',
  ].join('\n') + '\n');

  const phpunitXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"',
    '         bootstrap="tests/bootstrap.php"',
    '         cacheDirectory=".phpunit.cache"',
    '         executionOrder="random"',
    '         failOnWarning="true"',
    '         failOnRisky="true"',
    '         colors="true">',
    '    <testsuites>',
    '        <testsuite name="unit"><directory>tests/Unit</directory></testsuite>',
    '        <testsuite name="functional"><directory>tests/Functional</directory></testsuite>',
    '    </testsuites>',
    '    <extensions>',
    '        <bootstrap class="App\\Tests\\Extension\\ResetDatabaseExtension">',
    '            <parameter name="dsn" value="sqlite:///:memory:" />',
    '        </bootstrap>',
    '        <bootstrap class="DAMA\\DoctrineTestBundle\\PHPUnit\\PHPUnitExtension" />',
    '    </extensions>',
    '    <source>',
    '        <include><directory>src</directory></include>',
    '        <exclude><directory>src/Migrations</directory></exclude>',
    '    </source>',
    '    <php>',
    '        <env name="APP_ENV" value="test" />',
    '        <server name="KERNEL_CLASS" value="App\\Kernel" />',
    '    </php>',
    '</phpunit>',
  ].join('\n') + '\n';
  put(root, 'phpunit.xml.dist', phpunitXml);
  put(root, 'phpunit.xml', phpunitXml);

  put(root, 'src/Tests/Extension/ResetDatabaseExtension.php', [
    '<?php',
    'namespace App\\Tests\\Extension;',
    '',
    'use PHPUnit\\Runner\\Extension\\Extension;',
    'use PHPUnit\\Runner\\Extension\\Facade;',
    'use PHPUnit\\Runner\\Extension\\ParameterCollection;',
    'use PHPUnit\\TextUI\\Configuration\\Configuration;',
    '',
    'final class ResetDatabaseExtension implements Extension',
    '{',
    '    public function bootstrap(Configuration $configuration, Facade $facade, ParameterCollection $parameters): void',
    '    {',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Voters, serializer groups, compound forms, casters, plurals, JSON login. */
function symfonyAreas(root: string): void {
  put(root, 'src/Security/Voter/PostVoter.php', [
    '<?php',
    'namespace App\\Security\\Voter;',
    '',
    'use App\\Entity\\Post;',
    'use Symfony\\Bundle\\SecurityBundle\\Security;',
    'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
    'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
    '',
    'class PostVoter extends Voter',
    '{',
    '    public const EDIT = "POST_EDIT";',
    '    public const DELETE = "POST_DELETE";',
    '',
    '    public function __construct(private Security $security) {}',
    '',
    '    protected function supports(string $attribute, mixed $subject): bool',
    '    {',
    '        return in_array($attribute, [self::EDIT, self::DELETE], true) && $subject instanceof Post;',
    '    }',
    '',
    '    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool',
    '    {',
    '        $user = $token->getUser();',
    '        if ($this->security->isGranted("ROLE_ADMIN")) { return true; }',
    '',
    '        return match ($attribute) {',
    '            self::EDIT => $subject->getAuthor() === $user,',
    '            self::DELETE => $subject->getAuthor() === $user && !$subject->isPublished(),',
    '            default => false,',
    '        };',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Security/Voter/LegacyVoter.php', [
    '<?php',
    'namespace App\\Security\\Voter;',
    '',
    'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\CacheableVoterInterface;',
    'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\VoterInterface;',
    '',
    'class LegacyVoter implements VoterInterface, CacheableVoterInterface',
    '{',
    '    public function vote($token, $subject, array $attributes): int',
    '    {',
    '        return VoterInterface::ACCESS_ABSTAIN;',
    '    }',
    '',
    '    public function supportsAttribute(string $attribute): bool { return true; }',
    '    public function supportsType(string $subjectType): bool { return true; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Dto/OrderOutput.php', [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    'use Symfony\\Component\\Serializer\\Annotation\\Ignore;',
    'use Symfony\\Component\\Serializer\\Annotation\\MaxDepth;',
    'use Symfony\\Component\\Serializer\\Annotation\\SerializedName;',
    '',
    'class OrderOutput',
    '{',
    '    #[Groups(["order:read", "order:write"])]',
    '    public int $id = 0;',
    '',
    '    #[Groups(["order:read"])]',
    '    #[SerializedName("total_amount")]',
    '    public string $total = "0.00";',
    '',
    '    #[Ignore]',
    '    public ?string $internalNote = null;',
    '',
    '    #[Groups(["order:read"])]',
    '    #[MaxDepth(2)]',
    '    public array $lines = [];',
    '',
    '    public ?string $undocumented = null;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/AddressType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use App\\Entity\\Address;',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
    '',
    'class AddressType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder',
    '            ->add("street", TextType::class, ["required" => true])',
    '            ->add("city", TextType::class)',
    '            ->add("postalCode", TextType::class, ["label" => "ZIP"]);',
    '    }',
    '',
    '    public function configureOptions(OptionsResolver $resolver): void',
    '    {',
    '        $resolver->setDefaults(["data_class" => Address::class]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/CustomerType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use App\\Entity\\Customer;',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\CollectionType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
    '',
    'class CustomerType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder',
    '            ->add("name", TextType::class)',
    '            ->add("billingAddress", AddressType::class)',
    '            ->add("shippingAddress", AddressType::class, ["required" => false])',
    '            ->add("contacts", CollectionType::class, [',
    '                "entry_type" => ContactType::class,',
    '                "allow_add" => true,',
    '                "allow_delete" => true,',
    '                "by_reference" => false,',
    '            ]);',
    '    }',
    '',
    '    public function configureOptions(OptionsResolver $resolver): void',
    '    {',
    '        $resolver->setDefaults(["data_class" => Customer::class]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/ContactType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    '',
    'class ContactType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder->add("email")->add("phone");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Serializer/MoneyCaster.php', [
    '<?php',
    'namespace App\\Serializer;',
    '',
    'use Symfony\\Component\\VarDumper\\Caster\\Caster;',
    'use Symfony\\Component\\VarDumper\\Cloner\\Stub;',
    '',
    'class MoneyCaster',
    '{',
    '    public static function castMoney($money, array $a, Stub $stub, bool $isNested): array',
    '    {',
    '        $a[Caster::PREFIX_VIRTUAL . "amount"] = $money->getAmount();',
    '        $a[Caster::PREFIX_PROTECTED . "currency"] = $money->getCurrency();',
    '',
    '        return $a;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/debug.yaml', [
    'debug:',
    '    dump_destination: "tcp://%env(VAR_DUMPER_SERVER)%"',
    '',
    'services:',
    '    App\\Serializer\\MoneyCaster:',
    '        tags:',
    '            - { name: var_dumper.caster, type: App\\Money, method: castMoney }',
  ].join('\n') + '\n');

  put(root, 'translations/messages+intl-icu.en.yaml', [
    'cart.items: "{count, plural, =0 {No items} one {One item} other {# items}}"',
    'cart.total: "{total, number, ::currency/EUR}"',
    'order.status: "{status, select, paid {Paid} shipped {Shipped} other {Unknown}}"',
  ].join('\n') + '\n');

  put(root, 'translations/messages.es.yaml', [
    'cart.items: "{count, plural, =0 {Sin artículos} one {Un artículo} other {# artículos}}"',
    'cart.legacy: "Un artículo|%count% artículos"',
    'cart.broken: "one: Un artículo"',
  ].join('\n') + '\n');

  put(root, 'translations/validators.en.xlf', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
    '    <file source-language="en" target-language="en" datatype="plaintext" original="file.ext">',
    '        <body>',
    '            <trans-unit id="1" resname="post.comments">',
    '                <source>post.comments</source>',
    '                <target>{count, plural, one {# comment} other {# comments}}</target>',
    '            </trans-unit>',
    '            <trans-unit id="2" resname="post.legacy">',
    '                <source>post.legacy</source>',
    '                <target>One comment|%count% comments</target>',
    '            </trans-unit>',
    '        </body>',
    '    </file>',
    '</xliff>',
  ].join('\n') + '\n');
}

/** Doctrine platform, covariance hierarchy, parallel workflow, GraphQL, factories. */
function phpHierarchies(root: string): void {
  put(root, 'src/Doctrine/Platform/AcmePlatform.php', [
    '<?php',
    'namespace App\\Doctrine\\Platform;',
    '',
    'use Doctrine\\DBAL\\Platforms\\PostgreSQLPlatform;',
    '',
    'class AcmePlatform extends PostgreSQLPlatform',
    '{',
    '    public function getName(): string',
    '    {',
    '        return "acme";',
    '    }',
    '',
    '    public function getVarcharTypeDeclarationSQL(array $column): string',
    '    {',
    '        return "CITEXT";',
    '    }',
    '',
    '    protected function initializeDoctrineTypeMappings(): void',
    '    {',
    '        parent::initializeDoctrineTypeMappings();',
    '        $this->doctrineTypeMapping["citext"] = "string";',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/Type/PointType.php', [
    '<?php',
    'namespace App\\Doctrine\\Type;',
    '',
    'use Doctrine\\DBAL\\Platforms\\AbstractPlatform;',
    'use Doctrine\\DBAL\\Types\\Type;',
    '',
    'class PointType extends Type',
    '{',
    '    public const NAME = "point";',
    '',
    '    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string',
    '    {',
    '        return "POINT";',
    '    }',
    '',
    '    public function getName(): string { return self::NAME; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/TypeRegistrar.php', [
    '<?php',
    'namespace App\\Doctrine;',
    '',
    'use App\\Doctrine\\Type\\PointType;',
    'use Doctrine\\DBAL\\Types\\Type;',
    '',
    'class TypeRegistrar',
    '{',
    '    public function register(): void',
    '    {',
    '        if (!Type::hasType(PointType::NAME)) {',
    '            Type::addType(PointType::NAME, PointType::class);',
    '        }',
    '        Type::overrideType("datetime", \\App\\Doctrine\\Type\\UtcDateTimeType::class);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Repository/BaseRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'class BaseRepository',
    '{',
    '    public function find($id): ?object { return null; }',
    '    public function all(): iterable { return []; }',
    '    public function create(object $entity): object { return $entity; }',
    '    public function name(): string { return "base"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Repository/PostRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'use App\\Entity\\Post;',
    '',
    'final class PostRepository extends BaseRepository',
    '{',
    '    public function find($id): ?Post { return null; }',
    '    public function all(): array { return []; }',
    '    public function create(object $entity): Post { return $entity; }',
    '    public function name(): string { return "post"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Repository/DraftRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'class DraftRepository extends BaseRepository',
    '{',
    '    public function find($id) { return null; }',
    '    public function all(): iterable { return []; }',
    '    public function create(object $entity): mixed { return $entity; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/workflow.yaml', [
    'framework:',
    '    workflows:',
    '        publication:',
    '            type: workflow',
    '            audit_trail:',
    '                enabled: true',
    '            marking_store:',
    '                type: method',
    '                property: marking',
    '            supports:',
    '                - App\\Entity\\Post',
    '            initial_marking: draft',
    '            places:',
    '                - draft',
    '                - legal_review',
    '                - copy_review',
    '                - approved',
    '                - published',
    '            transitions:',
    '                submit:',
    '                    from: draft',
    '                    to: [legal_review, copy_review]',
    '                approve:',
    '                    from: [legal_review, copy_review]',
    '                    to: approved',
    '                publish:',
    '                    from: approved',
    '                    to: published',
    '                    guard: "is_granted(\'ROLE_EDITOR\')"',
    '        order_state:',
    '            type: state_machine',
    '            marking_store:',
    '                type: method',
    '                property: state',
    '            supports:',
    '                - App\\Entity\\Order',
    '            places: [new, paid, shipped, cancelled]',
    '            transitions:',
    '                pay:',
    '                    from: new',
    '                    to: paid',
    '                ship:',
    '                    from: paid',
    '                    to: shipped',
  ].join('\n') + '\n');

  put(root, 'src/Service/PublicationService.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\Workflow\\WorkflowInterface;',
    '',
    'class PublicationService',
    '{',
    '    public function __construct(private WorkflowInterface $publicationWorkflow) {}',
    '',
    '    public function submit(object $post): void',
    '    {',
    '        $marking = $this->publicationWorkflow->getMarking($post);',
    '        if ($this->publicationWorkflow->can($post, "submit")) {',
    '            $this->publicationWorkflow->apply($post, "submit");',
    '        }',
    '    }',
    '',
    '    public function approve(object $post): void',
    '    {',
    '        if ($this->publicationWorkflow->can($post, "approve")) {',
    '            $this->publicationWorkflow->apply($post, "approve");',
    '        }',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/GraphQL/Resolver/PostResolver.php', [
    '<?php',
    'namespace App\\GraphQL\\Resolver;',
    '',
    'use Overblog\\GraphQLBundle\\Annotation as GQL;',
    'use Overblog\\GraphQLBundle\\Definition\\Resolver\\QueryInterface;',
    '',
    '#[GQL\\Provider]',
    'class PostResolver implements QueryInterface',
    '{',
    '    #[GQL\\Query(type: "[Post]")]',
    '    public function posts(int $first = 10): array { return []; }',
    '',
    '    #[GQL\\Mutation(type: "Post")]',
    '    public function createPost(string $title): array { return []; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/graphql/types/Post.types.yaml', [
    'Post:',
    '    type: object',
    '    config:',
    '        fields:',
    '            id: { type: "ID!" }',
    '            title: { type: "String!" }',
    '            comments:',
    '                type: "[Comment]"',
    '                resolve: "@=query(\'comments\', value)"',
  ].join('\n') + '\n');

  put(root, 'src/Factory/PostFactory.php', [
    '<?php',
    'namespace App\\Factory;',
    '',
    'use App\\Entity\\Post;',
    'use Zenstruck\\Foundry\\Persistence\\PersistentProxyObjectFactory;',
    '',
    'final class PostFactory extends PersistentProxyObjectFactory',
    '{',
    '    public static function class(): string { return Post::class; }',
    '',
    '    protected function defaults(): array',
    '    {',
    '        return [',
    '            "title" => self::faker()->sentence(),',
    '            "body" => self::faker()->paragraphs(3, true),',
    '            "publishedAt" => self::faker()->dateTimeBetween("-1 year"),',
    '        ];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/DataFixtures/PostFixtures.php', [
    '<?php',
    'namespace App\\DataFixtures;',
    '',
    'use App\\Factory\\PostFactory;',
    'use Doctrine\\Bundle\\FixturesBundle\\Fixture;',
    'use Doctrine\\Persistence\\ObjectManager;',
    'use Faker\\Factory as FakerFactory;',
    '',
    'class PostFixtures extends Fixture',
    '{',
    '    public function load(ObjectManager $manager): void',
    '    {',
    '        $faker = FakerFactory::create();',
    '        PostFactory::createMany(20);',
    '        $manager->flush();',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addEcosystemMore(root: string): void {
  operations(root);
  staticAnalysis(root);
  symfonyAreas(root);
  phpHierarchies(root);
}
