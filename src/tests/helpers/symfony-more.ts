// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Content for the modules still finding nothing.
 *
 * Each block was written from what the module reads and the literals it
 * searches for, taken from its own source rather than from what a project
 * usually looks like.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Traefik, SonarQube and SQS environment settings. */
function infraConfigs(root: string): void {
  put(root, '.traefik/traefik.yml', [
    'entryPoints:',
    '    web:',
    '        address: ":80"',
    '        http:',
    '            redirections:',
    '                entryPoint:',
    '                    to: websecure',
    '                    scheme: https',
    '    websecure:',
    '        address: ":443"',
    '',
    'providers:',
    '    docker:',
    '        exposedByDefault: false',
    '    file:',
    '        directory: /etc/traefik/dynamic',
    '',
    'certificatesResolvers:',
    '    letsencrypt:',
    '        acme:',
    '            email: ops@example.com',
    '            storage: /letsencrypt/acme.json',
    '            httpChallenge:',
    '                entryPoint: web',
    '',
    'accessLog:',
    '    filePath: /var/log/traefik/access.log',
    '    format: json',
    '',
    'api:',
    '    dashboard: true',
    '    insecure: false',
  ].join('\n') + '\n');

  put(root, '.traefik/dynamic/middlewares.yml', [
    'http:',
    '    middlewares:',
    '        secure-headers:',
    '            headers:',
    '                frameDeny: true',
    '                contentTypeNosniff: true',
    '                stsSeconds: 31536000',
    '        rate-limit:',
    '            rateLimit:',
    '                average: 100',
    '                burst: 50',
  ].join('\n') + '\n');

  put(root, 'sonar-project.properties', [
    'sonar.projectKey=acme_app',
    'sonar.organization=acme',
    'sonar.sources=src',
    'sonar.tests=tests',
    'sonar.php.coverage.reportPaths=var/coverage/clover.xml',
    'sonar.php.tests.reportPath=var/test-results/junit.xml',
    'sonar.qualitygate.wait=true',
    'sonar.exclusions=src/Migrations/**,vendor/**',
  ].join('\n') + '\n');

  put(root, '.github/workflows/sonarqube.yml', [
    'name: SonarQube',
    'on: [push]',
    'jobs:',
    '    scan:',
    '        runs-on: ubuntu-latest',
    '        steps:',
    '            - uses: actions/checkout@v4',
    '            - uses: SonarSource/sonarqube-scan-action@v2',
    '              env:',
    '                  SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
  ].join('\n') + '\n');

  put(root, '.env.local', [
    'APP_ENV=prod',
    'AWS_REGION=eu-west-1',
    'AWS_DEFAULT_REGION=eu-west-1',
    'MESSENGER_TRANSPORT_DSN=https://sqs.eu-west-1.amazonaws.com/000000000000/orders.fifo',
    'SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/000000000000/orders.fifo',
    'SQS_VISIBILITY_TIMEOUT=30',
    'SQS_WAIT_TIME=20',
  ].join('\n') + '\n');

}

/** Monolog channel mapping, IP access, importmap polyfill. */
function symfonyBits(root: string): void {
  put(root, 'config/packages/monolog.yaml', [
    'monolog:',
    '    channels:',
    '        - deprecation',
    '        - business',
    '        - security',
    '        - payment',
    '    handlers:',
    '        main:',
    '            type: fingers_crossed',
    '            action_level: error',
    '            handler: nested',
    '            excluded_http_codes: [404, 405]',
    '            channels: ["!event", "!doctrine", "!console"]',
    '        nested:',
    '            type: rotating_file',
    '            path: "%kernel.logs_dir%/%kernel.environment%.log"',
    '            level: debug',
    '            max_files: 14',
    '        payment:',
    '            type: stream',
    '            path: "%kernel.logs_dir%/payment.log"',
    '            level: info',
    '            channels: [payment]',
    '        console:',
    '            type: console',
    '            process_psr_3_messages: false',
    '            channels: ["!event", "!doctrine"]',
  ].join('\n') + '\n');

  put(root, 'src/Service/ChannelLogger.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Psr\\Log\\LoggerInterface;',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\Autowire;',
    '',
    'class ChannelLogger',
    '{',
    '    public function __construct(',
    '        #[Autowire(service: "monolog.logger.payment")]',
    '        private LoggerInterface $paymentLogger,',
    '        #[Autowire(service: "monolog.logger.business")]',
    '        private LoggerInterface $businessLogger,',
    '    ) {}',
    '',
    '    public function log(): void',
    '    {',
    '        $this->paymentLogger->info("charged");',
    '        $this->businessLogger->warning("threshold reached");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'importmap.php', [
    '<?php',
    '',
    'return [',
    '    "app" => ["path" => "./assets/app.js", "entrypoint" => true],',
    '    "@hotwired/stimulus" => ["version" => "3.2.2"],',
    '    "core-js/stable" => ["version" => "3.36.0"],',
    '    "es-module-shims" => ["version" => "1.8.2", "polyfill" => true],',
    '    "bootstrap" => ["version" => "5.3.3"],',
    '    "bootstrap/dist/css/bootstrap.min.css" => ["version" => "5.3.3", "type" => "css"],',
    '];',
  ].join('\n') + '\n');
}

