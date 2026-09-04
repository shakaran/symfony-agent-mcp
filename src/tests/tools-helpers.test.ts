// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The helpers a module only calls once it has found something worth
 * looking at: the masks, which need a value that looks like a credential
 * in the field they read, and the small predicates behind one condition.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-helpers-'));
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

describe('the masks', () => {
  test('a password in an ansible vars block', async () => {
    const app = appWith('ansible', {
      'ansible/deploy.yml': `---
- name: Deploy the application
  hosts: web
  become: true
  vars:
    database_password: hunter2-not-in-the-vault
    api_key: 0123456789abcdef
    vault_smtp_password: "{{ vault_smtp }}"
  tasks:
    - name: Pull the release
      git:
        repo: git@example.com:acme/app.git
        dest: /srv/app
`,
    });

    const text = await runModule('ansible-playbook-config.js', app);

    expect(text).not.toContain('hunter2-not-in-the-vault');
    expect(text).toContain('***');
  });

  test('ses credentials in the environment and in the dsn', async () => {
    const app = appWith('aws-ses', {
      '.env': [
        'AWS_SES_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
        'AWS_SES_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
        'AWS_SES_REGION=eu-west-1',
        'MAILER_DSN=ses+smtp://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI@default',
        '',
      ].join('\n'),
    });

    const text = await runModule('aws-ses-integration.js', app);

    expect(text).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
    expect(text).toContain('***');
  });

  test('a mailgun key committed to .env', async () => {
    const app = appWith('mailgun', {
      '.env': [
        'MAILGUN_API_KEY=3f2c1a9d8e7b6c5a4d3e2f1a0b9c8d7e',
        'MAILGUN_DOMAIN=mg.example.com',
        'MAILER_DSN=mailgun+api://KEY:DOMAIN@default',
        '',
      ].join('\n'),
    });

    const text = await runModule('mailgun-integration.js', app);

    expect(text).not.toContain('3f2c1a9d8e7b6c5a4d3e2f1a0b9c8d7e');
  });

  test('an sms transport whose dsn carries the credentials', async () => {
    const app = appWith('notifier-sms', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        texter_transports:
            twilio: 'twilio://ACb1c2d3e4:authtoken-9f8e7d6c@default?from=+15550001111'
            vonage: 'vonage://apikey:apisecret@default?from=Acme'
`,
    });

    const text = await runModule('symfony-notifier-sms.js', app);

    expect(text).not.toContain('authtoken-9f8e7d6c');
  });

  test('an sms transport installed but never configured', async () => {
    const app = appWith('notifier-sms-unconfigured', {
      'composer.json': JSON.stringify({
        require: {
          'symfony/framework-bundle': '^7.0',
          'symfony/twilio-notifier': '^7.0',
          'symfony/vonage-notifier': '^7.0',
        },
      }, null, 2),
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            slack: '%env(SLACK_DSN)%'
`,
    });

    const text = await runModule('symfony-notifier-sms.js', app);

    expect(text).toContain('twilio');
    expect(text).toContain('not configured');
  });

  test('a compose service with a password in its environment', async () => {
    const app = appWith('docker-env', {
      'docker-compose.yml': `services:
  database:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=s3cret-in-the-repo
      - POSTGRES_USER=app
      - PROBE_COMMAND=pg_isready --password=hunter2
    healthcheck:
      test: ["CMD", "pg_isready"]
    volumes:
      - ./var/data:/var/lib/postgresql/data
  cache:
    image: redis:7
    environment:
      - REDIS_URL=redis://app:s3cret@cache:6379
`,
    });

    const text = await runModule('docker-inspector.js', app, ['database']);

    expect(text).not.toContain('s3cret-in-the-repo');
  });
});

