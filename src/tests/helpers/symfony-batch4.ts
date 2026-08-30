// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A fourth batch: DBAL types, service decoration, Kafka schemas, password
 * upgrades, mail, named constructors, Memcached, ext-parallel, Behat and
 * the role hierarchy.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function doctrineAndDi(root: string): void {
  put(root, 'config/packages/doctrine.yaml', [
    'doctrine:',
    '    dbal:',
    '        url: "%env(resolve:DATABASE_URL)%"',
    '        charset: utf8mb4',
    '        server_version: "16"',
    '        types:',
    '            point: App\\Doctrine\\Type\\PointType',
    '            uuid: Ramsey\\Uuid\\Doctrine\\UuidType',
    '            money: Brick\\Money\\Doctrine\\MoneyType',
    '            utcdatetime: App\\Doctrine\\Type\\UtcDateTimeType',
    '        mapping_types:',
    '            enum: string',
    '            citext: string',
    '    orm:',
    '        auto_generate_proxy_classes: true',
    '        enable_lazy_ghost_objects: true',
    '        naming_strategy: doctrine.orm.naming_strategy.underscore_number_aware',
    '        report_fields_where_declared: true',
    '        mappings:',
    '            App:',
    '                type: attribute',
    '                dir: "%kernel.project_dir%/src/Entity"',
    '                prefix: App\\Entity',
    '                alias: App',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/Type/UtcDateTimeType.php', [
    '<?php',
    'namespace App\\Doctrine\\Type;',
    '',
    'use Doctrine\\DBAL\\Platforms\\AbstractPlatform;',
    'use Doctrine\\DBAL\\Types\\DateTimeImmutableType;',
    '',
    'class UtcDateTimeType extends DateTimeImmutableType',
    '{',
    '    public const NAME = "utcdatetime";',
    '',
    '    public function convertToDatabaseValue($value, AbstractPlatform $platform)',
    '    {',
    '        return parent::convertToDatabaseValue($value, $platform);',
    '    }',
    '',
    '    public function convertToPHPValue($value, AbstractPlatform $platform)',
    '    {',
    '        return parent::convertToPHPValue($value, $platform);',
    '    }',
    '',
    '    public function requiresSQLCommentHint(AbstractPlatform $platform): bool { return true; }',
    '    public function getName(): string { return self::NAME; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/services_decoration.yaml', [
    'services:',
    '    _defaults:',
    '        autowire: true',
    '        autoconfigure: true',
    '',
    '    App\\Cache\\LoggingCacheDecorator:',
    '        decorates: cache.app',
    '        arguments: ["@.inner"]',
    '        decoration_priority: 10',
    '',
    '    App\\Mailer\\ThrottlingMailerDecorator:',
    '        decorates: mailer.mailer',
    '        arguments: ["@.inner", "@limiter.mail"]',
    '',
    '    App\\Serializer\\TracingNormalizerDecorator:',
    '        decorates: serializer.normalizer.object',
    '        decoration_priority: -10',
    '        decoration_on_invalid: ignore',
    '        arguments: ["@.inner"]',
    '',
    '    App\\Cache\\MetricsCacheDecorator:',
    '        decorates: App\\Cache\\LoggingCacheDecorator',
    '        arguments: ["@.inner"]',
  ].join('\n') + '\n');

  put(root, 'src/Cache/LoggingCacheDecorator.php', [
    '<?php',
    'namespace App\\Cache;',
    '',
    'use Psr\\Cache\\CacheItemPoolInterface;',
    '',
    'class LoggingCacheDecorator implements CacheItemPoolInterface',
    '{',
    '    public function __construct(private CacheItemPoolInterface $inner) {}',
    '',
    '    public function getItem($key): mixed { return $this->inner->getItem($key); }',
    '    public function getItems(array $keys = []): iterable { return $this->inner->getItems($keys); }',
    '    public function hasItem($key): bool { return $this->inner->hasItem($key); }',
    '    public function clear(): bool { return $this->inner->clear(); }',
    '    public function deleteItem($key): bool { return $this->inner->deleteItem($key); }',
    '    public function deleteItems(array $keys): bool { return $this->inner->deleteItems($keys); }',
    '    public function save($item): bool { return $this->inner->save($item); }',
    '    public function saveDeferred($item): bool { return $this->inner->saveDeferred($item); }',
    '    public function commit(): bool { return $this->inner->commit(); }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Security/UserPasswordUpgrader.php', [
    '<?php',
    'namespace App\\Security;',
    '',
    'use App\\Entity\\User;',
    'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
    'use Symfony\\Component\\Security\\Core\\User\\PasswordAuthenticatedUserInterface;',
    'use Symfony\\Component\\Security\\Core\\User\\PasswordUpgraderInterface;',
    '',
    'class UserPasswordUpgrader extends ServiceEntityRepository implements PasswordUpgraderInterface',
    '{',
    '    public function upgradePassword(PasswordAuthenticatedUserInterface $user, string $newHashedPassword): void',
    '    {',
    '        if (!$user instanceof User) {',
    '            throw new \\LogicException("Unexpected user class");',
    '        }',
    '',
    '        $user->setPassword($newHashedPassword);',
    '        $this->getEntityManager()->persist($user);',
    '        $this->getEntityManager()->flush();',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function messagingAndCache(root: string): void {
  put(root, 'config/packages/kafka.yaml', [
    'parameters:',
    '    kafka.brokers: "%env(KAFKA_BROKERS)%"',
    '    kafka.schema_registry: "%env(SCHEMA_REGISTRY_URL)%"',
    '',
    'services:',
    '    App\\Kafka\\SchemaRegistry:',
    '        arguments:',
    '            $url: "%kafka.schema_registry%"',
    '            $compatibility: BACKWARD',
  ].join('\n') + '\n');

  put(root, 'src/Kafka/SchemaRegistry.php', [
    '<?php',
    'namespace App\\Kafka;',
    '',
    'use FlixTech\\SchemaRegistryApi\\Registry\\CachedRegistry;',
    'use FlixTech\\SchemaRegistryApi\\Registry\\PromisingRegistry;',
    'use AvroSchema;',
    '',
    'class SchemaRegistry',
    '{',
    '    public function __construct(private string $url = "http://127.0.0.1:8081") {}',
    '',
    '    public function build(): CachedRegistry',
    '    {',
    '        $schema = AvroSchema::parse(file_get_contents(__DIR__ . "/../../schemas/order.avsc"));',
    '        $registry = new CachedRegistry(new PromisingRegistry($this->client), $this->cache);',
    '',
    '        return $registry;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'schemas/order.avsc', JSON.stringify({
    type: 'record',
    name: 'Order',
    namespace: 'com.acme.orders',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'total', type: 'double' },
      { name: 'placedAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
      { name: 'note', type: ['null', 'string'], default: null },
    ],
  }, null, 2) + '\n');

  put(root, 'config/packages/memcached.yaml', [
    'framework:',
    '    cache:',
    '        app: cache.adapter.memcached',
    '        default_memcached_provider: "memcached://memcached:11211"',
    '        pools:',
    '            app.cache.sessions:',
    '                adapter: cache.adapter.memcached',
    '                provider: "memcached://memcached:11211?weight=50"',
    '                default_lifetime: 1800',
    '',
    'services:',
    '    memcached.client:',
    '        class: Memcached',
    '        factory: ["Symfony\\\\Component\\\\Cache\\\\Adapter\\\\MemcachedAdapter", createConnection]',
    '        arguments:',
    '            - "memcached://memcached:11211"',
    '            -',
    '                libketama_compatible: true',
    '                serializer: igbinary',
    '                hash: md5',
    '                binary_protocol: true',
    '                persistent_id: acme',
  ].join('\n') + '\n');

  put(root, 'src/Service/Parallelism.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use parallel\\Runtime;',
    'use parallel\\Channel;',
    'use parallel\\Future;',
    '',
    'class Parallelism',
    '{',
    '    public function run(array $jobs): array',
    '    {',
    '        $channel = Channel::make("jobs", Channel::Infinite);',
    '        $runtime = new Runtime(__DIR__ . "/../../vendor/autoload.php");',
    '        $futures = [];',
    '',
    '        foreach ($jobs as $job) {',
    '            $futures[] = $runtime->run(static function () use ($job) {',
    '                return strtoupper($job);',
    '            });',
    '        }',
    '',
    '        $results = [];',
    '        foreach ($futures as $future) {',
    '            $results[] = $future->value();',
    '        }',
    '',
    '        $runtime->close();',
    '        $channel->close();',
    '',
    '        return $results;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function mailAndTests(root: string): void {
  put(root, 'config/packages/mailer.yaml', [
    'framework:',
    '    mailer:',
    '        dsn: "%env(MAILER_DSN)%"',
    '        envelope:',
    '            sender: no-reply@example.com',
    '            recipients: ["qa@example.com"]',
    '        headers:',
    '            From: "Acme <no-reply@example.com>"',
    '            X-Mailer: acme',
  ].join('\n') + '\n');

  put(root, 'src/Mailer/InvoiceEmail.php', [
    '<?php',
    'namespace App\\Mailer;',
    '',
    'use Symfony\\Bridge\\Twig\\Mime\\TemplatedEmail;',
    'use Symfony\\Component\\Mime\\Address;',
    '',
    'class InvoiceEmail extends TemplatedEmail',
    '{',
    '    public static function forCustomer(string $email, string $reference): self',
    '    {',
    '        return (new self())',
    '            ->from(new Address("no-reply@example.com", "Acme"))',
    '            ->to($email)',
    '            ->subject("Invoice " . $reference)',
    '            ->htmlTemplate("emails/invoice.html.twig")',
    '            ->textTemplate("emails/invoice.txt.twig")',
    '            ->context(["reference" => $reference]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Mailer/PlainEmail.php', [
    '<?php',
    'namespace App\\Mailer;',
    '',
    'use Symfony\\Component\\Mime\\Email;',
    '',
    'class PlainEmail extends Email',
    '{',
    '    public static function alert(string $to, string $body): self',
    '    {',
    '        $email = new self();',
    '        $email->to($to)->subject("Alert")->text($body);',
    '        $email->addTo("ops@example.com");',
    '',
    '        return $email;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/emails/invoice.html.twig', [
    '{% extends "emails/layout.html.twig" %}',
    '{% block content %}',
    '    <h1>Invoice {{ reference }}</h1>',
    '    <p>Total: {{ total|format_currency("EUR") }}</p>',
    '    <img src="{{ email.image("@images/logo.png") }}" alt="Acme">',
    '{% endblock %}',
  ].join('\n') + '\n');

  put(root, 'templates/emails/invoice.txt.twig', 'Invoice {{ reference }}\nTotal: {{ total }}\n');
  put(root, 'templates/emails/layout.html.twig', '<html><body>{% block content %}{% endblock %}</body></html>\n');

  put(root, 'src/Domain/Money.php', [
    '<?php',
    'namespace App\\Domain;',
    '',
    'final class Money',
    '{',
    '    private function __construct(',
    '        public readonly int $amount,',
    '        public readonly string $currency,',
    '    ) {}',
    '',
    '    public static function fromCents(int $cents, string $currency = "EUR"): self',
    '    {',
    '        return new self($cents, $currency);',
    '    }',
    '',
    '    public static function ofEuros(float $euros): static',
    '    {',
    '        return new static((int) round($euros * 100), "EUR");',
    '    }',
    '',
    '    public static function createZero(): Money',
    '    {',
    '        return new Money(0, "EUR");',
    '    }',
    '',
    '    public static function buildFromString(string $raw)',
    '    {',
    '        return new self((int) $raw, "EUR");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'behat.yaml', [
    'default:',
    '    suites:',
    '        default:',
    '            paths: ["%paths.base%/features"]',
    '            contexts: [App\\Tests\\Behat\\FeatureContext]',
    '        api:',
    '            paths: ["%paths.base%/features/api"]',
    '            contexts: [App\\Tests\\Behat\\ApiContext]',
    '            filters:',
    '                tags: "@api"',
    '    extensions:',
    '        FriendsOfBehat\\SymfonyExtension: ~',
    '        Behat\\MinkExtension:',
    '            base_url: "http://localhost:8000"',
    '            sessions:',
    '                default:',
    '                    symfony: ~',
    '                javascript:',
    '                    panther: ~',
  ].join('\n') + '\n');

  put(root, 'features/checkout.feature', [
    '@checkout @javascript',
    'Feature: Checkout',
    '    In order to buy things',
    '    As a customer',
    '    I need to complete an order',
    '',
    '    Background:',
    '        Given I am logged in as "buyer@example.com"',
    '',
    '    @smoke',
    '    Scenario: Cart totals',
    '        Given I have 2 items in the cart',
    '        When I open the cart',
    '        Then I should see "2 items"',
    '',
    '    @wip @ignore',
    '    Scenario: Discount codes',
    '        Given I have a discount code',
    '        Then the total drops',
  ].join('\n') + '\n');

  put(root, 'features/api/orders.feature', [
    '@api',
    'Feature: Orders API',
    '',
    '    @browser @chrome',
    '    Scenario: List orders',
    '        When I send a GET request to "/api/v2/orders"',
    '        Then the response status code should be 200',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchFour(root: string): void {
  doctrineAndDi(root);
  messagingAndCache(root);
  mailAndTests(root);
}
