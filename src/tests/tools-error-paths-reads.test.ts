// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The guards around single reads that the failing-filesystem sweep misses.
 *
 * Most modules check that a file exists before reading it, and the sweep's
 * application does not hold every file each module looks for. Others read a
 * file once to decide whether it is theirs and again to parse it, or read a
 * configuration file and then walk to more files, so failing every read stops
 * them before the guard. Here the application holds what each module looks
 * for, and the failures are narrower: existence checks that answer yes, reads
 * that fail by path, the second read of a file, and the calls after the nth.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('path', () => require('./helpers/sweep-fs').pathMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./helpers/sweep-fs').fsMock());

import * as os from 'os';

import { pathFunctions, state, writeSweepApp, type ResultLike } from './helpers/sweep-fs';

const path = jest.requireActual<typeof import('path')>('path');
const realFs = jest.requireActual<typeof import('fs')>('fs');
const toolsDir = path.resolve(__dirname, '../tools');

const modules = [
  'api-json-ld-context',
  'api-response-compression',
  'behat-config',
  'bundles',
  'cicd-config',
  'compiler-passes',
  'composer',
  'cypress-e2e-config',
  'database-fixture-groups',
  'doctrine-association-fetch',
  'doctrine-orm-profiling',
  'elasticsearch-mapping-config',
  'event-priority-conflicts',
  'fixtures',
  'grafana-dashboard',
  'grpc-integration',
  'http-client',
  'kernel-analysis',
  'memcached-integration',
  'messenger',
  'nelmio-security-bundle',
  'new-relic-integration',
  'nginx-php-fpm',
  'php-bcmath-patterns',
  'php-benchmark-patterns',
  'php-codesniffer-config',
  'php-cs-fixer',
  'php-fpm-config',
  'php-gc-config',
  'php-ini-analysis',
  'php-interface-segregation',
  'php-jit-config',
  'php-memory-profiling',
  'php-preloading-config',
  'php-property-hooks',
  'php-session-security',
  'php-template-injection',
  'php-xdebug-config',
  'rector-config',
  'saml-auth',
  'scheduler',
  'secrets-vault',
  'sonarqube-config',
  'symfony-asset-preload-hints',
  'symfony-container-compile',
  'symfony-di-lazy-ghost',
  'symfony-form-button',
  'symfony-form-data-class',
  'symfony-form-data-mapper',
  'symfony-http2-push',
  'symfony-kubernetes',
  'symfony-messenger-competing-consumers',
  'symfony-monolog-handler',
  'symfony-rate-limiter-algorithms',
  'symfony-security-post-auth',
  'symfony-serializer-discriminator',
  'symfony-serializer-name-converter',
  'symfony-translation-extractors',
  'symfony-translation-gaps',
  'symfony-translation-lint-all',
  'symfony-twig-embed',
  'symfony-twig-ux-icons',
  'symfony-ux',
  'symfony-ux-react',
  'symfony-ux-stimulus-controllers',
  'symfony-ux-translator',
  'symfony-ux-typed',
  'symfony-ux-vue',
  'symfony-workflow-state-machine',
  'translations',
  'translation-xliff-format',
  'twig-extensions',
  'varnish-config',
  'vite-bundle',
  'webpack-encore',
  'webserver-config',
  'websocket-integration',
];

// Each module stops early unless the application holds what it looks for:
// a package in composer.json, a directory it walks, a marker in a file.
const files: Record<string, string> = {
  'composer.json': JSON.stringify({
    require: {
      php: '>=8.2',
      'symfony/framework-bundle': '^7.0',
      'doctrine/orm': '^3.0',
      'symfony/cache': '^7.0',
      'symfony/messenger': '^7.0',
      'symfony/scheduler': '^7.0',
      'symfony/stimulus-bundle': '^2.0',
      'symfony/ux-icons': '^2.0',
      'symfony/ux-react': '^2.0',
      'symfony/ux-translator': '^2.0',
      'symfony/ux-twig-component': '^2.0',
      'symfony/ux-typed': '^2.0',
      'symfony/ux-vue': '^2.0',
    },
    'require-dev': { 'phpunit/phpunit': '^11.0', 'phpbench/phpbench': '^1.0' },
  }),
  'behat.yml': 'default:\n    suites:\n        default:\n            paths: [features]\n',
  'public/contexts/app.jsonld': '{"@context":{"@vocab":"https://schema.org/"}}\n',
  'src/DependencyInjection/Compiler/TagPass.php': '<?php\n\nnamespace App\\DependencyInjection\\Compiler;\n\nuse Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;\n\nclass TagPass implements CompilerPassInterface\n{\n}\n',
  'src/Kernel.php': '<?php\n\nnamespace App;\n\nclass Kernel\n{\n    protected function build($container): void\n    {\n        $container->addCompilerPass(new TagPass());\n    }\n}\n',
  'cypress/cypress.config.js': 'module.exports = { e2e: { baseUrl: "http://localhost" } };\n',
  'src/DataFixtures/AppFixtures.php': '<?php\n\nnamespace App\\DataFixtures;\n\nuse Doctrine\\Bundle\\FixturesBundle\\Fixture;\nuse Doctrine\\Bundle\\FixturesBundle\\FixtureGroupInterface;\n\nclass AppFixtures extends Fixture implements FixtureGroupInterface\n{\n    public static function getGroups(): array\n    {\n        return ["demo"];\n    }\n}\n',
  'config/doctrine/Order.orm.xml': '<doctrine-mapping><entity name="App\\Entity\\Order"><many-to-one field="customer" target-entity="User" fetch="EAGER"/></entity></doctrine-mapping>\n',
  'src/Service/QueryLogger.php': '<?php\n\nnamespace App\\Service;\n\nuse Doctrine\\DBAL\\Logging\\DebugStack;\n\nclass QueryLogger\n{\n    public function stack(): DebugStack\n    {\n        return $this->connection->getConfiguration()->getSQLLogger();\n    }\n}\n',
  'config/elasticsearch/products.json': '{"mappings":{"properties":{"name":{"type":"text"}}}}\n',
  'grafana/provisioning/datasources/prometheus.yaml': 'apiVersion: 1\ndatasources:\n    - name: Prometheus\n      type: prometheus\n',
  'proto/app.proto': 'syntax = "proto3";\n\nservice Greeter {\n    rpc Hello (HelloRequest) returns (HelloReply);\n}\n',
  'php.ini': 'memory_limit = 256M\nxdebug.mode = debug\n',
  'src/Message/SendEmail.php': '<?php\n\nnamespace App\\Message;\n\nclass SendEmail\n{\n}\n',
  'src/Message/SendSms.php': '<?php\n\nnamespace App\\Message;\n\nclass SendSms\n{\n}\n',
  'src/Resources/views/widget.html.twig': '{% embed "card.html.twig" %}{% block body %}{{ name|raw }}{% endblock %}{% endembed %}\n',
  'benchmarks/HashBench.php': '<?php\n\nnamespace App\\Benchmarks;\n\nclass HashBench\n{\n    /**\n     * @Revs(100)\n     */\n    public function benchHash(): void\n    {\n    }\n}\n',
  'src/Contract/ExporterInterface.php': '<?php\n\nnamespace App\\Contract;\n\ninterface ExporterInterface\n{\n    public function export(): void;\n}\n',
  'src/Scheduler/Tasks.php': '<?php\n\nnamespace App\\Scheduler;\n\nuse Symfony\\Component\\Scheduler\\Attribute\\AsPeriodicTask;\n\n#[AsPeriodicTask(frequency: "1 hour")]\nclass Tasks\n{\n    public function __invoke(): void\n    {\n    }\n}\n',
  'config/services.yaml': 'services:\n    _defaults:\n        autowire: true\n    App\\Service\\Importer:\n        lazy: true\n',
  'src/Form/OrderDataType.php': '<?php\n\nnamespace App\\Form;\n\nuse App\\Entity\\Order;\nuse Symfony\\Component\\Form\\AbstractType;\nuse Symfony\\Component\\OptionsResolver\\OptionsResolver;\n\nclass OrderDataType extends AbstractType\n{\n    public function configureOptions(OptionsResolver $resolver): void\n    {\n        $resolver->setDefaults(["data_class" => Order::class]);\n    }\n}\n',
  'src/Security/LoginAudit.php': '<?php\n\nnamespace App\\Security;\n\nuse Symfony\\Component\\Security\\Http\\Event\\LoginSuccessEvent;\n\nclass LoginAudit\n{\n    public static function getSubscribedEvents(): array\n    {\n        return [LoginSuccessEvent::class => "onLogin"];\n    }\n}\n',
  'src/Security/LoginNotifier.php': '<?php\n\nnamespace App\\Security;\n\nuse Symfony\\Component\\Security\\Http\\Event\\LoginSuccessEvent;\n\nclass LoginNotifier\n{\n    public static function getSubscribedEvents(): array\n    {\n        return [LoginSuccessEvent::class => "onLogin"];\n    }\n}\n',
  'assets/app.js': 'import { registerReactControllerComponents } from "@symfony/ux-react";\nimport { registerVueControllerComponents } from "@symfony/ux-vue";\nimport { trans } from "@symfony/ux-translator";\n\ntrans("hello");\n',
  'assets/controllers/typed_controller.js': 'import Typed from "typed.js";\n',
  'assets/controllers/hello_controller.js': 'import { Controller } from "@hotwired/stimulus";\n\nexport default class extends Controller {\n    connect() {}\n}\n',
  'assets/vue/controllers/Hello.vue': '<template><p>{{ name }}</p></template>\n',
  'src/Twig/Components/Alert.php': '<?php\n\nnamespace App\\Twig\\Components;\n\nuse Symfony\\UX\\TwigComponent\\Attribute\\AsTwigComponent;\n\n#[AsTwigComponent]\nclass Alert\n{\n}\n',
  'src/Twig/AppExtension.php': '<?php\n\nnamespace App\\Twig;\n\nuse Twig\\Extension\\AbstractExtension;\nuse Twig\\TwigFilter;\n\nclass AppExtension extends AbstractExtension\n{\n    public function getFilters(): array\n    {\n        return [new TwigFilter("price", [$this, "price"])];\n    }\n}\n',
  'translations/messages.fr.xlf': '<?xml version="1.0"?>\n<xliff version="1.2"><file source-language="en" target-language="fr"><body><trans-unit id="hello"><source>hello</source><target>bonjour</target></trans-unit></body></file></xliff>\n',
  'translations/messages.de.po': 'msgid "hello"\nmsgstr "hallo"\n',
  'translations/messages.es.php': '<?php\n\nreturn ["hello" => "hola"];\n',
  'docker/nginx.conf': 'server {\n    server_name acme.example.com;\n    root /app/public;\n    location / { try_files $uri /index.php$is_args$args; }\n}\n',
  'config/workflows/order.yaml': 'framework:\n    workflows:\n        order:\n            type: workflow\n',
  'rector.php': '<?php\n\nuse Rector\\Config\\RectorConfig;\nuse Rector\\Set\\ValueObject\\LevelSetList;\n\nreturn static function (RectorConfig $c): void {\n    $c->paths([__DIR__ . "/src"]);\n    $c->sets([LevelSetList::UP_TO_PHP_82]);\n};\n',
  'config/workflows/extra/refund.yaml': 'framework:\n    workflows:\n        refund:\n            type: workflow\n',
};

// A read fails when its path holds one of these: an extension, or the
// directory the module walks to after reading its configuration.
const fragments = [
  '.php', '.yaml', '.yml', '.twig', '.json', '.xml', '.xlf', '.feature', '.js', '.ts',
  '.jsx', '.tsx', '.vue', '.ini', '.conf', '.neon', '.toml', '.csv', '.env', '.lock',
  '.jsonld', '.proto', '.po', '.md', '/Entity/', '/translations/', '/assets/', '/Message/',
  '/MessageHandler/', '/Security/', '/DataFixtures/', '/Twig/',
];

// A module that reads one file before walking to the others only reaches the
// guard on a later read, listing or stat when the earlier ones work.
const laterCalls = Array.from({ length: 40 }, (_, i) => i + 1);

let appPath: string;

beforeAll(() => {
  appPath = realFs.mkdtempSync(path.join(os.tmpdir(), 'symfony-errors-'));
  writeSweepApp(appPath);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(appPath, rel);
    realFs.mkdirSync(path.dirname(full), { recursive: true });
    realFs.writeFileSync(full, content);
  }
});

