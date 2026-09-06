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

describe('container compilation', () => {
  test('a kernel that overrides its directories, and environments set the wrong way round', async () => {
    const app = appWith('container-compile', {
      'config/services.yaml': `services:
    _defaults:
        autowire: true
        autoconfigure: true

    _instanceof:
        App\\Handler\\HandlerInterface:
            tags: ['app.handler']
        App\\Voter\\VoterInterface:
            tags: ['security.voter']
        App\\Command\\CommandInterface:
            tags: ['console.command']

    App\\:
        resource: '../src/'

    App\\Service\\HeavyService:
        lazy: true

    App\\Service\\OtherHeavyService:
        lazy: true
`,
      'src/Kernel.php': `<?php

namespace App;

use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    public function getCacheDir(): string
    {
        return dirname(__DIR__) . '/var/cache/' . $this->environment;
    }

    public function getBuildDir(): string
    {
        return dirname(__DIR__) . '/var/build/' . $this->environment;
    }

    public function getLogDir(): string
    {
        return dirname(__DIR__) . '/var/log';
    }
}
`,
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
    build_dir: '%kernel.project_dir%/var/build'
    cache:
        system_clearer: false
        cache_clearer: false
`,
      '.env.prod': `APP_ENV=dev
APP_DEBUG=true
`,
      '.env.dev': `APP_ENV=prod
APP_DEBUG=1
`,
      'var/cache/prod/container.php': `<?php\n\n// compiled container\n`,
      'var/cache/dev/container.php': `<?php\n\n// compiled container\n`,
    });

    const text = await runModule('symfony-container-compile.js', app);

    expect(text).toContain('getCacheDir');
    expect(text).toContain('APP_DEBUG');
  });
});

describe('profiler storage', () => {
  test('every storage backend the profiler understands', async () => {
    const dsns = [
      ['file', 'file://%kernel.cache_dir%/profiler'],
      ['tmp', 'file:///tmp/profiler'],
      ['redis', 'redis://cache:6379'],
      ['elasticsearch', 'elasticsearch://search:9200/profiler'],
      ['mongodb', 'mongodb://mongo:27017/profiler'],
      ['custom', 'acme://storage'],
    ];

    for (const [name, dsn] of dsns) {
      const app = appWith(`profiler-${name}`, {
        'config/packages/framework.yaml': `framework:
    profiler:
        enabled: true
        dsn: '${dsn}'
        collect: true
        only_main_requests: true
`,
        'config/packages/prod/web_profiler.yaml': `web_profiler:
    toolbar: true

framework:
    profiler:
        enabled: true
        dsn: '${dsn}'
`,
      });

      const text = await runModule('symfony-profiler-storage.js', app);

      expect(text.length).toBeGreaterThan(0);
    }
  });

  test('a profiler that is off everywhere', async () => {
    const app = appWith('profiler-off', {
      'config/packages/framework.yaml': `framework:
    profiler:
        enabled: false
        collect: false
`,
    });

    const text = await runModule('symfony-profiler-storage.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('algolia', () => {
  test('an admin key in .env, an index with no faceting and a client with no search key', async () => {
    const app = appWith('algolia', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'algolia/search-bundle': '^4.0' },
      }, null, 2),
      '.env': `ALGOLIA_APP_ID=ACMEAPPID
ALGOLIA_API_KEY=0123456789abcdef0123456789abcdef
`,
      'config/packages/algolia_search.yaml': `algolia_search:
    prefix: 'acme_'
    indices:
        - name: products
          class: App\\Entity\\Product
`,
      'src/Search/ProductSearch.php': `<?php

namespace App\\Search;

use Algolia\\AlgoliaSearch\\SearchClient;

class ProductSearch
{
    public function client(): SearchClient
    {
        return SearchClient::create($_ENV['ALGOLIA_APP_ID'], $_ENV['ALGOLIA_API_KEY']);
    }
}
`,
    });

    const text = await runModule('algolia-integration.js', app);

    expect(text).toContain('ALGOLIA');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef');
  });
});

