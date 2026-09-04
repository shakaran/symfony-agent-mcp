// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * More of the same: a unique constraint that ignores null on a column that
 * cannot be null, a group sequence naming a group nobody defined, a form
 * listener with no priority, a query bus with no cache, a worker unit,
 * an expression function and a choice_attr returning a string.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-conditions4-'));
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

describe('the fourth set of conditions', () => {
  test('a unique constraint ignoring null on a column that cannot be, over a composite key', async () => {
    const app = appWith('unique-entity', {
      'src/Entity/Membership.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Bridge\\Doctrine\\Validator\\Constraints\\UniqueEntity;',
        'use Symfony\\Component\\Validator\\Constraints as Assert;',
        '',
        '#[ORM\\Entity]',
        "#[UniqueEntity(fields: ['userId', 'groupId'], ignoreNull: true)]",
        "#[UniqueEntity(fields: ['email'], ignoreNull: true)]",
        "#[UniqueEntity(fields: ['userId', 'groupId'])]",
        '#[Assert\\GroupSequence(["Membership", "Strict", "NeverDefined"])]',
        'class Membership',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\Column(type: "integer", nullable: false)]',
        '    private int $userId = 0;',
        '',
        '    #[ORM\\Id]',
        '    #[ORM\\Column(type: "integer", nullable: false)]',
        '    private int $groupId = 0;',
        '',
        '    #[ORM\\Column(length: 180, nullable: false)]',
        '    #[Assert\\NotBlank(groups: ["Strict"])]',
        '    private string $email = "";',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Simple.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        'use Symfony\\Bridge\\Doctrine\\Validator\\Constraints\\UniqueEntity;',
        'use Symfony\\Component\\Validator\\Constraints as Assert;',
        '',
        '#[ORM\\Entity]',
        '#[UniqueEntity]',
        '#[Assert\\GroupSequence(["Simple", "Second"])]',
        'class Simple',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[Assert\\NotBlank(groups: ["Second"])]',
        '    private string $name = "";',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0', 'symfony/validator': '^7.0' });

    const results = await Promise.all([
      runModule('symfony-validator-unique-entity.js', app),
      runModule('symfony-validator-group-sequence.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('form listeners without priority, a global theme, and a choice_attr returning a string', async () => {
    const app = appWith('forms-conditions', {
      'config/packages/twig.yaml': [
        'twig:',
        '    form_themes:',
        '        - "bootstrap_5_layout.html.twig"',
        '        - "form/theme.html.twig"',
      ].join('\n') + '\n',
      'templates/form/theme.html.twig': '{% use "bootstrap_5_layout.html.twig" %}\n{% block form_row %}<div>{{ form_widget(form) }}</div>{% endblock %}\n',
      'templates/order/new.html.twig': '{% form_theme form "form/theme.html.twig" %}\n{{ form(form) }}\n',
      'src/Form/ChoiceHeavyType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\ChoiceType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        'use Symfony\\Component\\Form\\FormEvent;',
        'use Symfony\\Component\\Form\\FormEvents;',
        '',
        'class ChoiceHeavyType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder->add("country", ChoiceType::class, [',
        '            "choices" => ["Spain" => "ES", "France" => "FR"],',
        "            'choice_value' => function (?string $choice): string { return (string) $choice; },",
        "            'choice_label' => function (string $choice): string { return 'Country ' . $choice; },",
        "            'choice_attr' => function (string $choice) { return 'data-code'; },",
        '        ]);',
        '',
        '        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event) { });',
        '        $builder->addEventListener(FormEvents::PRE_SUBMIT, function (FormEvent $event) { });',
        '        $builder->addEventListener(FormEvents::POST_SUBMIT, function (FormEvent $event) { }, 10);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Form/SecondChoiceType.php': [
        '<?php',
        'namespace App\\Form;',
        '',
        'use Symfony\\Component\\Form\\AbstractType;',
        'use Symfony\\Component\\Form\\Extension\\Core\\Type\\ChoiceType;',
        'use Symfony\\Component\\Form\\FormBuilderInterface;',
        'use Symfony\\Component\\Form\\FormEvent;',
        'use Symfony\\Component\\Form\\FormEvents;',
        '',
        'class SecondChoiceType extends AbstractType',
        '{',
        '    public function buildForm(FormBuilderInterface $builder, array $options): void',
        '    {',
        '        $builder->add("status", ChoiceType::class, ["choices" => ["Open" => 1]]);',
        '        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event) { });',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('symfony-form-events.js', app),
      runModule('symfony-form-themes.js', app),
      runModule('symfony-form-choice-value.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('a query bus with no cache middleware, and workers under systemd', async () => {
    const app = appWith('buses-and-workers', {
      'config/packages/messenger.yaml': [
        'framework:',
        '    messenger:',
        '        default_bus: command.bus',
        '        buses:',
        '            command.bus:',
        '                middleware: [validation, doctrine_transaction]',
        '            query.bus:',
        '                default_middleware: allow_no_handlers',
        '                middleware: [validation]',
        '            event.bus:',
        '                default_middleware: allow_no_handlers',
        '        transports:',
        '            async:',
        '                dsn: "doctrine://default"',
        '                options:',
        '                    lock_mode: pessimistic_write',
        '            scheduler_default:',
        '                dsn: "schedule://default"',
        '                options:',
        '                    lock: true',
        '                    cache: scheduler',
      ].join('\n') + '\n',
      'messenger-worker.service': [
        '[Unit]',
        'Description=Symfony messenger consumer',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'User=www-data',
        'Restart=always',
        'RestartSec=5',
        'ExecStart=/usr/bin/php /var/www/html/bin/console messenger:consume async --time-limit=3600 --memory-limit=128M',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n') + '\n',
      'deploy/messenger-scheduler.service': [
        '[Unit]',
        'Description=Symfony scheduler',
        '',
        '[Service]',
        'ExecStart=/usr/bin/php /var/www/html/bin/console messenger:consume scheduler_default',
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n') + '\n',
      'config/packages/scheduler.yaml': [
        'framework:',
        '    scheduler:',
        '        schedules:',
        '            default:',
        '                transport: scheduler_default',
        '                lock: true',
      ].join('\n') + '\n',
    }, { 'symfony/messenger': '^7.0' });

    const results = await Promise.all([
      runModule('symfony-message-buses.js', app),
      runModule('symfony-messenger-worker.js', app),
      runModule('symfony-scheduler-transport-config.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('an expression function, routes with schemes and a health endpoint', async () => {
    const app = appWith('expression-routes', {
      'config/services.yaml': [
        'services:',
        '    App\\Expression\\IsGrantedFunction:',
        '        class: App\\Expression\\IsGrantedFunction',
        '        tags:',
        '            - { name: expression_language.function }',
        '',
        '    App\\Expression\\SecondFunction:',
        '        class: App\\Expression\\SecondFunction',
        '        tags: [expression_language.function]',
      ].join('\n') + '\n',
      'src/Expression/IsGrantedFunction.php': [
        '<?php',
        'namespace App\\Expression;',
        '',
        'use Symfony\\Component\\ExpressionLanguage\\ExpressionFunction;',
        'use Symfony\\Component\\ExpressionLanguage\\ExpressionFunctionProviderInterface;',
        '',
        'class IsGrantedFunction implements ExpressionFunctionProviderInterface',
        '{',
        '    public function getFunctions(): array',
        '    {',
        '        return [',
        '            new ExpressionFunction("is_owner", fn ($subject) => sprintf("is_owner(%s)", $subject), fn ($values, $subject) => true),',
        '        ];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Expression/SecondFunction.php': [
        '<?php',
        'namespace App\\Expression;',
        '',
        'use Symfony\\Component\\ExpressionLanguage\\ExpressionFunction;',
        'use Symfony\\Component\\ExpressionLanguage\\ExpressionFunctionProviderInterface;',
        '',
        'class SecondFunction implements ExpressionFunctionProviderInterface',
        '{',
        '    public function getFunctions(): array',
        '    {',
        '        return [new ExpressionFunction("is_weekend", fn () => "is_weekend()", fn () => false)];',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/routes/api.yaml': [
        'api_secure:',
        '    path: /api/secure',
        '    controller: App\\Controller\\SecureController::index',
        '    schemes: [https]',
        '    methods: [GET, POST]',
        '    requirements:',
        '        _locale: "en|es"',
        '',
        'api_health:',
        '    path: /health',
        '    controller: App\\Controller\\HealthController::check',
        '    schemes: ["https"]',
        '',
        'api_ready:',
        '    path: /ready',
        '    controller: App\\Controller\\HealthController::ready',
      ].join('\n') + '\n',
      'config/routes/admin.yaml': [
        'admin_area:',
        '    resource: "../../src/Controller/Admin/"',
        '    type: attribute',
        '    prefix: /admin',
        '    requirements:',
        '        _locale: "en"',
        '    defaults:',
        '        _locale: en',
        '',
        'api_area:',
        '    resource: "../../src/Controller/Api/"',
        '    type: attribute',
        '    prefix: /api/v1',
        '    requirements:',
        '        version: "v1|v2"',
      ].join('\n') + '\n',
      'src/Controller/HealthController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\JsonResponse;',
        'use Symfony\\Component\\Routing\\Attribute\\Route;',
        '',
        'class HealthController extends AbstractController',
        '{',
        '    #[Route("/health", name: "health")]',
        '    public function check(): JsonResponse',
        '    {',
        '        return $this->json(["status" => "ok", "database" => "up", "version" => "1.4.0"]);',
        '    }',
        '',
        '    #[Route("/ready", name: "ready")]',
        '    public function ready(): JsonResponse',
        '    {',
        '        return $this->json(["status" => "ok"]);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/security.yaml': [
        'security:',
        '    firewalls:',
        '        main:',
        '            lazy: true',
        '    access_control:',
        '        - { path: ^/admin, roles: ROLE_ADMIN }',
      ].join('\n') + '\n',
      'src/Controller/Admin/DashboardController.php': '<?php\n\nnamespace App\\Controller\\Admin;\n\nclass DashboardController\n{\n}\n',
      'src/Controller/Api/OrderController.php': '<?php\n\nnamespace App\\Controller\\Api;\n\nclass OrderController\n{\n}\n',
    });

    const results = await Promise.all([
      runModule('symfony-expression-language-ext.js', app),
      runModule('symfony-routing-requirements.js', app),
      runModule('symfony-routing-sub-collections.js', app),
      runModule('symfony-health-endpoint-security.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('aggregates that record events without dispatching them', async () => {
    const app = appWith('domain-events', {
      'src/Domain/Order.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Order',
        '{',
        '    private array $domainEvents = [];',
        '',
        '    public function place(): void',
        '    {',
        '        $this->recordEvent(new OrderPlaced($this));',
        '    }',
        '',
        '    public function cancel(): void',
        '    {',
        '        $this->recordEvent(new OrderCancelled($this));',
        '    }',
        '',
        '    private function recordEvent(object $event): void',
        '    {',
        '        $this->domainEvents[] = $event;',
        '    }',
        '',
        '    public function releaseEvents(): array',
        '    {',
        '        $events = $this->domainEvents;',
        '        $this->domainEvents = [];',
        '',
        '        return $events;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Domain/Invoice.php': [
        '<?php',
        'namespace App\\Domain;',
        '',
        'class Invoice',
        '{',
        '    private array $domainEvents = [];',
        '',
        '    public function issue(): void',
        '    {',
        '        $this->domainEvents[] = new InvoiceIssued($this);',
        '    }',
        '',
        '    public function releaseEvents(): array',
        '    {',
        '        return $this->domainEvents;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Domain/OrderPlaced.php': '<?php\n\nnamespace App\\Domain;\n\nfinal class OrderPlaced\n{\n    public function __construct(public readonly object $order) {}\n}\n',
      'src/Domain/OrderCancelled.php': '<?php\n\nnamespace App\\Domain;\n\nfinal class OrderCancelled\n{\n    public function __construct(public readonly object $order) {}\n}\n',
      'src/Domain/InvoiceIssued.php': '<?php\n\nnamespace App\\Domain;\n\nfinal class InvoiceIssued\n{\n    public function __construct(public readonly object $invoice) {}\n}\n',
      'src/EventListener/DomainEventDispatcher.php': [
        '<?php',
        'namespace App\\EventListener;',
        '',
        'use App\\Domain\\Order;',
        'use Psr\\EventDispatcher\\EventDispatcherInterface;',
        '',
        'class DomainEventDispatcher',
        '{',
        '    public function __construct(private EventDispatcherInterface $dispatcher) {}',
        '',
        '    public function flush(Order $order): void',
        '    {',
        '        foreach ($order->releaseEvents() as $event) {',
        '            $this->dispatcher->dispatch($event);',
        '        }',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-domain-events.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('templates and tests the sorting reports need two of', async () => {
    const app = appWith('twig-and-tests', {
      'templates/first.html.twig': [
        '{{ first|raw }}',
        '{{ render(controller("App\\\\Controller\\\\FirstController::side")) }}',
        '{{ render(path("app_second")) }}',
      ].join('\n') + '\n',
      'templates/second.html.twig': [
        '{{ second|raw }}',
        '{{ include(dynamic) }}',
        '{{ render(controller("App\\\\Controller\\\\SecondController::side")) }}',
      ].join('\n') + '\n',
      'templates/third.html.twig': '{{ third|raw }}\n{{ render_esi(controller("App\\\\Controller\\\\FirstController::esi")) }}\n',
      'src/Controller/FirstController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        '',
        'class FirstController extends AbstractController',
        '{',
        '    public function side(): Response { return new Response("first"); }',
        '    public function esi(): Response { return new Response("esi"); }',
        '}',
      ].join('\n') + '\n',
      'src/Controller/SecondController.php': [
        '<?php',
        'namespace App\\Controller;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;',
        'use Symfony\\Component\\HttpFoundation\\Response;',
        '',
        'class SecondController extends AbstractController',
        '{',
        '    public function side(): Response { return new Response("second"); }',
        '}',
      ].join('\n') + '\n',
      'src/Workflow/FirstSubscriber.php': [
        '<?php',
        'namespace App\\Workflow;',
        '',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'use Symfony\\Component\\Workflow\\Event\\GuardEvent;',
        '',
        'class FirstSubscriber implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return ["workflow.publication.guard.publish" => "onGuard"];',
        '    }',
        '',
        '    public function onGuard(GuardEvent $event): void',
        '    {',
        '        $event->setBlocked(true, "not allowed");',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Workflow/SecondSubscriber.php': [
        '<?php',
        'namespace App\\Workflow;',
        '',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'use Symfony\\Component\\Workflow\\Event\\Event;',
        '',
        'class SecondSubscriber implements EventSubscriberInterface',
        '{',
        '    public static function getSubscribedEvents(): array',
        '    {',
        '        return ["workflow.publication.completed" => "onCompleted", "workflow.publication.entered" => "onEntered"];',
        '    }',
        '',
        '    public function onCompleted(Event $event): void { }',
        '    public function onEntered(Event $event): void { }',
        '}',
      ].join('\n') + '\n',
      'tests/FirstKernelTest.php': [
        '<?php',
        'namespace App\\Tests;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;',
        '',
        'class FirstKernelTest extends WebTestCase',
        '{',
        '    public function testOne(): void',
        '    {',
        '        $client = static::createClient();',
        '        $client->request("GET", "/");',
        '        self::ensureKernelShutdown();',
        '    }',
        '}',
      ].join('\n') + '\n',
      'tests/SecondKernelTest.php': [
        '<?php',
        'namespace App\\Tests;',
        '',
        'use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;',
        '',
        'class SecondKernelTest extends WebTestCase',
        '{',
        '    public function testTwo(): void',
        '    {',
        '        $client = static::createClient();',
        '        $client->request("GET", "/second");',
        '        $again = static::createClient();',
        '    }',
        '',
        '    public function testThree(): void',
        '    {',
        '        static::bootKernel();',
        '        static::getContainer()->get("doctrine");',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('symfony-twig-security.js', app),
      runModule('symfony-subrequest.js', app),
      runModule('symfony-workflow-events.js', app),
      runModule('symfony-test-http-kernel.js', app),
    ]);
    expect(results.join('').length).toBeGreaterThan(0);
  });
});
