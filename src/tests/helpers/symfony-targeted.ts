// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Content aimed at named analysers.
 *
 * The generated surfaces lifted coverage from 3% to 76% and then stopped: what
 * remains needs each module's own preconditions met, not more vocabulary. This
 * file supplies that, module by module, for the ones holding the most
 * uncovered code. Each block was written after reading what that module reads
 * and what it looks for — the file paths it joins onto the application root
 * and the literals it searches for.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * Symfony stores a profile gzip-compressed. A plain-text file leaves the
 * reader's decompression path — and everything that follows it — unexecuted,
 * which is why this module sat at half coverage through several rounds of
 * fixture work.
 */
function profilePath(token: string): string {
  // Symfony nests by the last two characters, then the two before those.
  return `var/cache/dev/profiler/${token.slice(-2)}/${token.slice(-4, -2)}/${token}`;
}

function writeProfile(root: string, rel: string, token: string): void {
  const payload = `O:8:"stdClass":2:{s:5:"token";s:${token.length}:"${token}";s:6:"parent";N;}`;
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zlib.gzipSync(Buffer.from(payload, 'utf-8')));
}

/**
 * profiler: reads var/, and wants profiles rather than configuration.
 *
 * `withIndex` splits the two readers apart. With an index.csv the analyser
 * parses that; without one it falls back to walking the token directories,
 * and that fallback is a third of the module. Giving both fixtures the same
 * layout left the fallback unreached.
 */
function profiler(root: string, withIndex = true): void {
  if (!withIndex) {
    // An earlier helper writes an index; remove it, or the analyser reads that
    // and the walking reader still never runs.
    for (const stale of ['var/cache/dev/profiler/index.csv', 'var/cache/prod/profiler/index.csv']) {
      fs.rmSync(path.join(root, stale), { force: true });
    }
    // Tokens on disk, no index: the walking reader has to find them.
    for (const token of ['c1d2e3', 'f4a5b6']) {
      writeProfile(root, profilePath(token), token);
    }
    put(root, 'var/cache/prod/profiler/ab/cd/abcdef', 'profile\n');
    return;
  }

  put(root, 'var/cache/dev/profiler/index.csv', [
    'b1c2d3,127.0.0.1,GET,http://localhost/,200,1756000000,app_home,',
    'e4f5a6,127.0.0.1,POST,http://localhost/orders,302,1756000060,app_order_new,',
    'a7b8c9,10.0.0.5,GET,http://localhost/admin,403,1756000120,app_admin,',
    // Fewer fields than the parser requires: it must skip this rather than
    // read past the end of the row.
    'short,127.0.0.1,GET',
    '',
  ].join('\n') + '\n');
  for (const token of ['b1c2d3', 'e4f5a6', 'a7b8c9']) {
    writeProfile(root, profilePath(token), token);
  }
  // One stored uncompressed as well: the reader tries gunzip and falls back.
  put(root, profilePath('plaintext'),
    'O:8:"stdClass":1:{s:5:"token";s:9:"plaintext";}\n');
  put(root, 'var/cache/dev/App_KernelDevDebugContainer.php', "<?php\nclass App_KernelDevDebugContainer {}\n");
  put(root, 'var/cache/prod/App_KernelProdContainer.php', "<?php\nclass App_KernelProdContainer {}\n");
  put(root, 'var/log/dev.log', '[2026-08-24T10:00:00+00:00] request.INFO: Matched route "app_home". [] []\n');
}

/** google-oauth-integration: wants the client library and a service account. */
function googleOauth(root: string): void {
  const composer = path.join(root, 'composer.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(composer, 'utf-8')) as Record<string, Record<string, string>>;
    pkg['require'] = { ...pkg['require'], 'google/apiclient': '^2.15', 'knpuniversity/oauth2-client-bundle': '^2.18' };
    fs.writeFileSync(composer, JSON.stringify(pkg, null, 2));
  } catch { /* fixture without composer.json */ }

  put(root, 'src/Service/GoogleAuth.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Google\\Client;',
    '',
    'class GoogleAuth',
    '{',
    '    public function url(): string',
    '    {',
    '        $client = new Client();',
    '        $client->setScopes(["https://www.googleapis.com/auth/userinfo.email"]);',
    '        $client->setAccessType("offline");',
    '        return $client->createAuthUrl();',
    '    }',
    '',
    '    public function exchange(string $code): array',
    '    {',
    '        $client = new Google_Client();',
    '        $token = $client->fetchAccessTokenWithAuthCode($code);',
    '        $refresh = $client->getRefreshToken();',
    '        $client->fetchAccessTokenWithRefreshToken($refresh);',
    '        return $token;',
    '    }',
    '}',
  ].join('\n') + '\n');

  // A service-account document, without anything resembling a real key.
  put(root, 'config/google-service-account.json', JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    client_email: 'sa@example-project.iam.gserviceaccount.com',
  }, null, 2));
}

