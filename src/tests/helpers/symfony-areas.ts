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

/** Security: voters, authenticators, custom access decisions. */
export function addSecurityFiles(root: string): void {
  put(root, 'src/Security/OrderVoter.php', [
    '<?php',
    'namespace App\\Security;',
    '',
    'use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;',
    'use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;',
    '',
    'class OrderVoter extends Voter',
    '{',
    '    public const VIEW = "ORDER_VIEW";',
    '    public const EDIT = "ORDER_EDIT";',
    '',
    '    protected function supports(string $attribute, $subject): bool',
    '    {',
    '        return in_array($attribute, [self::VIEW, self::EDIT], true);',
    '    }',
    '',
    '    protected function voteOnAttribute(string $attribute, $subject, TokenInterface $token): bool',
    '    {',
    '        $user = $token->getUser();',
    '        if (!$user) { return false; }',
    '        return match($attribute) {',
    '            self::VIEW => true,',
    '            self::EDIT => $subject->getOwner() === $user,',
    '            default => false,',
    '        };',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Security/ApiTokenAuthenticator.php', [
    '<?php',
    'namespace App\\Security;',
    '',
    'use Symfony\\Component\\Security\\Http\\Authenticator\\AbstractAuthenticator;',
    'use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Passport;',
    '',
    'class ApiTokenAuthenticator extends AbstractAuthenticator',
    '{',
    '    public function supports($request): ?bool { return $request->headers->has("X-API-TOKEN"); }',
    '    public function authenticate($request): Passport { throw new \\LogicException("stub"); }',
    '}',
  ].join('\n') + '\n');
}

