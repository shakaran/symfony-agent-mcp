// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The last few: a chained cache with memory and tag-aware adapters in it,
 * Doctrine filters declared in configuration, and columns whose defaults
 * are missing in each of the ways the analyser distinguishes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-close-'));
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
      require: { 'symfony/framework-bundle': '^7.0', 'doctrine/orm': '^3.0' },
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

describe('the last few', () => {
  test('a chain of adapters, with an array one in the middle and a tag-aware one at the end', async () => {
    const app = appWith('cache-chain', {
      'config/packages/cache.yaml': [
        'framework:',
        '    cache:',
        '        app: cache.adapter.redis',
        '        pools:',
        '            app.cache.layered:',
        '                adapter: cache.adapter.chain',
        '                providers:',
        '                    - cache.adapter.array',
        '                    - cache.adapter.apcu',
        '                    - cache.adapter.filesystem',
        '            app.cache.tagged:',
        '                adapter: cache.adapter.redis_tag_aware',
        '                tags: true',
        '            app.cache.memory_only:',
        '                adapter: cache.adapter.array',
        '            app.cache.plain:',
        '                adapter: cache.adapter.filesystem',
      ].join('\n') + '\n',
      'src/Cache/Chain.php': [
        '<?php',
        'namespace App\\Cache;',
        '',
        'use Symfony\\Component\\Cache\\Adapter\\ApcuAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\ArrayAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\ChainAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\FilesystemAdapter;',
        'use Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter;',
        '',
        'class Chain',
        '{',
        '    public function build(): TagAwareAdapter',
        '    {',
        '        return new TagAwareAdapter(new ChainAdapter([',
        '            new ArrayAdapter(30),',
        '            new ApcuAdapter("acme", 300),',
        '            new FilesystemAdapter("acme", 3600),',
        '        ], 30));',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-cache-chain.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('Doctrine filters declared in configuration and in code', async () => {
    const app = appWith('doctrine-filters', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    orm:',
        '        filters:',
        '            soft_deleteable:',
        '                class: Gedmo\\SoftDeleteable\\Filter\\SoftDeleteableFilter',
        '                enabled: true',
        '            tenant:',
        '                class: App\\Doctrine\\TenantFilter',
        '                enabled: false',
        '                parameters:',
        '                    tenant_id: "0"',
        '            locale:',
        '                class: App\\Doctrine\\LocaleFilter',
        '                enabled: "true"',
      ].join('\n') + '\n',
      'src/Doctrine/TenantFilter.php': [
        '<?php',
        'namespace App\\Doctrine;',
        '',
        'use Doctrine\\ORM\\Mapping\\ClassMetadata;',
        'use Doctrine\\ORM\\Query\\Filter\\SQLFilter;',
        '',
        'class TenantFilter extends SQLFilter',
        '{',
        '    public function addFilterConstraint(ClassMetadata $targetEntity, $targetTableAlias): string',
        '    {',
        '        return sprintf("%s.tenant_id = %s", $targetTableAlias, $this->getParameter("tenant_id"));',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Doctrine/LocaleFilter.php': [
        '<?php',
        'namespace App\\Doctrine;',
        '',
        'use Doctrine\\ORM\\Query\\Filter\\SQLFilter;',
        '',
        'class LocaleFilter extends SQLFilter',
        '{',
        '    public function addFilterConstraint($targetEntity, $targetTableAlias): string',
        '    {',
        '        return "";',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/EventSubscriber/FilterSubscriber.php': [
        '<?php',
        'namespace App\\EventSubscriber;',
        '',
        'use Doctrine\\ORM\\EntityManagerInterface;',
        '',
        'class FilterSubscriber',
        '{',
        '    public function __construct(private EntityManagerInterface $entityManager) {}',
        '',
        '    public function enable(): void',
        '    {',
        '        $this->entityManager->getFilters()->enable("tenant")->setParameter("tenant_id", "1");',
        '        $this->entityManager->getFilters()->disable("locale");',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('doctrine-filters.js', app, ['tenant']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('columns whose defaults are missing in each of the ways', async () => {
    const app = appWith('column-defaults', {
      'src/Entity/Settings.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        'class Settings',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Column(type: "boolean")]',
        '    private bool $active;',
        '',
        '    #[ORM\\Column(type: "boolean", options: ["default" => false])]',
        '    private bool $archived = false;',
        '',
        '    #[ORM\\Column(type: "datetime_immutable")]',
        '    private \\DateTimeImmutable $createdAt;',
        '',
        '    #[ORM\\Column(type: "datetime", options: ["default" => "CURRENT_TIMESTAMP"])]',
        '    private \\DateTime $updatedAt;',
        '',
        '    #[ORM\\Column(type: "string", enumType: Status::class)]',
        '    private Status $status;',
        '',
        '    #[ORM\\Column(type: "string", length: 32, nullable: true)]',
        '    private ?string $note = null;',
        '',
        '    #[ORM\\Column(type: "integer", options: ["default" => 0])]',
        '    private int $counter = 0;',
        '',
        '    #[ORM\\Column(type: "json")]',
        '    private array $payload;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Status.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'enum Status: string',
        '{',
        '    case Draft = "draft";',
        '    case Published = "published";',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('doctrine-column-defaults.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
