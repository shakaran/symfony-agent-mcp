// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * An application holding two of everything.
 *
 * A comparator only runs when there are two things to compare, and a good
 * number of these modules sort their findings before printing them. One
 * finding leaves that sort — and the report line it feeds — unreached, so
 * everything here comes in pairs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
let app: string;

const FILES: Record<string, string> = {
  'composer.json': JSON.stringify({
    require: {
      'php': '>=8.3',
      'symfony/framework-bundle': '^7.0',
      'doctrine/orm': '^3.0',
      'api-platform/core': '^3.2',
      'nelmio/api-doc-bundle': '^4.25',
      'stof/doctrine-extensions-bundle': '^1.11',
      'flagception/flagception-bundle': '^2.4',
    },
  }, null, 2) + '\n',

  'config/packages/doctrine.yaml': [
    'doctrine:',
    '    dbal:',
    '        url: "%env(resolve:DATABASE_URL)%"',
    '    orm:',
    '        mappings:',
    '            App:',
    '                type: attribute',
    '                dir: "%kernel.project_dir%/src/Entity"',
    '                prefix: App\\Entity',
    '            Legacy:',
    '                type: xml',
    '                dir: "%kernel.project_dir%/config/doctrine"',
    '                prefix: App\\Legacy',
    '            Annotated:',
    '                type: annotation',
    '                dir: "%kernel.project_dir%/src/Annotated"',
    '                prefix: App\\Annotated',
  ].join('\n') + '\n',

  'config/doctrine/Legacy.Order.orm.xml': [
    '<?xml version="1.0"?>',
    '<doctrine-mapping xmlns="http://doctrine-project.org/schemas/orm/doctrine-mapping">',
    '    <entity name="App\\Legacy\\Order" table="legacy_order">',
    '        <id name="id" type="integer"><generator strategy="AUTO"/></id>',
    '    </entity>',
    '</doctrine-mapping>',
  ].join('\n') + '\n',

  'config/packages/mailer.yaml': [
    'framework:',
    '    mailer:',
    '        dsn: "%env(MAILER_DSN)%"',
    '        envelope:',
    '            sender: no-reply@example.com',
    '        headers:',
    '            From: "Acme <no-reply@example.com>"',
    '',
    'services:',
    '    App\\Mailer\\DkimSigner:',
    '        arguments:',
    '            $privateKey: "%env(DKIM_PRIVATE_KEY)%"',
    '            $domain: example.com',
    '            $selector: acme',
  ].join('\n') + '\n',

  'src/Mailer/DkimSigner.php': [
    '<?php',
    'namespace App\\Mailer;',
    '',
    'use Symfony\\Component\\Mime\\Crypto\\DkimSigner;',
    'use Symfony\\Component\\Mime\\Message;',
    '',
    'class DkimSigner',
    '{',
    '    public function sign(Message $message): Message',
    '    {',
    '        $signer = new \\Symfony\\Component\\Mime\\Crypto\\DkimSigner($this->privateKey, "example.com", "acme");',
    '        $second = new \\Symfony\\Component\\Mime\\Crypto\\DkimSigner($this->privateKey, "acme.example.com", "backup");',
    '',
    '        return $signer->sign($message);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/EventSubscriber/FirstSubscriber.php': [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    'class FirstSubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents(): array',
    '    {',
    '        return [',
    '            KernelEvents::REQUEST => ["onRequest", 100],',
    '            KernelEvents::RESPONSE => ["onResponse", 50],',
    '        ];',
    '    }',
    '',
    '    public function onRequest($event): void { }',
    '    public function onResponse($event): void { }',
    '}',
  ].join('\n') + '\n',

  'src/EventSubscriber/SecondSubscriber.php': [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    'class SecondSubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents(): array',
    '    {',
    '        return [',
    '            KernelEvents::REQUEST => ["onRequest", 100],',
    '            KernelEvents::RESPONSE => ["onResponse", 50],',
    '        ];',
    '    }',
    '',
    '    public function onRequest($event): void { }',
    '    public function onResponse($event): void { }',
    '}',
  ].join('\n') + '\n',

  'src/Collection/FirstCollection.php': [
    '<?php',
    'namespace App\\Collection;',
    '',
    'class FirstCollection',
    '{',
    '    public function items(): \\Countable&\\Iterator',
    '    {',
    '        return $this->items;',
    '    }',
    '',
    '    public function traversable(): \\Countable&\\Traversable',
    '    {',
    '        return $this->items;',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Collection/SecondCollection.php': [
    '<?php',
    'namespace App\\Collection;',
    '',
    'use Symfony\\Contracts\\Cache\\CacheInterface;',
    'use Psr\\Log\\LoggerInterface;',
    '',
    'class SecondCollection',
    '{',
    '    public function __construct(private CacheInterface&LoggerInterface $both) {}',
    '',
    '    public function all(): \\Countable&\\Iterator',
    '    {',
    '        return $this->items;',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Entity/Article.php': [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Gedmo\\Mapping\\Annotation as Gedmo;',
    '',
    '#[ORM\\Entity]',
    '#[ORM\\HasLifecycleCallbacks]',
    'class Article',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[Gedmo\\Timestampable(on: "create")]',
    '    #[ORM\\Column(type: "datetime_immutable")]',
    '    private ?\\DateTimeImmutable $createdAt = null;',
    '',
    '    #[ORM\\Column(type: "datetime", nullable: true)]',
    '    private ?\\DateTime $updatedAt = null;',
    '',
    '    #[ORM\\PrePersist]',
    '    public function setCreatedAt(): void',
    '    {',
    '        $this->createdAt = new \\DateTimeImmutable();',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Entity/Comment.php': [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    'class Comment',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Column(type: "datetime")]',
    '    private ?\\DateTime $createdAt = null;',
    '',
    '    public function setCreatedAt(\\DateTime $when): void',
    '    {',
    '        $this->createdAt = $when;',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Domain/Amount.php': [
    '<?php',
    'namespace App\\Domain;',
    '',
    'declare(strict_types=1);',
    '',
    'final class Amount',
    '{',
    '    public const int PRECISION = 2;',
    '    public const string CURRENCY = "EUR";',
    '    public const MAX = 1000000;',
    '    private const LEGACY_FACTOR = 100;',
    '',
    '    private function __construct(public readonly int $cents) {}',
    '',
    '    public static function fromCents(int $cents): self { return new self($cents); }',
    '    public static function fromEuros(float $euros): static { return new static((int) ($euros * 100)); }',
    '}',
  ].join('\n') + '\n',

  'src/Domain/Percentage.php': [
    '<?php',
    'namespace App\\Domain;',
    '',
    'final class Percentage',
    '{',
    '    public const SCALE = 4;',
    '    public const NAME = "percentage";',
    '',
    '    private function __construct(public readonly float $value) {}',
    '',
    '    public static function of(float $value): self { return new self($value); }',
    '    public static function fromBasisPoints(int $points): self { return new self($points / 10000); }',
    '}',
  ].join('\n') + '\n',

  'src/Trait/FirstTrait.php': [
    '<?php',
    'namespace App\\Traits;',
    '',
    'trait FirstTrait',
    '{',
    '    public function describe(): string { return "first"; }',
    '    public function name(): string { return "first"; }',
    '}',
  ].join('\n') + '\n',

  'src/Trait/SecondTrait.php': [
    '<?php',
    'namespace App\\Traits;',
    '',
    'trait SecondTrait',
    '{',
    '    public function describe(): string { return "second"; }',
    '    public function label(): string { return "second"; }',
    '}',
  ].join('\n') + '\n',

  'src/Service/Combined.php': [
    '<?php',
    'namespace App\\Service;',
    '',
    'use App\\Traits\\FirstTrait;',
    'use App\\Traits\\SecondTrait;',
    '',
    'class Combined',
    '{',
    '    use FirstTrait, SecondTrait {',
    '        FirstTrait::describe insteadof SecondTrait;',
    '        SecondTrait::describe as describeSecond;',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Service/AlsoCombined.php': [
    '<?php',
    'namespace App\\Service;',
    '',
    'use App\\Traits\\FirstTrait;',
    'use App\\Traits\\SecondTrait;',
    '',
    'class AlsoCombined',
    '{',
    '    use FirstTrait, SecondTrait;',
    '}',
  ].join('\n') + '\n',

  'src/ApiResource/PagedFirst.php': [
    '<?php',
    'namespace App\\ApiResource;',
    '',
    'use ApiPlatform\\Metadata\\ApiResource;',
    'use ApiPlatform\\Metadata\\GetCollection;',
    '',
    "#[ApiResource(paginationEnabled: true, paginationItemsPerPage: 200, paginationClientItemsPerPage: true)]",
    "#[GetCollection(paginationMaximumItemsPerPage: 500)]",
    'class PagedFirst',
    '{',
    '    public int $id = 0;',
    '}',
  ].join('\n') + '\n',

  'src/ApiResource/PagedSecond.php': [
    '<?php',
    'namespace App\\ApiResource;',
    '',
    'use ApiPlatform\\Metadata\\ApiResource;',
    'use ApiPlatform\\Metadata\\GetCollection;',
    '',
    "#[ApiResource(paginationEnabled: false)]",
    "#[GetCollection(paginationViaCursor: [['field' => 'id', 'direction' => 'DESC']])]",
    'class PagedSecond',
    '{',
    '    public int $id = 0;',
    '}',
  ].join('\n') + '\n',

  'src/Controller/FirstApiController.php': [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Nelmio\\ApiDocBundle\\Annotation\\Model;',
    'use OpenApi\\Attributes as OA;',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    'class FirstApiController extends AbstractController',
    '{',
    '    #[Route("/api/first", methods: ["GET"])]',
    '    #[OA\\Response(response: 200, description: "The first list")]',
    '    #[OA\\Tag(name: "first")]',
    '    public function list(): JsonResponse { return $this->json([]); }',
    '}',
  ].join('\n') + '\n',

  'src/Controller/SecondApiController.php': [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use OpenApi\\Attributes as OA;',
    'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
    'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    'class SecondApiController extends AbstractController',
    '{',
    '    #[Route("/api/second", methods: ["POST"])]',
    '    #[OA\\Response(response: 201, description: "Created")]',
    '    public function create(): JsonResponse { return $this->json([], 201); }',
    '',
    '    #[Route("/api/second/{id}", methods: ["GET"])]',
    '    public function show(int $id): JsonResponse { return $this->json([]); }',
    '}',
  ].join('\n') + '\n',

  'config/packages/flagception.yaml': [
    'flagception:',
    '    features:',
    '        new_checkout:',
    '            default: true',
    '        dark_mode:',
    '            default: false',
    '    activators:',
    '        array:',
    '            features:',
    '                new_checkout: true',
    '                dark_mode: false',
  ].join('\n') + '\n',

  'src/Service/Flags.php': [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Flagception\\Manager\\FeatureManagerInterface;',
    '',
    'class Flags',
    '{',
    '    public function __construct(private FeatureManagerInterface $features) {}',
    '',
    '    public function check(): bool',
    '    {',
    '        return $this->features->isActive("new_checkout")',
    '            && $this->features->isActive("dark_mode")',
    '            && $this->features->isActive("never_declared");',
    '    }',
    '}',
  ].join('\n') + '\n',

  'config/services.yaml': [
    'services:',
    '    _defaults:',
    '        autowire: true',
    '',
    '    App\\Handler\\FirstHandler:',
    '        tags:',
    '            - { name: app.handler, priority: 10 }',
    '            - { name: app.reporter }',
    '',
    '    App\\Handler\\SecondHandler:',
    '        tags:',
    '            - { name: app.handler, priority: 20 }',
    '            - { name: app.unconsumed }',
    '',
    '    App\\Handler\\HandlerCollection:',
    '        arguments:',
    '            - !tagged_iterator app.handler',
  ].join('\n') + '\n',

  'src/Handler/FirstHandler.php': [
    '<?php',
    'namespace App\\Handler;',
    '',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\AsTaggedItem;',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\AutoconfigureTag;',
    '',
    '#[AutoconfigureTag("app.handler")]',
    '#[AsTaggedItem(index: "first", priority: 10)]',
    'class FirstHandler',
    '{',
    '}',
  ].join('\n') + '\n',

  'src/Handler/SecondHandler.php': [
    '<?php',
    'namespace App\\Handler;',
    '',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\AsTaggedItem;',
    '',
    '#[AsTaggedItem(index: "second", priority: 20)]',
    'class SecondHandler',
    '{',
    '}',
  ].join('\n') + '\n',

  'src/Handler/HandlerCollection.php': [
    '<?php',
    'namespace App\\Handler;',
    '',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\TaggedIterator;',
    '',
    'class HandlerCollection',
    '{',
    '    public function __construct(',
    '        #[TaggedIterator("app.handler")]',
    '        private iterable $handlers,',
    '    ) {}',
    '}',
  ].join('\n') + '\n',

  'src/Service/Ignored.php': [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Ignored',
    '{',
    '    /** @phpstan-ignore-next-line */',
    '    public function one(): void { $this->missing(); }',
    '',
    '    /** @phpstan-ignore-next-line */',
    '    public function two(): void { $this->missing(); }',
    '',
    '    /** @psalm-suppress UndefinedMethod */',
    '    public function three(): void { $this->missing(); }',
    '}',
  ].join('\n') + '\n',

  'src/Service/AlsoIgnored.php': [
    '<?php',
    'namespace App\\Service;',
    '',
    'class AlsoIgnored',
    '{',
    '    public function one(): void',
    '    {',
    '        $x = $this->missing(); // @phpstan-ignore-line',
    '        $y = $this->missing(); // @phpstan-ignore-line',
    '    }',
    '}',
  ].join('\n') + '\n',
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-pairs-'));
  app = path.join(root, 'app');
  for (const [rel, content] of Object.entries(FILES)) {
    const full = path.join(app, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function runModule(name: string, extras: string[] = []): Promise<string> {
  const mod = await import(path.resolve(__dirname, '../tools', name)) as Record<string, unknown>;
  const texts: string[] = [];

  for (const [, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const fn = value as (...args: unknown[]) => unknown;
    if (fn.length === 0) continue;

    const argsets = fn.length === 1 ? [[app]] : extras.map((e) => [app, e, e]);
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

describe('two of everything', () => {
  test.each([
    ['mailer-dkim-config', []],
    ['event-priority-conflicts', []],
    ['php-intersection-types', []],
    ['doctrine-timestamps', []],
    ['doctrine-mapping-format', []],
    ['api-platform-pagination', ['PagedFirst']],
    ['openapi', ['FirstApiController']],
    ['php-typed-constants', []],
    ['php-trait-conflicts', []],
    ['container-tags', ['app.handler']],
    ['feature-flags', ['new_checkout']],
    ['php-named-constructors', []],
    ['php-static-analysis-ignore', []],
    ['doctrine-named-queries', []],
    ['multi-tenancy', []],
    ['doctrine-entity-factory', []],
    ['doctrine-types', []],
    ['services', ['app.handler']],
  ])('%s reports on an application holding two of each', async (name, extras) => {
    const text = await runModule(name, extras as string[]);
    expect(typeof text).toBe('string');
  });
});