describe('controllers', () => {
  test('a controller asked for by name, and one with no actions', async () => {
    const app = appWith('controllers', {
      'src/Controller/BlogController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class BlogController extends AbstractController
{
    #[Route('/blog', name: 'blog_index', methods: ['GET'])]
    public function index(): Response
    {
        return $this->render('blog/index.html.twig');
    }

    #[Route('/blog/{slug}', name: 'blog_show', methods: ['GET', 'HEAD'])]
    public function show(string $slug): Response
    {
        return $this->render('blog/show.html.twig');
    }

    public function getTitle(): string
    {
        return 'blog';
    }

    public function __toString(): string
    {
        return 'blog';
    }

    public static function getSubscribedEvents(): array
    {
        return [];
    }
}
`,
      'src/Controller/EmptyController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;

class EmptyController extends AbstractController
{
    private function helper(): string
    {
        return 'nothing public here';
    }
}
`,
    });

    const text = await runModule('controllers.js', app, ['BlogController', 'EmptyController', 'NotAController']);

    expect(text).toContain('blog_index');
    expect(text).toContain('No public action methods found');
  });
});

describe('association fetch modes', () => {
  test('eager collections and extra_lazy singles, in attributes, annotations and xml', async () => {
    const app = appWith('association-fetch', {
      'src/Entity/Order.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Order
{
    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'order', fetch: 'EAGER')]
    private $lines;

    #[ORM\\ManyToOne(targetEntity: Customer::class, fetch: 'EXTRA_LAZY')]
    private $customer;

    #[ORM\\ManyToMany(targetEntity: Tag::class, fetch: 'EAGER')]
    private $tags;

    #[ORM\\OneToOne(targetEntity: Invoice::class, fetch: 'LAZY')]
    private $invoice;
}
`,
      'src/Entity/LegacyOrder.php': `<?php

namespace App\\Entity;

/**
 * @ORM\\Entity
 */
class LegacyOrder
{
    /**
     * @ORM\\OneToMany(targetEntity="Line", mappedBy="order", fetch="EAGER")
     */
    private $lines;

    /**
     * @ORM\\ManyToOne(targetEntity="Customer", fetch="EXTRA_LAZY")
     */
    private $customer;
}
`,
      'config/doctrine/Order.orm.xml': `<?xml version="1.0" encoding="utf-8"?>
<doctrine-mapping xmlns="http://doctrine-project.org/schemas/orm/doctrine-mapping">
    <entity name="App\\Entity\\XmlOrder" table="xml_order">
        <one-to-many field="lines" target-entity="Line" mapped-by="order" fetch="EAGER"/>
        <many-to-one field="customer" target-entity="Customer" fetch="EXTRA_LAZY"/>
    </entity>
</doctrine-mapping>
`,
    });

    const text = await runModule('doctrine-association-fetch.js', app);

    expect(text).toContain('EAGER');
    expect(text).toContain('EXTRA_LAZY');
  });
});

describe('migrations', () => {
  test('a destructive migration, a large one and one that cannot be rolled back', async () => {
    const statements = Array.from({ length: 40 }, (_, i) => `        $this->addSql('CREATE INDEX idx_${i} ON product (col_${i})');`).join('\n');
    const app = appWith('migrations', {
      'migrations/Version20260101000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Drop the legacy tables';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP TABLE legacy_order');
        $this->addSql('ALTER TABLE product DROP COLUMN old_price');
        $this->addSql('TRUNCATE TABLE session');
    }
}
`,
      'migrations/Version20260202000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260202000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
${statements}
    }

    public function down(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }
}
`,
    });

    const text = await runModule('migrations-analysis.js', app);

    expect(text).toContain('DROP TABLE');
    expect(text).toContain('Version20260202000000');
  });

  test('migrations that only add things', async () => {
    const app = appWith('migrations-safe', {
      'migrations/Version20260303000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260303000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE tag (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE tag');
    }
}
`,
    });

    const text = await runModule('migrations-analysis.js', app);

    expect(text).toContain('No destructive operations detected');
  });
});

