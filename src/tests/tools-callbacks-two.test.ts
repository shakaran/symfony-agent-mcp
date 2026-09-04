// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A second application for the reports that need a list: PHP code with the
 * risky calls in it, tests with snapshots and shared state, messenger
 * handlers on two buses, Monolog spread over three environments, GraphQL
 * types and an OpenTelemetry setup with two exporters.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
let app: string;

const FILES: Record<string, string> = {
  'composer.json': JSON.stringify({
    require: {
      'symfony/framework-bundle': '^7.0',
      'symfony/messenger': '^7.0',
      'open-telemetry/sdk': '^1.0',
      'overblog/graphql-bundle': '^1.2',
      'monolog/monolog': '^3.5',
    },
    'require-dev': { 'phpunit/phpunit': '^11.0' },
  }, null, 2) + '\n',

  'src/Legacy/Xml.php': [
    '<?php',
    'namespace App\\Legacy;',
    '',
    'class Xml',
    '{',
    '    public function parse(string $payload): array',
    '    {',
    '        $document = new \\DOMDocument();',
    '        $document->loadXML($payload);',
    '        $second = new \\DOMDocument();',
    '        $second->loadXML($payload, LIBXML_NOENT);',
    '',
    '        $xpath = new \\DOMXPath($document);',
    '        $nodes = $xpath->query("//user[@name=\'" . $_GET["name"] . "\']");',
    '        $more = $xpath->evaluate("count(//user[@id=" . $_GET["id"] . "])");',
    '',
    '        return [$nodes, $more];',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Legacy/Hashes.php': [
    '<?php',
    'namespace App\\Legacy;',
    '',
    'class Hashes',
    '{',
    '    public function checksum(string $payload): string',
    '    {',
    '        // An integrity check, not a password.',
    '        $fingerprint = md5($payload);',
    '        $etag = sha1($payload);',
    '',
    '        return $fingerprint . $etag;',
    '    }',
    '',
    '    public function password(string $plain): string',
    '    {',
    '        return md5($plain);',
    '    }',
    '',
    '    public function compare(string $given, string $stored): bool',
    '    {',
    '        return $given === $stored;',
    '    }',
    '',
    '    public function safeCompare(string $given, string $stored): bool',
    '    {',
    '        return hash_equals($stored, $given);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Legacy/Magic.php': [
    '<?php',
    'namespace App\\Legacy;',
    '',
    'class Magic',
    '{',
    '    private array $data = [];',
    '    private string $password = "";',
    '    private string $apiToken = "";',
    '',
    '    public function __get(string $name): mixed { return $this->data[$name] ?? null; }',
    '    public function __set(string $name, mixed $value): void { $this->data[$name] = $value; }',
    '    public function __call(string $name, array $arguments): mixed { return null; }',
    '    public static function __callStatic(string $name, array $arguments): mixed { return null; }',
    '    public function __toString(): string { return json_encode($this->data); }',
    '    public function __sleep(): array { return ["data", "password", "apiToken"]; }',
    '    public function __wakeup(): void { }',
    '    public function __destruct() { }',
    '}',
  ].join('\n') + '\n',

  'src/Security/Compare.php': [
    '<?php',
    'namespace App\\Security;',
    '',
    'class Compare',
    '{',
    '    public function token(string $given, string $stored): bool',
    '    {',
    '        return $given === $stored;',
    '    }',
    '',
    '    public function apiKey(string $given): bool',
    '    {',
    '        return $given == $_ENV["API_KEY"];',
    '    }',
    '',
    '    public function signature(string $given, string $expected): bool',
    '    {',
    '        return strcmp($given, $expected) === 0;',
    '    }',
    '',
    '    public function safe(string $given, string $expected): bool',
    '    {',
    '        return hash_equals($expected, $given);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Dto/OrderInput.php': [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    'use Symfony\\Component\\Validator\\Constraints as Assert;',
    '',
    'final class OrderInput',
    '{',
    "    #[Groups(['order:write', 'order:create'])]",
    '    #[Assert\\NotBlank]',
    '    public string $reference = "";',
    '',
    "    #[Groups(['order:write'])]",
    '    public string $note = "";',
    '}',
  ].join('\n') + '\n',

  'src/Dto/CustomerInput.php': [
    '<?php',
    'namespace App\\Dto;',
    '',
    'use Symfony\\Component\\Serializer\\Annotation\\Groups;',
    '',
    'final class CustomerInput',
    '{',
    "    #[Groups(['customer:write', 'customer:create'])]",
    '    public string $email = "";',
    '}',
  ].join('\n') + '\n',

  'config/packages/messenger.yaml': [
    'framework:',
    '    messenger:',
    '        default_bus: command.bus',
    '        buses:',
    '            command.bus:',
    '                middleware:',
    '                    - validation',
    '                    - doctrine_transaction',
    '                    - App\\Middleware\\AuditMiddleware',
    '            query.bus:',
    '                default_middleware: allow_no_handlers',
    '                middleware:',
    '                    - validation',
    '        transports:',
    '            async:',
    '                dsn: "%env(MESSENGER_TRANSPORT_DSN)%"',
  ].join('\n') + '\n',

  'src/MessageHandler/FirstHandler.php': [
    '<?php',
    'namespace App\\MessageHandler;',
    '',
    'use App\\Message\\First;',
    'use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;',
    '',
    '#[AsMessageHandler(bus: "command.bus")]',
    'final class FirstHandler',
    '{',
    '    public function __invoke(First $message): void { }',
    '}',
  ].join('\n') + '\n',

  'src/MessageHandler/SecondHandler.php': [
    '<?php',
    'namespace App\\MessageHandler;',
    '',
    'use App\\Message\\Second;',
    'use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;',
    '',
    '#[AsMessageHandler(bus: "query.bus")]',
    'final class SecondHandler',
    '{',
    '    public function __invoke(Second $message): string { return "ok"; }',
    '}',
  ].join('\n') + '\n',

  'src/Message/First.php': '<?php\n\nnamespace App\\Message;\n\nfinal class First\n{\n}\n',
  'src/Message/Second.php': '<?php\n\nnamespace App\\Message;\n\nfinal class Second\n{\n}\n',

  'src/Middleware/AuditMiddleware.php': [
    '<?php',
    'namespace App\\Middleware;',
    '',
    'use Symfony\\Component\\Messenger\\Envelope;',
    'use Symfony\\Component\\Messenger\\Middleware\\MiddlewareInterface;',
    'use Symfony\\Component\\Messenger\\Middleware\\StackInterface;',
    '',
    'class AuditMiddleware implements MiddlewareInterface',
    '{',
    '    public function handle(Envelope $envelope, StackInterface $stack): Envelope',
    '    {',
    '        return $stack->next()->handle($envelope, $stack);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'config/packages/monolog.yaml': [
    'monolog:',
    '    channels: [business, payment]',
    '    handlers:',
    '        main:',
    '            type: fingers_crossed',
    '            action_level: error',
    '            handler: nested',
    '        nested:',
    '            type: stream',
    '            path: "%kernel.logs_dir%/%kernel.environment%.log"',
  ].join('\n') + '\n',

  'config/packages/prod/monolog.yaml': [
    'monolog:',
    '    handlers:',
    '        main:',
    '            type: fingers_crossed',
    '            action_level: error',
    '            handler: nested',
    '            buffer_size: 50',
    '        nested:',
    '            type: stream',
    '            path: php://stderr',
    '            level: debug',
    '            formatter: monolog.formatter.json',
    '    processors:',
    '        - Monolog\\Processor\\PsrLogMessageProcessor',
    '        - Monolog\\Processor\\IntrospectionProcessor',
  ].join('\n') + '\n',

  'config/packages/dev/monolog.yaml': [
    'monolog:',
    '    handlers:',
    '        main:',
    '            type: stream',
    '            path: "%kernel.logs_dir%/dev.log"',
    '            level: debug',
    '    processors:',
    '        - Monolog\\Processor\\PsrLogMessageProcessor',
    '        - App\\Logger\\TenantProcessor',
  ].join('\n') + '\n',

  'config/packages/open_telemetry.yaml': [
    'open_telemetry:',
    '    service:',
    '        name: acme',
    '        namespace: shop',
    '    traces:',
    '        exporters:',
    '            jaeger:',
    '                endpoint: "http://jaeger:14268/api/traces"',
    '            zipkin:',
    '                endpoint: "http://zipkin:9411/api/v2/spans"',
    '            otlp:',
    '                endpoint: "http://collector:4318"',
    '        sampler:',
    '            type: always_on',
    '    instrumentation:',
    '        symfony: true',
    '        doctrine: true',
    '        http_client: false',
  ].join('\n') + '\n',

  'config/graphql/types/Product.types.yaml': [
    'Product:',
    '    type: object',
    '    config:',
    '        fields:',
    '            id: { type: "ID!" }',
    '            name: { type: "String!" }',
    '            price: { type: "Float" }',
  ].join('\n') + '\n',

  'config/graphql/types/Query.types.yaml': [
    'Query:',
    '    type: object',
    '    config:',
    '        fields:',
    '            products:',
    '                type: "[Product]"',
    '                resolve: "@=query(\'products\')"',
    '            product:',
    '                type: "Product"',
    '                args:',
    '                    id: { type: "ID!" }',
  ].join('\n') + '\n',

  'config/graphql/types/Mutation.types.yaml': [
    'Mutation:',
    '    type: object',
    '    config:',
    '        fields:',
    '            createProduct:',
    '                type: "Product"',
    '                resolve: "@=mutation(\'create_product\', args)"',
  ].join('\n') + '\n',

  'tests/Unit/SnapshotTest.php': [
    '<?php',
    'namespace App\\Tests\\Unit;',
    '',
    'use PHPUnit\\Framework\\TestCase;',
    '',
    'class SnapshotTest extends TestCase',
    '{',
    '    private static array $shared = [];',
    '',
    '    protected function setUp(): void',
    '    {',
    '        self::$shared["count"] = 0;',
    '    }',
    '',
    '    public function testMatchesTheSnapshot(): void',
    '    {',
    '        $this->assertStringEqualsFile(__DIR__ . "/__snapshots__/order.snap", "expected");',
    '    }',
    '',
    '    public function testMatchesTheOtherSnapshot(): void',
    '    {',
    '        $this->assertStringEqualsFile(__DIR__ . "/__snapshots__/customer.snap", "expected");',
    '        self::$shared["count"]++;',
    '    }',
    '}',
  ].join('\n') + '\n',

  'tests/Unit/__snapshots__/order.snap': '{"id":1,"reference":"A-1"}\n',
  'tests/Unit/__snapshots__/customer.snap': '{"id":2,"email":"buyer@example.com"}\n',
  'tests/Unit/__snapshots__/orphan.snap': '{"nothing":"references this"}\n',

  'tests/Unit/IsolationTest.php': [
    '<?php',
    'namespace App\\Tests\\Unit;',
    '',
    'use PHPUnit\\Framework\\TestCase;',
    '',
    'class IsolationTest extends TestCase',
    '{',
    '    private static ?object $client = null;',
    '    private array $fixtures = [];',
    '',
    '    protected function setUp(): void',
    '    {',
    '        $this->fixtures = ["one", "two"];',
    '        putenv("APP_ENV=test");',
    '    }',
    '',
    '    protected function tearDown(): void',
    '    {',
    '        $this->fixtures = [];',
    '    }',
    '',
    '    public function testOne(): void',
    '    {',
    '        self::$client = new \\stdClass();',
    '        $GLOBALS["shared"] = 1;',
    '        static::$client->value = 1;',
    '        $this->assertTrue(true);',
    '    }',
    '',
    '    public function testTwo(): void',
    '    {',
    '        $this->assertNotNull(self::$client);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'src/Contract/PaymentGatewayInterface.php': [
    '<?php',
    'namespace App\\Contract;',
    '',
    'interface PaymentGatewayInterface',
    '{',
    '    public function charge(int $amount): string;',
    '    public function refund(string $reference): void;',
    '    public function status(string $reference): string;',
    '}',
  ].join('\n') + '\n',

  'tests/Contract/PaymentGatewayContractTest.php': [
    '<?php',
    'namespace App\\Tests\\Contract;',
    '',
    'use App\\Contract\\PaymentGatewayInterface;',
    'use PHPUnit\\Framework\\TestCase;',
    '',
    'abstract class PaymentGatewayContractTest extends TestCase',
    '{',
    '    abstract protected function gateway(): PaymentGatewayInterface;',
    '',
    '    public function testCharge(): void',
    '    {',
    '        $this->assertNotEmpty($this->gateway()->charge(100));',
    '    }',
    '',
    '    public function testRefund(): void',
    '    {',
    '        $this->gateway()->refund("ref");',
    '        $this->assertTrue(true);',
    '    }',
    '}',
  ].join('\n') + '\n',

  'playwright.config.js': [
    "const { defineConfig, devices } = require('@playwright/test');",
    '',
    'module.exports = defineConfig({',
    "    testDir: './e2e',",
    '    fullyParallel: true,',
    '    retries: 2,',
    '    workers: 4,',
    "    reporter: 'html',",
    '    use: {',
    "        baseURL: 'http://localhost:8000',",
    "        trace: 'on-first-retry',",
    '        screenshot: "only-on-failure",',
    '    },',
    '    projects: [',
    "        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },",
    "        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },",
    '    ],',
    '});',
  ].join('\n') + '\n',

  'e2e/checkout.spec.js': [
    "const { test, expect } = require('@playwright/test');",
    '',
    "test('checkout', async ({ page }) => {",
    "    await page.goto('/cart');",
    '    await page.waitForTimeout(2000);',
    "    await expect(page.locator('.total')).toBeVisible();",
    '});',
  ].join('\n') + '\n',

  'e2e/login.spec.js': [
    "const { test, expect } = require('@playwright/test');",
    '',
    "test('login', async ({ page }) => {",
    "    await page.goto('/login');",
    "    await expect(page).toHaveTitle(/Login/);",
    '});',
  ].join('\n') + '\n',
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-callbacks2-'));
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

    const calls = fn.length === 1 ? [[app]] : (extras.length > 0 ? extras.map((e) => [app, e, e]) : [[app, '', '']]);
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

describe('lists with something in them', () => {
  test.each([
    ['php-dom-xpath', []],
    ['php-hash-algorithm-security', []],
    ['php-magic-methods', []],
    ['php-timing-attack', []],
    ['input-dto', []],
    ['messenger-handlers', ['command.bus']],
    ['messenger-middleware', []],
    ['monolog', ['prod']],
    ['opentelemetry-config', []],
    ['graphql', ['Product']],
    ['phpunit-snapshot', []],
    ['phpunit-test-isolation', []],
    ['php-contract-tests', []],
    ['playwright-e2e-config', []],
    ['php-gd-security', []],
    ['php-namespace-consistency', []],
  ])('%s reports on the second callback application', async (name, extras) => {
    const text = await runModule(name, extras as string[]);
    expect(typeof text).toBe('string');
  });
});
