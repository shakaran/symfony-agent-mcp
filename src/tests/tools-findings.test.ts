// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The findings themselves.
 *
 * An analyser that reads a file it never finds reports nothing, and the
 * half of it that decides what is wrong never runs. Each application here
 * is written for one module and holds, in one file, every shape that
 * module has something to say about: a timeout over the limit and one
 * under it, a hook that recurses and one that does not, a firewall of
 * each kind.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-findings-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function appWith(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (!files['composer.json']) {
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: { 'symfony/framework-bundle': '^7.0' },
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

describe('property hooks', () => {
  test('hooks that recurse, that run long, and that a non-abstract class declares abstract', async () => {
    const app = appWith('property-hooks', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

class Invoice
{
    public string $reference {
        get {
            $prefix = 'INV';
            $year = date('Y');
            $number = str_pad((string) $this->id, 6, '0', STR_PAD_LEFT);
            $suffix = $this->draft ? '-D' : '';
            $joined = $prefix . '-' . $year . '-' . $number . $suffix;
            $trimmed = trim($joined);
            $upper = strtoupper($trimmed);

            return $this->reference ?? $upper;
        }
        set {
            $trimmed = trim($value);
            $upper = strtoupper($trimmed);
            $checked = $upper === '' ? 'INV-UNKNOWN' : $upper;
            $logged = $checked;
            $counted = strlen($logged);
            $stamped = $counted > 0 ? $logged : 'INV-EMPTY';
            $final = $stamped;

            $this->reference = $final;
        }
    }

    abstract public string $label { get; }

    public readonly string $issuedBy {
        get {
            return 'acme';
        }
    }

    public int $total {
        get => $this->lines;
    }
}
`,
      'src/Entity/Draft.php': `<?php

namespace App\\Entity;

class Draft
{
    public string $title {
        get => 'draft';
    }
}

class DraftCopy
{
    public string $title {
        get {
            return 'copy';
        }
    }
}
`,
      'src/Support/hooks.php': `<?php

// A file with a hook-looking line and no class in it at all.
$reader = function (): string {
    return 'get';
};
`,
      'src/Support/Anonymous.php': `<?php

namespace App\\Support;

$handler = new class {
    public string $name {
        get {
            return 'anonymous';
        }
    }
};
`,
    });

    const text = await runModule('php-property-hooks.js', app);

    expect(text).toContain('Invoice');
    expect(text).toContain('infinite recursion');
  });

  test('an application whose hooks are all fine', async () => {
    const app = appWith('property-hooks-clean', {
      'src/Entity/Money.php': `<?php

namespace App\\Entity;

class Money
{
    public int $amount {
        get {
            return $field;
        }
        set {
            $field = $value;
        }
    }
}
`,
    });

    const text = await runModule('php-property-hooks.js', app);

    expect(text).toContain('Money');
  });
});

describe('vercel', () => {
  test('every section of a vercel.json that has something wrong with it', async () => {
    const app = appWith('vercel', {
      'vercel.json': JSON.stringify({
        framework: 'symfony',
        routes: [
          { src: '/admin/(.*)', dest: '/index.php' },
          { src: '/health', dest: '/health.php', has: [{ type: 'header', key: 'x-probe' }] },
        ],
        rewrites: [
          { source: '/admin/login', destination: '/index.php' },
          { source: '/blog/:slug', destination: '/index.php' },
        ],
        redirects: [
          { source: '/old', destination: '/new', permanent: true },
        ],
        functions: {
          'api/slow.php': { maxDuration: 400, memory: 3008, runtime: 'php' },
          'api/medium.php': { maxDuration: 120 },
          'api/quick.php': { maxDuration: 30, runtime: 'php@8.2' },
          'api/default.php': { memory: 1024 },
        },
        headers: [
          {
            source: '/(.*)',
            headers: [
              { key: 'Authorization', value: 'Bearer 8f14e45fceea167a' },
              { key: 'X-DNS-Prefetch-Control', value: 'on' },
            ],
          },
          { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public' }] },
        ],
        env: {
          APP_ENV: 'prod',
          DATABASE_URL: '@database_url',
        },
        build: {
          env: { COMPOSER_FLAGS: '--no-dev' },
        },
      }, null, 2),
    });

    const text = await runModule('vercel-deploy-config.js', app);

    expect(text).toContain('symfony');
    expect(text).toContain('maxDuration');
    expect(text).not.toContain('8f14e45fceea167a');
  });

  test('headers that are all present, and a file with no section in it', async () => {
    const withHeaders = appWith('vercel-headers', {
      'vercel.json': JSON.stringify({
        headers: [
          {
            source: '/(.*)',
            headers: [
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
            ],
          },
        ],
      }, null, 2),
    });
    // A vercel.json the process cannot read: present, so the tool goes on, and
    // unreadable, so nothing comes back from it.
    const empty = appWith('vercel-empty', { 'vercel.json': '{ "$schema": "https://openapi.vercel.sh/vercel.json" }\n' });
    fs.chmodSync(path.join(empty, 'vercel.json'), 0o000);
    const broken = appWith('vercel-broken', { 'vercel.json': '{ not json\n' });
    const noWildcard = appWith('vercel-no-wildcard', {
      'vercel.json': JSON.stringify({
        headers: [{ source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public' }] }],
      }, null, 2),
    });
    const noHeaders = appWith('vercel-no-headers', {
      'vercel.json': JSON.stringify({ routes: [{ src: '/(.*)', dest: '/index.php' }] }, null, 2),
    });

    const one = await runModule('vercel-deploy-config.js', withHeaders);
    const two = await runModule('vercel-deploy-config.js', empty);
    const three = await runModule('vercel-deploy-config.js', broken);

    expect(one).toContain('security headers present');
    expect(two).toContain('no analysable sections');
    fs.chmodSync(path.join(empty, 'vercel.json'), 0o644);
    const four = await runModule('vercel-deploy-config.js', noWildcard);
    const five = await runModule('vercel-deploy-config.js', noHeaders);

    expect(three).toContain('not valid JSON');
    expect(four).toContain('No wildcard headers block');
    expect(five).toContain('No "headers" field');
  });
});

describe('authentication', () => {
  test('a firewall of every kind, with jwt and oauth2 configured', async () => {
    const app = appWith('jwt-auth', {
      'config/packages/lexik_jwt_authentication.yaml': `lexik_jwt_authentication:
    secret_key: '%kernel.project_dir%/config/jwt/private.pem'
    public_key: '%kernel.project_dir%/config/jwt/public.pem'
    pass_phrase: '%env(JWT_PASSPHRASE)%'
    token_ttl: 45
    refresh_token_ttl: 2592000
    clock_skew: 30
    encoder:
        signature_algorithm: RS512
`,
      'config/packages/league_oauth2_server.yaml': `league_oauth2_server:
    authorization_server:
        private_key: '%env(OAUTH_PRIVATE_KEY)%'
        enable_implicit_grant: false
        access_token_ttl: PT1H
        refresh_token_ttl: P1M
    scopes:
        - read
        - write
    access_token_ttl: PT1H
    refresh_token_ttl: P1M
`,
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            pattern: ^/api
            stateless: true
            jwt:
                authenticator: lexik_jwt_authentication.security.jwt_authenticator
        oauth:
            oauth2: true
        basic:
            http_basic:
                realm: Acme
        main:
            form_login:
                login_path: app_login
        throttled:
            login_throttling:
                max_attempts: 3
        remembered:
            remember_me:
                secret: '%kernel.secret%'
        custom:
            custom_authenticators:
                - App\\Security\\ApiTokenAuthenticator
        denied:
            access_denied_handler: App\\Security\\DeniedHandler
        token:
            stateless: true
        session: ~
        plain:
            provider: app_user_provider
`,
    });

    const text = await runModule('jwt-auth.js', app);

    expect(text).toContain('JWT');
    expect(text).toContain('OAuth2');
    expect(text).toContain('45s');
  });

  test('a vault file that does not parse, and a security.yaml with no firewalls', async () => {
    const app = appWith('jwt-empty', {
      'config/packages/lexik_jwt_authentication.yaml': '\n',
      'config/packages/lexik_jwt_authentication.yml': `lexik_jwt_authentication:
    token_ttl: 604800
`,
      'config/packages/security.yaml': `security:
    providers:
        app_user_provider:
            entity:
                class: App\\Entity\\User
`,
    });

    const text = await runModule('jwt-auth.js', app);

    expect(text).toContain('7d');
  });

  test('an application with no authentication configuration at all', async () => {
    const app = appWith('jwt-none', {
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
`,
    });

    const text = await runModule('jwt-auth.js', app);

    expect(text).toContain('No JWT or OAuth2 configuration found');
  });

  test('token lifetimes in minutes and in hours', async () => {
    const app = appWith('jwt-ttl', {
      'config/packages/lexik_jwt_authentication.yaml': `lexik_jwt_authentication:
    token_ttl: 900
    refresh_token_ttl: 7200
    algorithm: HS256
`,
    });

    const text = await runModule('jwt-auth.js', app);

    expect(text).toContain('15min');
    expect(text).toContain('2h');
  });
});

describe('contract testing', () => {
  test('an application that calls out over http with no contract tests', async () => {
    const app = appWith('contract-testing', {
      'src/Service/CatalogueClient.php': `<?php

namespace App\\Service;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class CatalogueClient
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function fetch(string $sku): array
    {
        return $this->client->request('GET', '/catalogue/' . $sku)->toArray();
    }
}
`,
    });

    const withPacts = appWith('contract-testing-pacts', {
      'pacts/acme-catalogue.json': JSON.stringify({ consumer: { name: 'acme' }, provider: { name: 'catalogue' } }, null, 2),
      'src/Service/CatalogueClient.php': `<?php

namespace App\\Service;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class CatalogueClient
{
    public function __construct(private HttpClientInterface $client)
    {
    }
}
`,
    });

    const full = appWith('contract-testing-full', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'pact-foundation/pact-php': '^9.0' },
      }, null, 2),
      'tests/Contract/CatalogueConsumerTest.php': `<?php

namespace App\\Tests\\Contract;

use PhpPact\\Consumer\\ConsumerPactBuilder;
use PHPUnit\\Framework\\TestCase;

class CatalogueConsumerTest extends TestCase
{
    public function testItFetchesAProduct(): void
    {
        $builder = new ConsumerPactBuilder($this->config);
        $builder->newInteraction();
    }
}
`,
      'tests/Contract/CatalogueProviderTest.php': `<?php

namespace App\\Tests\\Contract;

use PhpPact\\Standalone\\ProviderVerifier\\ProviderVerifier;
use PHPUnit\\Framework\\TestCase;

class CatalogueProviderTest extends TestCase
{
    public function testItHonoursTheContract(): void
    {
        $verifier = new ProviderVerifier($this->config);
        $verifier->verify();
    }
}
`,
      'tests/Contract/MockServerTest.php': `<?php

namespace App\\Tests\\Contract;

use PhpPact\\Standalone\\MockService\\MockServer;
use PHPUnit\\Framework\\TestCase;

class MockServerTest extends TestCase
{
    public function testTheMockServerStarts(): void
    {
        $server = new MockServer($this->config);
        $server->start();
    }
}
`,
      '.github/workflows/contract.yml': `name: contract
on: [push]
jobs:
    verify:
        runs-on: ubuntu-latest
        env:
            PACT_BROKER_URL: https://pact.example.com
        steps:
            - run: vendor/bin/phpunit --testsuite contract
`,
    });

    const text = await runModule('api-contract-testing.js', app);
    const pacts = await runModule('api-contract-testing.js', withPacts);
    const fullText = await runModule('api-contract-testing.js', full);

    expect(text).toContain('contract testing');
    expect(pacts).toContain('pact');
    expect(fullText).toContain('ProviderVerifier');
  });
});

describe('helm charts', () => {
  test('a chart with dependencies and values, nested below the search root', async () => {
    const app = appWith('helm', {
      'helm/acme/Chart.yaml': `apiVersion: v2
name: acme
version: 1.4.2
appVersion: "7.0.3"
dependencies:
    - name: postgresql
      version: 13.2.0
      repository: https://charts.bitnami.com/bitnami
    - name: redis
      version: 18.1.0
      repository: https://charts.bitnami.com/bitnami
description: The acme application
`,
      'helm/acme/values.yaml': `replicaCount: 1
image:
    repository: registry.example.com/acme
    tag: latest
resources:
    limits:
        cpu: 500m
        memory: 512Mi
readinessProbe:
    httpGet:
        path: /health
        port: http
livenessProbe:
    httpGet:
        path: /health
        port: http
`,
      'k8s/overlays/production/acme/Chart.yaml': `apiVersion: v2
name: acme-prod
version: 2.0.0
appVersion: "7.0.3"
`,
      'k8s/overlays/production/acme/values.yaml': `image:
    tag: "1.4.2"
resources:
    limits:
        cpu: 500m
`,
      'Chart.yaml': `apiVersion: v2
name: root-chart
version: 0.1.0
`,
      'values.yaml': `image:
    tag: stable
`,
    });
    // A symlink where a chart directory would be, and a chart deeper than the
    // walk goes.
    fs.mkdirSync(path.join(app, 'charts-target'), { recursive: true });
    try { fs.symlinkSync(path.join(app, 'charts-target'), path.join(app, 'charts')); } catch { /* not supported */ }
    // A dangling link the walk must step over, and a chart whose Chart.yaml
    // cannot be read.
    try { fs.symlinkSync(path.join(app, 'helm', 'nowhere'), path.join(app, 'helm', 'dangling')); } catch { /* not supported */ }
    fs.mkdirSync(path.join(app, 'helm', 'unreadable'), { recursive: true });
    fs.mkdirSync(path.join(app, 'helm', 'unreadable', 'Chart.yaml'), { recursive: true });
    const deep = path.join(app, 'helm', 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'Chart.yaml'), 'apiVersion: v2\nname: too-deep\nversion: 0.0.1\n');

    const text = await runModule('helm-charts-config.js', app);

    expect(text).toContain('acme');
    expect(text).toContain('postgresql');
    expect(text).not.toContain('too-deep');
  });
});

describe('azure pipelines', () => {
  test('a pipeline with stages, a plain-text secret and a job with no timeout', async () => {
    const app = appWith('azure-stages', {
      'azure-pipelines.yml': `trigger:
    - main

variables:
    DB_PASSWORD: hunter2-in-the-yaml
    BUILD_CONFIGURATION: release
    - group: production-secrets

stages:
    - stage: build
      jobs:
          - job: compile
            steps:
                - script: composer install --no-dev
                - script: export API_TOKEN=abcdef0123456789 && bin/deploy
          - job: test
            timeoutInMinutes: 30
            steps:
                - script: vendor/bin/phpunit
    - stage: notify
      displayName: Notify the team
`,
    });

    const text = await runModule('azure-pipelines-config.js', app);

    expect(text).toContain('DB_PASSWORD');
  });

  test('a flat pipeline of jobs, and one that is only steps', async () => {
    const jobs = appWith('azure-flat', {
      'azure-pipelines.yml': `trigger:
    branches:
        include:
            - main

pool:
    vmImage: ubuntu-latest

jobs:
    - job: build
      steps:
          - script: composer install
    - job: deploy
      timeoutInMinutes: 20
      steps:
          - script: bin/deploy
`,
    });
    const steps = appWith('azure-steps', {
      'azure-pipelines.yaml': `trigger:
    branches:
        include:
            - main

steps:
    - script: composer install
    - script: vendor/bin/phpunit
`,
    });

    const one = await runModule('azure-pipelines-config.js', jobs);
    const two = await runModule('azure-pipelines-config.js', steps);

    expect(one).toContain('build');
    expect(two).toContain('timeoutInMinutes');
  });
});

describe('cloudflare', () => {
  test('a worker whose compatibility date is old, with secrets in vars', async () => {
    const app = appWith('cloudflare-toml', {
      'wrangler.toml': `name = "acme-worker"
main = "src/index.js"
compatibility_date = "2021-05-10"

[vars]
API_TOKEN = "abcdef0123456789"
PUBLIC_URL = "https://example.com"

[[kv_namespaces]]
binding = "SESSIONS"
id = "0123456789abcdef"
`,
      '.dev.vars': `API_TOKEN=abcdef0123456789
PUBLIC_URL=https://example.com
`,
    });

    const text = await runModule('cloudflare-config.js', app);

    expect(text).toContain('compatibility_date');
    expect(text).toContain('API_TOKEN');
  });

  test('a pages project, a wrangler.json and one that does not parse', async () => {
    const pages = appWith('cloudflare-pages', {
      'wrangler.toml': `name = "acme-site"
pages_build_output_dir = "public"
compatibility_date = "2026-01-15"
`,
    });
    const json = appWith('cloudflare-json', {
      'wrangler.json': JSON.stringify({
        name: 'acme-worker',
        compatibility_date: '2021-06-01',
        vars: { API_SECRET: 'shhh', PUBLIC_URL: 'https://example.com' },
      }, null, 2),
    });
    const broken = appWith('cloudflare-broken', { 'wrangler.json': '{ nope\n' });

    const one = await runModule('cloudflare-config.js', pages);
    const two = await runModule('cloudflare-config.js', json);
    const three = await runModule('cloudflare-config.js', broken);

    expect(one).toContain('pages');
    expect(two).toContain('API_SECRET');
    expect(three).toContain('not valid JSON');
  });
});

describe('sessions', () => {
  test('a session configured in the least safe way', async () => {
    const app = appWith('session-unsafe', {
      'config/packages/framework.yaml': `framework:
    session:
        enabled: true
        handler_id: session.handler.native_file
        name: ACMESESSID
        save_path: 'redis://app:s3cret@cache:6379'
        cookie_secure: false
        cookie_httponly: false
        cookie_samesite: none
        cookie_lifetime: 0
        cookie_domain: .example.com
        gc_maxlifetime: 259200
`,
    });

    const text = await runModule('session-config.js', app);

    expect(text).toContain('cookie_secure');
    expect(text).not.toContain('s3cret');
  });

  test('each session handler the tool knows', async () => {
    const handlers = [
      ['memcached', 'session.handler.memcached'],
      ['pdo', 'session.handler.pdo'],
      ['filesystem', 'session.handler.filesystem'],
      ['null', 'session.handler.null'],
      ['redis', 'snc_redis.session.handler'],
    ];

    for (const [name, handlerId] of handlers) {
      const app = appWith(`session-${name}`, {
        'config/packages/framework.yaml': `framework:
    session:
        enabled: true
        handler_id: ${handlerId}
        cookie_secure: true
        cookie_httponly: true
        cookie_samesite: lax
        gc_maxlifetime: 1440
`,
      });

      const text = await runModule('session-config.js', app);

      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('asset mapper', () => {
  test('an importmap with cdn entries, css and no integrity', async () => {
    const entries = Array.from({ length: 110 }, (_, i) => `    'pkg-${i}' => ['path' => 'vendor/pkg-${i}/index.js'],`).join('\n');
    const app = appWith('asset-mapper', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/asset-mapper': '^7.0' },
      }, null, 2),
      'assets/importmap.php': `<?php

return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
    'bootstrap' => ['url' => 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.min.js'],
    'bootstrap/css' => ['url' => 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'],
${entries}
];
`,
      'config/packages/asset_mapper.yaml': `framework:
    asset_mapper:
        paths:
            - assets/
            - vendor/acme/ui/assets/
        missing_import_mode: strict
`,
    });

    const text = await runModule('symfony-asset-mapper-ext.js', app);

    expect(text).toContain('integrity');
  });

  test('a single asset path written as a scalar', async () => {
    const app = appWith('asset-mapper-scalar', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/asset-mapper': '^7.0' },
      }, null, 2),
      'assets/importmap.php': `<?php

return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
];
`,
      'config/packages/framework.yaml': `framework:
    asset_mapper:
        paths: assets/
        missing_import_mode: warn
`,
    });

    const text = await runModule('symfony-asset-mapper-ext.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('cache pools', () => {
  test('pruneable pools with nothing scheduled to prune them', async () => {
    const app = appWith('cache-prune', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.filesystem
        pools:
            cache.files:
                adapter: cache.adapter.filesystem
                directory: '%kernel.cache_dir%/pools'
            cache.more_files:
                adapter: cache.adapter.filesystem
                directory: '%kernel.cache_dir%/pools'
            cache.database:
                adapter: cache.adapter.pdo
            cache.orm:
                adapter: cache.adapter.doctrine_dbal
            cache.local:
                adapter: cache.adapter.apcu
            cache.memory:
                adapter: cache.adapter.array
`,
      'src/Cache/WarmablePool.php': `<?php

namespace App\\Cache;

use Symfony\\Component\\Cache\\PruneableInterface;

class WarmablePool implements PruneableInterface
{
    public function prune(): bool
    {
        return true;
    }
}
`,
    });
    fs.mkdirSync(path.join(app, 'etc', 'cron.d'), { recursive: true });
    fs.writeFileSync(path.join(app, 'etc', 'cron.d', 'acme'), '# nothing scheduled here\n');

    const text = await runModule('symfony-cache-pool-prune.js', app);

    expect(text).toContain('cache.files');
    expect(text).toContain('shares directory');
  });

  test('an application that does schedule the prune', async () => {
    const app = appWith('cache-prune-scheduled', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.filesystem
        pools:
            cache.files:
                adapter: cache.adapter.filesystem
`,
      'crontab': `0 3 * * * php /srv/app/bin/console cache:pool:prune\n`,
    });

    const text = await runModule('symfony-cache-pool-prune.js', app);

    expect(text).toContain('cache.files');
  });
});

describe('column charsets', () => {
  test('columns in utf8 and latin1, with and without a collation', async () => {
    const app = appWith('column-charset', {
      'src/Entity/Comment.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'comment')]
class Comment
{
    #[ORM\\Column(type: 'string', length: 255, options: ['charset' => 'utf8', 'collation' => 'utf8_general_ci'])]
    private string $title = '';

    #[ORM\\Column(type: 'text', options: ['charset' => 'latin1'])]
    private string $body = '';

    #[ORM\\Column(type: 'string', length: 64, options: ['charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci'])]
    private string $author = '';

    #[ORM\\Column(type: 'string', length: 32)]
    private string $status = '';
}
`,
    });

    const annotated = appWith('column-charset-annotations', {
      'src/Entity/LegacyPost.php': `<?php

namespace App\\Entity;

/**
 * @ORM\\Entity
 * @ORM\\Table(name="legacy_post")
 */
class LegacyPost
{
    /**
     * @ORM\\Column(type="string", length=255, options={"charset":"utf8"})
     */
    private $title;

    /**
     * @ORM\\Column(type="text", options={"charset":"latin1"})
     */
    private $body;

    /**
     * @ORM\\Column(type="string", length=64, options={"charset":"utf8mb4","collation":"utf8mb4_unicode_ci"})
     */
    private $author;
}
`,
    });

    const text = await runModule('doctrine-column-charset.js', app);
    const annotatedText = await runModule('doctrine-column-charset.js', annotated);

    expect(text).toContain('Comment');
    expect(annotatedText).toContain('LegacyPost');
    expect(text).toContain('utf8mb4');
  });
});