describe('new relic', () => {
  test('an agent turned off in production, recording raw sql and sending a password', async () => {
    const app = appWith('newrelic', {
      'docker/php/newrelic.ini': `extension = newrelic.so

newrelic.license = ""
newrelic.appname = "Acme (production)"
newrelic.enabled = false
newrelic.transaction_tracer.record_sql = raw
newrelic.distributed_tracing_enabled = false
newrelic.loglevel = info
`,
      'conf.d/90-newrelic.ini': `newrelic.license = "0123456789abcdef0123456789abcdef01234567"
newrelic.enabled = true
newrelic.transaction_tracer.record_sql = obfuscated
newrelic.distributed_tracing_enabled = true
`,
      'conf.d/10-opcache.ini': `opcache.enable = 1
`,
      'src/Service/Telemetry.php': `<?php

namespace App\\Service;

class Telemetry
{
    public function record(string $user, string $password): void
    {
        newrelic_start_transaction('acme');
        newrelic_name_transaction('checkout');
        newrelic_add_custom_parameter('password', $password);
        newrelic_add_custom_parameter('order_id', 42);
        newrelic_record_custom_event('Checkout', ['user' => $user]);
    }
}
`,
    });

    const text = await runModule('newrelic-php-agent.js', app);

    expect(text).toContain('record_sql');
    expect(text).toContain('newrelic.enabled');
  });
});

describe('csv parsing', () => {
  test('fgetcsv with no comment, str_getcsv on a line read by hand, and a reader with no header offset', async () => {
    const app = appWith('csv-parsing', {
      'src/Import/ProductImporter.php': `<?php

namespace App\\Import;

class ProductImporter
{
    public function import(string $file): array
    {
        $rows = [];
        $handle = fopen($file, 'r');
        while (($row = fgetcsv($handle)) !== false) {
            $rows[] = $row;
        }
        fclose($handle);

        return $rows;
    }

    public function semicolons(string $file): array
    {
        $rows = [];
        $handle = fopen($file, 'r');
        while (($row = fgetcsv($handle, 1000, ';')) !== false) {
            $rows[] = $row;
        }
        fclose($handle);

        return $rows;
    }

    public function byHand(string $file): array
    {
        $rows = [];
        $handle = fopen($file, 'r');
        while (($line = fgets($handle)) !== false) {
            $rows[] = explode(',', $line);
        }
        fclose($handle);

        return $rows;
    }

    public function wholeFile(string $file): array
    {
        $contents = file_get_contents($file);
        $rows = [];
        foreach (explode("\\n", $contents) as $row) {
            $rows[] = str_getcsv($row);
        }

        return $rows;
    }

    public function splitRow(string $row): array
    {
        return explode(',', $row);
    }
}
`,
      'src/Import/BareLeagueImporter.php': `<?php

namespace App\\Import;

use League\\Csv\\Reader;

class BareLeagueImporter
{
    public function bare(string $file): iterable
    {
        $reader = Reader::createFromPath($file, 'r');

        return $reader->getRecords();
    }
}
`,
      'src/Import/LeagueImporter.php': `<?php

namespace App\\Import;

use League\\Csv\\Reader;

class LeagueImporter
{
    public function complete(string $file): iterable
    {
        $reader = Reader::createFromPath($file, 'r');
        $reader->setHeaderOffset(0);
        $reader->setCharset('UTF-8');

        return $reader->getRecords();
    }
}
`,
    });

    const text = await runModule('php-csv-parsing.js', app);

    expect(text).toContain('ProductImporter');
  });
});

describe('phpbench', () => {
  test('phpbench installed with no configuration, and a configuration with runners', async () => {
    const bare = appWith('phpbench-bare', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpbench/phpbench': '^1.2' },
      }, null, 2),
      'src/Benchmark/RoutingBench.php': `<?php

namespace App\\Benchmark;

class RoutingBench
{
    public function benchMatch(): void
    {
    }
}
`,
    });
    const configured = appWith('phpbench-configured', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpbench/phpbench': '^1.2' },
      }, null, 2),
      'phpbench.xml': `<?xml version="1.0"?>
<phpbench bootstrap="vendor/autoload.php">
    <executor name="microtime" iterations="5" revolutions="100"/>
    <executor name="xdebug"/>
    <path>benchmarks</path>
</phpbench>
`,
      'benchmarks/RoutingBench.php': `<?php

namespace App\\Benchmark;

class RoutingBench
{
    public function benchMatch(): void
    {
    }
}
`,
    });

    const one = await runModule('phpbench-config.js', bare);
    const two = await runModule('phpbench-config.js', configured);

    expect(one).toContain('PHPBench');
    expect(two).toContain('microtime');
  });
});

