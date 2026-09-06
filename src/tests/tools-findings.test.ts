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

describe('preload hints', () => {
  test('links of every kind in a template, and a preload built in php', async () => {
    const app = appWith('preload-hints', {
      'templates/base.html.twig': `<!doctype html>
<html>
    <head>
        <link rel="preload" href="/build/app.css" as="style">
        <link rel="preload" href="/build/app.js">
        <link rel="preload" href="/build/font.woff2" crossorigin>
        <link rel="prefetch" href="/build/hero.webp">
        <link rel="modulepreload" href="/build/module.mjs">
        <link rel="stylesheet" href="/build/other.css">
        <link rel="preload">
        {{ preload('/build/late.css', { as: 'style' }) }}
    </head>
    <body></body>
</html>
`,
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\WebLink\\Link;

class HomeController
{
    public function index(): void
    {
        $this->addLink(new Link('preload', '/build/app.js'));
    }
}
`,
    });

    const text = await runModule('symfony-asset-preload-hints.js', app);

    expect(text).toContain('app.css');
  });
});

describe('terraform', () => {
  test('providers, a hardcoded secret in a resource and one in a variable default', async () => {
    const app = appWith('terraform', {
      'terraform/main.tf': `terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

resource "aws_db_instance" "acme" {
  identifier = "acme"
  password   = "hunter2-in-the-state-file"
  username   = "acme"
}

variable "api_token" {
  type    = string
  default = "abcdef0123456789abcdef"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}
`,
      'root.tf': `resource "aws_s3_bucket" "assets" {
  bucket = "acme-assets"
}
`,
    });

    const text = await runModule('terraform-config.js', app);

    expect(text).toContain('aws');
    expect(text).not.toContain('hunter2-in-the-state-file');
  });
});

describe('caddy', () => {
  test('a Caddyfile with tls and a proxy without health checks, and a caddy.json', async () => {
    const app = appWith('caddy', {
      'Caddyfile': `acme.example.com {
    tls admin@example.com
    root * /srv/app/public
    php_fastcgi php:9000
    reverse_proxy /api/* backend:8080
    encode gzip
}
`,
      'caddy.json': JSON.stringify({
        apps: {
          http: {
            servers: {
              srv0: {
                listen: [':443'],
                routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'backend:8080' }] }] }],
              },
            },
          },
        },
      }, null, 2),
      'docker/Caddyfile': `:80 {
    root * /srv/app/public
    php_fastcgi php:9000
}
`,
      'docker/Caddyfile.dev': `:8080 {
    root * /srv/app/public
}
`,
    });

    const text = await runModule('caddy-server-config.js', app);

    expect(text).toContain('reverse_proxy');
  });

  test('a caddy.json that does not parse', async () => {
    const app = appWith('caddy-broken', { 'caddy.json': '{ nope\n' });

    const text = await runModule('caddy-server-config.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('ssrf', () => {
  test('requests built from user input, from a variable, and one with a filter check', async () => {
    const app = appWith('ssrf', {
      'src/Service/Fetcher.php': `<?php

namespace App\\Service;

class Fetcher
{
    public function fromUser(): void
    {
        $ch = curl_init($_GET['url']);
        curl_exec($ch);
    }

    public function optUser(): void
    {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $_POST['target']);
        curl_exec($ch);
    }

    public function optVariable(string $url): void
    {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_exec($ch);
    }

    public function optFiltered(string $url): void
    {
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return;
        }
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_exec($ch);
    }

    public function contentsFiltered(string $url): string
    {
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return '';
        }

        return file_get_contents($url);
    }

    public function contentsVariable(string $url): string
    {
        return file_get_contents($url);
    }
}
`,
    });

    const unchecked = appWith('ssrf-unchecked', {
      'src/Service/PlainFetcher.php': `<?php

namespace App\\Service;

class PlainFetcher
{
    public function init(string $url): void
    {
        $ch = curl_init($url);
        curl_exec($ch);
    }

    public function contents(string $url): string
    {
        return file_get_contents($url);
    }

    public function fromUser(): string
    {
        return file_get_contents($_GET['url']);
    }
}
`,
    });

    const text = await runModule('php-ssrf-patterns.js', app);
    const uncheckedText = await runModule('php-ssrf-patterns.js', unchecked);

    expect(text).toContain('curl');
    expect(uncheckedText).toContain('file_get_contents');
  });
});

describe('xsl', () => {
  test('a stylesheet that includes a path built from a variable', async () => {
    const app = appWith('xsl', {
      'templates/report.xsl': `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:include href="{$base}/common.xsl"/>
    <xsl:import href="header.xsl"/>

    <xsl:template match="/">
        <html><body><xsl:value-of select="report/title"/></body></html>
    </xsl:template>
</xsl:stylesheet>
`,
      'src/Report/Renderer.php': `<?php

namespace App\\Report;

class Renderer
{
    public function render(string $xml, string $xslPath): string
    {
        $xsl = new \\DOMDocument();
        $xsl->load($xslPath);

        $proc = new \\XSLTProcessor();
        $proc->registerPHPFunctions();
        $proc->importStylesheet($xsl);

        $doc = new \\DOMDocument();
        $doc->loadXML($xml);

        return $proc->transformToXml($doc);
    }
}
`,
    });

    const text = await runModule('php-xsl-transformation.js', app);

    expect(text).toContain('xsl');
  });
});

describe('asset packages', () => {
  test('every versioning strategy, a manifest that is not there and two packages on one path', async () => {
    const app = appWith('asset-packages', {
      'config/packages/framework.yaml': `framework:
    assets:
        version: 'v42'
        json_manifest_path: '%kernel.project_dir%/public/build/manifest.json'
        packages:
            static:
                base_path: /static
                version_strategy: 'Symfony\\Component\\Asset\\VersionStrategy\\JsonManifestVersionStrategy'
                json_manifest_path: '%kernel.project_dir%/public/build/missing.json'
            images:
                base_path: /static
                version: '%env(APP_VERSION)%'
            docs:
                base_path: /docs
                version: '1.0.0'
            cdn:
                base_urls: ['https://cdn.example.com']
                version_strategy: 'App\\Asset\\CustomVersionStrategy'
            empty: ~
`,
      'public/build/manifest.json': JSON.stringify({ 'app.js': '/build/app.123.js' }, null, 2),
    });

    const text = await runModule('symfony-asset-packages.js', app);

    expect(text).toContain('static');
  });
});

describe('lock resources', () => {
  test('every store a lock can use', async () => {
    const stores = [
      ['flock', 'flock'],
      ['semaphore', 'semaphore'],
      ['redis-cluster', 'redis+cluster://cache-1:6379,cache-2:6379'],
      ['redis-tls', 'rediss://cache:6379'],
      ['zookeeper', 'zookeeper://zk:2181'],
      ['postgresql', 'postgresql://app:pass@db:5432/acme'],
      ['mysql', 'mysql://app:pass@db:3306/acme'],
      ['combined', 'combined-lock:consensus'],
      ['service', '@app.lock.store'],
      ['unknown', 'acme://store'],
    ];

    for (const [name, store] of stores) {
      const app = appWith(`lock-${name}`, {
        'config/packages/lock.yaml': `framework:
    lock: '${store}'
`,
      });

      const text = await runModule('symfony-lock-resources.js', app);

      expect(text.length).toBeGreaterThan(0);
    }
  });

  test('named resources and a lock held for longer than five minutes', async () => {
    const app = appWith('lock-resources', {
      'config/packages/lock.yaml': `framework:
    lock:
        invoice: 'redis://cache:6379'
        report: 'flock'
`,
      'src/Service/InvoiceLocker.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Lock\\LockFactory;

class InvoiceLocker
{
    public function __construct(private LockFactory $factory)
    {
    }

    public function run(): void
    {
        $lock = $this->factory->createLock('invoice', 900);
        if ($lock->acquire()) {
            $lock->release();
        }
    }
}
`,
    });

    const text = await runModule('symfony-lock-resources.js', app);

    expect(text).toContain('invoice');
  });
});

describe('messenger routing table', () => {
  test('a routing entry whose transports are a list of their own lines', async () => {
    const app = appWith('routing-table', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: '%env(MESSENGER_TRANSPORT_DSN)%'
            failed: 'doctrine://default?queue_name=failed'
        routing:
            'App\\Message\\SendInvoice': async
            'App\\Message\\RebuildIndex':
                - async
                - failed
            'App\\Message\\*': async
`,
      'src/Message/SendInvoice.php': `<?php

namespace App\\Message;

final class SendInvoice
{
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

    const text = await runModule('symfony-messenger-routing-table.js', app);

    expect(text).toContain('RebuildIndex');
  });
});

describe('monolog handlers', () => {
  test('stdout in production, fingers crossed with no strategy, a group with duplicates and a short rotation', async () => {
    const app = appWith('monolog', {
      'config/packages/prod/monolog.yaml': `monolog:
    handlers:
        main:
            type: fingers_crossed
            handler: nested
            excluded_http_codes: [404, 405]
        nested:
            type: stream
            path: php://stdout
            level: debug
        grouped:
            type: group
            members: [nested, nested, sentry]
        rotating:
            type: rotating_file
            path: '%kernel.logs_dir%/%kernel.environment%.log'
            max_files: 3
        sentry:
            type: sentry
            level: error
`,
      'config/packages/dev/monolog.yaml': `monolog:
    handlers:
        main:
            type: stream
            path: '%kernel.logs_dir%/%kernel.environment%.log'
            level: debug
`,
    });

    const withPhp = appWith('monolog-php', {
      'src/Logger/AuditHandler.php': `<?php

namespace App\\Logger;

use Monolog\\Handler\\AbstractProcessingHandler;
use Monolog\\LogRecord;

class AuditHandler extends AbstractProcessingHandler
{
    protected function write(LogRecord $record): void
    {
    }

    public function isHandling(LogRecord $record): bool
    {
        return true;
    }
}
`,
      'src/Logger/SilentHandler.php': `<?php

namespace App\\Logger;

use Monolog\\Handler\\AbstractProcessingHandler;

class SilentHandler extends AbstractProcessingHandler
{
}
`,
      'src/Logger/PlainHandler.php': `<?php

namespace App\\Logger;

use Monolog\\Handler\\HandlerInterface;

class PlainHandler implements HandlerInterface
{
}
`,
      'src/Logger/BaseHandler.php': `<?php

namespace App\\Logger;

use Monolog\\Handler\\AbstractHandler;

class BaseHandler extends AbstractHandler
{
    public function isHandling($record): bool
    {
        return false;
    }
}
`,
    });

    const text = await runModule('symfony-monolog-handler.js', app);
    const phpText = await runModule('symfony-monolog-handler.js', withPhp);

    expect(phpText).toContain('AuditHandler');
    expect(text).toContain('fingers_crossed');
    expect(text).toContain('group');
  });
});

describe('fixtures', () => {
  test('fixtures in a cycle and one depending on something that is not there', async () => {
    const fixture = (name: string, deps: string[], groups: string[]): string => `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;
use Doctrine\\Bundle\\FixturesBundle\\FixtureGroupInterface;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class ${name} extends Fixture implements DependentFixtureInterface, FixtureGroupInterface
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }

    public function getDependencies(): array
    {
        return [${deps.map((d) => `${d}::class`).join(', ')}];
    }

    public static function getGroups(): array
    {
        return [${groups.map((g) => `'${g}'`).join(', ')}];
    }
}
`;

    const app = appWith('fixtures', {
      'src/DataFixtures/UserFixtures.php': fixture('UserFixtures', ['OrderFixtures'], ['dev']),
      'src/DataFixtures/OrderFixtures.php': fixture('OrderFixtures', ['UserFixtures'], ['dev', 'test']),
      'src/DataFixtures/ProductFixtures.php': fixture('ProductFixtures', ['MissingFixtures'], ['test']),
      'src/DataFixtures/TagFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class TagFixtures extends Fixture
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }
}
`,
    });

    const text = await runModule('database-fixture-groups.js', app);

    expect(text).toContain('Circular');
    expect(text).toContain('Missing');
  });
});

describe('schema manager', () => {
  test('schema work outside a migration, with and without a transaction', async () => {
    const app = appWith('schema-manager', {
      'src/Service/SchemaInstaller.php': `<?php

namespace App\\Service;

use Doctrine\\DBAL\\Connection;

class SchemaInstaller
{
    public function __construct(private Connection $connection)
    {
    }

    public function install(): void
    {
        $manager = $this->connection->createSchemaManager();
        $manager->createTable($this->tableDefinition());
        $manager->dropTable('legacy_order');
        $manager->introspectTable('product');
        $platform = $this->connection->getDatabasePlatform();
    }
}
`,
      'src/Service/TransactionalSchema.php': `<?php

namespace App\\Service;

use Doctrine\\DBAL\\Connection;

class TransactionalSchema
{
    public function __construct(private Connection $connection)
    {
    }

    public function install(): void
    {
        $this->connection->beginTransaction();
        $manager = $this->connection->createSchemaManager();
        $manager->createTable($this->tableDefinition());
        $this->connection->commit();
    }
}
`,
      'migrations/Version20260404000000.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260404000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $manager = $this->connection->createSchemaManager();
        $manager->createTable($this->tableDefinition());
    }
}
`,
    });

    const text = await runModule('doctrine-dbal-schema-manager.js', app);

    expect(text).toContain('SchemaInstaller');
  });
});

describe('file storage', () => {
  test('every adapter flysystem knows', async () => {
    const app = appWith('file-storage', {
      'config/packages/flysystem.yaml': `flysystem:
    storages:
        local.storage:
            adapter: 'local'
            options:
                directory: '%kernel.project_dir%/var/storage'
        s3.storage:
            adapter: 'aws'
            options:
                bucket: acme
        gcs.storage:
            adapter: 'google'
        azure.storage:
            adapter: 'azure'
        sftp.storage:
            adapter: 'sftp'
        ftp.storage:
            adapter: 'ftp'
        memory.storage:
            adapter: 'memory'
        readonly.storage:
            adapter: 'readonly'
        env.storage:
            adapter: '%env(STORAGE_ADAPTER)%'
        broken.storage: ~
`,
      'config/packages/vich_uploader.yaml': `vich_uploader:
    db_driver: orm
    mappings:
        product_image:
            uri_prefix: /images/products
            upload_destination: '%kernel.project_dir%/public/images/products'
        invoice_pdf: ~
`,
    });

    const uploadable = appWith('file-storage-entities', {
      'config/packages/vich_uploader.yaml': `vich_uploader:
    db_driver: orm
    mappings:
        product_image:
            uri_prefix: /images/products
            upload_destination: '%kernel.project_dir%/public/images/products'
`,
      'src/Entity/Product.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\HttpFoundation\\File\\File;
use Vich\\UploaderBundle\\Mapping\\Annotation as Vich;

#[Vich\\Uploadable]
class Product
{
    #[Vich\\UploadableField(mapping: 'product_image', fileNameProperty: 'imageName')]
    private ?File $imageFile = null;

    private ?string $imageName = null;
}
`,
      'src/Kernel.php': `<?php

namespace App;

class Kernel
{
}
`,
    });

    const text = await runModule('file-storage.js', app);
    const uploadableText = await runModule('file-storage.js', uploadable);

    expect(uploadableText).toContain('Product');
    expect(text).toContain('S3');
    expect(text).toContain('local');
  });
});

describe('nginx unit', () => {
  test('applications with threads and disabled functions, routes and http settings', async () => {
    const app = appWith('nginx-unit', {
      'docker/unit.json': JSON.stringify({
        listeners: { '*:80': { pass: 'routes/main' } },
        routes: {
          main: [
            { match: { uri: '/assets/*' }, action: { share: '/srv/app/public$uri' } },
            { action: { pass: 'applications/symfony' } },
          ],
        },
        applications: {
          symfony: {
            type: 'php',
            root: '/srv/app/public',
            script: 'index.php',
            processes: 4,
            threads: 32,
            options: {
              admin: {
                disable_functions: 'exec,passthru',
                memory_limit: '256M',
              },
            },
          },
        },
        settings: {
          http: {
            header_read_timeout: 30,
            body_read_timeout: 30,
          },
        },
      }, null, 2),
      'config/unit.json': '{ not json\n',
    });

    const text = await runModule('nginx-unit-config.js', app);

    expect(text).toContain('symfony');
  });
});

describe('oauth2 server', () => {
  test('token lifetimes given in hours, in seconds, and the grants a server enables', async () => {
    const composer = JSON.stringify({
      require: {
        'symfony/framework-bundle': '^7.0',
        'league/oauth2-server': '^8.5',
        'trikoder/oauth2-bundle': '^5.0',
      },
    }, null, 2);

    const app = appWith('oauth2-server', {
      'composer.json': composer,
      'src/Security/ServerFactory.php': `<?php

namespace App\\Security;

use DateInterval;
use League\\OAuth2\\Server\\AuthorizationServer;
use League\\OAuth2\\Server\\CryptKey;
use League\\OAuth2\\Server\\Grant\\AuthCodeGrant;
use League\\OAuth2\\Server\\Grant\\ClientCredentialsGrant;
use League\\OAuth2\\Server\\Grant\\ImplicitGrant;
use League\\OAuth2\\Server\\Grant\\PasswordGrant;
use League\\OAuth2\\Server\\Grant\\RefreshTokenGrant;

class ServerFactory
{
    public function build(): AuthorizationServer
    {
        $key = new CryptKey('/var/oauth/private.key');
        $server = new AuthorizationServer($this->clients, $this->tokens, $this->scopes, $key, 'encryption-key');

        $server->enableGrantType(new AuthCodeGrant($this->codes, $this->refresh, new DateInterval('PT10M')), new DateInterval('PT2H'));
        $server->enableGrantType(new ClientCredentialsGrant(), new DateInterval('PT1H'));
        $server->enableGrantType(new ImplicitGrant(new DateInterval('PT1H')));
        $server->enableGrantType(new PasswordGrant($this->users, $this->refresh));
        $server->enableGrantType(new RefreshTokenGrant($this->refresh));

        $server->setAccessTokenTTL(new DateInterval('PT2H'));
        $server->setRefreshTokenTTL(new DateInterval('P30D'));

        return $server;
    }
}
`,
      'src/Security/ShortLivedFactory.php': `<?php

namespace App\\Security;

use DateInterval;
use League\\OAuth2\\Server\\ResourceServer;

class ShortLivedFactory
{
    public function build(): ResourceServer
    {
        $server = new ResourceServer($this->tokens, $this->publicKey);
        $server->setAccessTokenTTL(new DateInterval('PT30S'));
        $server->setAccessTokenTTL(new DateInterval('PT15M'));

        return $server;
    }
}
`,
    });

    const text = await runModule('oauth2-server-config.js', app);

    expect(text).toContain('ImplicitGrant');
    expect(text).toContain('Access token TTL');
  });
});

describe('array find functions', () => {
  test('the php 8.4 array functions on a project that does not require 8.4', async () => {
    const app = appWith('array-find-old', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Service/Finder.php': `<?php

namespace App\\Service;

class Finder
{
    public function first(array $rows): mixed
    {
        return array_find($rows, static fn (array $row): bool => $row['active']);
    }

    public function firstKey(array $rows): mixed
    {
        return array_find_key($rows, static fn (array $row): bool => $row['active']);
    }

    public function any(array $rows): bool
    {
        return array_any($rows, static fn (array $row): bool => $row['active']);
    }

    public function all(array $rows): bool
    {
        return array_all($rows, static fn (array $row): bool => $row['active']);
    }

    public function byHand(array $rows): mixed
    {
        foreach ($rows as $row) {
            if ($row['active']) {
                return $row;
            }
        }

        return null;
    }
}
`,
    });
    const modern = appWith('array-find-new', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.4', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Service/Finder.php': `<?php

namespace App\\Service;

class Finder
{
    public function first(array $rows): mixed
    {
        return array_find($rows, static fn (array $row): bool => $row['active']);
    }
}
`,
    });

    const text = await runModule('php-array-find-functions.js', app);
    const modernText = await runModule('php-array-find-functions.js', modern);

    expect(text).toContain('array_find');
    expect(modernText).toContain('array_find');
  });
});

describe('phpunit configuration', () => {
  test('suites with excludes, coverage include and exclude, and minimum percentages', async () => {
    const app = appWith('phpunit-config', {
      'phpunit.xml': `<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         bootstrap="tests/bootstrap.php"
         colors="true"
         failOnWarning="true"
         failOnRisky="true">
    <testsuites>
        <testsuite name="unit">
            <directory>tests/Unit</directory>
            <exclude>tests/Unit/Legacy</exclude>
        </testsuite>
        <testsuite name="integration">
            <directory>tests/Integration</directory>
        </testsuite>
    </testsuites>

    <coverage>
        <include>
            <directory suffix=".php">src</directory>
        </include>
        <exclude>
            <directory suffix=".php">src/Kernel.php</directory>
            <directory suffix=".php">src/DataFixtures</directory>
        </exclude>
        <report>
            <text outputFile="php://stdout"/>
        </report>
    </coverage>

    <php>
        <env name="APP_ENV" value="test"/>
        <server name="KERNEL_CLASS" value="App\\Kernel"/>
    </php>

    <source>
        <include>
            <directory>src</directory>
        </include>
    </source>
</phpunit>
`,
      'phpunit.xml.dist': `<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/bootstrap.php">
    <testsuites>
        <testsuite name="all">
            <directory>tests</directory>
        </testsuite>
    </testsuites>
</phpunit>
`,
    });

    const text = await runModule('phpunit-config.js', app);

    expect(text).toContain('unit');
  });
});

describe('services', () => {
  test('a service with tags, an alias, a factory, arguments and calls', async () => {
    const app = appWith('services', {
      'config/services.yaml': `services:
    _defaults:
        autowire: true
        autoconfigure: true

    App\\Service\\InvoiceBuilder:
        arguments:
            - '@doctrine.orm.entity_manager'
            - '%kernel.project_dir%/var/invoices'
        calls:
            - [setLogger, ['@logger']]
        tags:
            - { name: app.builder, priority: 10 }
            - 'app.invoice'

    app.invoice_builder:
        alias: App\\Service\\InvoiceBuilder
        public: true

    App\\Service\\PdfRenderer:
        factory: ['@App\\Factory\\RendererFactory', 'create']

    App\\Service\\Plain: ~
`,
    });

    const text = await runModule('services.js', app, ['App\\Service\\InvoiceBuilder', 'app.invoice_builder', 'App\\Service\\PdfRenderer', 'app.builder']);

    expect(text).toContain('InvoiceBuilder');
  });
});

describe('symfony cloud', () => {
  test('an application with relationships, workers, crons and mounts', async () => {
    const app = appWith('symfony-cloud', {
      '.symfony.cloud.yaml': `name: app
type: php:8.3

relationships:
    database: 'db:postgresql'
    redis: 'cache:redis'

web:
    locations:
        '/':
            root: 'public'
            passthru: '/index.php'

mounts:
    '/uploads': { source: local, source_path: uploads }

workers:
    messenger:
        commands:
            start: symfony console messenger:consume async
        size: S
        memory: 512
    reports:
        commands:
            start: symfony console app:reports
    broken: ~

crons:
    cleanup:
        spec: '0 3 * * *'
        cmd: symfony console app:cleanup
    invalid: ~

variables:
    env:
        APP_ENV: prod
`,
      '.platform/routes.yaml': Array.from({ length: 12 }, (_, i) => `'https://route-${i}.example.com/':\n    type: upstream\n    upstream: 'app:http'\n`).join('\n'),
      '.platform/services.yaml': `db:
    type: postgresql:16
    disk: 2048

cache:
    type: redis:7.0
`,
      'composer.json': JSON.stringify({
        require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
    });

    const text = await runModule('symfony-cli.js', app);

    expect(text).toContain('messenger');
    expect(text).toContain('Relationships');
  });
});

describe('di factories', () => {
  test('factories written as an array, as a string and without a method', async () => {
    const app = appWith('di-factories', {
      'config/services.yaml': `services:
    App\\Service\\PdfRenderer:
        factory: ['@App\\Factory\\RendererFactory', 'create']

    App\\Service\\StaticRenderer:
        factory: 'App\\Factory\\RendererFactory::createStatic'

    App\\Service\\InvokableRenderer:
        factory: '@App\\Factory\\InvokableFactory'

    App\\Service\\Plain:
        class: App\\Service\\Plain
`,
      'src/Factory/RendererFactory.php': `<?php

namespace App\\Factory;

class RendererFactory
{
    public function create(): object
    {
        return new \\stdClass();
    }

    public static function createStatic(): object
    {
        return new \\stdClass();
    }
}
`,
    });

    const text = await runModule('symfony-di-factories.js', app);

    expect(text).toContain('RendererFactory');
  });
});

describe('http client retries', () => {
  test('scoped clients that retry too often and retry on an authorisation failure', async () => {
    const app = appWith('httpclient-retry', {
      'config/packages/framework.yaml': `framework:
    http_client:
        default_options:
            retry_failed:
                max_retries: 3
                delay: 1000
                multiplier: 2
                retry_on_status: [429, 500, 502, 503]
        scoped_clients:
            acme.client:
                base_uri: 'https://api.example.com'
                retry_failed:
                    max_retries: 9
                    retry_on_status: [401, 403, 500]
            plain.client:
                base_uri: 'https://plain.example.com'
`,
    });

    const inPhp = appWith('httpclient-retry-php', {
      'src/HttpClient/RetryingClient.php': `<?php

namespace App\\HttpClient;

use Symfony\\Component\\HttpClient\\RetryableHttpClient;
use Symfony\\Component\\HttpClient\\Retry\\GenericRetryStrategy;

class RetryingClient
{
    public function build($client): RetryableHttpClient
    {
        $strategy = new GenericRetryStrategy([429, 500], 1000, 2.0);

        return new RetryableHttpClient($client, $strategy, maxRetries: 4);
    }
}
`,
    });

    const text = await runModule('symfony-httpclient-retry.js', app);
    const phpText = await runModule('symfony-httpclient-retry.js', inPhp);

    expect(phpText).toContain('RetryingClient');
    expect(text).toContain('max_retries');
  });
});

describe('rate limiter storage', () => {
  test('limiters on the shared cache, on apcu and on redis', async () => {
    const app = appWith('rate-limiter', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.redis
        pools:
            limiter.pool:
                adapter: cache.adapter.apcu
            files.pool:
                adapter: cache.adapter.filesystem
            db.pool:
                adapter: cache.adapter.pdo
            memcached.pool:
                adapter: cache.adapter.memcached
            cache.redis:
                adapter: cache.adapter.redis
`,
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        anonymous_api:
            policy: 'sliding_window'
            limit: 100
            interval: '60 minutes'
            cache_pool: 'cache.app'
        login:
            policy: 'token_bucket'
            limit: 5
            rate: { interval: '15 minutes', amount: 5 }
            cache_pool: 'limiter.pool'
        uploads:
            policy: 'fixed_window'
            limit: 20
            interval: '1 hour'
            cache_pool: 'files.pool'
        reports:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'db.pool'
        exports:
            policy: 'sliding_window'
            limit: 2
            interval: '1 day'
        webhooks:
            policy: 'fixed_window'
            limit: 50
            interval: '1 minute'
            cache_pool: 'cache.redis'
        locks:
            policy: 'token_bucket'
            limit: 3
            rate: { interval: '1 minute', amount: 3 }
            lock_factory: 'lock.default.factory'
`,
    });

    const unconfigured = appWith('rate-limiter-unconfigured', {
      'src/Security/LoginLimiter.php': `<?php

namespace App\\Security;

use Symfony\\Component\\RateLimiter\\RateLimiterFactory;

class LoginLimiter
{
    public function __construct(private RateLimiterFactory $anonymousApiLimiter)
    {
    }
}
`,
    });

    const text = await runModule('symfony-rate-limiter-storage.js', app);
    const unconfiguredText = await runModule('symfony-rate-limiter-storage.js', unconfigured);

    expect(text).toContain('login');
    expect(unconfiguredText).toContain('RateLimiterFactory');
  });
});

describe('translation catalogues', () => {
  test('plurals with the wrong number of forms, and a catalogue that is not valid', async () => {
    const app = appWith('translation-lint', {
      'translations/messages.en.yaml': `app:
    apples: 'There is one apple|There are %count% apples'
    pears: 'one pear|two pears|many pears'
    title: 'Dashboard'
`,
      'translations/messages.pl.yaml': `app:
    apples: 'Jest jedno jablko|Sa %count% jablka'
    title: 'Panel'
`,
      'translations/messages.ja.yaml': `app:
    apples: 'ringo ga arimasu|ringo ga takusan arimasu'
    title: 'Dashboard'
`,
      'translations/validators.en.xlf': `<?xml version="1.0"?>
<xliff version="1.2">
    <file source-language="en" datatype="plaintext" original="file.ext">
        <body>
            <trans-unit id="1">
                <source>subscription.plan_required</source>
                <target>Choose a plan</target>
            </trans-unit>
        </body>
    </file>
</xliff>
`,
      'translations/broken.en.yaml': `app:
    unbalanced: "one
`,
    });

    const text = await runModule('symfony-translation-lint-all.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('events', () => {
  test('listeners registered by attribute, by subscriber and by service tag', async () => {
    const app = appWith('events', {
      'config/services.yaml': `services:
    App\\EventListener\\LegacyListener:
        tags:
            - { name: kernel.event_listener, event: kernel.request, method: onKernelRequest, priority: 250 }
            - { name: kernel.event_listener, event: kernel.response }
            - 'app.other'
`,
      'src/EventListener/RequestListener.php': `<?php

namespace App\\EventListener;

use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;
use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;

#[AsEventListener(event: 'kernel.request', priority: 100)]
class RequestListener
{
    public function __invoke(RequestEvent $event): void
    {
    }
}
`,
      'src/EventSubscriber/AuditSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\HttpKernel\\Event\\ResponseEvent;

class AuditSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'kernel.response' => ['onResponse', -10],
            'kernel.terminate' => 'onTerminate',
        ];
    }

    public function onResponse(ResponseEvent $event): void
    {
    }

    public function onTerminate(): void
    {
    }
}
`,
      'src/Service/DispatchingService.php': `<?php

namespace App\\Service;

use Symfony\\Contracts\\EventDispatcher\\EventDispatcherInterface;

class DispatchingService
{
    public function __construct(private EventDispatcherInterface $dispatcher)
    {
    }

    public function run(): void
    {
        $this->dispatcher->dispatch(new \\App\\Event\\InvoicePaid(), 'invoice.paid');
    }
}
`,
    });

    const text = await runModule('events.js', app, ['kernel.request', 'kernel.response']);

    expect(text).toContain('kernel.request');
  });
});

describe('security firewalls and access control', () => {
  test('a firewall of every authenticator, and access control with host, methods and an expression', async () => {
    const app = appWith('security-firewalls', {
      'config/packages/security.yaml': `security:
    role_hierarchy:
        ROLE_ADMIN: [ROLE_USER]
        ROLE_SUPER_ADMIN: [ROLE_ADMIN]
    firewalls:
        api:
            pattern: ^/api
            stateless: true
            jwt:
                authenticator: lexik_jwt_authentication.security.jwt_authenticator
            entry_point: App\\Security\\ApiEntryPoint
        oauth:
            oauth2: true
        basic:
            http_basic:
                realm: Acme
        main:
            lazy: true
            form_login:
                login_path: app_login
            custom_authenticators:
                - App\\Security\\ApiTokenAuthenticator
        broken: ~
    access_control:
        - { path: ^/admin, roles: ROLE_ADMIN, host: admin.example.com, methods: [GET, POST] }
        - { path: ^/reports, allow_if: "is_granted('ROLE_USER') and user.isActive()" }
        - { path: ^/public, roles: PUBLIC_ACCESS }
`,
      'src/Security/InvoiceVoter.php': `<?php

namespace App\\Security;

use App\\Entity\\Invoice;
use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class InvoiceVoter extends Voter
{
    public const VIEW = 'INVOICE_VIEW';
    public const EDIT = 'INVOICE_EDIT';

    protected function supports(string $attribute, mixed $subject): bool
    {
        return in_array($attribute, ['INVOICE_VIEW', 'INVOICE_EDIT'], true)
            && $subject instanceof Invoice;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return match ($attribute) {
            self::VIEW => true,
            self::EDIT => false,
            default => false,
        };
    }
}
`,
    });

    const text = await runModule('security-voters.js', app);

    expect(text).toContain('InvoiceVoter');
    expect(text).toContain('ROLE_ADMIN');
  });
});

describe('data pipelines', () => {
  test('an extract-transform-load service that accumulates everything in an array', async () => {
    const app = appWith('data-pipeline', {
      'src/Pipeline/ImportPipeline.php': `<?php

namespace App\\Pipeline;

class ImportPipeline
{
    public function extract(string $file): array
    {
        $rows = [];
        $handle = fopen($file, 'r');
        while (($line = fgets($handle)) !== false) {
            $rows[] = $line;
        }
        fclose($handle);

        return $rows;
    }

    public function transform(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $out[] = strtoupper($row);
        }

        return $out;
    }

    public function load(array $rows): void
    {
        foreach ($rows as $row) {
            $this->em->persist($this->toEntity($row));
        }
        $this->em->flush();
    }
}
`,
      'src/Pipeline/SplPipeline.php': `<?php

namespace App\\Pipeline;

class SplPipeline
{
    public function readAll(string $file): array
    {
        $rows = [];
        $spl = new \\SplFileObject($file);
        foreach ($spl as $line) {
            $rows[] = $line;
        }

        return $rows;
    }

    public function piped(iterable $rows): iterable
    {
        return $this->collection->pipe($rows);
    }
}
`,
    });

    const etl = appWith('data-pipeline-etl', {
      'src/Pipeline/EtlPipeline.php': `<?php

namespace App\\Pipeline;

class EtlPipeline
{
    public function run(array $source): void
    {
        $extracted = $this->extract($source);
        $transformed = $this->transform($extracted);
        $this->load($transformed);
    }

    public function extract(array $source): array
    {
        return $source;
    }

    public function transform(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $out[] = $row;
        }

        return $out;
    }

    public function load(array $rows): void
    {
        foreach ($rows as $row) {
            $this->em->persist($row);
        }
        $this->em->flush();
    }
}
`,
      'src/Pipeline/ExportService.php': `<?php

namespace App\\Pipeline;

class ExportService
{
    public function export(iterable $rows): \\Generator
    {
        foreach ($rows as $row) {
            yield $this->toCsvLine($row);
        }
    }
}
`,
    });

    const text = await runModule('symfony-data-pipeline-patterns.js', app);
    const etlText = await runModule('symfony-data-pipeline-patterns.js', etl);

    expect(etlText).toContain('EtlPipeline');
    expect(text).toContain('ImportPipeline');
  });
});

describe('svelte components', () => {
  test('components without typescript and a twig call passing an object', async () => {
    const app = appWith('ux-svelte', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/ux-svelte': '^2.0' },
      }, null, 2),
      'package.json': JSON.stringify({
        devDependencies: { svelte: '^4.0.0', '@symfony/ux-svelte': '^2.0.0' },
      }, null, 2),
      'assets/svelte/controllers/Counter.svelte': `<script>
    export let count = 0;
</script>

<button on:click={() => count++}>{count}</button>
`,
      'assets/svelte/controllers/Typed.svelte': `<script lang="ts">
    export let label: string;
</script>

<span>{label}</span>
`,
      'assets/svelte/controllers/README.md': 'Not a component\n',
      'templates/home/index.html.twig': `{{ svelte_component('Counter', { count: 1 }) }}
{{ svelte_component('Typed', { label: invoice }) }}
`,
    });

    const text = await runModule('symfony-ux-svelte.js', app);

    expect(text).toContain('Svelte');
    expect(text).toContain('not TypeScript');
  });
});

describe('codeception', () => {
  test('suites with and without an app path, and a cleanup setting', async () => {
    const app = appWith('codeception', {
      'codeception.yml': `namespace: App\\Tests
support_namespace: Support
paths:
    tests: tests
    output: var/codeception
settings:
    shuffle: false
    lint: true
coverage:
    enabled: true
`,
      'tests/acceptance.suite.yml': `actor: AcceptanceTester
modules:
    enabled:
        - WebDriver:
              url: http://localhost
              browser: chrome
`,
      'tests/functional.suite.yml': `actor: FunctionalTester
modules:
    enabled:
        - Symfony:
              app_path: src
              environment: test
        - Doctrine2:
              depends: Symfony
              cleanup: true
`,
      'tests/unit.suite.yml': `actor: UnitTester
modules:
    enabled:
        - Asserts
        - Db:
              cleanup: false
`,
    });

    const text = await runModule('codeception-config.js', app);

    expect(text).toContain('acceptance');
  });
});

describe('docker swarm', () => {
  test('services with resource blocks, update order and published ports', async () => {
    const app = appWith('docker-swarm', {
      'docker-compose.prod.yml': `version: "3.8"

services:
  app:
    image: registry.example.com/acme:latest
    deploy:
      replicas: 4
      resources:
        reservations:
          cpus: "0.25"
      update_config:
        parallelism: 2
        order: stop-first
      restart_policy:
        condition: none
      rollback_config:
        delay: 5s
    ports:
      - "8080:8080"

  worker:
    image: registry.example.com/acme:latest
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
      update_config:
        order: start-first
      restart_policy:
        condition: on-failure
      rollback_config:
        parallelism: 1
    ports:
      - target: 9000
        published: 9000
        mode: host
`,
    });

    const text = await runModule('docker-swarm-config.js', app);

    expect(text).toContain('app');
  });
});

describe('gitlab ci', () => {
  test('a pipeline with a secret in variables and artifacts that carry the environment', async () => {
    const app = appWith('gitlab-ci', {
      '.gitlab-ci.yml': `stages:
    - test
    - deploy

variables:
    COMPOSER_CACHE_DIR: .composer
    DEPLOY_TOKEN: glpat-0123456789abcdef
    APP_ENV: test

test:
    stage: test
    image: php:8.3
    script:
        - composer install
        - vendor/bin/phpunit
    artifacts:
        paths:
            - .env
            - var/log/
            - config/

deploy:
    stage: deploy
    script:
        - bin/deploy
    only:
        - main
`,
    });

    const text = await runModule('gitlab-ci-config.js', app);

    expect(text).toContain('hardcoded secret');
    expect(text).not.toContain('glpat-0123456789abcdef');
  });
});
