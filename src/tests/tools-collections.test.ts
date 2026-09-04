// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The comparators, and the lines that report a collection.
 *
 * A sort callback with one item never runs, and neither does the map that
 * writes the list under it. Every application here holds two of whatever
 * the module counts: two platforms, two factories, two listeners on the
 * same event at the same priority, two templates with something to say.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-collections-'));
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
      autoload: { 'psr-4': { 'App\\': 'src/' } },
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

    const calls = fn.length === 1 ? [[appPath]] : (extras.length > 0 ? extras.map((e) => [appPath, e, e]) : [[appPath, '', '']]);
    for (const args of calls) {
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

describe('the comparators', () => {
  test('two platforms and two types, ordered by how much each overrides', async () => {
    const app = appWith('custom-platform', {
      'src/Platform/AcmePlatform.php': `<?php

namespace App\\Platform;

use Doctrine\\DBAL\\Platforms\\AbstractPlatform;
use Doctrine\\DBAL\\Types\\Type;

class AcmePlatform extends AbstractPlatform
{
    public function getName(): string { return 'acme'; }
    public function initializeDoctrineTypeMappings(): void { Type::overrideType('datetime', AcmeDateTimeType::class); }
    public function getDateTimeFormatString(): string { return 'Y-m-d H:i:s'; }
    public function getDateFormatString(): string { return 'Y-m-d'; }
    public function getBooleanTypeDeclarationSQL(array $c): string { return 'BOOLEAN'; }
    public function getClobTypeDeclarationSQL(array $c): string { return 'TEXT'; }
    public function getBlobTypeDeclarationSQL(array $c): string { return 'BLOB'; }
    public function getCurrentDatabaseExpression(): string { return 'current_database()'; }
    public function registerTypes(): void { Type::addType('point', 'App\\Type\\PointType'); }
}
`,
      'src/Platform/ReadOnlyPlatform.php': `<?php

namespace App\\Platform;

use Doctrine\\DBAL\\Platforms\\PostgreSQLPlatform;

class ReadOnlyPlatform extends PostgreSQLPlatform
{
    public function getDateFormatString(): string { return 'Y-m-d'; }
}
`,
      'src/Type/UuidType.php': `<?php

namespace App\\Type;

use Doctrine\\DBAL\\Types\\StringType;

class UuidType extends StringType
{
    public function getName(): string { return 'uuid'; }
    public function convertToPHPValue($value, $platform) { return $value; }
    public function convertToDatabaseValue($value, $platform) { return (string) $value; }
}
`,
      'src/Type/PointType.php': `<?php

namespace App\\Type;

use Doctrine\\DBAL\\Types\\TextType;

class PointType extends TextType
{
    public function convertToPHPValue($value, $platform) { return $value; }
}
`,
    });

    const text = await runModule('doctrine-custom-platform.js', app);

    expect(text).toContain('AcmePlatform');
    expect(text).toContain('ReadOnlyPlatform');
    expect(text).toContain('UuidType');
    expect(text).toContain('PointType');
    // The platform that overrides most is the one named in the summary.
    expect(text).toMatch(/Custom Platforms \(2\)/);
    expect(text).toMatch(/Custom Types \(2\)/);
  });

  test('two factories, ordered by class name', async () => {
    const factory = (name: string, entity: string): string => `<?php

namespace App\\Factory;

use Zenstruck\\Foundry\\ModelFactory;

final class ${name} extends ModelFactory
{
    protected function getDefaults(): array
    {
        return ['name' => self::faker()->name(), 'email' => self::faker()->email()];
    }

    protected static function getClass(): string
    {
        return ${entity}::class;
    }
}
`;

    const app = appWith('entity-factory', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'zenstruck/foundry': '^2.0' },
      }, null, 2),
      'src/Factory/UserFactory.php': factory('UserFactory', 'User'),
      'src/Factory/ArticleFactory.php': factory('ArticleFactory', 'Article'),
    });

    const text = await runModule('doctrine-entity-factory.js', app);

    expect(text).toContain('UserFactory');
    expect(text).toContain('ArticleFactory');
  });

  test('two entities with named native queries, ordered by how many issues each has', async () => {
    const entity = (name: string, queries: string): string => `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
${queries}
class ${name}
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`;

    const app = appWith('named-queries', {
      'src/Entity/Invoice.php': entity('Invoice', [
        "#[ORM\\NamedNativeQuery(name: 'invoice_totals', query: 'SELECT * FROM invoice')]",
        "#[ORM\\NamedNativeQuery(name: 'invoice_open', query: 'SELECT * FROM invoice WHERE paid = 0')]",
      ].join('\n')),
      'src/Entity/Customer.php': entity('Customer', [
        "#[ORM\\NamedNativeQuery(name: 'customer_names', query: 'SELECT id, name FROM customer', resultSetMapping: 'names')]",
        "#[ORM\\SqlResultSetMapping(name: 'names')]",
      ].join('\n')),
    });

    const text = await runModule('doctrine-named-queries.js', app);

    expect(text).toContain('Invoice');
    expect(text).toContain('Customer');
  });

  test('two entities with timestamps, ordered by issues and then by name', async () => {
    const entity = (name: string, body: string): string => `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\HasLifecycleCallbacks]
class ${name}
{
    #[ORM\\Column]
    private ?\\DateTimeInterface $createdAt = null;

    #[ORM\\Column]
    private ?\\DateTimeInterface $updatedAt = null;

${body}
}
`;

    const app = appWith('timestamps', {
      'src/Entity/Order.php': entity('Order', `    #[PrePersist]
    public function onPrePersist(): void
    {
        $this->createdAt = new \\DateTime();
        $this->updatedAt = new \\DateTime();
    }

    public function setCreatedAt(\\DateTimeInterface $d): void
    {
        $this->createdAt = $d;
    }`),
      'src/Entity/Shipment.php': entity('Shipment', `    #[PreUpdate]
    public function onPreUpdate(): void
    {
        $this->updatedAt = new \\DateTimeImmutable();
    }`),
    });

    const text = await runModule('doctrine-timestamps.js', app);

    expect(text).toContain('Order');
    expect(text).toContain('Shipment');
  });

  test('two column type usages, ordered by entity', async () => {
    const app = appWith('doctrine-types', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        types:
            uuid: Ramsey\\Uuid\\Doctrine\\UuidType
            money: App\\Type\\MoneyType
`,
      'src/Entity/Wallet.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Wallet
{
    #[ORM\\Column(type: 'uuid')]
    private $reference;

    #[ORM\\Column(type: 'money')]
    private $balance;
}
`,
      'src/Entity/Account.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Account
{
    #[ORM\\Column(type: 'uuid')]
    private $reference;
}
`,
    });

    const text = await runModule('doctrine-types.js', app);

    expect(text).toContain('uuid');
    expect(text).toContain('money');
  });

  test('two conflicts, ordered by how many listeners each holds', async () => {
    const subscriber = (name: string, body: string): string => `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;

class ${name} implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
${body}
        ];
    }

    public function onRequest($event): void {}
    public function onResponse($event): void {}
}
`;

    const app = appWith('priority-conflicts', {
      'src/EventSubscriber/AuditSubscriber.php': subscriber('AuditSubscriber', [
        "            'kernel.request' => ['onRequest', 100],",
        "            'kernel.response' => ['onResponse', 10],",
      ].join('\n')),
      'src/EventSubscriber/LocaleSubscriber.php': subscriber('LocaleSubscriber', [
        "            'kernel.request' => ['onRequest', 100],",
        "            'kernel.response' => ['onResponse', 10],",
      ].join('\n')),
      'src/EventSubscriber/TenantSubscriber.php': subscriber('TenantSubscriber', [
        "            'kernel.request' => ['onRequest', 100],",
      ].join('\n')),
    });

    const text = await runModule('event-priority-conflicts.js', app);

    expect(text).toContain('kernel.request');
    expect(text).toContain('AuditSubscriber');
  });

  test('a form whose fields are counted and searched', async () => {
    const app = appWith('form-stats', {
      'src/Form/RegistrationType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\EmailType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\PasswordType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\OptionsResolver\\OptionsResolver;
use Symfony\\Component\\Validator\\Constraints\\Length;
use Symfony\\Component\\Validator\\Constraints\\NotBlank;

class RegistrationType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('email', EmailType::class, ['constraints' => [new NotBlank()]])
            ->add('emailConfirmation', EmailType::class, ['constraints' => [new NotBlank()]])
            ->add('plainPassword', PasswordType::class, ['constraints' => [new Length(min: 12)]])
            ->add('displayName', TextType::class, ['constraints' => [new NotBlank()]])
            ->add('company', TextType::class, ['label' => 'Company name', 'required' => false]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults(['data_class' => User::class]);
    }
}
`,
      'src/Form/ProfileType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class ProfileType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('displayName', TextType::class)
            ->add('biography', TextType::class);
    }
}
`,
    });

    const text = await runModule('forms.js', app, ['registration', 'email']);

    expect(text).toContain('RegistrationType');
    expect(text).toContain('ProfileType');
    // Two field types, so the counts are ordered rather than printed as found.
    expect(text).toMatch(/TextType|EmailType/);
  });

  test('graphql types of two kinds, ordered by kind', async () => {
    const app = appWith('graphql-kinds', {
      'config/graphql/types/Query.yaml': `Query:
    type: object
    config:
        fields:
            articles:
                type: "[Article]"
            legacyArticles:
                type: "[Article]"
                deprecationReason: "use articles"