describe('http cache store', () => {
  test('a default store in the temp directory, and one with a shared path', async () => {
    const app = appWith('http-cache-store', {
      'src/CacheKernel.php': `<?php

namespace App;

use Symfony\\Component\\HttpKernel\\HttpCache\\HttpCache;
use Symfony\\Component\\HttpKernel\\HttpCache\\Store;

class CacheKernel extends HttpCache
{
    protected function createStore(): Store
    {
        return new Store(sys_get_temp_dir() . '/http_cache');
    }
}
`,
      'src/SharedCacheKernel.php': `<?php

namespace App;

use Symfony\\Component\\HttpKernel\\HttpCache\\HttpCache;
use App\\Cache\\RedisStore;

class SharedCacheKernel extends HttpCache
{
    protected function createStore(): RedisStore
    {
        return new RedisStore('redis://cache:6379/http');
    }
}
`,
      'src/CacheFactory.php': `<?php

namespace App;

use Symfony\\Component\\HttpKernel\\HttpCache\\HttpCache;
use Symfony\\Component\\HttpKernel\\HttpCache\\Store;

class CacheFactory
{
    public function build($kernel): HttpCache
    {
        return new HttpCache(
            $kernel,
            new Store(sys_get_temp_dir() . '/http_cache'),
        );
    }

    public function buildShared($kernel): HttpCache
    {
        return new HttpCache(
            $kernel,
            new \\App\\Cache\\RedisStore('redis://cache:6379/http'),
        );
    }
}
`,
      'config/packages/framework.yaml': `framework:
    http_cache:
        enabled: true
        store_options:
            private_headers: ['Authorization', 'Cookie']
            allow_reload: true
`,
    });

    const text = await runModule('symfony-http-cache-store.js', app);

    expect(text).toContain('Store');
  });
});

describe('twig templates', () => {
  test('a template that extends, includes, embeds, uses and defines macros', async () => {
    const files: Record<string, string> = {
      'templates/base.html.twig': `<!doctype html>
<html>
    <body>
        {% block body %}{% endblock %}
    </body>
</html>
`,
      'templates/blog/show.html.twig': `{% extends 'base.html.twig' %}
{% use 'blocks/sidebar.html.twig' %}
{% import 'macros/forms.html.twig' as forms %}

{% block body %}
    {% include 'blog/_meta.html.twig' %}
    {% embed 'blocks/card.html.twig' %}
        {% block title %}{{ post.title }}{% endblock %}
    {% endembed %}
    {{ forms.field('title') }}
{% endblock %}
`,
      'templates/macros/forms.html.twig': `{% macro field(name) %}
    <input name="{{ name }}">
{% endmacro %}

{% macro label(name) %}
    <label>{{ name }}</label>
{% endmacro %}
`,
      'templates/blog/_meta.html.twig': `<p>{{ post.publishedAt|date('Y-m-d') }}</p>
`,
      'templates/blocks/card.html.twig': `<div class="card">{% block title %}{% endblock %}</div>
`,
      'templates/blocks/sidebar.html.twig': `{% block sidebar %}{% endblock %}
`,
    };
    // Enough standalone templates that the list has to be cut short.
    for (let i = 0; i < 14; i++) {
      files[`templates/standalone/page-${i}.html.twig`] = `<p>page ${i}</p>\n`;
    }
    const app = appWith('twig-templates', files);

    const text = await runModule('twig.js', app, ['blog/show.html.twig', 'macros/forms.html.twig']);

    expect(text).toContain('Extends');
    expect(text).toContain('Macros');
  });
});

describe('aws secrets manager', () => {
  test('a secret read with no version stage and decoded without a guard', async () => {
    const app = appWith('aws-secrets', {
      'src/Secrets/SecretsReader.php': `<?php

namespace App\\Secrets;

use Aws\\SecretsManager\\SecretsManagerClient;

class SecretsReader
{
    public function __construct(private SecretsManagerClient $client)
    {
    }

    public function read(string $id): array
    {
        $result = $this->client->getSecretValue([
            'SecretId' => $id,
        ]);

        $decoded = json_decode($result['SecretString'], true);

        return $decoded;
    }

    public function readGuarded(string $id): array
    {
        try {
            $result = $this->client->getSecretValue([
                'SecretId' => $id,
                'VersionStage' => 'AWSCURRENT',
            ]);

            return json_decode($result['SecretString'], true);
        } catch (\\Throwable $e) {
            return [];
        }
    }
}
`,
      'config/packages/aws.yaml': `aws:
    version: latest
    region: eu-west-1
    SecretsManager:
        version: '2017-10-17'
`,
    });

    const text = await runModule('aws-secrets-manager.js', app);

    expect(text).toContain('SecretsReader');
  });
});

