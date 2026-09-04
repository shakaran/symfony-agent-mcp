// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Second applications for modules already covered once.
 *
 * Where the first application answered "what does it find", these answer
 * the questions the first one could not hold at the same time: a mailer
 * with every kind of DSN, a client with credentials in its headers, a URL
 * that comes from a variable rather than the request, a project with no
 * lock file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-variants-'));
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

describe('the other half of the question', () => {
  test('every kind of mailer DSN, one per environment file', async () => {
    for (const [name, dsn] of [
      ['null', 'null://null'],
      ['sendmail', 'sendmail://default'],
      ['smtp', 'smtp://acme:hunter2@smtp.example.com:465'],
      ['ses', 'ses+api://ACCESS:SECRET@default?region=eu-west-1'],
      ['mailgun', 'mailgun+https://KEY:example.com@default'],
      ['postmark', 'postmark+api://TOKEN@default'],
      ['sendgrid', 'sendgrid+api://KEY@default'],
      ['brevo', 'brevo+api://KEY@default'],
      ['failover', 'failover(smtp://one.example.com sendmail://default)'],
      ['roundrobin', 'roundrobin(ses+api://A:B@default mailgun+api://KEY:example.com@default)'],
      ['native', 'native://default'],
    ] as const) {
      const app = appWith(`mailer-${name}`, {
        'config/packages/mailer.yaml': `framework:\n    mailer:\n        dsn: "${dsn}"\n`,
        '.env': `MAILER_DSN=${dsn}\n`,
      });

      const text = await runModule('symfony-mailer-dsn-analysis.js', app);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test('an HTTP client whose credentials are in the file', async () => {
    const app = appWith('http-client-credentials', {
      'config/packages/framework.yaml': [
        'framework:',
        '    http_client:',
        '        max_host_connections: 6',
        '        default_options:',
        '            timeout: 10',
        '            max_redirects: 5',
        '            http_version: "2.0"',
        '            headers:',
        '                Authorization: "Bearer 0123456789abcdef0123456789abcdef"',
        '                X-Api-Key: "0123456789abcdef"',
        '                Accept: application/json',
        '                User-Agent: acme/1.0',
        '            extra:',
        '                curl:',
        '                    64: false',
        '        scoped_clients:',
        '            payments.client:',
        '                base_uri: "https://acme:hunter2@payments.example.com/v2/"',
        '                timeout: 5',
        '                max_redirects: 0',
        '                headers:',
        '                    Cookie: "session=abc123"',
        '                retry_failed:',
        '                    max_retries: 4',
        '                    delay: 1000',
        '                    multiplier: 3',
        '            search.client:',
        '                scope: "https://search\\\\.example\\\\.com"',
        '                verify_peer: false',
        '                query:',
        '                    key: "%env(SEARCH_KEY)%"',
        '            broken.client: "not an object"',
      ].join('\n') + '\n',
    });

    const text = await runModule('http-client.js', app, ['payments.client', 'search.client']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a URL that comes from a variable, checked in one place and not the other', async () => {
    const app = appWith('ssrf-variable', {
      'src/Service/Callbacks.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'class Callbacks',
        '{',
        '    public function unchecked(string $endpoint): string',
        '    {',
        '        $ch = curl_init($endpoint);',
        '        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
        '',
        '        return (string) curl_exec($ch);',
        '    }',
        '',
        '    public function checked(string $endpoint): string',
        '    {',
        '        if (!filter_var($endpoint, FILTER_VALIDATE_URL)) {',
        '            throw new \\InvalidArgumentException("bad url");',
        '        }',
        '        $ch = curl_init($endpoint);',
        '',
        '        return (string) curl_exec($ch);',
        '    }',
        '',
        '    public function internal(): string',
        '    {',
        '        $url = "http://127.0.0.1:8080/metrics";',
        '',
        '        return (string) file_get_contents($url);',
        '    }',
        '',
        '    public function localhostCurl(): string',
        '    {',
        '        $ch = curl_init("http://localhost/health");',
        '',
        '        return (string) curl_exec($ch);',
        '    }',
        '',
        '    public function fromRequest(): string',
        '    {',
        '        return (string) file_get_contents($_GET["callback"]);',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-ssrf-patterns.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a template rendered from a variable assigned a few lines earlier', async () => {
    const app = appWith('template-injection-context', {
      'src/Service/Mailing.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Twig\\Environment;',
        '',
        'class Mailing',
        '{',
        '    public function __construct(private Environment $twig) {}',
        '',
        '    public function render(): string',
        '    {',
        '        $body = $_POST["body"];',
        '        $subject = trim($body);',
        '        $template = $subject;',
        '',
        '        return $this->twig->createTemplate($template)->render([]);',
        '    }',
        '',
        '    public function safe(): string',
        '    {',
        '        $template = "emails/fixed.html.twig";',
        '',
        '        return $this->twig->render($template, []);',
        '    }',
        '',
        '    public function stringTemplate(): string',
        '    {',
        '        $input = $_REQUEST["tpl"];',
        '',
        '        return (new \\Twig\\Environment(new \\Twig\\Loader\\ArrayLoader(["t" => $input])))->render("t");',
        '    }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('php-template-injection.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a manifest with authors and contrib allowed, and no lock file at all', async () => {
    const withAuthors = appWith('composer-authors', {
      'composer.json': JSON.stringify({
        name: 'acme/app',
        description: 'The Acme storefront',
        type: 'project',
        license: 'MIT',
        authors: [
          { name: 'Ángel Guzmán Maeso', email: 'angel@example.com' },
          { name: 'A colleague', role: 'Developer' },
        ],
        require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpunit/phpunit': '^11.0', 'symfony/maker-bundle': '^1.55' },
        extra: { symfony: { 'allow-contrib': true, require: '7.0.*' } },
        config: { 'sort-packages': true },
      }, null, 2) + '\n',
    });

    const withoutLock = appWith('composer-nolock', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'doctrine/orm': 'dev-main' },
      }, null, 2) + '\n',
    });

    const first = await runModule('composer.js', withAuthors, ['symfony/framework-bundle']);
    const second = await runModule('composer.js', withoutLock, ['doctrine/orm']);
    expect((first + second).length).toBeGreaterThan(0);
  });

  test('an asset pipeline built by Webpack Encore instead', async () => {
    const app = appWith('encore', {
      'webpack.config.js': [
        "const Encore = require('@symfony/webpack-encore');",
        '',
        'Encore',
        "    .setOutputPath('public/build/')",
        "    .setPublicPath('/build')",
        "    .addEntry('app', './assets/app.js')",
        "    .addEntry('admin', './assets/admin.js')",
        '    .splitEntryChunks()',
        '    .enableSingleRuntimeChunk()',
        '    .cleanupOutputBeforeBuild()',
        '    .enableSourceMaps(!Encore.isProduction())',
        '    .enableVersioning(Encore.isProduction())',
        '    .enableSassLoader()',
        '    .enableTypeScriptLoader()',
        '    .enableStimulusBridge(\'./assets/controllers.json\');',
        '',
        'module.exports = Encore.getWebpackConfig();',
      ].join('\n') + '\n',
      'package.json': JSON.stringify({
        devDependencies: { '@symfony/webpack-encore': '^4.6.0', 'webpack-notifier': '^1.15.0' },
        scripts: { dev: 'encore dev', build: 'encore production --progress' },
      }, null, 2) + '\n',
      'assets/app.js': "import './styles/app.css';\n",
      'assets/admin.js': "import './styles/admin.css';\n",
      'assets/styles/app.css': 'body { margin: 0; }\n',
      'assets/styles/admin.css': 'body { padding: 0; }\n',
      'public/build/manifest.json': JSON.stringify({ 'build/app.js': '/build/app.abc123.js' }, null, 2) + '\n',
      'public/build/entrypoints.json': JSON.stringify({ entrypoints: { app: { js: ['/build/app.abc123.js'] } } }, null, 2) + '\n',
      'config/packages/webpack_encore.yaml': [
        'webpack_encore:',
        '    output_path: "%kernel.project_dir%/public/build"',
        '    script_attributes:',
        '        defer: true',
        '    strict_mode: true',
      ].join('\n') + '\n',
    }, { 'symfony/webpack-encore-bundle': '^2.1' });

    const text = await runModule('asset-mapper.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a RoadRunner file with the values written the other way', async () => {
    const app = appWith('roadrunner-variant', {
      '.rr.yaml': [
        'version: "3"',
        'rpc:',
        '    listen: tcp://127.0.0.1:6001',
        'server:',
        '    command: php public/index.php',
        '    relay: unix:///var/run/rr.sock',
        'http:',
        '    address: "127.0.0.1:8080"',
        '    max_request_size: 256',
        '    pool:',
        '        num_workers: 0',
        '        max_jobs: 64',
        '        allocate_timeout: 60s',
        '        destroy_timeout: 60s',
        '        debug: true',
        '    uploads:',
        '        forbid: [".php"]',
        'logs:',
        '    mode: development',
        '    level: error',
        '    encoding: json',
        'status:',
        '    address: 127.0.0.1:2114',
      ].join('\n') + '\n',
      'Dockerfile': 'FROM spiralscout/roadrunner:2024 AS rr\nFROM php:8.3-cli\nCOPY --from=rr /usr/bin/rr /usr/local/bin/rr\n',
    });

    const text = await runModule('symfony-roadrunner-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a CircleCI file with one job and no workflow', async () => {
    const app = appWith('circleci-minimal', {
      '.circleci/config.yml': [
        'version: 2.1',
        '',
        'jobs:',
        '    build:',
        '        docker:',
        '            - image: cimg/php:8.3',
        '        steps:',
        '            - checkout',
        '            - run: composer install',
        '            - run:',
        '                  name: Deploy',
        '                  command: |',
        '                      echo "$SSH_KEY" > /tmp/key',
        '                      ./deploy.sh',
      ].join('\n') + '\n',
    });

    const text = await runModule('circleci-config.js', app);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a schema the database module can describe', async () => {
    const app = appWith('schema', {
      'config/packages/doctrine.yaml': [
        'doctrine:',
        '    dbal:',
        '        url: "%env(resolve:DATABASE_URL)%"',
        '    orm:',
        '        auto_mapping: true',
      ].join('\n') + '\n',
      '.env': 'DATABASE_URL="postgresql://acme:hunter2@127.0.0.1:5432/acme?serverVersion=16&charset=utf8"\n',
      'src/Entity/Customer.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Table(name: "customer")]',
        '#[ORM\\Index(columns: ["email"], name: "idx_customer_email")]',
        '#[ORM\\UniqueConstraint(name: "uniq_customer_email", columns: ["email"])]',
        'class Customer',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column(type: "integer")]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\Column(type: "string", length: 180, unique: true, nullable: false)]',
        '    private string $email = "";',
        '',
        '    #[ORM\\Column(type: "decimal", precision: 10, scale: 2, nullable: true)]',
        '    private ?string $credit = null;',
        '',
        '    #[ORM\\Column(type: "json", options: ["default" => "[]"])]',
        '    private array $preferences = [];',
        '',
        '    #[ORM\\OneToMany(targetEntity: Order::class, mappedBy: "customer", cascade: ["persist"])]',
        '    private $orders;',
        '}',
      ].join('\n') + '\n',
      'src/Entity/Order.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'use Doctrine\\ORM\\Mapping as ORM;',
        '',
        '#[ORM\\Entity]',
        '#[ORM\\Table(name: "orders")]',
        'class Order',
        '{',
        '    #[ORM\\Id]',
        '    #[ORM\\GeneratedValue]',
        '    #[ORM\\Column]',
        '    private ?int $id = null;',
        '',
        '    #[ORM\\ManyToOne(targetEntity: Customer::class, inversedBy: "orders")]',
        '    #[ORM\\JoinColumn(nullable: false, onDelete: "CASCADE")]',
        '    private ?Customer $customer = null;',
        '',
        '    #[ORM\\Column(type: "datetime_immutable")]',
        '    private \\DateTimeImmutable $placedAt;',
        '}',
      ].join('\n') + '\n',
      'migrations/Version20260301120000.php': [
        '<?php',
        '',
        'namespace DoctrineMigrations;',
        '',
        'use Doctrine\\DBAL\\Schema\\Schema;',
        'use Doctrine\\Migrations\\AbstractMigration;',
        '',
        'final class Version20260301120000 extends AbstractMigration',
        '{',
        '    public function getDescription(): string',
        '    {',
        '        return \'Create the customer and orders tables\';',
        '    }',
        '',
        '    public function up(Schema $schema): void',
        '    {',
        '        $this->addSql(\'CREATE TABLE customer (id SERIAL NOT NULL, email VARCHAR(180) NOT NULL)\');',
        '        $this->addSql(\'CREATE TABLE orders (id SERIAL NOT NULL, customer_id INT NOT NULL)\');',
        '        $this->addSql(\'CREATE UNIQUE INDEX uniq_customer_email ON customer (email)\');',
        '    }',
        '',
        '    public function down(Schema $schema): void',
        '    {',
        '        $this->addSql(\'DROP TABLE orders\');',
        '        $this->addSql(\'DROP TABLE customer\');',
        '    }',
        '}',
      ].join('\n') + '\n',
    }, { 'doctrine/orm': '^3.0', 'doctrine/doctrine-migrations-bundle': '^3.3' });

    const text = await runModule('database.js', app, ['customer', 'orders']);
    expect(text.length).toBeGreaterThan(0);
  });

  test('a parallel workflow whose marking store cannot hold two places', async () => {
    const app = appWith('workflow-single-marking', {
      'config/packages/workflow.yaml': [
        'framework:',
        '    workflows:',
        '        publication:',
        '            type: workflow',
        '            marking_store:',
        '                type: method',
        '                property: currentPlace',
        '            supports: [App\\Entity\\Post]',
        '            initial_marking: draft',
        '            places: [draft, legal_review, copy_review, approved]',
        '            transitions:',
        '                submit:',
        '                    from: [draft]',
        '                    to: [legal_review, copy_review]',
        '                approve:',
        '                    from: [legal_review, copy_review]',
        '                    to: [approved]',
        '        order_state:',
        '            type: state_machine',
        '            supports: [App\\Entity\\Order]',
        '            places: [new, paid]',
        '            transitions:',
        '                pay:',
        '                    from: [new]',
        '                    to: [paid]',
      ].join('\n') + '\n',
      'src/Entity/Post.php': [
        '<?php',
        'namespace App\\Entity;',
        '',
        'class Post',
        '{',
        '    private string $currentPlace = "draft";',
        '',
        '    public function getCurrentPlace(): string { return $this->currentPlace; }',
        '    public function setCurrentPlace(string $place): void { $this->currentPlace = $place; }',
        '}',
      ].join('\n') + '\n',
    });

    const text = await runModule('symfony-workflow-parallel-transitions.js', app);
    expect(text.length).toBeGreaterThan(0);
  });
});
