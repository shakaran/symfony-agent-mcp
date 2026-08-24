// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Per-area fixture content.
 *
 * The generic fixtures get every module past its "is there anything to read"
 * guard, but each subject area has its own file layout and its own vocabulary,
 * and a module analyses nothing until it sees them. These add the real shapes
 * — a messenger transport with a failure queue, a workflow with places and
 * transitions, an API Platform resource with a filter — so the parsing and the
 * reporting both run.
 *
 * Each function is additive and safe to apply to any fixture.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Messenger: transports, routing, handlers, retries, a failure queue. */
export function addMessengerFiles(root: string): void {
  put(root, 'config/packages/messenger.yaml', [
    'framework:',
    '    messenger:',
    '        failure_transport: failed',
    '        transports:',
    '            async:',
    '                dsn: "%env(MESSENGER_TRANSPORT_DSN)%"',
    '                retry_strategy:',
    '                    max_retries: 3',
    '                    delay: 1000',
    '                    multiplier: 2',
    '                options:',
    '                    queue_name: default',
    '            async_priority_high:',
    '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/high"',
    '                retry_strategy:',
    '                    max_retries: 0',
    '            failed:',
    '                dsn: "doctrine://default?queue_name=failed"',
    '            sync:',
    '                dsn: "sync://"',
    '        routing:',
    '            App\\Message\\SendEmail: async',
    '            App\\Message\\GenerateReport: async_priority_high',
    '            App\\Message\\AuditEvent: [async, sync]',
    '        buses:',
    '            command.bus:',
    '                middleware:',
    '                    - validation',
    '                    - doctrine_transaction',
    '            query.bus:',
    '                default_middleware: allow_no_handlers',
  ].join('\n') + '\n');

  put(root, 'src/Message/SendEmail.php', [
    '<?php',
    'namespace App\\Message;',
    '',
    'final class SendEmail',
    '{',
    '    public function __construct(private string $to, private string $subject) {}',
    '    public function getTo(): string { return $this->to; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Message/GenerateReport.php', [
    '<?php',
    'namespace App\\Message;',
    'final class GenerateReport { public function __construct(public readonly int $id) {} }',
  ].join('\n') + '\n');

  put(root, 'src/MessageHandler/SendEmailHandler.php', [
    '<?php',
    'namespace App\\MessageHandler;',
    '',
    'use App\\Message\\SendEmail;',
    'use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;',
    '',
    '#[AsMessageHandler]',
    'final class SendEmailHandler',
    '{',
    '    public function __invoke(SendEmail $message): void',
    '    {',
    '        // no retry guard, no idempotency key',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/MessageHandler/LegacyHandler.php', [
    '<?php',
    'namespace App\\MessageHandler;',
    '',
    'use Symfony\\Component\\Messenger\\Handler\\MessageHandlerInterface;',
    '',
    'class LegacyHandler implements MessageHandlerInterface',
    '{',
    '    public function __invoke($message): void {}',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Middleware/AuditMiddleware.php', [
    '<?php',
    'namespace App\\Middleware;',
    '',
    'use Symfony\\Component\\Messenger\\Middleware\\MiddlewareInterface;',
    'use Symfony\\Component\\Messenger\\Middleware\\StackInterface;',
    '',
    'class AuditMiddleware implements MiddlewareInterface',
    '{',
    '    public function handle($envelope, StackInterface $stack) { return $stack->next()->handle($envelope, $stack); }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/scheduler.yaml', [
    'framework:',
    '    scheduler:',
    '        schedules:',
    '            default:',
    '                transport: async',
  ].join('\n') + '\n');
}

/** Workflow: a state machine and a workflow, with places and transitions. */
export function addWorkflowFiles(root: string): void {
  put(root, 'config/packages/workflow.yaml', [
    'framework:',
    '    workflows:',
    '        order_processing:',
    '            type: state_machine',
    '            audit_trail:',
    '                enabled: true',
    '            marking_store:',
    '                type: method',
    '                property: status',
    '            supports:',
    '                - App\\Entity\\Order',
    '            initial_marking: draft',
    '            places:',
    '                - draft',
    '                - pending',
    '                - paid',
    '                - shipped',
    '                - cancelled',
    '            transitions:',
    '                submit:',
    '                    from: draft',
    '                    to: pending',
    '                pay:',
    '                    from: pending',
    '                    to: paid',
    '                    guard: "is_granted(\'ROLE_USER\')"',
    '                ship:',
    '                    from: paid',
    '                    to: shipped',
    '                cancel:',
    '                    from: [draft, pending, paid]',
    '                    to: cancelled',
    '        publication:',
    '            type: workflow',
    '            marking_store:',
    '                type: method',
    '                property: marking',
    '            supports:',
    '                - App\\Entity\\Article',
    '            places: [drafted, reviewed, published]',
    '            transitions:',
    '                review:',
    '                    from: drafted',
    '                    to: reviewed',
    '                publish:',
    '                    from: reviewed',
    '                    to: published',
  ].join('\n') + '\n');

  put(root, 'src/EventListener/WorkflowListener.php', [
    '<?php',
    'namespace App\\EventListener;',
    '',
    'use Symfony\\Component\\Workflow\\Event\\GuardEvent;',
    'use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;',
    '',
    'class WorkflowListener',
    '{',
    '    #[AsEventListener(event: "workflow.order_processing.guard.pay")]',
    '    public function onPay(GuardEvent $event): void',
    '    {',
    '        $event->setBlocked(true, "not allowed");',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** API Platform: resources, filters, operations, serialization groups. */
export function addApiPlatformFiles(root: string): void {
  put(root, 'config/packages/api_platform.yaml', [
    'api_platform:',
    '    title: Demo API',
    '    version: 1.0.0',
    '    formats:',
    '        jsonld: ["application/ld+json"]',
    '        json: ["application/json"]',
    '    defaults:',
    '        pagination_items_per_page: 30',
    '        pagination_client_items_per_page: true',
  ].join('\n') + '\n');

  put(root, 'src/ApiResource/Product.php', [
    '<?php',
    'namespace App\\ApiResource;',
    '',
    'use ApiPlatform\\Metadata\\ApiResource;',
    'use ApiPlatform\\Metadata\\ApiFilter;',
    'use ApiPlatform\\Metadata\\Get;',
    'use ApiPlatform\\Metadata\\GetCollection;',
    'use ApiPlatform\\Metadata\\Post;',
    'use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    '',
    '#[ApiResource(',
    '    operations: [new Get(), new GetCollection(), new Post()],',
    '    normalizationContext: ["groups" => ["product:read"]],',
    '    denormalizationContext: ["groups" => ["product:write"]],',
    '    paginationItemsPerPage: 30,',
    ')]',
    '#[ApiFilter(SearchFilter::class, properties: ["name" => "partial"])]',
    'class Product',
    '{',
    '    #[Groups(["product:read"])]',
    '    public int $id;',
    '',
    '    #[Groups(["product:read", "product:write"])]',
    '    public string $name;',
    '',
    '    // No group: silently invisible in both directions',
    '    public string $internalNote;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/State/ProductProcessor.php', [
    '<?php',
    'namespace App\\State;',
    '',
    'use ApiPlatform\\State\\ProcessorInterface;',
    '',
    'class ProductProcessor implements ProcessorInterface',
    '{',
    '    public function process($data, $operation, array $uriVariables = [], array $context = []) { return $data; }',
    '}',
  ].join('\n') + '\n');
}

/** Serializer: groups, normalizers, circular-reference handling. */
export function addSerializerFiles(root: string): void {
  put(root, 'config/packages/serializer.yaml', [
    'framework:',
    '    serializer:',
    '        enable_annotations: true',
    '        circular_reference_handler: null',
    '        name_converter: serializer.name_converter.camel_case_to_snake_case',
  ].join('\n') + '\n');

  put(root, 'src/Serializer/UserNormalizer.php', [
    '<?php',
    'namespace App\\Serializer;',
    '',
    'use Symfony\\Component\\Serializer\\Normalizer\\NormalizerInterface;',
    '',
    'class UserNormalizer implements NormalizerInterface',
    '{',
    '    public function normalize($object, ?string $format = null, array $context = []): array { return []; }',
    '    public function supportsNormalization($data, ?string $format = null, array $context = []): bool { return true; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/serialization/User.yaml', [
    'App\\Entity\\User:',
    '    attributes:',
    '        email:',
    '            groups: ["user:read"]',
    '        password:',
    '            groups: []',
  ].join('\n') + '\n');
}

/** Deployment and orchestration: Kubernetes, Prometheus, platform configs. */
export function addDeploymentFiles(root: string): void {
  put(root, 'k8s/deployment.yaml', [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '    name: app',
    'spec:',
    '    replicas: 2',
    '    template:',
    '        spec:',
    '            containers:',
    '                - name: php',
    '                  image: acme/app:latest',
    '                  ports:',
    '                      - containerPort: 9000',
    '                  env:',
    '                      - name: APP_ENV',
    '                        value: prod',
    '                  resources: {}',
  ].join('\n') + '\n');

  put(root, 'k8s/service.yaml', [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '    name: app',
    'spec:',
    '    ports:',
    '        - port: 80',
    '          targetPort: 9000',
  ].join('\n') + '\n');

  put(root, 'prometheus/alerts.yml', [
    'groups:',
    '    - name: app',
    '      rules:',
    '          - alert: HighErrorRate',
    '            expr: rate(http_requests_total{status="500"}[5m]) > 0.05',
    '            for: 5m',
    '            labels:',
    '                severity: critical',
    '            annotations:',
    '                summary: "High error rate"',
  ].join('\n') + '\n');

  put(root, 'vercel.json', JSON.stringify({
    version: 2,
    builds: [{ src: 'api/index.php', use: 'vercel-php@0.6.0' }],
    routes: [{ src: '/(.*)', dest: '/api/index.php' }],
  }, null, 2));

  put(root, 'netlify.toml', [
    '[build]',
    '    command = "composer install"',
    '    publish = "public"',
    '',
    '[[redirects]]',
    '    from = "/*"',
    '    to = "/index.php"',
    '    status = 200',
  ].join('\n') + '\n');
}

/** Profiler, cache and monolog: the observability side. */
export function addObservabilityFiles(root: string): void {
  put(root, 'config/packages/web_profiler.yaml', [
    'web_profiler:',
    '    toolbar: true',
    '    intercept_redirects: false',
    'framework:',
    '    profiler:',
    '        only_exceptions: false',
    '        collect: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/monolog.yaml', [
    'monolog:',
    '    handlers:',
    '        main:',
    '            type: rotating_file',
    '            path: "%kernel.logs_dir%/%kernel.environment%.log"',
    '            level: debug',
    '            max_files: 7',
    '        console:',
    '            type: console',
    '            process_psr_3_messages: false',
  ].join('\n') + '\n');

  put(root, 'config/packages/cache.yaml', [
    'framework:',
    '    cache:',
    '        app: cache.adapter.redis',
    '        default_redis_provider: "redis://localhost:6379"',
    '        pools:',
    '            doctrine.result_cache_pool:',
    '                adapter: cache.app',
    '            app.cache.products:',
    '                adapter: cache.adapter.array',
    '                default_lifetime: 3600',
  ].join('\n') + '\n');
}

/** Behat and testing configuration. */
export function addTestingFiles(root: string): void {
  put(root, 'behat.yml', [
    'default:',
    '    suites:',
    '        default:',
    '            contexts:',
    '                - App\\Tests\\Behat\\FeatureContext',
    '    extensions:',
    '        Behat\\MinkExtension:',
    '            base_url: "http://localhost"',
  ].join('\n') + '\n');

  put(root, 'tests/Behat/FeatureContext.php', [
    '<?php',
    'namespace App\\Tests\\Behat;',
    'use Behat\\Behat\\Context\\Context;',
    'class FeatureContext implements Context {}',
  ].join('\n') + '\n');

  put(root, 'src/DataFixtures/AppFixtures.php', [
    '<?php',
    'namespace App\\DataFixtures;',
    '',
    'use Doctrine\\Bundle\\FixturesBundle\\Fixture;',
    'use Doctrine\\Bundle\\FixturesBundle\\FixtureGroupInterface;',
    'use Doctrine\\Persistence\\ObjectManager;',
    '',
    'class AppFixtures extends Fixture implements FixtureGroupInterface',
    '{',
    '    public static function getGroups(): array { return ["dev"]; }',
    '    public function load(ObjectManager $manager): void { $manager->flush(); }',
    '}',
  ].join('\n') + '\n');
}

/** Everything above, applied in one call. */
export function addAllAreas(root: string): void {
  addMessengerFiles(root);
  addWorkflowFiles(root);
  addApiPlatformFiles(root);
  addSerializerFiles(root);
  addDeploymentFiles(root);
  addObservabilityFiles(root);
  addTestingFiles(root);
}