describe('circleci', () => {
  test('a deploy job with no pinned image, no cache, no parallelism and a secret in a command', async () => {
    const app = appWith('circleci', {
      '.circleci/config.yml': `version: 2.1

jobs:
    build:
        docker:
            - image: cimg/php:8.3
        steps:
            - checkout
            - restore_cache:
                  keys:
                      - composer-{{ checksum "composer.lock" }}
            - run:
                  name: Install
                  command: composer install --no-dev --optimize-autoloader
            - save_cache:
                  key: composer-{{ checksum "composer.lock" }}
                  paths:
                      - vendor
            - run:
                  name: Test
                  command: vendor/bin/phpunit
        parallelism: 4

    deploy:
        docker:
            - image: cimg/php:latest
        steps:
            - checkout
            - run:
                  name: Install
                  command: composer install
            - run:
                  name: Push
                  command: curl -u acme:hunter2-password https://deploy.example.com/release

workflows:
    main:
        jobs:
            - build
            - deploy:
                  requires:
                      - build
`,
    });

    const text = await runModule('circleci-config.js', app);

    expect(text).toContain('deploy');
  });
});

describe('change tracking', () => {
  test('every change tracking policy, and the mix of two of them', async () => {
    const fields = Array.from({ length: 30 }, (_, i) => `    #[ORM\\Column]\n    private ?string $field${i} = null;`).join('\n\n');
    const app = appWith('change-tracking', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: true
        change_tracking_policy: DEFERRED_IMPLICIT
`,
      'src/Entity/WideEntity.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\ChangeTrackingPolicy('DEFERRED_IMPLICIT')]
class WideEntity
{
${fields}
}
`,
      'src/Entity/NotifyEntity.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\ChangeTrackingPolicy('NOTIFY')]
class NotifyEntity
{
    #[ORM\\Column]
    private ?string $name = null;

    public function setName(string $name): void
    {
        $this->name = $name;
    }
}
`,
      'src/Entity/NotifierEntity.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\NotifyPropertyChanged;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\ChangeTrackingPolicy('NOTIFY')]
class NotifierEntity implements NotifyPropertyChanged
{
    #[ORM\\Column]
    private ?string $name = null;

    public function setName(string $name): void
    {
        $this->name = $name;
    }
}
`,
      'src/Entity/ExplicitEntity.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\ChangeTrackingPolicy('DEFERRED_EXPLICIT')]
class ExplicitEntity
{
    #[ORM\\Column]
    private ?string $name = null;
}
`,
      'src/Entity/LegacyEntity.php': `<?php

namespace App\\Entity;

/**
 * @ORM\\Entity
 * @ORM\\ChangeTrackingPolicy("DEFERRED_IMPLICIT")
 */
class LegacyEntity
{
    /**
     * @ORM\\Column
     */
    private $name;
}
`,
    });

    const text = await runModule('doctrine-change-tracking.js', app);

    expect(text).toContain('NOTIFY');
    expect(text).toContain('DEFERRED_IMPLICIT');
  });
});

describe('read replicas', () => {
  test('a connection that names replicas but defines none, and one single host', async () => {
    const app = appWith('read-replica', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        default_connection: default
        connections:
            default:
                url: 'postgresql://app:pass@db.example.com:5432/acme'
            reporting:
                url: 'postgresql://app:pass@db.example.com:5432/acme'
                replicas: {}
            analytics:
                url: 'postgresql://app:pass@db.example.com:5432/acme'
                slaves:
                    replica_one:
                        host: replica-1.example.com
                    replica_two:
                        host: replica-2.example.com
                keep_slave: true
`,
    });

    const text = await runModule('doctrine-read-replica.js', app);
    const forced = appWith('read-replica-forced', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: 'postgresql://app:pass@db.example.com:5432/acme'
`,
      'src/Repository/ReportRepository.php': `<?php

namespace App\\Repository;

class ReportRepository
{
    public function build(): void
    {
        $qb = $this->createQueryBuilder('r');
        $this->getEntityManager()->getConnection()->getWrappedConnection();
    }
}
`,
      'src/Kernel.php': `<?php

namespace App;

class Kernel
{
}
`,
    });

    const forcedText = await runModule('doctrine-read-replica.js', forced);

    expect(text).toContain('reporting');
    expect(forcedText).toContain('forced master connection');
  });
});

describe('messenger', () => {
  test('a transport of every kind, routed, with a failure transport', async () => {
    const app = appWith('messenger-transports', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        failure_transport: failed
        default_bus: command.bus
        buses:
            command.bus: ~
            query.bus:
                default_middleware: false
        transports:
            async: '%env(MESSENGER_TRANSPORT_DSN)%'
            redis: 'redis://app:s3cret@cache:6379/messages'
            beanstalk: 'beanstalkd://queue:11300'
            kafka: 'kafka://broker:9092'
            memory: 'in-memory://'
            void: 'null://'
            amqp:
                dsn: 'amqp://guest:guest@rabbit:5672/%2f/messages'
                options:
                    auto_setup: false
            failed: 'doctrine://default?queue_name=failed'
        routing:
            'App\\Message\\SendInvoice': async
            'App\\Message\\RebuildIndex': [redis, kafka]
`,
      '.env': `MESSENGER_TRANSPORT_DSN=amqp://guest:guest@rabbit:5672/%2f/messages
`,
      'src/Message/SendInvoice.php': `<?php

namespace App\\Message;

final class SendInvoice
{
    public function __construct(public readonly int $invoiceId)
    {
    }
}
`,
      'src/MessageHandler/SendInvoiceHandler.php': `<?php

namespace App\\MessageHandler;

use App\\Message\\SendInvoice;
use Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;

#[AsMessageHandler]
final class SendInvoiceHandler
{
    public function __invoke(SendInvoice $message): void
    {
    }
}
`,
    });

    const text = await runModule('messenger.js', app, ['async', 'App\\Message\\SendInvoice']);

    expect(text).toContain('Redis');
    expect(text).not.toContain('s3cret');
  });
});