/** forms: wants optional fields and the option shapes it reports on. */
function forms(root: string): void {
  put(root, 'src/Form/ProfileType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\OptionsResolver\\OptionsResolver;',
    '',
    'class ProfileType extends AbstractType',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder',
    '            ->add(\'nickname\', null, [\'required\' => false])',
    '            ->add("bio", null, ["required" => false, "empty_data" => ""])',
    '            ->add("website", null, ["required" => false, "trim" => true])',
    '            ->add("avatar", null, ["mapped" => false, "required" => false])',
    '            ->add("agree", null, ["required" => true, "constraints" => []]);',
    '    }',
    '',
    '    public function configureOptions(OptionsResolver $resolver): void',
    '    {',
    '        $resolver->setDefaults([',
    '            "data_class" => null,',
    '            "csrf_protection" => true,',
    '            "csrf_field_name" => "_token",',
    '            "allow_extra_fields" => true,',
    '        ]);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** php-property-hooks: PHP 8.4 hooks, asymmetric visibility, readonly. */
function propertyHooks(root: string): void {
  put(root, 'src/Model/Temperature.php', [
    '<?php',
    'namespace App\\Model;',
    '',
    'class Temperature',
    '{',
    '    public float $celsius = 0.0;',
    '',
    '    public float $fahrenheit {',
    '        get => $this->celsius * 9 / 5 + 32;',
    '        set (float $value) { $this->celsius = ($value - 32) * 5 / 9; }',
    '    }',
    '',
    '    public string $label {',
    '        get {',
    '            return sprintf("%.1f C", $this->celsius);',
    '        }',
    '    }',
    '',
    '    public private(set) int $readings = 0;',
    '    protected protected(set) string $source = "sensor";',
    '',
    '    public function record(float $value): void',
    '    {',
    '        $this->celsius = $value;',
    '        $this->readings++;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** symfony-workflow-parallel-transitions: marking API and multi-place moves. */
function workflowParallel(root: string): void {
  put(root, 'src/Service/OrderWorkflow.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\Workflow\\WorkflowInterface;',
    'use Symfony\\Component\\Workflow\\Marking;',
    '',
    'class OrderWorkflow',
    '{',
    '    public function __construct(private WorkflowInterface $orderProcessing) {}',
    '',
    '    public function advance($order): void',
    '    {',
    '        $marking = $this->orderProcessing->getMarking($order);',
    '        $places = $marking->getPlaces();',
    '',
    '        if ($this->orderProcessing->can($order, "submit")) {',
    '            $this->orderProcessing->apply($order, "submit");',
    '        }',
    '        if ($marking->has("pending") && $marking->has("reserved")) {',
    '            $this->orderProcessing->apply($order, "pay");',
    '        }',
    '    }',
    '',
    '    public function marking($order): Marking',
    '    {',
    '        return $this->orderProcessing->getMarking($order);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/workflow_parallel.yaml', [
    'framework:',
    '    workflows:',
    '        fulfilment:',
    '            type: workflow',
    '            marking_store:',
    '                type: method',
    '                property: marking',
    '            supports: [App\\Entity\\Order]',
    '            places: [received, picked, packed, invoiced, shipped]',
    '            transitions:',
    '                prepare:',
    '                    from: received',
    '                    to: [picked, invoiced]',
    '                dispatch:',
    '                    from: [packed, invoiced]',
    '                    to: shipped',
  ].join('\n') + '\n');
}

/** symfony-messenger-competing-consumers: consume commands in orchestration. */
function competingConsumers(root: string): void {
  put(root, 'Makefile', [
    'consume:',
    '\tphp bin/console messenger:consume async --limit=10 --time-limit=3600',
    '',
    'consume-high:',
    '\tphp bin/console messenger:consume async_priority_high -l 100',
    '',
    'test:',
    '\tvendor/bin/phpunit',
  ].join('\n') + '\n');

  put(root, 'docker-compose.yml', [
    'services:',
    '    php:',
    '        build: ./docker/php',
    '    worker:',
    '        build: ./docker/php',
    '        command: php bin/console messenger:consume async --limit=50 --memory-limit=128M',
    '        deploy:',
    '            replicas: 3',
    '    worker_high:',
    '        build: ./docker/php',
    '        command: php bin/console messenger:consume async_priority_high -l 25',
    '        deploy:',
    '            replicas: 2',
    '    database:',
    '        image: mysql:8.0',
  ].join('\n') + '\n');
}

/** paypal-checkout-v2: the SDK request objects and webhook headers. */
function paypal(root: string): void {
  put(root, 'src/Service/PayPalCheckout.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use PayPalCheckoutSdk\\Core\\PayPalHttpClient;',
    'use PayPalCheckoutSdk\\Orders\\OrdersCreateRequest;',
    'use PayPalCheckoutSdk\\Orders\\OrdersCaptureRequest;',
    'use PayPalCheckoutSdk\\Orders\\OrdersGetRequest;',
    '',
    'class PayPalCheckout',
    '{',
    '    public function __construct(private PayPalHttpClient $client) {}',
    '',
    '    public function create(): array',
    '    {',
    '        $request = new OrdersCreateRequest();',
    '        $request->prefer("return=representation");',
    '        return (array) $this->client->execute($request)->result;',
    '    }',
    '',
    '    public function capture(string $id): array',
    '    {',
    '        $request = new OrdersCaptureRequest($id);',
    '        return (array) $this->client->execute($request)->result;',
    '    }',
    '',
    '    public function get(string $id): array',
    '    {',
    '        return (array) $this->client->execute(new OrdersGetRequest($id))->result;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Controller/PayPalWebhookController.php', [
    '<?php',
    'namespace App\\Controller;',
    '',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    'use Symfony\\Component\\HttpFoundation\\Response;',
    '',
    'class PayPalWebhookController',
    '{',
    '    public function handle(Request $request): Response',
    '    {',
    '        // Signature headers present but never verified.',
    '        $sig = $request->headers->get("PAYPAL-TRANSMISSION-SIG");',
    '        $certUrl = $request->headers->get("PAYPAL-CERT-URL");',
    '        return new Response($sig . $certUrl);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** netlify-deploy-config: headers block with and without the security ones. */
function netlify(root: string): void {
  put(root, 'netlify.toml', [
    '[build]',
    '    command = "composer install --no-dev && bin/console cache:warmup"',
    '    publish = "public"',
    '    functions = "netlify/functions"',
    '',
    '[build.environment]',
    '    PHP_VERSION = "8.3"',
    '    APP_ENV = "prod"',
    '',
    '[[redirects]]',
    '    from = "/*"',
    '    to = "/index.php"',
    '    status = 200',
    '',
    '[[headers]]',
    '    for = "/*"',
    '    [headers.values]',
    '        x-frame-options = "DENY"',
    '        x-content-type-options = "nosniff"',
    '        content-security-policy = "default-src \'self\'"',
    '        permissions-policy = "geolocation=()"',
    '',
    '[[headers]]',
    '    for = "/assets/*"',
    '    [headers.values]',
    '        cache-control = "public, max-age=31536000, immutable"',
  ].join('\n') + '\n');
}

/** php-benchmark-patterns: a PHPBench suite. */
function benchmarks(root: string): void {
  put(root, 'benchmarks/OrderBench.php', [
    '<?php',
    'namespace App\\Benchmarks;',
    '',
    'class OrderBench',
    '{',
    '    /**',
    '     * @Revs(1000)',
    '     * @Iterations(5)',
    '     * @Groups({"orders"})',
    '     */',
    '    public function benchCreate(): void',
    '    {',
    '        sleep(0);',
    '    }',
    '',
    '    /**',
    '     * @Revs(10)',
    '     * @Groups({"slow"})',
    '     */',
    '    public function benchReport(): void',
    '    {',
    '        usleep(100);',
    '    }',
    '}',
  ].join('\n') + '\n');
  put(root, 'phpbench.json', JSON.stringify({ 'runner.bootstrap': 'vendor/autoload.php', 'runner.path': 'benchmarks' }, null, 2));
}

/** secrets-vault: the encrypted-secrets directory layout. */
function secretsVault(root: string): void {
  put(root, 'config/secrets/prod/prod.list.php', "<?php\n\nreturn [\n    'APP_SECRET' => null,\n    'MAILER_DSN' => null,\n];\n");
  put(root, 'config/secrets/prod/prod.encrypt.public.php', "<?php\n\nreturn '<public-key-placeholder>';\n");
  put(root, 'config/secrets/dev/dev.list.php', "<?php\n\nreturn [\n    'APP_SECRET' => null,\n];\n");
  put(root, 'src/Service/VaultReader.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'class VaultReader',
    '{',
    '    public function encrypt(string $value): string { return base64_encode($value); }',
    '    public function decrypt(string $value): string { return base64_decode($value); }',
    '}',
  ].join('\n') + '\n');
}

/** commands: console input definitions with every mode constant. */
function commands(root: string): void {
  put(root, 'src/Command/ReportCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
    'use Symfony\\Component\\Console\\Command\\Command;',
    'use Symfony\\Component\\Console\\Input\\InputArgument;',
    'use Symfony\\Component\\Console\\Input\\InputInterface;',
    'use Symfony\\Component\\Console\\Input\\InputOption;',
    'use Symfony\\Component\\Console\\Output\\OutputInterface;',
    'use Symfony\\Component\\Console\\Style\\SymfonyStyle;',
    '',
    '#[AsCommand(name: "app:report", description: "Builds a report")]',
    'class ReportCommand extends Command',
    '{',
    '    protected function configure(): void',
    '    {',
    '        $this',
    '            ->addArgument("period", InputArgument::REQUIRED, "Reporting period")',
    '            ->addArgument("targets", InputArgument::IS_ARRAY, "Targets")',
    '            ->addOption("format", "f", InputOption::VALUE_REQUIRED, "Output format", "json")',
    '            ->addOption("dry-run", null, InputOption::VALUE_NONE, "Do not write")',
    '            ->addOption("tag", "t", InputOption::VALUE_IS_ARRAY | InputOption::VALUE_OPTIONAL, "Tags");',
    '    }',
    '',
    '    protected function execute(InputInterface $input, OutputInterface $output): int',
    '    {',
    '        $io = new SymfonyStyle($input, $output);',
    '        $io->title("Report");',
    '        $io->progressStart(10);',
    '        $io->success("done");',
    '        return Command::SUCCESS;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** stripe-billing-subscriptions: the SDK calls and the env variable names. */
function stripe(root: string): void {
  const composer = path.join(root, 'composer.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(composer, 'utf-8')) as Record<string, Record<string, string>>;
    pkg['require'] = { ...pkg['require'], 'stripe/stripe-php': '^13.0' };
    fs.writeFileSync(composer, JSON.stringify(pkg, null, 2));
  } catch { /* fixture without composer.json */ }

  put(root, 'src/Service/Billing.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Stripe\\StripeClient;',
    '',
    'class Billing',
    '{',
    '    public function __construct(private StripeClient $stripe) {}',
    '',
    '    public function subscribe(string $email): array',
    '    {',
    '        $customer = \\Stripe\\Customer::create(["email" => $email]);',
    '        $price = \\Stripe\\Price::create(["unit_amount" => 1000, "currency" => "eur"]);',
    '        $plan = \\Stripe\\Plan::create(["amount" => 1000, "interval" => "month"]);',
    '        $portal = $this->stripe->billingPortal->sessions->create(["customer" => $customer->id]);',
    '        $invoice = \\Stripe\\Invoice::upcoming(["customer" => $customer->id]);',
    '        return [$price->id, $plan->id, $portal->url, $invoice->total];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, '.env.stripe', 'STRIPE_PUBLISHABLE_KEY=\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\n');
}

/** symfony-rate-limiter-algorithms: the three policies and a burst. */
function rateLimiter(root: string): void {
  put(root, 'config/packages/rate_limiter.yaml', [
    'framework:',
    '    rate_limiter:',
    '        anonymous_api:',
    '            policy: "fixed_window"',
    '            limit: 100',
    '            interval: "60 minutes"',
    '        authenticated_api:',
    '            policy: "token_bucket"',
    '            limit: 5000',
    '            rate: { interval: "15 minutes", amount: 500 }',
    '        login:',
    '            policy: "sliding_window"',
    '            limit: 5',
    '            interval: "15 minutes"',
    '        uploads:',
    '            policy: "no_limit"',
  ].join('\n') + '\n');
}

/** cloudflare and terraform: worker and infrastructure definitions. */
function infrastructure(root: string): void {
  put(root, 'wrangler.toml', [
    'name = "acme-edge"',
    'main = "src/worker.js"',
    'compatibility_date = "2026-01-01"',
    'workers_dev = true',
    '',
    '[vars]',
    'APP_ENV = "prod"',
    '',
    '[[kv_namespaces]]',
    'binding = "CACHE"',
    'id = "0123456789abcdef"',
  ].join('\n') + '\n');

  put(root, 'infra/main.tf', [
    'terraform {',
    '    required_version = ">= 1.6"',
    '    required_providers {',
    '        aws = {',
    '            source  = "hashicorp/aws"',
    '            version = "~> 5.0"',
    '        }',
    '    }',
    '}',
    '',
    'variable "db_user" {',
    '    type    = string',
    '    default = "app"',
    '}',
    '',
    'resource "aws_db_instance" "main" {',
    '    engine         = "mysql"',
    '    instance_class = "db.t3.micro"',
    '    username       = var.db_user',
    '    publicly_accessible = true',
    '}',
  ].join('\n') + '\n');

  put(root, 'azure-pipelines.yml', [
    'trigger:',
    '    - main',
    '',
    'pool:',
    '    vmImage: ubuntu-latest',
    '',
    'jobs:',
    '    - job: Test',
    '      timeoutInMinutes: 30',
    '      steps:',
    '          - script: composer install',
    '          - script: vendor/bin/phpunit',
    '            env:',
    '                APP_ENV: test',
  ].join('\n') + '\n');
}

/** psalm-config: a psalm.xml with the settings the analyser reports on. */
function psalm(root: string): void {
  put(root, 'psalm.xml', [
    '<?xml version="1.0"?>',
    '<psalm',
    '    errorLevel="3"',
    '    findUnusedCode="true"',
    '    findUnusedBaselineEntry="true"',
    '    resolveFromConfigFile="true"',
    '>',
    '    <projectFiles>',
    '        <directory name="src" />',
    '        <ignoreFiles>',
    '            <directory name="vendor" />',
    '            <directory name="var" />',
    '        </ignoreFiles>',
    '    </projectFiles>',
    '    <plugins>',
    '        <pluginClass class="Psalm\\SymfonyPsalmPlugin\\Plugin" />',
    '    </plugins>',
    '</psalm>',
  ].join('\n') + '\n');
  put(root, '.psalm/baseline.xml', '<?xml version="1.0"?>\n<files psalm-version="5.x" />\n');
}

/** oauth2-server-config: league/oauth2-server wiring. */
function oauth2Server(root: string): void {
  put(root, 'src/Service/AuthServerFactory.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use League\\OAuth2\\Server\\AuthorizationServer;',
    'use League\\OAuth2\\Server\\ResourceServer;',
    'use League\\OAuth2\\Server\\CryptKey;',
    'use League\\OAuth2\\Server\\Grant\\RefreshTokenGrant;',
    '',
    'class AuthServerFactory',
    '{',
    '    public function build(): AuthorizationServer',
    '    {',
    '        $privateKey = new \\League\\OAuth2\\Server\\CryptKey(getenv("OAUTH_PRIVATE_KEY_PATH"));',
    '        $server = new AuthorizationServer(',
    '            $this->clients,',
    '            $this->tokens,',
    '            $this->scopes,',
    '            $privateKey,',
    '            $_ENV["OAUTH_ENCRYPTION_KEY"]',
    '        );',
    '        $server->enableGrantType(new RefreshTokenGrant($this->refreshTokens), new \\DateInterval("P1M"));',
    '        return $server;',
    '    }',
    '',
    '    public function resource(): ResourceServer',
    '    {',
    '        return new ResourceServer($this->tokens, new CryptKey(env("OAUTH_PUBLIC_KEY_PATH")));',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** microsoft-graph-integration: the fluent Graph client. */
function microsoftGraph(root: string): void {
  put(root, 'src/Service/GraphClient.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Microsoft\\Graph\\Graph;',
    '',
    'class GraphClient',
    '{',
    '    public function __construct(private Graph $graph) {}',
    '',
    '    public function me(string $token): array',
    '    {',
    '        $this->graph->setAccessToken($token);',
    '        $user = $this->graph->users()->get();',
    '        $mail = $this->graph->users()->mail()->messages()->get();',
    '        $request = $this->graph->createRequest("GET", "/me");',
    '        return [$user, $mail, $request];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** cors: a permissive and a scoped configuration. */
function cors(root: string): void {
  put(root, 'config/packages/cors.yaml', [
    'nelmio_cors:',
    '    defaults:',
    '        origin_regex: true',
    '        allow_origin: ["%env(CORS_ALLOW_ORIGIN)%"]',
    '        allow_methods: ["GET", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]',
    '        allow_headers: ["Content-Type", "Authorization"]',
    '        expose_headers: ["Link"]',
    '        max_age: 3600',
    '    paths:',
    '        "^/api/":',
    '            allow_origin: ["*"]',
    '            allow_credentials: true',
    '        "^/public/":',
    '            allow_origin: ["https://app.example.com"]',
  ].join('\n') + '\n');
}

/** symfony-form-events: form type extensions and event subscribers. */
function formEvents(root: string): void {
  put(root, 'src/Form/EventedType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\AbstractType;',
    'use Symfony\\Component\\Form\\FormBuilderInterface;',
    'use Symfony\\Component\\Form\\FormEvent;',
    'use Symfony\\Component\\Form\\FormEvents;',
    'use Symfony\\Component\\Form\\FormTypeInterface;',
    '',
    'class EventedType extends AbstractType implements FormTypeInterface',
    '{',
    '    public function buildForm(FormBuilderInterface $builder, array $options): void',
    '    {',
    '        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event) {',
    '            $event->stopPropagation();',
    '        });',
    '        $builder->addEventListener(FormEvents::POST_SUBMIT, [$this, "onPostSubmit"]);',
    '        $builder->addEventListener(FormEvents::PRE_SUBMIT, [$this, "onPreSubmit"]);',
    '    }',
    '',
    '    public function onPostSubmit(FormEvent $event): void {}',
    '    public function onPreSubmit(FormEvent $event): void {}',
    '}',
  ].join('\n') + '\n');
}

/** http-client and scopes: every verb, scoped clients, auth and retries. */
function httpClient(root: string): void {
  put(root, 'config/packages/http_client.yaml', [
    'framework:',
    '    http_client:',
    '        default_options:',
    '            timeout: 30',
    '            max_duration: 60',
    '            headers:',
    '                User-Agent: "acme/1.0"',
    '            retry_failed:',
    '                max_retries: 3',
    '                delay: 1000',
    '        scoped_clients:',
    '            api.client:',
    '                base_uri: "https://api.example.com"',
    '                auth_bearer: "%env(API_TOKEN)%"',
    '            internal.client:',
    '                base_uri: "http://127.0.0.1:8080"',
    '                verify_peer: false',
    '            legacy.client:',
    '                base_uri: "http://localhost:9000"',
    '                auth_basic: "%env(LEGACY_AUTH)%"',
  ].join('\n') + '\n');

  put(root, 'src/Service/ApiCaller.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\HttpClient\\HttpClient;',
    'use Symfony\\Component\\HttpClient\\ScopingHttpClient;',
    'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
    '',
    'class ApiCaller',
    '{',
    '    public function __construct(private HttpClientInterface $client) {}',
    '',
    '    public function all(): array',
    '    {',
    '        $c = HttpClient::create(["timeout" => 10]);',
    '        $scoped = ScopingHttpClient::forBaseUri($c, "https://api.example.com");',
    '',
    '        $a = $this->client->request("GET", "/items");',
    '        $b = $this->client->get("/items/1");',
    '        $d = $this->client->post("/items", ["json" => []]);',
    '        $e = $this->client->put("/items/1", ["json" => []]);',
    '        $f = $this->client->patch("/items/1", ["json" => []]);',
    '        $g = $this->client->delete("/items/1");',
    '',
    '        if ($a->getStatusCode() === 401) {',
    '            // Unauthorized: the token may have expired and need a refresh',
    '            $this->refresh();',
    '        }',
    '        return [$b, $d, $e, $f, $g, $scoped];',
    '    }',
    '',
    '    private function refresh(): void {}',
    '}',
  ].join('\n') + '\n');
}

/** heroku, nginx unit, swarm and helm: the deployment descriptors. */
function deployDescriptors(root: string): void {
  put(root, 'Procfile', 'web: heroku-php-apache2 public/\nworker: php bin/console messenger:consume async\n');
  put(root, 'app.json', JSON.stringify({
    name: 'acme',
    env: { APP_ENV: { value: 'prod' } },
    formation: { web: { quantity: 1, size: 'standard-1x' } },
    addons: ['heroku-postgresql'],
  }, null, 2));

  // The analyser looks for unit.json, config.json or nginx-unit.json in the
  // application root, docker/ or config/ — not a nested docker/unit/.
  put(root, 'docker/unit.json', JSON.stringify({
    listeners: { '*:80': { pass: 'applications/php' }, '*:8080': { pass: 'routes' } },
    applications: { php: { type: 'php', root: '/var/www/public', script: 'index.php' } },
  }, null, 2));

  put(root, 'docker-compose.swarm.yml', [
    'services:',
    '    php:',
    '        image: acme/app:1.0',
    '        deploy:',
    '            replicas: 3',
    '            placement:',
    '                constraints:',
    '                    - node.role == worker',
    '            resources:',
    '                limits:',
    '                    cpus: "0.50"',
    '                    memory: 512M',
    '        healthcheck:',
    '            test: ["CMD", "php", "-v"]',
    '            interval: 30s',
    '        ports:',
    '            - target: 80',
    '              published: 80',
    '              mode: ingress',
  ].join('\n') + '\n');

  // At the application root: that is where the analyser joins them.
  put(root, 'Chart.yaml', 'apiVersion: v2\nname: acme\nversion: 1.0.0\nappVersion: "1.0"\n');
  put(root, 'values.yaml', [
    'image:',
    '    repository: acme/app',
    '    tag: latest',
    '    pullPolicy: Always',
    'replicaCount: 2',
    'livenessProbe:',
    '    httpGet:',
    '        path: /health',
    '        port: 80',
    'readinessProbe:',
    '    httpGet:',
    '        path: /health',
    '        port: 80',
    'resources: {}',
  ].join('\n') + '\n');
}

/** twig: extensions, filters, functions and the shapes the analyser reads. */
function twig(root: string): void {
  put(root, 'src/Twig/AppExtension.php', [
    '<?php',
    'namespace App\\Twig;',
    '',
    'use Twig\\Extension\\AbstractExtension;',
    'use Twig\\TwigFilter;',
    'use Twig\\TwigFunction;',
    'use Twig\\Extension\\RuntimeExtensionInterface;',
    '',
    'class AppExtension extends AbstractExtension',
    '{',
    '    public function getFilters(): array',
    '    {',
    '        return [',
    '            new TwigFilter("money", [$this, "money"]),',
    '            new TwigFilter("markdown", [$this, "markdown"], ["is_safe" => ["html"]]),',
    '        ];',
    '    }',
    '',
    '    public function getFunctions(): array',
    '    {',
    '        return [new TwigFunction("asset_version", [$this, "assetVersion"])];',
    '    }',
    '',
    '    public function money(int $cents): string { return number_format($cents / 100, 2); }',
    '    public function markdown(string $text): string { return $text; }',
    '    public function assetVersion(string $path): string { return $path . "?v=1"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'templates/report.html.twig', [
    '{% extends "base.html.twig" %}',
    '',
    '{% block title %}{{ parent() }} — Report{% endblock %}',
    '',
    '{% block body %}',
    '    {% for row in rows %}',
    '        {{ row.total|money }}',
    '        {{ row.notes|markdown }}',
    '        {{ row.raw|raw }}',
    '        <img src="{{ asset("build/logo.png") }}" alt="{{ row.name|e("html_attr") }}">',
    '    {% else %}',
    '        {{ "empty"|trans }}',
    '    {% endfor %}',
    '    {% include "partials/_row.html.twig" with { row: rows|first } only %}',
    '    {{ include("partials/_row.html.twig") }}',
    '{% endblock %}',
  ].join('\n') + '\n');
  put(root, 'templates/partials/_row.html.twig', '<tr><td>{{ row.name }}</td></tr>\n');
}

/** search-integration: Elastica and MeiliSearch wiring. */
function search(root: string): void {
  put(root, 'config/packages/fos_elastica.yaml', [
    'fos_elastica:',
    '    clients:',
    '        default:',
    '            host: elasticsearch',
    '            port: 9200',
    '    indexes:',
    '        products:',
    '            persistence:',
    '                driver: orm',
    '                model: App\\Entity\\Product',
    '                finder: ~',
  ].join('\n') + '\n');

  put(root, 'src/Service/ProductSearch.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use FOS\\ElasticaBundle\\Finder\\FinderInterface;',
    'use Elastica\\Query;',
    'use Meilisearch\\Client as MeiliSearchClient;',
    '',
    'class ProductSearch',
    '{',
    '    public function __construct(private FinderInterface $finder) {}',
    '',
    '    public function search(string $term): array',
    '    {',
    '        $query = new Query\\MultiMatch();',
    '        $query->setQuery($term);',
    '        return $this->finder->find($query, 20);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/SearchableProduct.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Symfony\\UX\\Autocomplete\\Attribute\\Searchable;',
    '',
    '#[Searchable(fields: ["name", "description"])]',
    'class SearchableProduct',
    '{',
    '    public string $name = "";',
    '}',
  ].join('\n') + '\n');
}

/** serializer: the four attributes the analyser reads, on real properties. */
function serializerAttributes(root: string): void {
  put(root, 'src/Entity/SerializedOrder.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Symfony\\Component\\Serializer\\Attribute\\Groups;',
    'use Symfony\\Component\\Serializer\\Attribute\\Ignore;',
    'use Symfony\\Component\\Serializer\\Attribute\\MaxDepth;',
    'use Symfony\\Component\\Serializer\\Attribute\\SerializedName;',
    '',
    'class SerializedOrder',
    '{',
    '    #[Groups(["order:read", "order:write"])]',
    '    public int $id = 0;',
    '',
    '    #[Groups(["order:read"])]',
    '    #[SerializedName("reference_code")]',
    '    public string $reference = "";',
    '',
    '    #[MaxDepth(2)]',
    '    #[Groups(["order:read"])]',
    '    public $customer;',
    '',
    '    #[Ignore]',
    '    public string $internalNote = "";',
    '',
    '    // No group at all: invisible in both directions',
    '    public string $auditTrail = "";',
    '}',
  ].join('\n') + '\n');
}

/** A second swarm file under the name the analyser also accepts. */
function swarmProd(root: string): void {
  put(root, 'docker-compose.prod.yml', [
    'services:',
    '    php:',
    '        image: acme/app:1.0',
    '        deploy:',
    '            mode: replicated',
    '            replicas: 4',
    '            update_config:',
    '                parallelism: 2',
    '                order: start-first',
    '            restart_policy:',
    '                condition: on-failure',
    '            placement:',
    '                constraints: [node.labels.tier == app]',
    '            resources:',
    '                limits:',
    '                    cpus: "1.0"',
    '                    memory: 1G',
    '                reservations:',
    '                    memory: 256M',
    '        healthcheck:',
    '            test: ["CMD-SHELL", "php-fpm-healthcheck || exit 1"]',
    '            interval: 10s',
    '            retries: 3',
    '        ports:',
    '            - target: 9000',
    '              published: 9000',
    '              mode: ingress',
  ].join('\n') + '\n');
}

/** vercel: the headers and runtime blocks the analyser reports on. */
function vercel(root: string): void {
  put(root, 'vercel.json', JSON.stringify({
    version: 2,
    functions: { 'api/index.php': { runtime: 'vercel-php@0.6.0', memory: 512, maxDuration: 10 } },
    builds: [{ src: 'api/index.php', use: 'vercel-php@0.6.0' }],
    routes: [{ src: '/(.*)', dest: '/api/index.php' }],
    headers: [{
      source: '/(.*)',
      headers: [
        { key: 'x-content-type-options', value: 'nosniff' },
        { key: 'x-frame-options', value: 'DENY' },
      ],
    }],
    env: { APP_ENV: 'prod', APP_DEBUG: '0' },
  }, null, 2));
}

/** doctrine: a custom DBAL platform and association fetch modes. */
function doctrineExtras(root: string): void {
  put(root, 'src/Doctrine/CustomPlatform.php', [
    '<?php',
    'namespace App\\Doctrine;',
    '',
    'use Doctrine\\DBAL\\Platforms\\MySQLPlatform;',
    'use Doctrine\\DBAL\\Types\\Type;',
    '',
    'class CustomPlatform extends MySQLPlatform',
    '{',
    '    public function getName(): string { return "custom"; }',
    '',
    '    public function getDateFormatString(): string { return "Y-m-d"; }',
    '    public function getDateTimeFormatString(): string { return "Y-m-d H:i:s"; }',
    '',
    '    protected function initializeDoctrineTypeMappings(): void',
    '    {',
    '        parent::initializeDoctrineTypeMappings();',
    '        $this->doctrineTypeMapping["jsonb"] = "json";',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/TypeRegistrar.php', [
    '<?php',
    'namespace App\\Doctrine;',
    '',
    'use Doctrine\\DBAL\\Types\\Type;',
    '',
    'class TypeRegistrar',
    '{',
    '    public function register(): void',
    '    {',
    '        Type::addType("money", MoneyType::class);',
    '        Type::overrideType("datetime", UtcDateTimeType::class);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Invoice.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    'class Invoice',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\Column]',
    '    private int $id;',
    '',
    '    #[ORM\\ManyToOne(targetEntity: Customer::class, fetch: "EAGER")]',
    '    private $customer;',
    '',
    '    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: "invoice", fetch: "LAZY", cascade: ["persist"])]',
    '    private $lines;',
    '',
    '    #[ORM\\ManyToMany(targetEntity: Tag::class, fetch: "EXTRA_LAZY")]',
    '    private $tags;',
    '',
    '    #[ORM\\OneToOne(targetEntity: Receipt::class, fetch: "EAGER", orphanRemoval: true)]',
    '    private $receipt;',
    '}',
  ].join('\n') + '\n');
}

/** symfony-di-lazy-ghost: lazy services and ghost object configuration. */
function lazyServices(root: string): void {
  put(root, 'config/packages/lazy_services.yaml', [
    'services:',
    '    App\\Service\\HeavyService:',
    '        lazy: true',
    '    App\\Service\\GhostService:',
    '        lazy: "ghost"',
    '    App\\Service\\ProxyService:',
    '        lazy: "virtual"',
  ].join('\n') + '\n');

  put(root, 'src/Service/HeavyService.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\Lazy;',
    'use Symfony\\Component\\DependencyInjection\\Attribute\\Autoconfigure;',
    '',
    '#[Lazy]',
    '#[Autoconfigure(lazy: true)]',
    'class HeavyService',
    '{',
    '    public function __construct() { /* expensive */ }',
    '}',
  ].join('\n') + '\n');
}

/** Group-sequence providers and data mappers, declared as the interfaces do. */
function validatorAndMapper(root: string): void {
  put(root, 'src/Entity/SequencedUser.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Symfony\\Component\\Validator\\GroupSequenceProviderInterface;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    '',
    '#[Assert\\GroupSequenceProvider]',
    'class SequencedUser implements GroupSequenceProviderInterface',
    '{',
    '    public bool $premium = false;',
    '',
    '    public function getGroupSequence(): array',
    '    {',
    '        return $this->premium',
    '            ? ["SequencedUser", "Premium"]',
    '            : ["SequencedUser", "Standard"];',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/DataMapperType.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\DataMapperInterface;',
    '',
    'class DataMapperType implements DataMapperInterface',
    '{',
    '    public function mapDataToForms($viewData, $forms): void',
    '    {',
    '        $forms = iterator_to_array($forms);',
    '        $forms["name"]->setData($viewData?->name);',
    '    }',
    '',
    '    public function mapFormsToData($forms, &$viewData): void',
    '    {',
    '        $forms = iterator_to_array($forms);',
    '        $viewData->name = $forms["name"]->getData();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Form/AppTypeGuesser.php', [
    '<?php',
    'namespace App\\Form;',
    '',
    'use Symfony\\Component\\Form\\FormTypeGuesserInterface;',
    'use Symfony\\Component\\Form\\Guess\\Guess;',
    'use Symfony\\Component\\Form\\Guess\\TypeGuess;',
    '',
    'class AppTypeGuesser implements FormTypeGuesserInterface',
    '{',
    '    public function guessType(string $class, string $property): ?TypeGuess',
    '    {',
    '        if (str_ends_with($property, "Email")) {',
    '            return new TypeGuess(EmailType::class, [], Guess::HIGH_CONFIDENCE);',
    '        }',
    '        return null;',
    '    }',
    '',
    '    public function guessRequired(string $class, string $property): ?Guess { return null; }',
    '    public function guessMaxLength(string $class, string $property): ?Guess { return null; }',
    '    public function guessPattern(string $class, string $property): ?Guess { return null; }',
    '}',
  ].join('\n') + '\n');
}

/** commands: the attribute's optional arguments, and the pre-attribute style. */
function commandVariants(root: string): void {
  put(root, 'src/Command/HiddenCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Attribute\\AsCommand;',
    'use Symfony\\Component\\Console\\Command\\Command;',
    '',
    '#[AsCommand(',
    '    name: "app:internal",',
    '    description: "Internal maintenance",',
    '    aliases: ["app:maint", "app:internal-run"],',
    '    hidden: true,',
    ')]',
    'class HiddenCommand extends Command',
    '{',
    '    protected function execute($input, $output): int { return Command::SUCCESS; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Command/LegacyNameCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Command\\Command;',
    '',
    'class LegacyNameCommand extends Command',
    '{',
    '    // The pre-attribute way of naming a command, still widespread.',
    '    protected static $defaultName = "app:legacy";',
    '    protected static $defaultDescription = "Legacy command";',
    '',
    '    protected function execute($input, $output): int { return 0; }',
    '}',
  ].join('\n') + '\n');
}

/** serializer: attributes on constructor-promoted properties. */
function serializerPromoted(root: string): void {
  put(root, 'src/Dto/OrderDto.php', [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Attribute\\Groups;',
    'use Symfony\\Component\\Serializer\\Attribute\\Ignore;',
    'use Symfony\\Component\\Serializer\\Attribute\\MaxDepth;',
    'use Symfony\\Component\\Serializer\\Attribute\\SerializedName;',
    '',
    'final class OrderDto',
    '{',
    '    public function __construct(',
    '        #[Groups(["order:read", "order:write"])]',
    '        public readonly int $id,',
    '',
    '        #[Groups(["order:read"])]',
    '        #[SerializedName("reference_code")]',
    '        public readonly string $reference,',
    '',
    '        #[MaxDepth(1)]',
    '        #[Groups(["order:read"])]',
    '        private readonly array $lines,',
    '',
    '        #[Ignore]',
    '        protected readonly string $internal = "",',
    '    ) {}',
    '}',
  ].join('\n') + '\n');
}

/** swarm: deploy blocks in the compose file the analyser reads by default. */
function swarmInCompose(root: string): void {
  put(root, 'docker-compose.yml', [
    'services:',
    '    php:',
    '        build: ./docker/php',
    '        environment:',
    '            APP_ENV: dev',
    '        volumes:',
    '            - ./:/var/www',
    '        deploy:',
    '            replicas: 2',
    '            placement:',
    '                constraints:',
    '                    - node.role == worker',
    '            resources:',
    '                limits:',
    '                    cpus: "0.50"',
    '                    memory: 512M',
    '        healthcheck:',
    '            test: ["CMD", "php", "-v"]',
    '            interval: 30s',
    '        ports:',
    '            - target: 80',
    '              published: 80',
    '              mode: ingress',
    '    worker:',
    '        build: ./docker/php',
    '        command: php bin/console messenger:consume async --limit=50 --memory-limit=128M',
    '        deploy:',
    '            replicas: 3',
    '    database:',
    '        image: mysql:8.0',
    '        environment:',
    '            MYSQL_ROOT_PASSWORD: root',
    '        ports:',
    '            - "3306:3306"',
  ].join('\n') + '\n');
}

/** twig: the constructs beyond extends and include. */
function twigConstructs(root: string): void {
  put(root, 'templates/macros.html.twig', [
    '{% macro field(name, value) %}',
    '    <input name="{{ name }}" value="{{ value }}">',
    '{% endmacro %}',
    '',
    '{% macro button(label) %}',
    '    <button>{{ label }}</button>',
    '{% endmacro %}',
  ].join('\n') + '\n');

  put(root, 'templates/embedded.html.twig', [
    '{% extends "base.html.twig" %}',
    '',
    '{% use "blocks/_form.html.twig" with field as form_field %}',
    '{% import "macros.html.twig" as forms %}',
    '{% from "macros.html.twig" import button %}',
    '',
    '{% block body %}',
    '    {% embed "partials/_card.html.twig" with { title: "Orders" } %}',
    '        {% block content %}',
    '            {{ forms.field("sku", item.sku) }}',
    '            {{ button("Save") }}',
    '        {% endblock %}',
    '    {% endembed %}',
    '',
    '    {% embed "partials/_card.html.twig" %}',
    '        {% block content %}{{ parent() }}{% endblock %}',
    '    {% endembed %}',
    '{% endblock %}',
  ].join('\n') + '\n');

  put(root, 'templates/blocks/_form.html.twig', '{% block field %}<input>{% endblock %}\n');
  put(root, 'templates/partials/_card.html.twig',
    '<div class="card"><h2>{{ title|default("") }}</h2>{% block content %}{% endblock %}</div>\n');
}

/** http-client: credentials in URLs and headers, for the masking paths. */
function httpCredentials(root: string): void {
  put(root, 'src/Service/CredentialedClient.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Contracts\\HttpClient\\HttpClientInterface;',
    '',
    'class CredentialedClient',
    '{',
    '    public function __construct(private HttpClientInterface $client) {}',
    '',
    '    public function call(): void',
    '    {',
    '        // Credentials inside the URI: the analyser masks these before',
    '        // anything is reported.',
    '        $this->client->request("GET", "https://apiuser:hunter2@api.example.com/v1/items");',
    '        $this->client->request("GET", "http://svc@internal.example.com/health");',
    '',
    '        $this->client->request("POST", "https://api.example.com/v1/items", [',
    '            "headers" => [',
    '                "Authorization" => "Bearer abcdefghijklmnopqrstuvwx",',
    '                "X-Api-Token" => "0123456789",',
    '                "Cookie" => "session=abcdef",',
    '                "Accept" => "application/json",',
    '            ],',
    '            "auth_basic" => ["apiuser", "hunter2"],',
    '            "auth_bearer" => "abcdefghijklmnopqrstuvwx",',
    '        ]);',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'config/packages/scoped_clients.yaml', [
    'framework:',
    '    http_client:',
    '        scoped_clients:',
    '            credentialed.client:',
    '                base_uri: "https://apiuser:hunter2@api.example.com"',
    '                auth_basic: "apiuser:hunter2"',
    '            localhost.client:',
    '                base_uri: "http://127.0.0.1:8000"',
    '            named.client:',
    '                base_uri: "http://localhost:9200"',
    '                headers:',
    '                    Authorization: "Bearer %env(API_TOKEN)%"',
  ].join('\n') + '\n');
}

/** Asset packages, versioning strategies and a manifest. */
function assetPackages(root: string): void {
  put(root, 'config/packages/assets.yaml', [
    'framework:',
    '    assets:',
    '        version: "%env(APP_VERSION)%"',
    '        version_format: "%%s?v=%%s"',
    '        json_manifest_path: "%kernel.project_dir%/public/build/manifest.json"',
    '        packages:',
    '            images:',
    '                base_urls: ["https://cdn.example.com"]',
    '                version_strategy: assets.static_version_strategy',
    '            documents:',
    '                json_manifest_path: "%kernel.project_dir%/public/docs/manifest.json"',
    '            legacy:',
    '                base_path: /legacy',
  ].join('\n') + '\n');

  put(root, 'public/build/manifest.json', JSON.stringify({
    'app.js': '/build/app.abc123.js',
    'app.css': '/build/app.def456.css',
  }, null, 2));
  put(root, 'public/build/entrypoints.json', JSON.stringify({
    entrypoints: { app: { js: ['/build/app.abc123.js'], css: ['/build/app.def456.css'] } },
  }, null, 2));

  put(root, 'src/Service/AssetVersioning.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\Asset\\VersionStrategy\\JsonManifestVersionStrategy;',
    'use Symfony\\Component\\Asset\\VersionStrategy\\StaticVersionStrategy;',
    '',
    'class AssetVersioning',
    '{',
    '    public function strategies(): array',
    '    {',
    '        return [',
    '            new StaticVersionStrategy("v1", "%s?%s"),',
    '            new JsonManifestVersionStrategy(__DIR__ . "/../../public/build/manifest.json"),',
    '        ];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** phpunit.xml with the attributes the analyser reports on. */
function phpunitConfig(root: string): void {
  put(root, 'phpunit.xml.dist', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         bootstrap="tests/bootstrap.php"',
    '         colors="true"',
    '         stopOnFailure="true"',
    '         stopOnError="false"',
    '         failOnWarning="true"',
    '         failOnRisky="true"',
    '         beStrictAboutOutputDuringTests="true"',
    '         cacheDirectory=".phpunit.cache">',
    '    <testsuites>',
    '        <testsuite name="unit"><directory>tests/Unit</directory></testsuite>',
    '        <testsuite name="functional"><directory>tests/Functional</directory></testsuite>',
    '    </testsuites>',
    '    <source>',
    '        <include><directory>src</directory></include>',
    '        <exclude><directory>src/Migrations</directory></exclude>',
    '    </source>',
    '    <coverage><report><html outputDirectory="var/coverage"/></report></coverage>',
    '    <php>',
    '        <env name="APP_ENV" value="test" force="true"/>',
    '        <server name="SHELL_VERBOSITY" value="-1"/>',
    '    </php>',
    '</phpunit>',
  ].join('\n') + '\n');
  // The ecosystem helper also writes a bare phpunit.xml; overwrite that too,
  // or the analyser reads the simpler of the two.
  put(root, 'phpunit.xml', fs.readFileSync(path.join(root, 'phpunit.xml.dist'), 'utf-8'));
  put(root, 'tests/bootstrap.php', "<?php\nrequire dirname(__DIR__).'/vendor/autoload.php';\n");
}

/** Symfony CLI and Platform.sh descriptors. */
function symfonyCli(root: string): void {
  put(root, '.symfony.cloud.yaml', [
    'name: app',
    'type: php:8.3',
    'dependencies:',
    '    php:',
    '        composer/composer: "^2"',
    'web:',
    '    locations:',
    '        "/":',
    '            root: "public"',
    '            passthru: "/index.php"',
    'disk: 2048',
    'mounts:',
    '    "/var": { source: local, source_path: var }',
    'hooks:',
    '    build: composer install --no-dev',
    '    deploy: php bin/console cache:clear',
  ].join('\n') + '\n');

  put(root, '.platform/services.yaml', 'db:\n    type: mysql:8.0\n    disk: 1024\n');
  put(root, '.platform/routes.yaml', '"https://{default}/":\n    type: upstream\n    upstream: "app:http"\n');
  put(root, '.symfony.local.yaml', 'workers:\n    messenger:\n        cmd: ["symfony", "console", "messenger:consume", "async"]\n');
}

/** Console tables, and test doubles in the test suite. */
function consoleAndDoubles(root: string): void {
  put(root, 'src/Command/TableCommand.php', [
    '<?php',
    'namespace App\\Command;',
    '',
    'use Symfony\\Component\\Console\\Command\\Command;',
    'use Symfony\\Component\\Console\\Helper\\Table;',
    'use Symfony\\Component\\Console\\Helper\\TableSeparator;',
    '',
    'class TableCommand extends Command',
    '{',
    '    protected function execute($input, $output): int',
    '    {',
    '        $table = new Table($output);',
    '        $table->setHeaders(["Id", "Name", "Total"]);',
    '        $table->setRows([[1, "One", "10.00"], new TableSeparator(), [2, "Two", "20.00"]]);',
    '        $table->addRow([3, "Three", "30.00"]);',
    '        $table->addRows([[4, "Four", "40.00"]]);',
    '        $table->setColumnWidth(1, 30);',
    '        $table->setColumnMaxWidth(2, 10);',
    '        $table->render();',
    '        return Command::SUCCESS;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'tests/Unit/DoubleTest.php', [
    '<?php',
    'namespace App\\Tests\\Unit;',
    '',
    'use PHPUnit\\Framework\\TestCase;',
    '',
    'class DoubleTest extends TestCase',
    '{',
    '    private $recorded = [];',
    '',
    '    public function testDoubles(): void',
    '    {',
    '        $mock = $this->createMock(\\App\\Service\\Calculator::class);',
    '        $mock->expects($this->once())->method("total")->willReturn(42);',
    '',
    '        $stub = $this->createStub(\\App\\Service\\Calculator::class);',
    '        $partial = $this->createPartialMock(\\App\\Service\\Calculator::class, ["total"]);',
    '        $spy = $this->getMockBuilder(\\App\\Service\\Calculator::class)',
    '            ->disableOriginalConstructor()',
    '            ->getMock();',
    '',
    '        $this->recorded[] = $mock->total([]);',
    '        $this->assertSame(42, $this->recorded[0]);',
    '        $this->assertNotNull($stub);',
    '        $this->assertNotNull($partial);',
    '        $this->assertNotNull($spy);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** DQL: custom functions and query building. */
function dql(root: string): void {
  put(root, 'config/packages/doctrine_dql.yaml', [
    'doctrine:',
    '    orm:',
    '        dql:',
    '            string_functions:',
    '                GROUP_CONCAT: App\\Doctrine\\DQL\\GroupConcat',
    '                JSON_EXTRACT: App\\Doctrine\\DQL\\JsonExtract',
    '            numeric_functions:',
    '                ROUND: App\\Doctrine\\DQL\\Round',
    '            datetime_functions:',
    '                DATE_FORMAT: App\\Doctrine\\DQL\\DateFormat',
  ].join('\n') + '\n');

  put(root, 'src/Doctrine/DQL/GroupConcat.php', [
    '<?php',
    'namespace App\\Doctrine\\DQL;',
    '',
    'use Doctrine\\ORM\\Query\\AST\\Functions\\FunctionNode;',
    '',
    'class GroupConcat extends FunctionNode',
    '{',
    '    public function parse(\\Doctrine\\ORM\\Query\\Parser $parser): void {}',
    '    public function getSql(\\Doctrine\\ORM\\Query\\SqlWalker $walker): string { return "GROUP_CONCAT()"; }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Repository/DqlRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'class DqlRepository',
    '{',
    '    public function report(): array',
    '    {',
    '        $dql = "SELECT o, GROUP_CONCAT(l.sku) FROM App\\Entity\\Order o JOIN o.lines l GROUP BY o.id";',
    '        $query = $this->em->createQuery($dql);',
    '        $qb = $this->em->createQueryBuilder()->select("o")->from("App\\Entity\\Order", "o");',
    '        return [$query->getResult(), $qb->getQuery()->getResult()];',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Regex use, in the shapes the injection analyser looks for. */
function regexUse(root: string): void {
  put(root, 'src/Service/PatternMatcher.php', [
    '<?php',
    'namespace App\\Service;',
    '',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    '',
    'class PatternMatcher',
    '{',
    '    public function unsafe(Request $request): array',
    '    {',
    '        $term = $request->query->get("q");',
    '',
    '        // User input interpolated straight into a pattern.',
    '        preg_match("/" . $term . "/", "subject", $m);',
    '        preg_replace("/" . $term . "/i", "", "subject");',
    '        preg_split("/" . $term . "/", "a,b,c");',
    '        preg_match_all("/{$term}/u", "subject", $all);',
    '',
    '        // The e modifier, removed in PHP 7 but still written.',
    '        preg_replace("/x/e", "strtoupper", "subject");',
    '',
    '        return [$m, $all];',
    '    }',
    '',
    '    public function safe(string $term): array',
    '    {',
    '        preg_match("/" . preg_quote($term, "/") . "/", "subject", $m);',
    '        preg_match("/^[a-z0-9-]+$/", $term);',
    '        return $m;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Scheduler transports across every backend the analyser names. */
function schedulerTransports(root: string): void {
  put(root, 'config/packages/scheduler_transports.yaml', [
    'framework:',
    '    scheduler:',
    '        schedules:',
    '            default:',
    '                transport: "doctrine://default"',
    '            reports:',
    '                transport: "redis://localhost:6379/messages"',
    '            volatile:',
    '                transport: "in-memory://"',
    '            spooled:',
    '                transport: "filesystem://var/spool"',
    '            cached:',
    '                transport: "cache.app"',
  ].join('\n') + '\n');

  put(root, 'src/Scheduler/ReportSchedule.php', [
    '<?php',
    'namespace App\\Scheduler;',
    '',
    'use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;',
    'use Symfony\\Component\\Scheduler\\RecurringMessage;',
    'use Symfony\\Component\\Scheduler\\Schedule;',
    'use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;',
    '',
    '#[AsSchedule("reports")]',
    'class ReportSchedule implements ScheduleProviderInterface',
    '{',
    '    public function getSchedule(): Schedule',
    '    {',
    '        return (new Schedule())',
    '            ->add(RecurringMessage::every("1 hour", new \\App\\Message\\GenerateReport(1)))',
    '            ->add(RecurringMessage::cron("0 3 * * *", new \\App\\Message\\GenerateReport(2)))',
    '            ->stateful($this->cache);',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Repository queries with pagination, ordering and the manager reached directly. */
function repositoryQueries(root: string): void {
  put(root, 'src/Repository/ReportRepository.php', [
    '<?php',
    'namespace App\\Repository;',
    '',
    'use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;',
    '',
    'class ReportRepository extends ServiceEntityRepository',
    '{',
    '    public function paginated(int $page): array',
    '    {',
    '        return $this->createQueryBuilder("r")',
    '            ->orderBy("r.createdAt", "DESC")',
    '            ->addOrderBy("r.id", "ASC")',
    '            ->setFirstResult(($page - 1) * 20)',
    '            ->setMaxResults(20)',
    '            ->getQuery()',
    '            ->getResult();',
    '    }',
    '',
    '    public function raw(): array',
    '    {',
    '        // Reaching the manager from the repository, which the analyser flags.',
    '        return $this->getEntityManager()',
    '            ->createQuery("SELECT r FROM App\\Entity\\Report r")',
    '            ->getResult();',
    '    }',
    '',
    '    public function unbounded(): array',
    '    {',
    '        // No limit at all',
    '        return $this->createQueryBuilder("r")->getQuery()->getResult();',
    '    }',
    '}',
  ].join('\n') + '\n');
}

/** Gedmo behavioural extensions, in both attribute and annotation form. */
function gedmo(root: string): void {
  put(root, 'src/Entity/Auditable.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    'use Gedmo\\Mapping\\Annotation as Gedmo;',
    '',
    '/**',
    ' * @ORM\\Entity',
    ' * @Gedmo\\Loggable',
    ' */',
    '#[ORM\\Entity]',
    '#[Gedmo\\Loggable]',
    'class Auditable',
    '{',
    '    /**',
    '     * @Gedmo\\Timestampable(on="create")',
    '     * @ORM\\Column(type="datetime")',
    '     */',
    '    #[Gedmo\\Timestampable(on: "create")]',
    '    private $createdAt;',
    '',
    '    /**',
    '     * @Gedmo\\Blameable(on="update")',
    '     * @ORM\\Column(type="string", nullable=true)',
    '     */',
    '    #[Gedmo\\Blameable(on: "update")]',
    '    private $updatedBy;',
    '',
    '    /**',
    '     * @Gedmo\\Versioned',
    '     */',
    '    private $title;',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/LogEntry.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Gedmo\\Loggable\\Entity\\MappedSuperclass\\AbstractLogEntry;',
    '',
    'class LogEntry extends AbstractLogEntry {}',
  ].join('\n') + '\n');
}

/** DQL configuration where the analyser actually looks for it. */
function dqlInDoctrineYaml(root: string): void {
  put(root, 'config/packages/doctrine.yaml', [
    'doctrine:',
    '    dbal:',
    '        url: "%env(resolve:DATABASE_URL)%"',
    '        charset: utf8mb4',
    '    orm:',
    '        auto_generate_proxy_classes: true',
    '        naming_strategy: doctrine.orm.naming_strategy.underscore_number_aware',
    '        dql:',
    '            string_functions:',
    '                GROUP_CONCAT: App\\Doctrine\\DQL\\GroupConcat',
    '                JSON_EXTRACT: App\\Doctrine\\DQL\\JsonExtract',
    '            numeric_functions:',
    '                ROUND: App\\Doctrine\\DQL\\Round',
    '            datetime_functions:',
    '                DATE_FORMAT: App\\Doctrine\\DQL\\DateFormat',
  ].join('\n') + '\n');
}

/** CircleCI, Codeception and phpspec configuration. */
function ciAndSpecConfigs(root: string): void {
  put(root, '.circleci/config.yml', [
    'version: 2.1',
    '',
    'orbs:',
    '    php: circleci/php@1.1',
    '',
    'jobs:',
    '    build:',
    '        docker:',
    '            - image: cimg/php:8.3',
    '        steps:',
    '            - checkout',
    '            - run: composer install --no-interaction',
    '            - persist_to_workspace:',
    '                  root: .',
    '                  paths: [vendor]',
    '    test:',
    '        docker:',
    '            - image: cimg/php:8.3',
    '            - image: cimg/mysql:8.0',
    '                environment:',
    '                    MYSQL_ROOT_PASSWORD: root',
    '        parallelism: 4',
    '        steps:',
    '            - attach_workspace: { at: . }',
    '            - run: vendor/bin/phpunit',
    '            - store_test_results: { path: var/test-results }',
    '',
    'workflows:',
    '    main:',
    '        jobs:',
    '            - build',
    '            - test:',
    '                  requires: [build]',
  ].join('\n') + '\n');

  put(root, 'codeception.yml', [
    'namespace: App\\Tests',
    'support_namespace: Support',
    'paths:',
    '    tests: tests',
    '    output: var/_output',
    '    support: tests/Support',
    'actor_suffix: Tester',
    'suites:',
    '    unit:',
    '        actor: UnitTester',
    '        path: Unit',
    '    functional:',
    '        actor: FunctionalTester',
    '        path: Functional',
    '        modules:',
    '            enabled: [Symfony, Doctrine2]',
    '    acceptance:',
    '        actor: AcceptanceTester',
    '        path: Acceptance',
    'extensions:',
    '    enabled: [Codeception\\Extension\\RunFailed]',
  ].join('\n') + '\n');

  put(root, 'phpspec.yml', [
    'suites:',
    '    app:',
    '        namespace: App',
    '        psr4_prefix: App',
    '        src_path: src',
    '        spec_path: spec',
    '    domain:',
    '        namespace: App\\Domain',
    '        psr4_prefix: App\\Domain',
    'formatter.name: pretty',
    'extensions:',
    '    PhpSpec\\Extension\\CodeCoverageExtension: ~',
  ].join('\n') + '\n');
  put(root, 'spec/App/CalculatorSpec.php', [
    '<?php',
    'namespace spec\\App;',
    'use PhpSpec\\ObjectBehavior;',
    'class CalculatorSpec extends ObjectBehavior',
    '{',
    '    function it_is_initializable() { $this->shouldHaveType(\\App\\Service\\Calculator::class); }',
    '}',
  ].join('\n') + '\n');
}

/** Apply every targeted block. */
export function addTargetedContent(root: string, withProfilerIndex = true): void {
  profiler(root, withProfilerIndex);
  googleOauth(root);
  forms(root);
  propertyHooks(root);
  workflowParallel(root);
  competingConsumers(root);
  paypal(root);
  netlify(root);
  benchmarks(root);
  secretsVault(root);
  commands(root);
  stripe(root);
  rateLimiter(root);
  infrastructure(root);
  psalm(root);
  oauth2Server(root);
  microsoftGraph(root);
  cors(root);
  formEvents(root);
  httpClient(root);
  deployDescriptors(root);
  twig(root);
  search(root);
  serializerAttributes(root);
  swarmProd(root);
  vercel(root);
  doctrineExtras(root);
  lazyServices(root);
  validatorAndMapper(root);
  commandVariants(root);
  serializerPromoted(root);
  swarmInCompose(root);
  twigConstructs(root);
  httpCredentials(root);
  assetPackages(root);
  phpunitConfig(root);
  symfonyCli(root);
  consoleAndDoubles(root);
  dql(root);
  regexUse(root);
  schedulerTransports(root);
  repositoryQueries(root);
  gedmo(root);
  dqlInDoctrineYaml(root);
  ciAndSpecConfigs(root);
}
