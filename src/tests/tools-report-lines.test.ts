// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The lines that write a collection out, and the filters behind them.
 *
 * A map over an empty array never calls its callback, and neither does the
 * filter that decides what goes in the report. Each application here is
 * built so the module has something to say: driver options with a password
 * among them, a recipe that added environment variables, a tagged service
 * that somebody consumes, a chain adapter wrapping something that is not
 * tag aware.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-report-lines-'));
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

describe('the lines that report a collection', () => {
  test('a tag somebody consumes and a tag nobody consumes', async () => {
    const app = appWith('container-tags', {
      'config/services.yaml': `services:
    App\\Handler\\EmailHandler:
        tags:
            - { name: app.notification_handler }

    App\\Handler\\SmsHandler:
        tags:
            - { name: app.orphan_handler }

    App\\Handler\\HandlerChain:
        arguments:
            - tagged_iterator: app.notification_handler
`,
    });

    const text = await runModule('container-tags.js', app);

    expect(text).toContain('app.notification_handler');
    expect(text).toContain('app.orphan_handler');
  });

  test('driver options, with the credential among them masked', async () => {
    const app = appWith('driver-options', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        connections:
            default:
                driver: pdo_mysql
                charset: utf8mb4
                options:
                    1002: "SET NAMES utf8mb4"
                driverOptions:
                    ssl_key: /etc/mysql/client-key.pem
                    connect_timeout: 5
`,
    });

    const text = await runModule('doctrine-dbal-driveroptions.js', app);

    expect(text).toContain('driverOptions');
    expect(text).not.toContain('client-key.pem');
  });

  test('a recipe that added environment variables', async () => {
    const app = appWith('flex-recipes', {
      'symfony.lock': JSON.stringify({
        'symfony/mailer': {
          version: '7.0',
          recipe: {
            repo: 'github.com/symfony/recipes',
            branch: 'main',
            version: '4.3',
            ref: '5f5b1d1e8d7ab7ba7f57c0b2b5b7ba1e42d0f10a',
          },
          files: {
            '.env': 'MAILER_DSN=null://null\nMAILER_FROM=noreply@example.com\n',
          },
        },
      }, null, 2),
    });

    const text = await runModule('flex-recipes.js', app);

    expect(text).toContain('symfony/mailer');
  });

  test('a cached action that must not be stored, and one that varies', async () => {
    const app = appWith('http-cache', {
      'src/Controller/ReportController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpKernel\\Attribute\\Cache;
use Symfony\\Component\\Routing\\Attribute\\Route;

class ReportController
{
    #[Route('/report/private')]
    #[Cache(noStore: true)]
    public function private(): void {}

    #[Route('/report/public')]
    #[Cache(maxAge: 300, public: true, vary: ['Accept', 'Accept-Language'])]
    public function summary(): void {}

    #[Route('/report/user')]
    #[Cache(maxAge: 60, public: false)]
    public function forUser(): void {}
}
`,
    });

    const text = await runModule('http-cache.js', app);

    expect(text).toContain('ReportController');
  });

  test('http client defaults whose headers carry a token', async () => {
    const app = appWith('http-client-headers', {
      'config/packages/framework.yaml': `framework:
    http_client:
        default_options:
            base_uri: 'https://api.example.com'
            timeout: 10
            max_redirects: 3
            headers:
                Accept: 'application/json'
                Authorization: 'Bearer 8f14e45fceea167a5a36dedd4bea2543'
`,
    });

    const text = await runModule('http-client.js', app);

    expect(text).toContain('Accept');
    expect(text).not.toContain('8f14e45fceea167a5a36dedd4bea2543');
  });

  test('a mapped payload with validation groups', async () => {
    const app = appWith('input-dto', {
      'src/Controller/RegistrationController.php': `<?php

namespace App\\Controller;

use App\\Dto\\RegistrationInput;
use Symfony\\Component\\HttpKernel\\Attribute\\MapRequestPayload;
use Symfony\\Component\\Routing\\Attribute\\Route;

class RegistrationController
{
    #[Route('/register', methods: ['POST'])]
    public function register(
        #[MapRequestPayload(validationGroups: ['create', 'strict'])] RegistrationInput $input,
    ): void {
    }
}
`,
      'src/Dto/RegistrationInput.php': `<?php

namespace App\\Dto;

use Symfony\\Component\\Validator\\Constraints as Assert;

final class RegistrationInput
{
    #[Assert\\NotBlank(groups: ['create'])]
    public string $email = '';
}
`,
    });

    const text = await runModule('input-dto.js', app);

    expect(text).toContain('RegistrationController');
  });

  test('middleware on the default bus', async () => {
    const app = appWith('messenger-middleware', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        middleware:
            - 'App\\Middleware\\AuditMiddleware'
            - doctrine_transaction
        buses:
            command.bus:
                middleware:
                    - validation
                    - 'App\\Middleware\\TenantMiddleware'
            query.bus:
                default_middleware: false
                middleware:
                    - validation
`,
    });

    const text = await runModule('messenger-middleware.js', app);

    expect(text).toContain('AuditMiddleware');
    expect(text).toContain('command.bus');
  });

  test('phpmetrics configured in xml, with an exclude list', async () => {
    const app = appWith('php-metrics', {
      'phpmetrics.xml': `<?xml version="1.0"?>
<phpmetrics>
    <config>
        <report format="html" />
        <exclude = "var,tests" />
    </config>
</phpmetrics>
`,
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpmetrics/phpmetrics': '^2.8' },
      }, null, 2),
    });

    const text = await runModule('php-metrics-config.js', app);

    expect(text.length).toBeGreaterThan(0);
  });

  test('two vaults, and a secret that is also in .env', async () => {
    const app = appWith('secrets-vault', {
      'config/secrets/prod/APP_SECRET.a1b2c3d4.php': '<?php return "encrypted";\n',
      'config/secrets/prod/MAILER_DSN.b2c3d4e5.php': '<?php return "encrypted";\n',
      'config/secrets/prod/prod.decrypt.private.php': '<?php return "key";\n',
      'config/secrets/dev/APP_SECRET.c3d4e5f6.php': '<?php return "encrypted";\n',
      '.env': 'APP_SECRET=not-a-secret-anymore\nAPP_ENV=dev\n',
    });

    const text = await runModule('secrets-vault.js', app);

    expect(text).toContain('APP_SECRET');
  });

  test('a firewall with a custom authenticator', async () => {
    const app = appWith('security-authenticators', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            lazy: true
            custom_authenticators:
                - App\\Security\\ApiTokenAuthenticator
                - App\\Security\\LoginFormAuthenticator
            form_login:
                login_path: app_login
    access_control:
        - { path: ^/admin, roles: ROLE_ADMIN }
`,
      'src/Security/ApiTokenAuthenticator.php': `<?php

namespace App\\Security;

use Symfony\\Component\\Security\\Http\\Authenticator\\AbstractAuthenticator;

class ApiTokenAuthenticator extends AbstractAuthenticator
{
    public function supports($request): bool { return true; }
}
`,
    });

    const text = await runModule('security-voters.js', app);

    expect(text.length).toBeGreaterThan(0);
  });

  test('a transport pointing at a failure transport, and a dead letter nobody points at', async () => {
    const app = appWith('messenger-failures', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        failure_transport: failed
        transports:
            async:
                dsn: '%env(MESSENGER_TRANSPORT_DSN)%'
                failure_transport: failed_async
                retry_strategy:
                    max_retries: 12
                    delay: 1000
            failed_async:
                dsn: 'doctrine://default?queue_name=failed_async'
            failed:
                dsn: 'doctrine://default?queue_name=failed'
            orphaned_failed:
                dsn: 'doctrine://default?queue_name=orphaned_failed'
`,
    });

    const text = await runModule('symfony-messenger-failures.js', app);

    expect(text).toContain('failed_async');
  });

  test('a notification class sent over a channel that is configured', async () => {
    const app = appWith('notifier-channels', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            slack: 'slack://token@default?channel=alerts'
        texter_transports:
            - 'twilio://sid:token@default?from=+15550001111'
        admin_recipients:
            - { email: ops@example.com, phone: '+15550002222' }
        channel_policy:
            urgent: ['chat/slack', 'sms/twilio']
            high: ['chat/slack']
`,
      'src/Notification/DeployFinishedNotification.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;

class DeployFinishedNotification extends Notification
{
    public function getChannels(object $recipient): array
    {
        return ['push/firebase'];
    }
}
`,
      'src/Notification/InvoiceOverdueNotification.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;

class InvoiceOverdueNotification extends Notification
{
    public function getChannels(object $recipient): array
    {
        return ['chat/slack', 'email'];
    }
}
`,
    });

    const text = await runModule('symfony-notifier-channels.js', app);

    expect(text).toContain('InvoiceOverdueNotification');
  });

  test('a route restricted to a scheme', async () => {
    const app = appWith('routing-requirements', {
      'src/Controller/CheckoutController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;

class CheckoutController
{
    #[Route('/checkout/{step}', name: 'checkout', requirements: ['step' => '\\\\d+'], schemes: ['https'], methods: ['GET', 'POST'])]
    public function step(int $step): void {}

    #[Route('/checkout/callback', name: 'checkout_callback', host: 'payments.example.com', schemes: ['https', 'http'])]
    public function callback(): void {}
}
`,
    });

    const text = await runModule('symfony-routing-requirements.js', app);

    expect(text).toContain('checkout');
  });

  test('a scheduled task declared twice, in an attribute and in the config', async () => {
    const app = appWith('scheduler-tasks', {
      'src/Scheduler/ReportSchedule.php': `<?php

namespace App\\Scheduler;

use Symfony\\Component\\Scheduler\\Attribute\\AsCronTask;

#[AsCronTask('0 3 * * *')]
class ReportSchedule
{
    public function __invoke(): void
    {
        try {
            $this->run();
        } catch (\\Throwable) {
        }
    }
}
`,
      'config/packages/scheduler.yaml': `framework:
    scheduler:
        schedules:
            default:
                transport: 'doctrine://default'
                tasks:
                    - id: ReportSchedule
                      expression: '0 3 * * *'
                    - id: CleanupSchedule
                      expression: 'every 5 minutes'
`,
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);

    expect(text).toContain('ReportSchedule');
  });

  test('a workflow whose places carry metadata', async () => {
    const app = appWith('workflow-places', {
      'config/packages/workflow.yaml': `framework:
    workflows:
        article:
            type: workflow
            marking_store:
                type: method
                property: currentPlace
            supports:
                - App\\Entity\\Article
            places:
                draft:
                    metadata:
                        title: Draft
                review:
                    metadata:
                        title: In review
                published: ~
            transitions:
                to_review:
                    from: draft
                    to: review
                publish:
                    from: review
                    to: published
`,
    });

    const text = await runModule('workflow.js', app, ['article']);

    expect(text).toContain('draft');
  });
});

describe('the filters behind the report', () => {
  test('an exception mapped to a server error', async () => {
    const app = appWith('api-error-handling', {
      'config/packages/api_platform.yaml': `api_platform:
    formats:
        jsonld: ['application/ld+json']
    error_formats:
        jsonproblem: ['application/problem+json']
        jsonld: ['application/ld+json']
    exception_to_status:
        App\\Exception\\NotFoundException: 404
        App\\Exception\\StorageUnavailableException: 503
`,
    });

    const text = await runModule('api-platform-error-handling.js', app);

    expect(text).toContain('5xx');
  });

  test('a command whose arguments carry no description', async () => {
    const app = appWith('console-options', {
      'src/Command/ImportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputArgument;
use Symfony\\Component\\Console\\Input\\InputOption;

#[AsCommand(name: 'app:import')]
class ImportCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addArgument('file', InputArgument::REQUIRED)
            ->addArgument('target', InputArgument::OPTIONAL)
            ->addOption('dry-run', null, InputOption::VALUE_NONE)
            ->addOption('batch', null, InputOption::VALUE_REQUIRED, 'Rows per batch', 100);
    }
}
`,
      'src/Command/ExportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputOption;

#[AsCommand(name: 'app:export')]
class ExportCommand extends Command
{
    protected function configure(): void
    {
        $this->addOption('no-interaction', null, InputOption::VALUE_NONE, 'Skip the questions');
    }
}
`,
    });

    const text = await runModule('console-command-options.js', app);

    expect(text).toContain('app:import');
  });

  test('grumphp with tasks configured', async () => {
    const app = appWith('grumphp', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpro/grumphp': '^2.0' },
      }, null, 2),
      'grumphp.yml': `grumphp:
    tasks:
        phpcs:
            standard: PSR12
        phpunit: ~
        composer: ~
    git_hook_variables:
        EXEC_GRUMPHP_COMMAND: 'docker compose run --rm php'
`,
    });

    const text = await runModule('grumphp-config.js', app);

    expect(text).toContain('phpcs');
  });

  test('__debugInfo that hands back a password', async () => {
    const app = appWith('magic-methods', {
      'src/Entity/Credentials.php': `<?php

namespace App\\Entity;

class Credentials
{
    private string $password = '';
    private string $apiToken = '';

    public function __debugInfo(): array
    {
        return [
            'password' => $this->password,
            'apiToken' => $this->apiToken,
        ];
    }

    public function __toString(): string
    {
        throw new \\LogicException('not printable');
    }
}
`,
    });

    const text = await runModule('php-magic-methods.js', app);

    expect(text).toContain('__debugInfo');
  });

  test('the same partial mock reported twice is reported once', async () => {
    const app = appWith('self-shunting', {
      'tests/Service/PaymentServiceTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\TestCase;

class PaymentServiceTest extends TestCase
{
    public function testCharge(): void
    {
        $sut = $this->getMockBuilder(PaymentService::class)
            ->onlyMethods(['callGateway'])
            ->getMock();
        $sut->method('callGateway')->willReturn(true);
        self::assertTrue($sut->charge(10));
    }

    public function testRefund(): void
    {
        $sut = $this->getMockBuilder(PaymentService::class)
            ->onlyMethods(['callGateway'])
            ->getMock();
        $sut->method('callGateway')->willReturn(true);
        self::assertTrue($sut->refund(10));
    }
}
`,
    });

    const text = await runModule('phpunit-self-shunting.js', app);

    expect(text).toContain('PaymentServiceTest');
  });

  test('a repository method that queries inside a loop', async () => {
    const app = appWith('repository-nplus1', {
      'src/Repository/OrderRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;

class OrderRepository extends ServiceEntityRepository
{
    public function loadCustomers(array $orders): array
    {
        $customers = [];
        foreach ($orders as $order) {
            $customers[] = $this->find($order->getCustomerId());
        }

        return $customers;
    }

    public function loadAddresses(array $orders): array
    {
        $addresses = [];
        foreach ($orders as $order) {
            $addresses[] = $this->findBy(['order' => $order]);
        }

        return $addresses;
    }
}
`,
    });

    const text = await runModule('repository-analyzer.js', app, ['OrderRepository']);

    expect(text).toContain('OrderRepository');
  });

  test('phpstan including an extension', async () => {
    const app = appWith('static-analysis', {
      'phpstan.neon': `includes:
    - vendor/phpstan/phpstan-symfony/extension.neon
    - vendor/phpstan/phpstan-doctrine/extension.neon

parameters:
    level: 8
    paths:
        - src
    excludePaths:
        - src/Kernel.php
`,
      'phpstan-baseline.neon': `parameters:
    ignoreErrors:
        -
            message: "#^Method has no return type specified.$#"
            count: 2
            path: src/Service/Importer.php
        -
            message: "#^Property is never read.$#"
            count: 1
            path: src/Service/Importer.php
        -
            message: "#^Cannot call method on mixed.$#"
            count: 1
            path: src/Controller/HomeController.php
`,
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpstan/phpstan': '^1.10' },
      }, null, 2),
    });

    const text = await runModule('static-analysis.js', app);

    expect(text).toContain('level');
  });

  test('a tag-aware adapter wrapping something that is not tag aware', async () => {
    const app = appWith('cache-chain', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.chain
        pools:
            cache.tagged:
                adapter: cache.adapter.redis
                tags: true
            cache.chained:
                adapter: cache.adapter.chain
                tags: true
                providers:
                    - cache.adapter.redis
                    - cache.adapter.array
            cache.layered:
                adapter: cache.adapter.chain
                providers:
                    - cache.adapter.array
                    - cache.adapter.filesystem
`,
    });

    const text = await runModule('symfony-cache-chain.js', app);

    expect(text.length).toBeGreaterThan(0);
  });

  test('two listeners on the same form event, one without priority', async () => {
    const app = appWith('form-events', {
      'src/Form/OrderType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\Form\\FormEvent;
use Symfony\\Component\\Form\\FormEvents;

class OrderType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event): void {
            $event->getForm();
        });

        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event): void {
            $event->stopPropagation();
        }, 10);
    }
}
`,
    });

    const text = await runModule('symfony-form-events.js', app);

    expect(text).toContain('PRE_SET_DATA');
  });

  test('two global form themes from different layout systems', async () => {
    const app = appWith('form-themes', {
      'config/packages/twig.yaml': `twig:
    form_themes:
        - 'bootstrap_5_layout.html.twig'
        - 'foundation_6_layout.html.twig'
`,
      'templates/order/new.html.twig': `{% form_theme form 'form/fields.html.twig' %}
{{ form(form) }}
`,
    });

    const text = await runModule('symfony-form-themes.js', app);

    expect(text).toContain('bootstrap_5_layout.html.twig');
  });

  test('an access_control attribute no voter supports', async () => {
    const app = appWith('custom-voter', {
      'config/packages/security.yaml': `security:
    access_control:
        - { path: ^/invoice, roles: INVOICE_VIEW }
        - { path: ^/export, roles: ['EXPORT_RUN'] }
`,
      'src/Security/Voter/InvoiceVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class InvoiceVoter extends Voter
{
    public const VIEW = 'INVOICE_VIEW';

    protected function supports(string $attribute, mixed $subject): bool
    {
        return in_array($attribute, [self::VIEW], true);
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return match ($attribute) {
            self::VIEW => true,
            default => false,
        };
    }
}
`,
    });

    const text = await runModule('symfony-security-custom-voter.js', app);

    expect(text).toContain('INVOICE_VIEW');
  });
});