/** never return type, constraint validator tests, XSS in templates. */
function phpAndTests(root: string): void {
  put(root, 'src/Exception/Thrower.php', [
    '<?php',
    'namespace App\\Exception;',
    '',
    'class Thrower',
    '{',
    '    public function fail(string $why): never',
    '    {',
    '        throw new \\RuntimeException($why);',
    '    }',
    '',
    '    public function redirect(string $url): never',
    '    {',
    '        header("Location: " . $url);',
    '        exit;',
    '    }',
    '',
    '    public function stop(): never',
    '    {',
    '        die("stopped");',
    '    }',
    '',
    '    // Returns void but only ever throws: a candidate for never',
    '    public function alsoFails(): void',
    '    {',
    '        throw new \\LogicException("always");',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'tests/Unit/Validator/ValidVatValidatorTest.php', [
    '<?php',
    'namespace App\\Tests\\Unit\\Validator;',
    '',
    'use App\\Validator\\ValidVatConstraint;',
    'use App\\Validator\\ValidVatConstraintValidator;',
    'use Symfony\\Component\\Validator\\Test\\ConstraintValidatorTestCase;',
    '',
    'class ValidVatValidatorTest extends ConstraintValidatorTestCase',
    '{',
    '    protected function createValidator(): ValidVatConstraintValidator',
    '    {',
    '        return new ValidVatConstraintValidator();',
    '    }',
    '',
    '    public function testNullIsValid(): void',
    '    {',
    '        $this->validator->validate(null, new ValidVatConstraint());',
    '        $this->assertNoViolation();',
    '    }',
    '',
    '    public function testInvalidVatRaises(): void',
    '    {',
    '        $constraint = new ValidVatConstraint();',
    '        $this->validator->validate("nope", $constraint);',
    '        $this->buildViolation($constraint->message)->assertRaised();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/unsafe.html.twig', [
    '{% extends "base.html.twig" %}',
    '{% block body %}',
    '    {{ comment.body|raw }}',
    '    <div data-json="{{ payload|json_encode }}">{{ payload|json_encode|raw }}</div>',
    '    <script>var user = {{ user|json_encode|raw }};</script>',
    '    <a href="{{ target }}" onclick="go({{ id }})">link</a>',
    '    {{ trusted|escape("html") }}',
    '    {{ untrusted|e("js") }}',
    '    {% autoescape false %}{{ anything }}{% endautoescape %}',
    '{% endblock %}',
  ].join('\n') + '\n');
}

/** Gedmo slug handlers and cache chain, both still empty. */
function gedmoAndCache(root: string): void {
  put(root, 'src/Entity/Page.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Gedmo\\Mapping\\Annotation as Gedmo;',
    '',
    '#[ORM\\Entity]',
    '#[ORM\\Index(name: "idx_page_slug", columns: ["slug"])]',
    'class Page',
    '{',
    '    #[Gedmo\\Slug(fields: ["title"], updatable: false, unique: true, separator: "-")]',
    '    #[ORM\\Column(length: 128, unique: true)]',
    '    private ?string $slug = null;',
    '',
    '    #[Gedmo\\Slug(',
    '        fields: ["title"],',
    '        handlers: [',
    '            new Gedmo\\SlugHandler(class: \\Gedmo\\Sluggable\\Handler\\TreeSlugHandler::class),',
    '        ],',
    '    )]',
    '    private $treePath;',
    '',
    '    #[ORM\\Column(length: 255)]',
    '    private string $title = \'\';',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/cache.yaml', [
    'framework:',
    '    cache:',
    '        app: cache.adapter.redis',
    '        default_redis_provider: "redis://localhost:6379"',
    '        pools:',
    '            app.cache.layered:',
    '                adapter: cache.adapter.chain',
    '                provider: ~',
    '                default_lifetime: 120',
    '            app.cache.multi:',
    '                adapters:',
    '                    - cache.adapter.array',
    '                    - cache.adapter.filesystem',
    '                    - cache.adapter.redis',
    '                tags: true',
    '            app.cache.tags:',
    '                adapter: cache.app',
    '                tags: app.cache.tag_store',
    '            app.cache.tag_store:',
    '                adapter: cache.adapter.redis',
    '            app.cache.sessions:',
    '                adapter: cache.adapter.memcached',
    '                provider: "memcached://memcached:11211?weight=50"',
    '                default_lifetime: 1800',
    '        default_memcached_provider: "memcached://memcached:11211"',
  ].join('\n') + '\n');

  put(root, 'src/Cache/LayeredCache.php', [
    '<?php',
    'namespace App\\Cache;',
    '',
    'use Symfony\\Component\\Cache\\Adapter\\ApcuAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\ArrayAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\ChainAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\FilesystemAdapter;',
    'use Symfony\\Component\\Cache\\Adapter\\TagAwareAdapter;',
    '',
    'class LayeredCache',
    '{',
    '    public function build(): TagAwareAdapter',
    '    {',
    '        $chain = new ChainAdapter([',
    '            new ArrayAdapter(60),',
    '            new ApcuAdapter("app", 300),',
    '            new FilesystemAdapter("app", 3600),',
    '        ], 60);',
    '',
    '        return new TagAwareAdapter($chain, new FilesystemAdapter("tags"));',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Rate limiters, kernel subscribers, SQS transport and raw-PHP output. */
function limitersEventsAndOutput(root: string): void {
  // Symfony's own four-space style puts the limiter names eight spaces in.
  put(root, 'config/packages/rate_limiter.yaml', [
    'framework:',
    '    rate_limiter:',
    '        anonymous_api:',
    '            policy: "fixed_window"',
    '            limit: 100',
    '            interval: "60 minutes"',
    '        authenticated_api:',
    '            policy: "sliding_window"',
    '            limit: 5000',
    '            interval: "1 hour"',
    '        uploads:',
    '            policy: "token_bucket"',
    '            limit: 10',
    '            rate: { interval: "15 minutes", amount: 5 }',
    '        downloads:',
    '            policy: "token_bucket"',
    '            limit: 20',
    '        reports:',
    '            policy: "sliding_window"',
    '            limit: 250000',
    '            interval: "1 day"',
    '        internal:',
    '            policy: "no_limit"',
    '        broken:',
    '            policy: "sliding_window"',
    '            interval: "1 hour"',
  ].join('\n') + '\n');

  put(root, 'config/packages/prod/rate_limiter.yaml', [
    'framework:',
    '    rate_limiter:',
    '        internal:',
    '            policy: "no_limit"',
  ].join('\n') + '\n');

  put(root, 'src/EventSubscriber/KernelSubscriber.php', [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    'use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;',
    'use Symfony\\Component\\HttpKernel\\Event\\ResponseEvent;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    'class KernelSubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents(): array',
    '    {',
    '        return [',
    '            KernelEvents::REQUEST => ["onRequest", 32],',
    '            KernelEvents::RESPONSE => ["onResponse", -10],',
    '            KernelEvents::CONTROLLER_ARGUMENTS => "onArguments",',
    '            KernelEvents::EXCEPTION => ["onException", 0],',
    '            KernelEvents::FINISH_REQUEST => "onFinish",',
    '        ];',
    '    }',
    '',
    '    public function onRequest(RequestEvent $event): void { }',
    '    public function onResponse(ResponseEvent $event): void { }',
    '    public function onArguments($event): void { }',
    '    public function onException($event): void { }',
    '    public function onFinish($event): void { }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventSubscriber/LegacyKernelSubscriber.php', [
    '<?php',
    'namespace App\\EventSubscriber;',
    '',
    'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
    '',
    'class LegacyKernelSubscriber implements EventSubscriberInterface',
    '{',
    '    public static function getSubscribedEvents()',
    '    {',
    '        return [',
    '            "kernel.request" => ["onRequest", 8],',
    '            "kernel.terminate" => "onTerminate",',
    '        ];',
    '    }',
    '',
    '    public function onRequest($event)',
    '    {',
    '        if (!$event->isMainRequest()) { return; }',
    '    }',
    '',
    '    public function onTerminate($event)',
    '    {',
    '        file_put_contents("/var/log/audit.log", "done", FILE_APPEND);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/TerminateListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
    'use Symfony\\Component\\HttpKernel\\KernelEvents;',
    '',
    '#[AsEventListener(event: KernelEvents::TERMINATE, method: "onTerminate", priority: -100)]',
    '#[AsEventListener(event: KernelEvents::CONTROLLER_ARGUMENTS, method: "onArguments")]',
    '#[AsEventListener(event: "kernel.request")]',
    'class TerminateListener',
    '{',
    '    public function onTerminate($event): void',
    '    {',
    '        $this->mailer->send($message);',
    '    }',
    '',
    '    public function onArguments($event): void { }',
    '    public function __invoke($event): void { }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Legacy/Output.php', [
    '<?php',
    'namespace App\\Legacy;',
    '',
    'class Output',
    '{',
    '    public function render(array $row, $request): void',
    '    {',
    '        echo $row["name"];',
    '        echo $_GET["q"];',
    '        print $_POST["comment"];',
    '        echo $request->get("term");',
    '        print $row["total"];',
    '        echo htmlspecialchars($row["safe"], ENT_QUOTES);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/legacy/list.phtml', [
    '<ul>',
    '<?php foreach ($rows as $row): ?>',
    '    <li><?= $row["name"] ?></li>',
    '    <li><?= $_GET["highlight"] ?></li>',
    '    <li><?= htmlspecialchars($row["safe"]) ?></li>',
    '<?php endforeach; ?>',
    '</ul>',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addMoreContent(root: string): void {
  infraConfigs(root);
  symfonyBits(root);
  phpAndTests(root);
  gedmoAndCache(root);
  limitersEventsAndOutput(root);
}