/** Validation: constraints including UniqueEntity, and a custom validator. */
export function addValidatorFiles(root: string): void {
  put(root, 'config/packages/validator.yaml', [
    'framework:',
    '    validation:',
    '        email_validation_mode: html5',
    '        enable_annotations: true',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Customer.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    'use Symfony\\Bridge\\Doctrine\\Validator\\Constraints\\UniqueEntity;',
    '',
    '#[ORM\\Entity]',
    '#[UniqueEntity(fields: ["email"], message: "Already used")]',
    '#[UniqueEntity(fields: ["taxId", "country"], errorPath: "taxId")]',
    'class Customer',
    '{',
    '    #[ORM\\Column(length: 180, unique: true)]',
    '    #[Assert\\NotBlank]',
    '    #[Assert\\Email]',
    '    private string $email;',
    '',
    '    // Declared unique by the validator but not by the schema',
    '    #[ORM\\Column(length: 32)]',
    '    private string $taxId;',
    '',
    '    #[ORM\\Column(length: 2)]',
    '    private string $country;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Validator/ValidVatConstraint.php', [
    '<?php',
    'namespace App\\Validator;',
    'use Symfony\\Component\\Validator\\Constraint;',
    '#[\\Attribute]',
    'class ValidVatConstraint extends Constraint { public string $message = "Invalid VAT"; }',
  ].join('\n') + '\n');

  put(root, 'src/Validator/ValidVatConstraintValidator.php', [
    '<?php',
    'namespace App\\Validator;',
    '',
    'use Symfony\\Component\\Validator\\ConstraintValidator;',
    'use Symfony\\Component\\Validator\\Constraint;',
    '',
    'class ValidVatConstraintValidator extends ConstraintValidator',
    '{',
    '    public function validate($value, Constraint $constraint): void',
    '    {',
    '        if (!$value) { return; }',
    '        $this->context->buildViolation($constraint->message)->addViolation();',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Forms: several field types, options resolvers, a collection. */
export function addFormFiles(root: string): void {
  put(root, 'src/Form/OrderType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\ChoiceType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\CollectionType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\DateTimeType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\MoneyType;',
    'use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
    '',
    'class OrderType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder',
    '            ->add("reference", TextType::class, ["required" => true])',
    '            ->add("total", MoneyType::class, ["currency" => "EUR"])',
    '            ->add("placedAt", DateTimeType::class, ["widget" => "single_text"])',
    '            ->add("status", ChoiceType::class, [',
    '                "choices" => ["Draft" => "draft", "Paid" => "paid"],',
    '                "expanded" => false,',
    '            ])',
    '            ->add("lines", CollectionType::class, [',
    '                "entry_type" => OrderLineType::class,',
    '                "allow_add" => true,',
    '                "by_reference" => false,',
    '            ]);',
    '    }',
    '',
    '    public function configureOptions(OptionsResolver $resolver): void',
    '    {',
    '        $resolver->setDefaults(["data_class" => \\App\\Entity\\Order::class, "csrf_protection" => false]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/OrderLineType.php', [
    '<?php',
    'namespace App\\Form;',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'class OrderLineType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder->add("sku")->add("quantity");',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** HTTP client, third-party integrations and file storage. */
export function addIntegrationFiles(root: string): void {
  put(root, 'config/packages/framework_http_client.yaml', [
    'framework:',
    '    http_client:',
    '        default_options:',
    '            timeout: 30',
    '            max_redirects: 3',
    '            verify_peer: false',
    '        scoped_clients:',
    '            github.client:',
    '                base_uri: "https://api.github.com"',
    '                headers:',
    '                    Accept: "application/vnd.github+json"',
  ].join('\n') + '\n');

  put(root, 'src/Service/GithubClient.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
    '',
    'class GithubClient',
    '{',
    '    public function __construct(private HttpClientInterface $client) {}',
    '',
    '    public function repo(string $name): array',
    '    {',
    '        $response = $this->client->request("GET", "/repos/" . $name, ["timeout" => 5]);',
    '        return $response->toArray();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/oneup_flysystem.yaml', [
    'oneup_flysystem:',
    '    adapters:',
    '        local_adapter:',
    '            local:',
    '                location: "%kernel.project_dir%/var/storage"',
    '    filesystems:',
    '        uploads:',
    '            adapter: local_adapter',
  ].join('\n') + '\n');

  put(root, 'config/packages/vich_uploader.yaml', [
    'vich_uploader:',
    '    db_driver: orm',
    '    mappings:',
    '        product_image:',
    '            uri_prefix: /images/products',
    '            upload_destination: "%kernel.project_dir%/public/images/products"',
  ].join('\n') + '\n');

  put(root, 'config/packages/knpu_oauth2_client.yaml', [
    'knpu_oauth2_client:',
    '    clients:',
    '        google:',
    '            type: google',
    '            client_id: "%env(GOOGLE_CLIENT_ID)%"',
    '            client_secret: "%env(GOOGLE_CLIENT_SECRET)%"',
    '            redirect_route: connect_google_check',
  ].join('\n') + '\n');
}

/** Modern PHP language features the analysers look for. */
export function addModernPhpFiles(root: string): void {
  put(root, 'src/Enum/OrderStatus.php', [
    '<?php',
    'namespace App\\Enum;',
    '',
    'enum OrderStatus: string',
    '{',
    '    case Draft = "draft";',
    '    case Paid = "paid";',
    '',
    '    const DEFAULT = self::Draft;',
    '',
    '    public function label(): string',
    '    {',
    '        return match($this) { self::Draft => "Draft", self::Paid => "Paid" };',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Model/Money.php', [
    '<?php',
    'namespace App\\Model;',
    '',
    'final readonly class Money',
    '{',
    '    public const int SCALE = 2;',
    '    public const string CURRENCY = "EUR";',
    '',
    '    public function __construct(public int $amount) {}',
    '',
    '    public int $major {',
    '        get => intdiv($this->amount, 100);',
    '    }',
    '',
    '    public function with(int $amount): static',
    '    {',
    '        return new static($amount);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Service/Calculator.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class Calculator',
    '{',
    '    public function total(array $lines): int',
    '    {',
    '        $sum = array_map($this->lineTotal(...), $lines);',
    '        return array_sum($sum);',
    '    }',
    '',
    '    private function lineTotal(array $line): int { return $line["qty"] * $line["price"]; }',
    '}',
  ].join('\n') + '\n');
}

/** Symfony UX / Stimulus controllers and their values. */
export function addUxFiles(root: string): void {
  put(root, 'assets/controllers.json', JSON.stringify({
    controllers: { '@symfony/ux-turbo': { 'turbo-core': { enabled: true, fetch: 'eager' } } },
    entrypoints: [],
  }, null, 2));

  put(root, 'assets/controllers/search_controller.js', [
    "import { Controller } from '@hotwired/stimulus';",
    '',
    'export default class extends Controller {',
    "    static targets = ['input', 'results'];",
    '    static values = {',
    '        url: String,',
    '        minLength: { type: Number, default: 3 },',
    '        open: Boolean,',
    '    };',
    '',
    '    connect() { this.element.dataset.connected = "true"; }',
    '',
    '    search() {',
    '        if (this.inputTarget.value.length < this.minLengthValue) return;',
    '        fetch(this.urlValue);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/search.html.twig', [
    '<div {{ stimulus_controller("search", { url: path("app_home"), minLength: 3 }) }}>',
    '    <input data-search-target="input">',
    '    <ul data-search-target="results"></ul>',
    '</div>',
  ].join('\n') + '\n');
}

/** Doctrine repositories with queries the analysers inspect. */
export function addRepositoryFiles(root: string): void {
  put(root, 'src/Repository/UserRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'use App\\Entity\\User;',
    'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
    'use Doctrine\\Persistence\\ManagerRegistry;',
    '',
    'class UserRepository extends ServiceEntityRepository',
    '{',
    '    public function __construct(ManagerRegistry $registry)',
    '    {',
    '        parent::__construct($registry, User::class);',
    '    }',
    '',
    '    public function findActive(): array',
    '    {',
    '        return $this->createQueryBuilder("u")',
    '            ->andWhere("u.active = :active")',
    '            ->setParameter("active", true)',
    '            ->orderBy("u.email", "ASC")',
    '            ->setMaxResults(50)',
    '            ->getQuery()',
    '            ->getResult();',
    '    }',
    '',
    '    public function findWithOrders(): array',
    '    {',
    '        // No join: one query per user follows',
    '        return $this->createQueryBuilder("u")->getQuery()->getResult();',
    '    }',
    '',
    '    public function countAll(): int',
    '    {',
    '        return (int) $this->createQueryBuilder("u")',
    '            ->select("COUNT(u.id)")',
    '            ->getQuery()',
    '            ->getSingleScalarResult();',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Worker supervision, alert rules and profiler data. */
export function addOperationsFiles(root: string): void {
  put(root, 'docker/supervisord.conf', [
    '[supervisord]',
    'nodaemon=true',
    '',
    '[program:messenger-consume]',
    'command=php /var/www/bin/console messenger:consume async --time-limit=3600 --memory-limit=128M',
    'numprocs=4',
    'process_name=%(program_name)s_%(process_num)02d',
    'autostart=true',
    'autorestart=true',
    'startsecs=0',
    'user=www-data',
    '',
    '[program:messenger-failed]',
    'command=php /var/www/bin/console messenger:consume failed --limit=10',
    'numprocs=1',
    'autorestart=unexpected',
  ].join('\n') + '\n');

  put(root, 'prometheus/app.rules.yaml', [
    'groups:',
    '    - name: symfony',
    '      interval: 30s',
    '      rules:',
    '          - alert: MessengerQueueBacklog',
    '            expr: messenger_queue_size > 1000',
    '            for: 10m',
    '            labels:',
    '                severity: warning',
    '                team: backend',
    '            annotations:',
    '                summary: "Queue backlog"',
    '                runbook_url: "https://example.com/runbook"',
    '          - alert: PhpFpmSaturation',
    '            expr: phpfpm_active_processes / phpfpm_max_children > 0.9',
    '            for: 5m',
    '            labels:',
    '                severity: critical',
    '          - record: job:http_requests:rate5m',
    '            expr: sum(rate(http_requests_total[5m])) by (job)',
  ].join('\n') + '\n');

  // The profiler tools read the cache directory rather than configuration.
  put(root, 'var/cache/dev/profiler/index.csv',
    'a1b2c3,127.0.0.1,GET,http://localhost/,200,1756000000,,\n');
  put(root, 'var/cache/dev/profiler/a1/b2/a1b2c3', 'serialized-profile-stub\n');
  put(root, 'var/cache/prod/url_generating_routes.php', "<?php\nreturn [];\n");
  put(root, 'var/log/prod.deprecations.log', "[2026-08-24] deprecation: Passing null is deprecated\n");
}

/** HTML sanitizer configuration and a bundle extension. */
export function addConfigExtensionFiles(root: string): void {
  put(root, 'config/packages/html_sanitizer.yaml', [
    'framework:',
    '    html_sanitizer:',
    '        sanitizers:',
    '            app.comment_sanitizer:',
    '                allow_safe_elements: true',
    '                allow_elements:',
    '                    span: ["class"]',
    '                    a: ["href", "title"]',
    '                block_elements: ["script", "iframe"]',
    '                drop_attributes:',
    '                    style: ["*"]',
    '                force_https_urls: true',
    '                max_input_length: 20000',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/AppExtension.php', [
    '<?php',
    'namespace App\\DependencyInjection;',
    '',
    'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
    'use Symfony\\Component\\DependencyInjection\\Extension\\Extension;',
    'use Symfony\\Component\\DependencyInjection\\Loader\\YamlFileLoader;',
    'use Symfony\\Component\\Config\\FileLocator;',
    '',
    'class AppExtension extends Extension',
    '{',
    '    public function load(array $configs, ContainerBuilder $container): void',
    '    {',
    '        $config = $this->processConfiguration(new Configuration(), $configs);',
    '        $container->setParameter("app.retention_days", $config["retention_days"]);',
    '        $loader = new YamlFileLoader($container, new FileLocator(__DIR__ . "/../../config"));',
    '        $loader->load("services.yaml");',
    '    }',
    '',
    '    public function getAlias(): string { return "app"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/Configuration.php', [
    '<?php',
    'namespace App\\DependencyInjection;',
    '',
    'use Symfony\\Component\\Config\\Definition\\ConfigurationInterface;',
    'use Symfony\\Component\\Config\\Definition\\Builder\\TreeBuilder;',
    '',
    'class Configuration implements ConfigurationInterface',
    '{',
    '    public function getConfigTreeBuilder(): TreeBuilder',
    '    {',
    '        $tb = new TreeBuilder("app");',
    '        $tb->getRootNode()->children()->integerNode("retention_days")->defaultValue(30)->end();',
    '        return $tb;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/DependencyInjection/Compiler/TagPass.php', [
    '<?php',
    'namespace App\\DependencyInjection\\Compiler;',
    '',
    'use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;',
    'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
    '',
    'class TagPass implements CompilerPassInterface',
    '{',
    '    public function process(ContainerBuilder $container): void',
    '    {',
    '        foreach ($container->findTaggedServiceIds("app.handler") as $id => $tags) {',
    '            $container->getDefinition($id)->addMethodCall("setLogger", []);',
    '        }',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Low-level PHP the analysers look at: sockets, streams, APM agents. */
export function addLowLevelPhpFiles(root: string): void {
  put(root, 'src/Service/SocketProbe.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class SocketProbe',
    '{',
    '    public function probe(string $host, int $port): bool',
    '    {',
    '        $socket = socket_create(AF_INET, SOCK_STREAM, SOL_TCP);',
    '        socket_set_option($socket, SOL_SOCKET, SO_RCVTIMEO, ["sec" => 2, "usec" => 0]);',
    '        $ok = @socket_connect($socket, $host, $port);',
    '        socket_close($socket);',
    '        return (bool) $ok;',
    '    }',
    '',
    '    public function stream(string $host, int $port)',
    '    {',
    '        $fp = stream_socket_client("tcp://" . $host . ":" . $port, $errno, $errstr, 5);',
    '        stream_set_blocking($fp, false);',
    '        fwrite($fp, "PING\\r\\n");',
    '        $line = fgets($fp, 1024);',
    '        fclose($fp);',
    '        return $line;',
    '    }',
    '',
    '    public function curl(string $url): string',
    '    {',
    '        $ch = curl_init($url);',
    '        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
    '        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);',
    '        $body = curl_exec($ch);',
    '        curl_close($ch);',
    '        return (string) $body;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'docker/php/newrelic.ini', [
    'extension = newrelic.so',
    'newrelic.appname = "acme-app"',
    'newrelic.license = "0123456789abcdef0123456789abcdef01234567"',
    'newrelic.distributed_tracing_enabled = true',
    'newrelic.transaction_tracer.enabled = true',
    'newrelic.transaction_tracer.threshold = apdex_f',
    'newrelic.error_collector.enabled = true',
    'newrelic.loglevel = info',
  ].join('\n') + '\n');
}

/**
 * A catalogue of API usage, copied in from a committed PHP fixture.
 *
 * The realistic fixtures cover what an application normally contains. Many
 * analysers look for symbols a given application would not happen to use, and
 * their parsing never runs without one. The symbol list in that file was
 * extracted from the modules themselves — every string they search for — not
 * guessed, and anything credential-shaped was filtered out before writing it.
 */
export function addApiSurface(root: string): void {
  const source = path.join(__dirname, 'fixtures', 'api-surface.php');
  put(root, 'src/Reference/ApiSurface.php', fs.readFileSync(source, 'utf-8'));

  // The same idea on the configuration side: every key, DSN scheme, env var
  // and console command the modules look for, in one YAML document.
  const config = path.join(__dirname, 'fixtures', 'config-surface.yaml');
  put(root, 'config/packages/reference_surface.yaml', fs.readFileSync(config, 'utf-8'));

  // Many modules scan one specific subdirectory rather than src/ as a whole,
  // so a single copy is invisible to them. These are the directories the
  // modules actually join onto appPath.
  const php = fs.readFileSync(source, 'utf-8');
  for (const dir of [
    'Controller', 'Entity', 'Repository', 'Service', 'Form', 'Security',
    'MessageHandler', 'EventSubscriber', 'EventListener', 'Command', 'Twig',
    'Model', 'DataFixtures', 'Fixtures', 'Validator', 'Serializer', 'State',
    'Resources', 'Maker', 'Migrations', 'Tests',
  ]) {
    put(root, `src/${dir}/ApiSurfaceReference.php`, php.replace('final class ApiSurface', `final class ApiSurface${dir}`));
  }
  put(root, 'tests/ApiSurfaceReference.php', php.replace('final class ApiSurface', 'final class ApiSurfaceTests'));
}

/**
 * One reference file per analyser, carrying the symbols that analyser looks for.
 *
 * The single shared surface file lifted coverage a long way, but each module
 * searches for its own vocabulary — Algolia's index options, Stripe's webhook
 * events, Psalm's configuration keys — and one file cannot plausibly contain
 * all of them in the shapes each expects.
 *
 * This reads each module's own source, takes the literals it passes to
 * `includes()`, and writes them into a file the module will scan. What that
 * proves is deliberately narrow: it does not verify that a finding is
 * *correct*, only that the code path which produces it runs without throwing,
 * hanging or returning something the server cannot serialise. That is the
 * property that was entirely untested, and the one every defect found so far
 * would have violated.
 */
/**
 * Render one symbol in the several shapes a matcher might expect.
 *
 * A bare string in an array satisfies `includes()` but not a regular
 * expression, which usually wants the symbol in context — an attribute with
 * its parentheses, a superglobal with its bracket, a use statement with its
 * semicolon. Emitting each symbol several ways costs nothing and reaches the
 * matchers a plain list misses.
 */
function renderReference(className: string, symbols: string[]): string {
  const lines: string[] = [];
  const attrs: string[] = [];
  const uses: string[] = [];

  for (const sym of symbols) {
    if (/^[A-Z][A-Za-z0-9]*$/.test(sym)) {
      // Class-shaped. Most matchers for these want the attribute *with* its
      // arguments — /Groups\s*\(\s*\[([^\]]+)\]/ finds nothing against a
      // bare #[Groups]. Emit the argument forms an attribute actually takes.
      attrs.push(`#[${sym}]`);
      attrs.push(`#[ORM\\${sym}(targetEntity: Related::class, fetch: "EAGER")]`);
      attrs.push(`#[${sym}(["read", "write"])]`);
      attrs.push(`#[${sym}("value")]`);
      attrs.push(`#[${sym}(2)]`);
      attrs.push(`#[${sym}(name: "example", nullable: true)]`);
      uses.push(`use Symfony\\Component\\${sym};`);
      lines.push(`        $x = new ${sym}();`);
      lines.push(`        $y = ${sym}::class;`);
      lines.push(`        $z = $this->container->get(${sym}::class);`);
    } else if (sym === sym.toUpperCase() && /^[A-Z_][A-Z0-9_]*$/.test(sym)) {
      // Constant-shaped: as a constant, a superglobal subscript, and both
      // sides of the boolean settings so many checks turn on.
      lines.push(`        $c = ${sym};`);
      lines.push(`        $g = $_SERVER[${JSON.stringify(sym)}];`);
      lines.push(`        $on[${JSON.stringify(sym)}] = true;`);
      lines.push(`        $off[${JSON.stringify(sym)}] = false;`);
      lines.push(`        ini_set(${JSON.stringify(sym.toLowerCase())}, "1");`);
    } else if (sym.includes('_')) {
      lines.push(`        $a[${JSON.stringify(sym)}] = $this->${sym.replace(/[^A-Za-z0-9_]/g, '')}();`);
      lines.push(`        $this->config->set(${JSON.stringify(sym)}, true);`);
    } else {
      // Method-shaped names: matchers usually want the call with arguments,
      // and often chained, which is how these APIs are written in practice.
      const safe = sym.replace(/[^A-Za-z0-9_]/g, '');
      lines.push(`        $s = ${JSON.stringify(sym)};`);
      lines.push(`        $this->builder->${safe}('value', 30)->${safe}([1, 2])->getQuery();`);
      lines.push(`        $this->service->${safe}($request, ['timeout' => 5, 'verify_peer' => false]);`);
      // Concatenated user input is what a great many detections look for:
      // the same call is reported or not depending on whether its argument is
      // a literal or built from a request.
      lines.push(`        $this->service->${safe}("prefix " . $request->query->get("q") . " suffix");`);
      lines.push(`        $this->service->${safe}($_GET["id"]);`);
      lines.push(`        $this->service->${safe}(sprintf("%s", $userInput));`);
    }
  }

  return [
    ...uses,
    '',
    `class ${className}Annotated`,
    '{',
    ...attrs.map((a, i) => `    ${a}\n    private $field${i};\n`),
    '}',
    '',
    `class ${className}`,
    '{',
    '    public function symbols(): array',
    '    {',
    '        return [',
    ...symbols.map((l) => `            ${JSON.stringify(l)},`),
    '        ];',
    '    }',
    '',
    '    public function shapes(): void',
    '    {',
    ...lines,
    '    }',
    '}',
    '',
  ].join('\n');
}

export function addPerModuleSurface(root: string, toolsDir: string): void {
  const credentialish = /(secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i;
  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts'));

  const phpParts: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf-8');
    const literals = new Set<string>();
    for (const m of source.matchAll(/includes\('([^']{3,70})'\)/g)) {
      const lit = m[1];
      if (credentialish.test(lit)) continue;
      // Only shapes that can sit in PHP source without making it nonsense.
      if (/^[A-Za-z_$#\\][A-Za-z0-9_\\:>.$()[\]-]*$/.test(lit)) literals.add(lit);
    }

    // Not everything a module looks for goes through includes(): plenty is
    // matched by regular expression. Pull the symbol-shaped identifiers out of
    // regex literals in positions where one is unambiguous.
    for (const m of source.matchAll(
      /(?:=\s*|\.test\(|\.match\(|\.exec\(|\.matchAll\(|\.replace\()\s*\/((?:[^/\\\n]|\\.){4,300})\/[gimsuy]*/g
    )) {
      for (const word of m[1].match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) ?? []) {
        if (credentialish.test(word)) continue;
        // Symbols, not English: CamelCase, snake_case or ALLCAPS.
        if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(word) || word.includes('_') || word === word.toUpperCase()) {
          literals.add(word);
        }
      }
    }
    if (literals.size === 0) continue;

    const cls = file.replace(/\.ts$/, '').replace(/[^A-Za-z0-9]/g, '');
    phpParts.push(`// ${file}\n` + renderReference(`Ref${cls}`, [...literals]));
  }

  const header = [
    '<?php',
    '',
    '/**',
    ' * Per-analyser reference symbols, for the tool test-suite.',
    ' *',
    ' * Generated from the analysers themselves: each class holds the literals one',
    ' * module searches for. It is a fixture — plausible, never executed — and it',
    ' * exists so each module\'s parsing runs against something it recognises.',
    ' */',
    '',
    'namespace App\\Generated;',
    '',
  ].join('\n');

  // Split across the directories modules scan, so each sees a share.
  //
  // Giving every directory the whole set was tried and reverted: it pushed the
  // suite past ten minutes for no measurable gain, because a module scanning
  // src/ recursively already sees all of it and one scanning a single
  // directory is looking for a narrow vocabulary anyway.
  const dirs = ['Controller', 'Entity', 'Service', 'Repository', 'MessageHandler', 'Security', 'Form'];
  const chunk = Math.ceil(phpParts.length / dirs.length);
  dirs.forEach((dir, i) => {
    const part = phpParts.slice(i * chunk, (i + 1) * chunk);
    if (part.length === 0) return;
    put(root, `src/${dir}/GeneratedReference.php`, header + part.join('\n'));
  });

  // The same symbols again, in files that declare no class.
  //
  // 212 guards are `!classM`: a parser reaches them only after the file has
  // already matched the module's own vocabulary, and then finds no class to
  // attribute the finding to. The classes above satisfy the first half and
  // never the second, so that branch stayed unreachable. Real applications
  // produce these constantly — a returned config array mentioning a service,
  // a function library using an attribute.
  const classlessDirs = ['Config', 'Bootstrap', 'Legacy'];
  const classlessChunk = Math.ceil(phpParts.length / classlessDirs.length);
  classlessDirs.forEach((dir, i) => {
    const slice = phpParts.slice(i * classlessChunk, (i + 1) * classlessChunk);
    if (slice.length === 0) return;
    // Keep the rendered context — attributes with their arguments, use
    // statements, calls — and remove only the class declarations. Extracting
    // bare literals loses exactly what the matchers are looking at.
    const withoutClasses = slice
      .join('\n')
      .split('\n')
      .filter((line) => !/^\s*(final\s+)?(abstract\s+)?class\s|^\s*interface\s/.test(line))
      .filter((line) => !/^\s*(public|private|protected)\s+function\s/.test(line))
      .join('\n');

    const body = [
      '<?php',
      '',
      '/**',
      ' * Reference symbols with no class declaration, for the tool test-suite.',
      ' *',
      ' * The same vocabulary and the same syntactic context as the reference',
      ' * classes, in the shape an application file takes when it holds',
      ' * configuration rather than a type. A fixture — never loaded.',
      ' */',
      '',
      'namespace App\\Reference;',
      '',
      withoutClasses,
    ].join('\n');
    put(root, `src/${dir}/reference_values.php`, body + '\n');
  });

  // The configuration half. A module reading YAML never sees the PHP above,
  // and many of the literals only make sense as keys or scalar values.
  const yamlLines: string[] = [
    '# Per-analyser reference values, generated from the analysers themselves.',
    '# A fixture: not a working Symfony configuration, never loaded by an app.',
    '',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf-8');
    const values = new Set<string>();
    for (const m of source.matchAll(/includes\('([^']{3,70})'\)/g)) {
      const lit = m[1];
      if (credentialish.test(lit) || lit.includes('\n')) continue;
      values.add(lit);
    }
    if (values.size === 0) continue;
    yamlLines.push(`${file.replace(/\.ts$/, '').replace(/[^a-z0-9]/gi, '_')}:`);
    for (const v of values) yamlLines.push(`    - ${JSON.stringify(v)}`);
  }
  put(root, 'config/packages/generated_reference.yaml', yamlLines.join('\n') + '\n');

  // Twig is the third format these modules read, after PHP and YAML, and
  // 35 of them scan templates. Symbols go in comments so the template stays
  // syntactically plausible.
  const twigSymbols = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf-8');
    for (const m of source.matchAll(/includes\('([^']{3,60})'\)/g)) {
      const lit = m[1];
      if (credentialish.test(lit) || /[\n{}]/.test(lit)) continue;
      twigSymbols.add(lit);
    }
  }
  const twig = [
    '{# Reference symbols for the tool test-suite, generated from the analysers. #}',
    '{# A fixture: never rendered by an application. #}',
    '{% extends "base.html.twig" %}',
    '{% block body %}',
    ...[...twigSymbols].map((v) => `    {# ${v.replace(/[#{}]/g, '')} #}`),
    '    {{ value|escape }}',
    '    {{ untrusted|raw }}',
    '{% endblock %}',
  ].join('\n');
  put(root, 'templates/generated_reference.html.twig', twig + '\n');
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
  addSecurityFiles(root);
  addValidatorFiles(root);
  addFormFiles(root);
  addIntegrationFiles(root);
  addModernPhpFiles(root);
  addUxFiles(root);
  addRepositoryFiles(root);
  addOperationsFiles(root);
  addConfigExtensionFiles(root);
  addLowLevelPhpFiles(root);
  addApiSurface(root);
}