describe('the helpers behind one condition', () => {
  test('development packages come from the lock file', async () => {
    const app = appWith('composer-dev', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
      }, null, 2),
      'composer.lock': JSON.stringify({
        'content-hash': 'a1b2c3d4e5f6',
        packages: [
          { name: 'symfony/framework-bundle', version: 'v7.0.3', type: 'symfony-bundle' },
          { name: 'symfony/http-kernel', version: 'v7.0.3', type: 'library' },
        ],
        'packages-dev': [
          { name: 'phpunit/phpunit', version: '11.0.1', type: 'library' },
          { name: 'symfony/browser-kit', version: 'v7.0.3', type: 'library' },
        ],
      }, null, 2),
    });

    const text = await runModule('composer.js', app, ['dev', 'phpunit/phpunit']);

    expect(text).toContain('phpunit/phpunit');
  });

  test('a subscriber that flushes inside its own event, and one that rewrites metadata', async () => {
    const app = appWith('doctrine-subscribers', {
      'src/EventSubscriber/AuditSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Doctrine\\Bundle\\DoctrineBundle\\EventSubscriber\\EventSubscriberInterface;

class AuditSubscriber implements EventSubscriberInterface
{
    public function getSubscribedEvents(): array
    {
        return ['onFlush', 'preFlush', 'loadClassMetadata'];
    }

    public function onFlush($args): void
    {
        $args->getObjectManager()->flush();
    }

    public function preFlush($args): void
    {
        $args->getObjectManager()->flush();
    }

    public function loadClassMetadata($args): void
    {
        $metadata = $args->getClassMetadata();
        $metadata->setPrimaryTable(['name' => 'audit_' . $metadata->getTableName()]);
    }
}
`,
    });

    const text = await runModule('doctrine-event-subscribers.js', app);

    expect(text).toContain('AuditSubscriber');
  });

  test('a weak hash next to something that looks like an integrity check', async () => {
    const app = appWith('hash-algorithm', {
      'src/Service/LegacyPasswordService.php': `<?php

namespace App\\Service;

class LegacyPasswordService
{
    public function hashPassword(string $password): string
    {
        return md5($password);
    }
}
`,
      'src/Service/ChecksumService.php': `<?php

namespace App\\Service;

class ChecksumService
{
    public function verify(string $file, string $expected): bool
    {
        $hash = md5_file($file);

        return hash_equals($expected, $hash);
    }

    public function fingerprint(string $payload): string
    {
        $checksum = crc32($payload);

        return (string) $checksum;
    }
}
`,
    });

    const text = await runModule('php-hash-algorithm-security.js', app);

    expect(text).toContain('LegacyPasswordService');
  });

  test('a template that renders a variable as a template', async () => {
    const app = appWith('template-injection', {
      'templates/mail/campaign.html.twig': `{{ include(template_from_string(body)) }}
{{ subject|raw }}
{% set tpl = 'mail/' ~ name ~ '.html.twig' %}
{% include tpl %}
`,
      'src/Controller/CampaignController.php': `<?php

namespace App\\Controller;

class CampaignController
{
    public function preview(string $body): string
    {
        return $this->twig->createTemplate($body)->render();
    }
}
`,
    });

    const text = await runModule('php-template-injection.js', app);

    expect(text).toContain('campaign.html.twig');
  });

  test('expectException written without $this', async () => {
    const app = appWith('test-isolation', {
      'tests/Service/ImporterTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\TestCase;

class ImporterTest extends TestCase
{
    public function testRejectsEmptyFile(): void
    {
        $sut = new Importer();
        $sut->expectException(\\InvalidArgumentException::class);
        $sut->import('');
    }

    public function testAcceptsRows(): void
    {
        $importer = new Importer();
        self::assertSame(2, $importer->import("a\\nb"));
    }
}
`,
    });

    const text = await runModule('phpunit-test-isolation.js', app);

    expect(text).toContain('ImporterTest');
  });

  test('choice_attr that hands back something other than an array', async () => {
    const app = appWith('choice-value', {
      'src/Form/CountryType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\ChoiceType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class CountryType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->add('country', ChoiceType::class, [
            'choices' => ['Spain' => 'ES', 'France' => 'FR'],
            'choice_attr' => fn (string $code) => 'data-code-' . $code;,
            'choice_label' => fn (string $code) => 'Country',
        ]);
    }
}
`,
    });

    const text = await runModule('symfony-form-choice-value.js', app);

    expect(text).toContain('CountryType');
  });
});

describe('the last predicates', () => {
  test('a mercure topic with no placeholder in it', async () => {
    const app = appWith('mercure-topics', {
      'src/Entity/Alert.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource(
    mercure: ['private' => true, 'topics' => ['https://example.com/alerts', 'https://example.com/alerts/{id}']],
)]
class Alert
{
    public ?int $id = null;
}
`,
    });

    const text = await runModule('api-platform-mercure-push.js', app);

    expect(text).toContain('Alert');
  });

  test('a read group that exposes a password field', async () => {
    const app = appWith('apip-security', {
      'src/Entity/Account.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;
use Symfony\\Component\\Serializer\\Attribute\\Groups;

#[ApiResource(
    normalizationContext: ['groups' => ['account:read', 'account:password_hash']],
)]
class Account
{
    #[Groups(['account:read'])]
    public string $email = '';

    #[Groups(['account:password_hash'])]
    public string $passwordHash = '';
}
`,
    });

    const text = await runModule('api-platform-security.js', app);

    expect(text).toContain('Account');
  });

  test('a cache region the second level cache never declares', async () => {
    const app = appWith('doctrine-cache-region', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        second_level_cache:
            enabled: true
            regions:
                catalogue:
                    lifetime: 3600
                    cache_driver:
                        type: pool
                        pool: doctrine.result_cache_pool
        query_cache_driver:
            type: pool
            pool: doctrine.system_cache_pool
        result_cache_driver:
            type: pool
            pool: doctrine.result_cache_pool
        metadata_cache_driver:
            type: pool
            pool: doctrine.system_cache_pool
`,
      'src/Entity/Product.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Cache(usage: 'READ_WRITE', region: 'inventory')]
class Product
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-cache.js', app);

    expect(text).toContain('inventory');
  });

  test('the container asked for a service after the kernel was shut down', async () => {
    const app = appWith('http-kernel-shutdown', {
      'tests/Controller/DashboardTest.php': `<?php

namespace App\\Tests\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class DashboardTest extends WebTestCase
{
    public function testDashboardLoads(): void
    {
        $client = static::createClient();
        $client->request('GET', '/dashboard');
        $client->getKernel()->shutdown();
        $repository = static::getContainer()->get(DashboardRepository::class);
        self::assertNotNull($repository);
    }
}
`,
    });

    const text = await runModule('symfony-test-http-kernel.js', app);

    expect(text).toContain('DashboardTest');
  });

  test('a group sequence naming a group no constraint declares', async () => {
    const app = appWith('group-sequence', {
      'src/Entity/Subscription.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Validator\\Constraints as Assert;

#[Assert\\GroupSequence(['Default', 'strict', 'billing'])]
class Subscription
{
    #[Assert\\NotBlank(groups: ['Default'])]
    public string $plan = '';

    #[Assert\\Positive(groups: ['strict'])]
    public int $seats = 0;
}
`,
    });

    const text = await runModule('symfony-validator-group-sequence.js', app);

    expect(text).toContain('Subscription');
  });

  test('translation files counted across catalogues', async () => {
    const app = appWith('translations', {
      'translations/messages.en.yaml': `app:
    title: 'Dashboard'
    subtitle: 'Everything at a glance'
`,
      'translations/messages.es.yaml': `app:
    title: 'Panel'
`,
      'translations/validators.en.yaml': `subscription:
    plan_required: 'Choose a plan'
`,
    });

    const text = await runModule('translations.js', app, ['messages']);

    const mod = await import(path.resolve(__dirname, '../tools/translations')) as {
      searchTranslations: (appPath: string, query: string, locale?: string) => { content: Array<{ text?: string }> };
    };
    const found = mod.searchTranslations(app, 'title').content.map((c) => c.text ?? '').join('\n');

    expect(text).toContain('messages');
    expect(found).toContain('app.title');
  });

  test('a contract test that leaves an interface method untested', async () => {
    const app = appWith('contract-tests', {
      'src/Gateway/PaymentGatewayInterface.php': `<?php

namespace App\\Gateway;

interface PaymentGatewayInterface
{
    public function charge(int $amount): bool;

    public function refund(int $amount): bool;
}
`,
      'src/Gateway/StripeGateway.php': `<?php

namespace App\\Gateway;

class StripeGateway implements PaymentGatewayInterface
{
    public function charge(int $amount): bool { return true; }

    public function refund(int $amount): bool { return true; }
}
`,
      'src/Gateway/PaypalGateway.php': `<?php

namespace App\\Gateway;

class PaypalGateway implements PaymentGatewayInterface
{
    public function charge(int $amount): bool { return true; }

    public function refund(int $amount): bool { return true; }
}
`,
      'tests/Gateway/PaymentGatewayInterfaceTest.php': `<?php

namespace App\\Tests\\Gateway;

use PHPUnit\\Framework\\TestCase;

abstract class PaymentGatewayInterfaceTest extends TestCase
{
    abstract protected function gateway(): PaymentGatewayInterface;

    public function testCharge(): void
    {
        self::assertTrue($this->gateway()->charge(100));
    }
}
`,
    });

    const text = await runModule('php-contract-tests.js', app);

    expect(text).toContain('PaymentGatewayInterface');
  });
});