afterAll(() => {
  realFs.rmSync(appPath, { recursive: true, force: true });
});

afterEach(() => {
  state.failMode = 'none';
  state.existsAll = false;
  state.failReadPart = '';
  state.failFromRead = 0;
  state.failFromStat = 0;
  state.failFromReaddir = 0;
  state.failRepeatRead = false;
  state.failStatPart = '';
  state.readSeen.clear();
});

async function runAll(mod: Record<string, unknown>): Promise<void> {
  for (const [, fn] of pathFunctions(mod)) {
    const returned = await Promise.resolve(fn(appPath));

    expect(returned).toBeDefined();
    if (typeof returned === 'object' && returned !== null && 'content' in returned) {
      expect(Array.isArray((returned as ResultLike).content)).toBe(true);
    }
  }
}

describe.each(modules)('%s', (name) => {
  let mod: Record<string, unknown>;

  beforeAll(async () => {
    mod = (await import(path.join(toolsDir, name))) as Record<string, unknown>;
  });

  test('every existence check answers yes', async () => {
    state.existsAll = true;
    await runAll(mod);
  });

  test('a file read a second time fails', async () => {
    state.failRepeatRead = true;
    for (const [, fn] of pathFunctions(mod)) {
      state.readSeen.clear();
      await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
    }
  });

  test.each(['read', 'read-file', 'stat'] as const)('the sweep mode %s', async (mode) => {
    state.failMode = mode;
    await runAll(mod);
  });

  test.each(fragments)('only the reads of paths holding %s fail', async (part) => {
    state.failReadPart = part;
    await runAll(mod);
  });

  test.each(fragments)('every file exists and the reads of paths holding %s fail', async (part) => {
    state.existsAll = true;
    state.failReadPart = part;
    await runAll(mod);
  });

  test.each(fragments)('only the stats of paths holding %s fail', async (part) => {
    state.failStatPart = part;
    await runAll(mod);
  });

  test.each(laterCalls)('the reads, stats and listings from number %i on fail', async (n) => {
    for (const [, fn] of pathFunctions(mod)) {
      for (const key of ['failFromRead', 'failFromStat', 'failFromReaddir'] as const) {
        state.failFromRead = 0;
        state.failFromStat = 0;
        state.failFromReaddir = 0;
        state[key] = n;
        state.readCount = 0;
        state.statCount = 0;
        state.readdirCount = 0;
        await expect(Promise.resolve(fn(appPath))).resolves.toBeDefined();
      }
    }
  });
});

describe('arguments the sweep does not pass', () => {
  test('the dev packages are read again and that read fails', async () => {
    const { getInstalledPackages } = await import(path.join(toolsDir, 'composer')) as {
      getInstalledPackages: (appPath: string, type?: string) => ResultLike;
    };
    state.failRepeatRead = true;

    expect(getInstalledPackages(appPath, 'dev').content).toBeDefined();
  });
});