describe('object injection', () => {
  test('unserialize on every source of attacker-controlled data', async () => {
    const app = appWith('object-injection', {
      'src/Controller/LegacyController.php': `<?php

namespace App\\Controller;

class LegacyController
{
    public function fromCookie(): void
    {
        $data = unserialize($_COOKIE['prefs']);
    }

    public function fromBase64(): void
    {
        $data = unserialize(base64_decode($_GET['state']));
    }

    public function fromHeader(): void
    {
        $headers = getallheaders();
        $data = unserialize($headers['X-State']);
    }

    public function fromQuery(): void
    {
        $data = unserialize($_POST['payload']);
    }

    public function fromSession(): void
    {
        $data = unserialize($_SESSION['cart']);
    }

    public function igbinary(): void
    {
        $data = igbinary_unserialize($_GET['blob']);
    }

    public function msgpack(): void
    {
        $data = msgpack_unpack($_GET['blob']);
    }

    public function jsonObjects(): void
    {
        $payload = $_GET['payload'];
        $decoded = json_decode($payload, false);
        if ($decoded instanceof \\stdClass) {
            return;
        }
    }

    public function incomplete(): void
    {
        $data = unserialize('O:8:"Missing":0:{}');
        if ($data instanceof __PHP_Incomplete_Class) {
            return;
        }
    }
}
`,
    });

    const text = await runModule('php-object-injection.js', app);

    expect(text).toContain('unserialize');
  });
});

describe('prometheus alerting rules', () => {
  test('alerts with no duration, no severity, a lowercase name and deprecated functions', async () => {
    const app = appWith('prometheus', {
      'monitoring/acme.rules.yml': `groups:
    - name: acme
      rules:
          - alert: highErrorRate
            expr: count_values("code", http_requests_total) > 100
            annotations:
                summary: Too many errors

          - alert: SlowResponses
            expr: topk(http_request_duration_seconds) > 2
            for: 5m
            labels:
                severity: warning
            annotations:
                summary: Responses are slow
                description: The p99 is above two seconds

          - record: job:http_requests:rate5m
            expr: rate(http_requests_total[5m])
            labels:
                job: acme

          - record: job:http_errors:rate5m
            expr: rate(http_errors_total[5m])
`,
    });

    const text = await runModule('prometheus-alerting-rules.js', app);

    expect(text).toContain('highErrorRate');
  });
});