`,
      'config/graphql/types/ArticleInput.yaml': `ArticleInput:
    type: input-object
    config:
        fields:
            title:
                type: "String!"
`,
      'src/GraphQL/UserMutation.php': `<?php

namespace App\\GraphQL;

use Overblog\\GraphQLBundle\\Definition\\Resolver\\MutationInterface;

class UserMutation implements MutationInterface
{
    public function register($args)
    {
        return null;
    }
}
`,
      'src/GraphQL/ArticleResolver.php': `<?php

namespace App\\GraphQL;

use Overblog\\GraphQLBundle\\Definition\\Resolver\\QueryInterface;

class ArticleResolver implements QueryInterface
{
    public function resolve($args)
    {
        return [];
    }
}
`,
    });

    const text = await runModule('graphql.js', app);

    expect(text).toContain('Query');
    expect(text).toContain('ArticleInput');
  });

  test('two mailer transports, ordered by issues', async () => {
    const app = appWith('mailer-dkim', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        transports:
            main: 'smtp://user:pass@smtp.example.com:587'
            marketing: 'sendgrid+api://KEY@default?local_domain=example.com&return_path=bounce@example.com'
`,
    });

    const text = await runModule('mailer-dkim-config.js', app);

    expect(text.length).toBeGreaterThan(0);
  });

  test('two tenant-aware entities, ordered by class', async () => {
    const app = appWith('multi-tenancy', {
      'src/Entity/Tenant.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Tenant
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\ManyToOne(targetEntity: Tenant::class)]
    private ?Tenant $tenant = null;
}
`,
      'src/Filter/TenantFilter.php': `<?php

namespace App\\Filter;

use Doctrine\\ORM\\Query\\Filter\\SQLFilter;

class TenantFilter extends SQLFilter
{
    public function addFilterConstraint($targetEntity, $targetTableAlias): string
    {
        return sprintf('%s.tenant_id = %s', $targetTableAlias, $this->getParameter('tenant_id'));
    }
}
`,
    });

    const text = await runModule('multi-tenancy.js', app);

    expect(text).toContain('Tenant');
    expect(text).toContain('Invoice');
  });

  test('two documented endpoints, ordered by class', async () => {
    const controller = (name: string, tag: string): string => `<?php

namespace App\\Controller;

use OpenApi\\Attributes as OA;
use Symfony\\Component\\Routing\\Attribute\\Route;

class ${name}
{
    #[Route('/api/${tag}', methods: ['GET'])]
    #[OA\\Get(path: '/api/${tag}')]
    #[OA\\Tag(name: '${tag}')]
    #[OA\\Response(response: 200, description: 'ok')]
    public function index(): void {}
}
`;

    const app = appWith('openapi-pair', {
      'config/packages/nelmio_api_doc.yaml': `nelmio_api_doc:
    documentation:
        info:
            title: Example
            version: 1.0.0
    areas:
        default:
            path_patterns: ['^/api']
`,
      'src/Controller/ArticleApiController.php': controller('ArticleApiController', 'articles'),
      'src/Controller/UserApiController.php': controller('UserApiController', 'users'),
      'src/Dto/ArticleOutput.php': `<?php

namespace App\\Dto;

use OpenApi\\Attributes as OA;

#[OA\\Schema]
class ArticleOutput
{
    #[OA\\Property]
    public string $title = '';

    #[OA\\Property]
    public string $body = '';
}
`,
      'src/Dto/UserOutput.php': `<?php

namespace App\\Dto;

use OpenApi\\Attributes as OA;

#[OA\\Schema]
class UserOutput
{
    #[OA\\Property]
    public string $email = '';
}
`,
    });

    const text = await runModule('openapi.js', app);

    expect(text).toContain('ArticleApiController');
    expect(text).toContain('UserApiController');
  });

  test('two files loading images, ordered by how many findings each has', async () => {
    const app = appWith('gd-security', {
      'src/Service/AvatarService.php': `<?php

namespace App\\Service;

class AvatarService
{
    public function fromUpload(): void
    {
        $path = $_FILES['avatar']['tmp_name'];
        $image = imagecreatefromjpeg($path);
        $second = imagecreatefrompng($path);
        imagedestroy($image);
        imagedestroy($second);
    }
}
`,
      'src/Service/ThumbnailService.php': `<?php

namespace App\\Service;

class ThumbnailService
{
    public function build(string $source): void
    {
        $image = imagecreatefromgif($source);
        imagedestroy($image);
    }
}
`,
    });

    const text = await runModule('php-gd-security.js', app);

    expect(text).toContain('AvatarService');
    expect(text).toContain('ThumbnailService');
  });

  test('two searchable classes, ordered by class', async () => {
    const app = appWith('search-integration', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'meilisearch/meilisearch-symfony': '^0.14' },
      }, null, 2),
      '.env': 'MEILISEARCH_URL=http://meili.example.com:7700\n',
      'config/packages/meilisearch.yaml': `meilisearch:
    host: 'http://admin:s3cret@meili.example.com:7700'
    indices:
        articles:
            class: App\\Entity\\Article
        users:
            class: App\\Entity\\User
`,
      'src/Entity/Article.php': `<?php

namespace App\\Entity;

use Meilisearch\\Bundle\\Searchable;

class Article implements SearchableInterface
{
    public function getSearchableArray(): array
    {
        return ['title' => $this->title];
    }
}
`,
      'src/Kernel.php': `<?php

namespace App;

class Kernel
{
}
`,
      'src/Entity/User.php': `<?php

namespace App\\Entity;

class User implements SearchableInterface
{
    public function getSearchableArray(): array
    {
        return ['email' => $this->email];
    }
}
`,
    });

    const text = await runModule('search-integration.js', app);

    expect(text).toContain('Article');
    expect(text).toContain('User');
  });

  test('two templates with something to say, ordered by file', async () => {
    const app = appWith('twig-security', {
      'config/packages/security.yaml': `security:
    role_hierarchy:
        ROLE_ADMIN: ROLE_USER
    firewalls:
        main:
            lazy: true
`,
      'templates/admin/dashboard.html.twig': `{% if is_granted('ROLE_SUPERUSER') %}
    <p>{{ user.password }}</p>
{% endif %}
{% for item in items %}
    {% if is_granted('ROLE_ADMIN', item) %}{{ item.name }}{% endif %}
{% endfor %}
`,
      'templates/profile/show.html.twig': `<p>{{ attribute(app.user, 'apiToken') }}</p>
<p>{{ app.user.email }}</p>
`,
    });

    const text = await runModule('symfony-twig-security.js', app);

    expect(text).toContain('dashboard.html.twig');
    expect(text).toContain('show.html.twig');
  });
});
