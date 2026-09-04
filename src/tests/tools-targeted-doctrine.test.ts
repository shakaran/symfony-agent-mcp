// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * More applications written for one module at a time: identifiers, the
 * second level cache, entity listeners, serializer groups and the push
 * notification transports.
 *
 * Same idea as the first file, kept apart so each stays readable.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-doctrine-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: {
        'symfony/framework-bundle': '^7.0',
        'doctrine/orm': '^3.0',
        'symfony/uid': '^7.0',
        'symfony/notifier': '^7.0',
        'symfony/serializer': '^7.0',
      },
    }));
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

describe('another application for one module', () => {
  test('entities keyed by UUID and by ULID, and one on an integer', async () => {
    const app = appWith('uid', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    dbal:',
        '        types:',
        '            uuid: Symfony\\Bridge\\Doctrine\\Types\\UuidType',
        '            ulid: Symfony\\Bridge\\Doctrine\\Types\\UlidType',
        '    orm:',
        '        auto_mapping: true',
      ].join('\n') + '\n',
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Uid\\Uuid;',
        '',
        '#[ORM\\Entity]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\Column(type: "uuid", unique: true)]',
        '    #[ORM\\GeneratedValue(strategy: "CUSTOM")]',
        '    #[ORM\\CustomIdGenerator(class: "doctrine.uuid_generator")]',
        '    private ?Uuid $id = null;',
        '',
        '    public function __construct()',
        '    {',
        '        $this->id = Uuid::v7();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Invoice.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Uid\\Ulid;',
        '',
        '#[ORM\\Entity]',
        'class Invoice',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\Column(type: "ulid", unique: true)]',
        '    private Ulid $id;',
        '',
        '    public function __construct()',
        '    {',
        '        $this->id = new Ulid();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/LegacyRow.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class LegacyRow',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
      'src/Service/Identifiers.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Symfony\\Component\\Uid\\Factory\\UlidFactory;',
        'use Symfony\\Component\\Uid\\Factory\\UuidFactory;',
        'use Symfony\\Component\\Uid\\Uuid;',
        '',
        'class Identifiers',
        '{',
        '    public function __construct(private UuidFactory $uuids, private UlidFactory $ulids) {}',
        '',
        '    public function make(): array',
        '    {',
        '        return [',
        '            Uuid::v4(),',
        '            Uuid::v6(),',
        '            Uuid::v7(),',
        '            $this->uuids->create(),',
        '            $this->ulids->create(),',
        '        ];',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-uid.js', app, ['Order']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('the second level cache, on and off, with regions', async () => {
    const app = appWith('second-level-cache', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        second_level_cache:',
        '            enabled: true',
        '            log_enabled: true',
        '            region_cache_driver:',
        '                type: pool',
        '                pool: cache.doctrine.second_level',
        '            regions:',
        '                product_region:',
        '                    lifetime: 3600',
        '                    cache_driver:',
        '                        type: pool',
        '                        pool: cache.doctrine.second_level',
        '                volatile_region:',
        '                    lifetime: 5',
        '        entity_managers:',
        '            default:',
        '                second_level_cache:',
        '                    enabled: true',
      ].join('\n') + '\n',
      'src/Entity/Product.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Cache(usage: "READ_ONLY", region: "product_region")]',
        'class Product',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Cache(usage: "NONSTRICT_READ_WRITE")]',
        '    #[ORM\\ManyToOne(targetEntity: Category::class)]',
        '    private ?Category $category = null;',
        '',
        '    #[ORM\\Cache(usage: "READ_WRITE", region: "volatile_region")]',
        '    #[ORM\\OneToMany(targetEntity: Variant::class, mappedBy: "product")]',
        '    private $variants;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Category.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Category',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('doctrine-second-level-cache.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('entity listeners, as attributes and as tagged services', async () => {
    const app = appWith('entity-listeners', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        auto_mapping: true',
      ].join('\n') + '\n',
      'config/services.yaml': [
        'services:',
        '    App\\EventListener\\OrderListener:',
        '        tags:',
        '            - { name: doctrine.orm.entity_listener, event: prePersist, entity: App\\Entity\\Order }',
        '            - { name: doctrine.orm.entity_listener, event: postUpdate, entity: App\\Entity\\Order, lazy: true }',
        '',
        '    App\\EventListener\\AuditListener:',
        '        tags:',
        '            - { name: doctrine.event_listener, event: onFlush, priority: 10 }',
        '            - { name: doctrine.event_listener, event: postFlush }',
        '',
        '    App\\EventListener\\UntaggedListener: ~',
      ].join('\n') + '\n',
      'src/EventListener/OrderListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use App\\Entity\\Order;',
        'use Doctrine\\Bundle\\DoctrineBundle\\Attribute\\AsEntityListener;',
        'use Doctrine\\ORM\\Event\\PrePersistEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        '#[AsEntityListener(event: Events::prePersist, method: "onPrePersist", entity: Order::class)]',
        '#[AsEntityListener(event: Events::postUpdate, method: "onPostUpdate", entity: Order::class, lazy: true)]',
        'class OrderListener',
        '{',
        '    public function onPrePersist(Order $order, PrePersistEventArgs $args): void',
        '    {',
        '        $args->getObjectManager()->flush();',
        '    }',
        '',
        '    public function onPostUpdate(Order $order): void { }',
        '}',
      ].join('\n') + '\n',
      'src/EventListener/AuditListener.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use Doctrine\\Bundle\\DoctrineBundle\\Attribute\\AsDoctrineListener;',
        'use Doctrine\\ORM\\Event\\OnFlushEventArgs;',
        'use Doctrine\\ORM\\Events;',
        '',
        '#[AsDoctrineListener(event: Events::onFlush, priority: 10, connection: "default")]',
        'class AuditListener',
        '{',
        '    public function onFlush(OnFlushEventArgs $args): void',
        '    {',
        '        $uow = $args->getObjectManager()->getUnitOfWork();',
        '        foreach ($uow->getScheduledEntityUpdates() as $entity) {',
        '            $uow->computeChangeSet($args->getObjectManager()->getClassMetadata($entity::class), $entity);',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use App\\EventListener\\OrderListener;',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\EntityListeners([OrderListener::class])]',
        '#[ORM\\HasLifecycleCallbacks]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\PrePersist]',
        '    public function stampCreatedAt(): void { }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('doctrine-entity-listeners.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('serializer groups, one of them carrying a field that should not travel', async () => {
    const app = appWith('serializer-groups', {
      'src/Entity/User.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        'use Symfony\\Component\\Serializer\\Annotation\\Ignore;',
        'use Symfony\\Component\\Serializer\\Annotation\\MaxDepth;',
        'use Symfony\\Component\\Serializer\\Annotation\\SerializedName;',
        '',
        '#[ORM\\Entity]',
        'class User',
        '{',
        "    #[Groups(['user:read', 'public'])]",
        '    public int $id = 0;',
        '',
        "    #[Groups(['user:read', 'user:write', 'public'])]",
        '    public string $email = "";',
        '',
        "    #[Groups(['public'])]",
        '    public string $password = "";',
        '',
        "    #[Groups(['user:read'])]",
        '    #[SerializedName("api_token")]',
        '    public string $apiToken = "";',
        '',
        '    #[Ignore]',
        '    public string $salt = "";',
        '',
        "    #[Groups(['user:read'])]",
        '    #[MaxDepth(1)]',
        '    public array $orders = [];',
        '',
        '    public string $undocumented = "";',
        '}',
      ].join('\n') + '\n',
      'src/Dto/PublicProfile.php': [
        '<?php',
        'namespace App\\Dto;',
        '',
        'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
        '',
        'final class PublicProfile',
        '{',
        '    public function __construct(',
        "        #[Groups(['public'])]",
        '        public readonly string $displayName,',
        "        #[Groups(['public', 'admin'])]",
        '        public readonly string $secretNote = "",',
        '    ) {}',
        '}',
      ].join('\n') + '\n',
      'config/packages/serializer.yaml': [
        'framework:',
        '    serializer:',
        '        enable_attributes: true',
        '        default_context:',
        '            enable_max_depth: true',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-serializer-groups.js', app, ['public', 'user:read']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('push notifications, with the token in configuration and in code', async () => {
    const app = appWith('notifier-push', {
      'config/packages/notifier.yaml': [
        'framework:',
        '    notifier:',
        '        texter_transports:',
        '            twilio: "%env(TWILIO_DSN)%"',
        '        chatter_transports:',
        '            slack: "%env(SLACK_DSN)%"',
        '            telegram: "telegram://0123456789:AAAAaaaaBBBBccccDDDDeeeeFFFFgggg@default?channel=@acme"',
        '        channel_policy:',
        '            urgent: ["chat/slack", "sms/twilio"]',
        '            high: ["chat/slack"]',
        '            low: ["email"]',
        '        admin_recipients:',
        '            - { email: ops@example.com, phone: "+34600000000" }',
      ].join('\n') + '\n',
      '.env': [
        'TWILIO_DSN=twilio://SID:TOKEN@default?from=+34600000000',
        'SLACK_DSN=slack://TOKEN@default?channel=alerts',
        'EXPO_TOKEN=ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
        'FIREBASE_SERVER_KEY=AAAAbbbbccccddddeeeeffffgggghhhh',
      ].join('\n') + '\n',
      'src/Notification/OrderNotification.php': [
        '<?php',
        'namespace App\\Notification;',
        '',
        'use Symfony\\Component\\Notifier\\Bridge\\Firebase\\Notification\\FirebaseNotification;',
        'use Symfony\\Component\\Notifier\\Message\\PushMessage;',
        'use Symfony\\Component\\Notifier\\Notification\\Notification;',
        'use Symfony\\Component\\Notifier\\Recipient\\Recipient;',
        '',
        'class OrderNotification extends Notification',
        '{',
        '    public function asPushMessage(Recipient $recipient, ?string $transport = null): ?PushMessage',
        '    {',
        '        return new PushMessage($this->getSubject(), $this->getContent());',
        '    }',
        '',
        '    public function toFirebase(string $body): FirebaseNotification',
        '    {',
        '        $message = new FirebaseNotification($body);',
        '        $message->setData(["orderId" => $_GET["order"]]);',
        '',
        '        return $message;',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-notifier-push.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
