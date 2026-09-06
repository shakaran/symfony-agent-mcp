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

describe('kubernetes manifests', () => {
  test('a load balancer in a dev manifest, a node port, a secret with data and a budget with no bound', async () => {
    const app = appWith('kubernetes', {
      'k8s/dev/service.yaml': `apiVersion: v1
kind: Service
metadata:
    name: acme-dev
spec:
    type: LoadBalancer
    selector:
        app: acme
    ports:
        - port: 80
          targetPort: 8080
`,
      'k8s/service-nodeport.yaml': `apiVersion: v1
kind: Service
metadata:
    name: acme-nodeport
spec:
    type: NodePort
    selector:
        app: acme
    ports:
        - port: 80
          nodePort: 30080
`,
      'k8s/secret.yaml': `apiVersion: v1
kind: Secret
metadata:
    name: acme-secrets
type: Opaque
data:
    APP_SECRET: c2VjcmV0LXZhbHVl
    DATABASE_PASSWORD: aHVudGVyMg==
`,
      'k8s/pdb.yaml': `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
    name: acme
spec:
    selector:
        matchLabels:
            app: acme
`,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: acme
spec:
    replicas: 3
    template:
        spec:
            containers:
                - name: app
                  image: registry.example.com/acme:1.2.3
                  resources:
                      limits:
                          cpu: 500m
                          memory: 512Mi
`,
    });

    const text = await runModule('kubernetes-manifests.js', app);

    expect(text).toContain('NodePort');
  });
});

describe('asymmetric visibility', () => {
  test('private(set) on a static property, with readonly, and with a narrower getter', async () => {
    const app = appWith('asymmetric-visibility', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.4', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Entity/Account.php': `<?php

namespace App\\Entity;

class Account
{
    public private(set) string $reference = '';

    public static private(set) string $registry = '';

    public private(set) readonly string $createdBy;

    private protected(set) string $internal = '';

    public protected(set) int $balance = 0;
}
`,
    });

    const text = await runModule('php-asymmetric-visibility.js', app);

    expect(text).toContain('reference');
  });
});

describe('posix functions', () => {
  test('process and permission calls, and a named pipe', async () => {
    const app = appWith('posix', {
      'src/System/Process.php': `<?php

namespace App\\System;

class Process
{
    public function drop(): void
    {
        posix_setuid(1000);
        posix_setgid(1000);
        posix_seteuid(1000);
    }

    public function kill(): void
    {
        $pid = (int) $_GET['pid'];
        posix_kill($pid, SIGTERM);
    }

    public function lookup(): array
    {
        $username = $_POST['user'];

        return posix_getpwnam($username);
    }

    public function pipe(string $path): void
    {
        posix_mkfifo($path, 0666);
        // posix_mkfifo($path, 0600) in a comment does not count
    }

    public function info(): array
    {
        return [
            'user' => posix_getpwuid(posix_geteuid()),
            'tty' => posix_ttyname(STDOUT),
        ];
    }
}
`,
    });

    const text = await runModule('php-posix-functions.js', app);

    expect(text).toContain('posix_');
  });
});

describe('profiler', () => {
  test('an index with tokens and a profile with collectors', async () => {
    const app = appWith('profiler', {
      'var/cache/dev/profiler/index.csv': [
        'abc123,127.0.0.1,GET,http://localhost/,1767225600,200,/,acme',
        'def456,127.0.0.1,POST,http://localhost/checkout,1767225700,500,/checkout,acme',
        'short,line',
        '',
      ].join('\n'),
    });

    const text = await runModule('profiler.js', app, ['abc123']);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('rector', () => {
  test('a config whose php set is older than composer requires, with many rules and skips', async () => {
    const rules = Array.from({ length: 20 }, (_, i) => `        Rector\\Php80\\Rector\\Class_\\Rule${i}::class,`).join('\n');
    const skips = Array.from({ length: 14 }, (_, i) => `        Rector\\Php74\\Rector\\Skip${i}::class,`).join('\n');
    const app = appWith('rector', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.3', 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'rector/rector': '^1.0' },
      }, null, 2),
      'rector.php': `<?php

declare(strict_types=1);

use Rector\\Config\\RectorConfig;
use Rector\\Set\\ValueObject\\LevelSetList;

return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->paths([__DIR__ . '/src', __DIR__ . '/tests']);

    $rectorConfig->sets([
        LevelSetList::UP_TO_PHP_81,
    ]);

    $rectorConfig->rules([
${rules}
    ]);

    $rectorConfig->skip([
${skips}
    ]);
};
`,
    });

    const text = await runModule('rector-config.js', app);

    expect(text).toContain('rector.php');
  });
});

describe('shopify', () => {
  test('api credentials written into .env, and a webhook without verification', async () => {
    const app = appWith('shopify', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'shopify/shopify-api': '^5.0' },
      }, null, 2),
      '.env': `SHOPIFY_API_KEY=0123456789abcdef0123456789abcdef
SHOPIFY_API_SECRET=shpss\x5f0123456789abcdef0123456789abcdef
SHOPIFY_ACCESS_TOKEN=shpat\x5f0123456789abcdef0123456789abcdef
SHOPIFY_SHOP_DOMAIN=acme.myshopify.com
`,
      '.env.local': `SHOPIFY_API_KEY=%env(SHOPIFY_API_KEY)%
`,
      'src/Shopify/WebhookController.php': `<?php

namespace App\\Shopify;

use Shopify\\Clients\\Rest;

class WebhookController
{
    public function handle(string $payload): void
    {
        $client = new Rest('acme.myshopify.com', $_ENV['SHOPIFY_ACCESS_TOKEN']);
        $client->get(['path' => 'products']);
    }
}
`,
    });

    const text = await runModule('shopify-integration.js', app);

    expect(text).toContain('SHOPIFY_API_KEY');
    expect(text).not.toContain('shpss\x5f0123456789abcdef0123456789abcdef');
  });
});

describe('console completion', () => {
  test('a complete() that suggests values for arguments and options that do not exist', async () => {
    const app = appWith('console-completion', {
      'src/Command/DeployCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Completion\\CompletionInput;
use Symfony\\Component\\Console\\Completion\\CompletionSuggestions;
use Symfony\\Component\\Console\\Input\\InputArgument;
use Symfony\\Component\\Console\\Input\\InputOption;

#[AsCommand(name: 'app:deploy')]
class DeployCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addArgument('environment', InputArgument::REQUIRED, 'Target environment')
            ->addOption('strategy', null, InputOption::VALUE_REQUIRED, 'Deploy strategy');
    }

    public function complete(CompletionInput $input, CompletionSuggestions $suggestions): void
    {
        if ($input->mustSuggestArgumentValuesFor('environment')) {
            $suggestions->suggestValues(['prod', 'staging']);
        }

        if ($input->mustSuggestArgumentValuesFor('release')) {
            $suggestions->suggestValues(['latest']);
        }

        if ($input->mustSuggestOptionValuesFor('strategy')) {
            $suggestions->suggestValues(['rolling', 'blue-green']);
        }

        if ($input->mustSuggestOptionValuesFor('force')) {
            $suggestions->suggestValues(['yes', 'no']);
        }
    }
}
`,
    });

    const text = await runModule('symfony-console-completion.js', app);

    expect(text).toContain('DeployCommand');
  });
});

describe('doctrine sql logging', () => {
  test('logging and backtrace left on in production, and off in development', async () => {
    const app = appWith('sql-logger', {
      'config/packages/prod/doctrine.yaml': `doctrine:
    dbal:
        logging: true
        profiling: true
        profiling_collect_backtrace: true
`,
      'config/packages/dev/doctrine.yaml': `doctrine:
    dbal:
        logging: false
        profiling: false
`,
      'src/Doctrine/QueryLogger.php': `<?php

namespace App\\Doctrine;

use Doctrine\\DBAL\\Driver\\Middleware;

class QueryLogger implements Middleware
{
    public function wrap($driver): object
    {
        return $driver;
    }
}
`,
    });

    const text = await runModule('symfony-doctrine-sql-logger.js', app);

    expect(text).toContain('logging');
  });
});

describe('exception mapping', () => {
  test('exceptions with status codes, an access denied subclass and duplicate codes', async () => {
    const app = appWith('exception-mapping', {
      'src/Exception/NotFoundException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpException;
use Symfony\\Component\\HttpFoundation\\Response;

class NotFoundException extends HttpException
{
    public function __construct()
    {
        parent::__construct(Response::HTTP_NOT_FOUND, 'Not found');
    }
}
`,
      'src/Exception/GoneException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class GoneException extends HttpException
{
    public function __construct()
    {
        parent::__construct(404, 'Gone');
    }
}
`,
      'src/Exception/StorageUnavailableException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class StorageUnavailableException extends HttpException
{
    public function __construct()
    {
        parent::__construct(503, 'Storage unavailable');
    }
}
`,
      'src/Exception/InvoiceAccessDeniedException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\Security\\Core\\Exception\\AccessDeniedException;

class InvoiceAccessDeniedException extends AccessDeniedException
{
}
`,
      'config/packages/twig.yaml': `twig:
    exception_controller: null
    paths:
        '%kernel.project_dir%/templates': ~
`,
      'templates/bundles/TwigBundle/Exception/error404.html.twig': `<h1>Not found</h1>
`,
      'templates/bundles/TwigBundle/Exception/error.html.twig': `<h1>Error</h1>
`,
    });

    const text = await runModule('symfony-exception-mapping.js', app);

    expect(text).toContain('NotFoundException');
  });
});

describe('accessibility', () => {
  test('a template with every accessibility problem the audit knows', async () => {
    const app = appWith('accessibility', {
      'templates/page/index.html.twig': `<h1>First</h1>
<h1>Second</h1>
<h4>Skipped a level</h4>

<img src="/logo.png" alt="">
<img src="/hero.png">

<button></button>
<button><i class="icon-save"></i></button>

<table>
    <tr><th>Name</th><td>Acme</td></tr>
</table>

<div aria-hidden="true"><a href="/hidden">Hidden link</a></div>

<label>Name</label>
<input type="text" name="name">

<a href="/somewhere">Click here</a>
`,
    });

    const text = await runModule('accessibility-audit.js', app);

    expect(text).toContain('index.html.twig');
  });
});

describe('api platform resources', () => {
  test('a resource with operations, filters, pagination and a security expression', async () => {
    const app = appWith('api-platform-resource', {
      'config/packages/api_platform.yaml': `api_platform:
    title: Acme API
    version: 1.0.0
    defaults:
        pagination_items_per_page: 25
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Doctrine\\Orm\\Filter\\OrderFilter;
use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;
use ApiPlatform\\Metadata\\ApiFilter;
use ApiPlatform\\Metadata\\ApiResource;
use ApiPlatform\\Metadata\\Get;
use ApiPlatform\\Metadata\\GetCollection;
use ApiPlatform\\Metadata\\Post;

#[ApiResource(
    description: 'A customer invoice',
    security: "is_granted('ROLE_USER')",
    paginationEnabled: true,
    paginationItemsPerPage: 50,
    operations: [
        new Get(security: "is_granted('INVOICE_VIEW', object)"),
        new GetCollection(),
        new Post(security: "is_granted('ROLE_ADMIN')"),
    ],
)]
#[ApiFilter(SearchFilter::class, properties: ['reference' => 'exact', 'customer.name' => 'partial'])]
#[ApiFilter(OrderFilter::class, properties: ['issuedAt'])]
class Invoice
{
    public ?int $id = null;
}
`,
      'src/Entity/Note.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Note
{
    public ?int $id = null;
}
`,
    });

    const text = await runModule('api-platform.js', app, ['Invoice', 'Note']);

    expect(text).toContain('Invoice');
  });
});

describe('cloudwatch', () => {
  test('a cloudwatch handler, an alarm, a retention setting and x-ray', async () => {
    const app = appWith('cloudwatch', {
      'composer.json': JSON.stringify({
        require: {
          'symfony/framework-bundle': '^7.0',
          'aws/aws-sdk-php': '^3.0',
          'maxbanton/cwh': '^2.0',
        },
      }, null, 2),
      'config/packages/prod/monolog.yaml': `monolog:
    handlers:
        cloudwatch:
            type: service
            id: Maxbanton\\Cwh\\Handler\\CloudWatch
            level: error
`,
      'src/Aws/AlarmFactory.php': `<?php

namespace App\\Aws;

use Aws\\CloudWatch\\CloudWatchClient;
use Aws\\CloudWatchLogs\\CloudWatchLogsClient;

class AlarmFactory
{
    public function alarm(CloudWatchClient $client): void
    {
        $client->putMetricAlarm([
            'AlarmName' => 'acme-5xx',
            'MetricName' => 'HTTPCode_Target_5XX_Count',
        ]);
    }

    public function retention(CloudWatchLogsClient $logs): void
    {
        $logs->putRetentionPolicy([
            'logGroupName' => '/acme/app',
            'retentionInDays' => 30,
        ]);
    }
}
`,
      '.env': `AWS_XRAY_DAEMON_ADDRESS=127.0.0.1:2000
AWS_REGION=eu-west-1
`,
    });

    const text = await runModule('cloudwatch-integration.js', app);

    expect(text).toContain('CloudWatch');
  });
});

describe('easy coding standard', () => {
  test('an ecs config, the older cs-fixer files and ecs in the pipeline', async () => {
    const app = appWith('ecs', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'symplify/easy-coding-standard': '^12.0' },
        scripts: { ecs: 'vendor/bin/ecs check' },
      }, null, 2),
      'ecs.php': `<?php

declare(strict_types=1);

use PhpCsFixer\\Fixer\\ArrayNotation\\ArraySyntaxFixer;
use Symplify\\EasyCodingStandard\\Config\\ECSConfig;

return ECSConfig::configure()
    ->withPaths([__DIR__ . '/src', __DIR__ . '/tests'])
    ->withPreparedSets(psr12: true, common: true)
    ->withRules([ArraySyntaxFixer::class])
    ->withSkip([__DIR__ . '/src/Kernel.php']);
`,
      '.php-cs-fixer.dist.php': `<?php

return (new PhpCsFixer\\Config())->setRules(['@PSR12' => true]);
`,
      '.github/workflows/ci.yml': `name: ci
on: [push]
jobs:
    style:
        runs-on: ubuntu-latest
        steps:
            - run: vendor/bin/ecs check --no-progress-bar
`,
    });

    const text = await runModule('easy-coding-standard.js', app);

    expect(text).toContain('ecs');
  });
});

describe('flex recipes', () => {
  test('official and contrib recipes side by side', async () => {
    const app = appWith('flex-official', {
      'symfony.lock': JSON.stringify({
        'symfony/framework-bundle': {
          version: '7.0',
          recipe: {
            repo: 'github.com/symfony/recipes',
            branch: 'main',
            version: '6.4',
            ref: 'https://github.com/symfony/recipes/tree/main/symfony/framework-bundle',
          },
        },
        'sentry/sentry-symfony': {
          version: '4.9',
          recipe: {
            repo: 'github.com/symfony/recipes-contrib',
            branch: 'main',
            version: '4.0',
            ref: 'https://github.com/symfony/recipes-contrib/tree/main/sentry/sentry-symfony',
          },
        },
        'acme/private-bundle': {
          version: '1.0',
          recipe: { repo: 'gitlab.example.com/acme/recipes', branch: 'main', version: '1.0' },
        },
      }, null, 2),
    });

    const text = await runModule('flex-recipes.js', app);

    expect(text).toContain('framework-bundle');
    expect(text).toContain('Contrib');
  });
});

describe('heroku', () => {
  test('a Procfile with a release dyno and an app.json with addons', async () => {
    const app = appWith('heroku', {
      'Procfile': `web: heroku-php-apache2 public/
worker: php bin/console messenger:consume async
release: php bin/console doctrine:migrations:migrate --no-interaction
# a comment line
malformed line without a colon
`,
      'app.json': JSON.stringify({
        name: 'acme',
        env: {
          APP_ENV: { description: 'Environment', value: 'prod' },
          APP_SECRET: { description: 'Secret', required: true },
        },
        addons: [
          { plan: 'heroku-postgresql:standard-0' },
          { plan: 'heroku-redis' },
          'papertrail',
        ],
        buildpacks: [
          { url: 'heroku/php' },
          { name: 'heroku/nodejs' },
        ],
      }, null, 2),
    });

    const text = await runModule('heroku-config.js', app);

    expect(text).toContain('release');
  });
});

describe('netlify', () => {
  test('a netlify.toml with build, environment, headers, redirects and functions', async () => {
    const app = appWith('netlify', {
      'netlify.toml': `[build]
    command = "composer install && bin/console assets:install"
    publish = "public"

[build.environment]
    PHP_VERSION = "8.3"
    APP_SECRET = "0123456789abcdef0123456789abcdef"
    APP_ENV = "$APP_ENV"

[context.production.environment]
    APP_ENV = "prod"
    DATABASE_URL = "postgresql://app:hunter2@db.example.com/acme"

[[headers]]
    for = "/*"
    [headers.values]
        X-Frame-Options = "SAMEORIGIN"
        X-Content-Type-Options = "nosniff"

[[redirects]]
    from = "/old"
    to = "/new"
    status = 301

[functions]
    directory = "netlify/functions"
    node_bundler = "esbuild"
`,
    });

    const text = await runModule('netlify-deploy-config.js', app);

    expect(text).toContain('build');
    expect(text).not.toContain('hunter2');
  });
});

describe('covariance', () => {
  test('return types narrowed, widened and left alone', async () => {
    const app = appWith('covariance', {
      'src/Contract/Repository.php': `<?php

namespace App\\Contract;

abstract class Repository
{
    abstract public function find(int $id): ?object;

    abstract public function all(): iterable;

    abstract public function name(): string|int;

    abstract public function raw(): mixed;
}
`,
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use App\\Contract\\Repository;
use App\\Entity\\Invoice;

class InvoiceRepository extends Repository
{
    public function find(int $id): ?Invoice
    {
        return null;
    }

    public function all(): array
    {
        return [];
    }

    public function name(): string
    {
        return 'invoice';
    }

    public function raw(): string|int
    {
        return 1;
    }
}
`,
    });

    const text = await runModule('php-covariance.js', app);

    expect(text).toContain('InvoiceRepository');
  });
});

describe('parallel extension', () => {
  test('runtimes and channels created outside try/catch', async () => {
    const app = appWith('parallel', {
      'src/Parallel/Worker.php': `<?php

namespace App\\Parallel;

use parallel\\Channel;
use parallel\\Runtime;

class Worker
{
    public function unguarded(): void
    {
        $runtime = new Runtime();
        parallel\\run(function (): void {
            echo 'work';
        });
    }

    public function guarded(): void
    {
        try {
            $runtime = new Runtime();
            parallel\\run(function (): void {
                echo 'work';
            });
        } catch (\\parallel\\Error $e) {
        }
    }

    public function channels(object $shared): void
    {
        $unbuffered = new Channel();
        $buffered = Channel::make('acme', 16);
        parallel\\run(function () use ($shared): void {
            $shared->mutate();
        });
    }

    public function boot(string $path): void
    {
        parallel\\bootstrap($path);
    }
}
`,
    });

    const text = await runModule('php-parallel-extension.js', app);

    expect(text).toContain('Worker');
  });
});

describe('phpstan configuration', () => {
  test('a large baseline, unmatched ignores turned off and many excluded paths', async () => {
    const excludes = Array.from({ length: 8 }, (_, i) => `        - src/Legacy${i}`).join('\n');
    const baseline = Array.from({ length: 220 }, (_, i) => `    -\n        message: "#^Error ${i}$#"\n        count: 1\n        path: src/Legacy.php`).join('\n');
    const app = appWith('phpstan-config', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpstan/phpstan': '^1.10' },
      }, null, 2),
      'phpstan.neon': `includes:
    - phpstan-baseline.neon
    - vendor/phpstan/phpstan-symfony/extension.neon

parameters:
    level: 6
    reportUnmatchedIgnoredErrors: false
    paths:
        - src
    excludePaths:
${excludes}
`,
      'phpstan-baseline.neon': `parameters:
    ignoreErrors:
${baseline}
`,
    });

    const text = await runModule('phpstan-config.js', app);

    expect(text).toContain('phpstan.neon');
  });
});

describe('composite primary keys', () => {
  test('an entity with two ids, looked up with a single scalar', async () => {
    const app = appWith('composite-pk', {
      'src/Entity/OrderLine.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class OrderLine
{
    #[ORM\\Id]
    #[ORM\\Column]
    private int $orderId;

    #[ORM\\Id]
    #[ORM\\Column]
    private int $lineNumber;

    #[ORM\\Column]
    private string $sku = '';
}
`,
      'src/Entity/LegacyLine.php': `<?php

namespace App\\Entity;

/**
 * @ORM\\Entity
 */
class LegacyLine
{
    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $orderId;

    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $lineNumber;
}
`,
      'src/Repository/LineRepository.php': `<?php

namespace App\\Repository;

use App\\Entity\\OrderLine;
use Doctrine\\ORM\\EntityManagerInterface;

class LineRepository
{
    public function __construct(private EntityManagerInterface $em)
    {
    }

    public function byScalar(int $id): ?OrderLine
    {
        return $this->em->find(OrderLine::class, $id);
    }

    public function reference(int $id): object
    {
        return $this->em->getReference(OrderLine::class, $id);
    }

    public function byArray(array $ids): ?OrderLine
    {
        return $this->em->find(OrderLine::class, $ids);
    }
}
`,
    });

    const text = await runModule('doctrine-composite-primary-keys.js', app);

    expect(text).toContain('OrderLine');
  });
});

describe('doctrine metadata cache', () => {
  test('an array driver in production and a filesystem adapter for metadata', async () => {
    const app = appWith('metadata-cache', {
      'config/packages/prod/doctrine.yaml': `doctrine:
    orm:
        metadata_cache_driver:
            type: pool
            pool: doctrine.system_cache_pool
        query_cache_driver:
            type: array
        result_cache_driver:
            type: service
            id: cache.adapter.filesystem
`,
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: true
        metadata_cache_driver:
            type: array
`,
      'config/packages/dev/doctrine.yaml': `doctrine:
    orm:
        metadata_cache_driver:
            type: array
`,
    });

    const text = await runModule('symfony-doctrine-metadata-cache.js', app);

    expect(text).toContain('array');
  });
});

describe('migration rollback', () => {
  test('down() that drops a table, one that removes a column and one that refuses', async () => {
    const app = appWith('migration-rollback', {
      'config/packages/doctrine_migrations.yaml': `doctrine_migrations:
    migrations_paths:
        'DoctrineMigrations': '%kernel.project_dir%/migrations'
    transactional: false
    all_or_nothing: false
`,
      'migrations/Version20260101000001.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000001 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE audit (id INT PRIMARY KEY)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE audit');
        $table = $schema->getTable('audit');
        $schema->dropTable('audit');
    }
}
`,
      'migrations/Version20260101000002.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000002 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE product ADD COLUMN legacy_price INT');
    }

    public function down(Schema $schema): void
    {
        $table = $schema->getTable('product');
        $table->dropColumn('legacy_price');
    }
}
`,
      'migrations/Version20260101000003.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000003 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('UPDATE product SET price = price * 100');
    }

    public function down(Schema $schema): void
    {
        throw new \\RuntimeException('This migration cannot be reverted');
    }
}
`,
      'migrations/Version20260101000004.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000004 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE INDEX idx_sku ON product (sku)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX idx_sku');
        $this->addSql('INSERT INTO audit SELECT * FROM product_backup');
    }
}
`,
    });

    const text = await runModule('symfony-doctrine-migration-rollback.js', app);

    expect(text).toContain('down()');
  });
});

describe('esi', () => {
  test('esi enabled with no proxy, esi disabled, and fragments in templates', async () => {
    const app = appWith('esi', {
      'config/packages/framework.yaml': `framework:
    esi:
        enabled: true
    fragments:
        path: /_fragment
`,
      'config/packages/prod/framework.yaml': `framework:
    esi:
        enabled: false
`,
      'templates/base.html.twig': `<!doctype html>
<html>
    <body>
        {{ render_esi(controller('App\\\\Controller\\\\SidebarController::recent')) }}
        {{ render_esi(url('news_latest')) }}
        {{ render(controller('App\\\\Controller\\\\FooterController::index')) }}
    </body>
</html>
`,
    });

    const text = await runModule('symfony-esi-config.js', app);

    expect(text).toContain('esi');
  });
});

describe('competing consumers', () => {
  test('transports with concurrency and prefetch, and a single worker in supervisor', async () => {
    const app = appWith('competing-consumers', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: '%env(MESSENGER_TRANSPORT_DSN)%'
                options:
                    concurrency: 4
                    prefetch_count: 10
            slow:
                dsn: 'doctrine://default?queue_name=slow'
                options:
                    prefetch_count: 1
`,
      'docker/supervisord.conf': `[program:messenger-async]
command=php /srv/app/bin/console messenger:consume async --time-limit=3600
numprocs=1
autostart=true

[program:messenger-slow]
command=php /srv/app/bin/console messenger:consume slow
numprocs=6
`,
      'docker-compose.yml': `services:
  worker:
    image: acme
    command: php bin/console messenger:consume async
    deploy:
      replicas: 2
`,
      'Makefile': `.PHONY: consume
consume:
	php bin/console messenger:consume async
`,
    });

    const text = await runModule('symfony-messenger-competing-consumers.js', app);

    expect(text).toContain('async');
  });
});

describe('property info', () => {
  test('extractors referenced in code with property_info turned off', async () => {
    const app = appWith('property-info', {
      'config/packages/framework.yaml': `framework:
    property_info:
        enabled: false
`,
      'src/Serializer/Extractor.php': `<?php

namespace App\\Serializer;

use Symfony\\Component\\PropertyInfo\\Extractor\\PhpDocExtractor;
use Symfony\\Component\\PropertyInfo\\Extractor\\ReflectionExtractor;
use Symfony\\Component\\PropertyInfo\\PropertyInfoExtractorInterface;
use Symfony\\Component\\PropertyInfo\\PropertyTypeExtractorInterface;

class Extractor implements PropertyTypeExtractorInterface
{
    public function __construct(private PropertyInfoExtractorInterface $inner)
    {
    }

    public function getTypes(string $class, string $property, array $context = []): ?array
    {
        $reflection = new ReflectionExtractor();
        $phpDoc = new PhpDocExtractor();

        return $this->inner->getTypes($class, $property, $context);
    }
}
`,
    });

    const text = await runModule('symfony-property-info.js', app);

    expect(text).toContain('property_info');
  });
});

describe('rate limiter policies', () => {
  test('intervals written in every shape, and limits that make no sense', async () => {
    const app = appWith('rate-limiter-policy', {
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        per_hour:
            policy: 'sliding_window'
            limit: 1000
            interval: '1 hour'
        per_minutes:
            policy: 'fixed_window'
            limit: 5
            interval: '15 minutes'
        iso_seconds:
            policy: 'fixed_window'
            limit: 10
            interval: 'PT30S'
        iso_minutes:
            policy: 'sliding_window'
            limit: 20
            interval: 'PT10M'
        iso_hours:
            policy: 'sliding_window'
            limit: 100
            interval: 'PT2H'
        bare_number:
            policy: 'fixed_window'
            limit: 3
            interval: '60'
        bucket:
            policy: 'token_bucket'
            limit: 10000
            rate: { interval: '1 second', amount: 500 }
        no_limit:
            policy: 'sliding_window'
            interval: '1 hour'
        broken: ~
`,
    });

    const text = await runModule('symfony-rate-limiter-policy.js', app);

    expect(text).toContain('per_hour');
  });
});

describe('ux typed', () => {
  test('a typed controller with no strings, no speed and no loop', async () => {
    const app = appWith('ux-typed', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'assets/controllers.json': JSON.stringify({
        controllers: {
          '@symfony/ux-typed': {
            typed: { enabled: true, fetch: 'eager' },
          },
        },
      }, null, 2),
      'assets/controllers/typed_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    connect() {
    }
}
`,
      'templates/home/index.html.twig': `<div {{ stimulus_controller('symfony/ux-typed/typed') }}>
    <span></span>
</div>
`,
    });

    const text = await runModule('symfony-ux-typed.js', app);

    expect(text).toContain('Typed');
  });
});

describe('ux vue', () => {
  test('vue components without defineProps and a twig call passing an object', async () => {
    const app = appWith('ux-vue', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/ux-vue': '^2.0' },
      }, null, 2),
      'package.json': JSON.stringify({
        devDependencies: { vue: '^3.4.0', '@symfony/ux-vue': '^2.0.0' },
      }, null, 2),
      'assets/vue/controllers/Counter.vue': `<template>
    <button @click="count++">{{ count }}</button>
</template>

<script setup>
let count = 0;
</script>
`,
      'assets/vue/controllers/Typed.vue': `<template>
    <span>{{ label }}</span>
</template>

<script setup>
defineProps({ label: String });
</script>
`,
      'assets/vue/controllers/notes.md': 'not a component\n',
      'templates/home/index.html.twig': `{{ vue_component('Counter', { count: 1 }) }}
{{ vue_component('Typed', { label: invoice }) }}
`,
    });

    const text = await runModule('symfony-ux-vue.js', app);

    expect(text).toContain('Vue');
  });
});

describe('workflows and state machines', () => {
  test('a state machine with several from-states, no marking store and an audit trail', async () => {
    const app = appWith('state-machine', {
      'config/packages/workflow.yaml': `framework:
    workflows:
        invoice:
            type: state_machine
            audit_trail:
                enabled: true
            supports:
                - App\\Entity\\Invoice
            places:
                - draft
                - review
                - approved
                - paid
            transitions:
                to_review:
                    from: draft
                    to: review
                approve:
                    from: [review, draft]
                    to: approved
                pay:
                    from: approved
                    to: paid
`,
      'config/workflows/article.yaml': `framework:
    workflows:
        article:
            type: workflow
            marking_store:
                type: method
                property: currentPlace
            supports:
                - App\\Entity\\Article
            places: [draft, published]
            transitions:
                publish:
                    from: draft
                    to: published
`,
    });

    const text = await runModule('symfony-workflow-state-machine.js', app);

    expect(text).toContain('invoice');
  });
});

describe('websockets', () => {
  test('a ratchet server whose onOpen checks neither authentication nor origin', async () => {
    const app = appWith('websocket', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'cboden/ratchet': '^0.4' },
      }, null, 2),
      'src/WebSocket/ChatServer.php': `<?php

namespace App\\WebSocket;

use Ratchet\\ConnectionInterface;
use Ratchet\\MessageComponentInterface;

class ChatServer implements MessageComponentInterface
{
    public function onOpen(ConnectionInterface $conn)
    {
        $this->clients->attach($conn);
    }

    public function onMessage(ConnectionInterface $from, $msg)
    {
    }

    public function onClose(ConnectionInterface $conn)
    {
    }

    public function onError(ConnectionInterface $conn, \\Exception $e)
    {
    }
}
`,
      'config/packages/mercure.yaml': `mercure:
    hubs:
        default:
            url: 'https://mercure.example.com/.well-known/mercure'
            jwt:
                secret: '%env(MERCURE_JWT_SECRET)%'
                publish: '*'
`,
      'docker/nginx.conf': `server {
    location /ws {
        proxy_pass http://websocket:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`,
    });

    const text = await runModule('websocket-integration.js', app);

    expect(text).toContain('ChatServer');
  });
});

describe('aws ecs', () => {
  test('a task definition with a secret in the environment, no health check and a privileged container', async () => {
    const app = appWith('aws-ecs', {
      'deploy/task-definition.json': JSON.stringify({
        family: 'acme-app',
        networkMode: 'awsvpc',
        containerDefinitions: [
          {
            name: 'app',
            image: 'registry.example.com/acme:latest',
            essential: true,
            privileged: true,
            environment: [
              { name: 'APP_ENV', value: 'prod' },
              { name: 'DATABASE_PASSWORD', value: 'hunter2-in-the-task-def' },
            ],
          },
          {
            name: 'sidecar',
            image: 'registry.example.com/sidecar:latest',
            healthCheck: { command: ['CMD-SHELL', 'curl -f http://localhost/health || exit 1'] },
            secrets: [{ name: 'APP_SECRET', valueFrom: 'arn:aws:secretsmanager:eu-west-1:1:secret:acme' }],
          },
        ],
      }, null, 2),
      'deploy/ecs-task-broken.json': '{ not json\n',
      'node_modules/ignored/task-definition.json': '{}\n',
    });

    const text = await runModule('aws-ecs-config.js', app);

    expect(text).toContain('acme-app');
    expect(text).not.toContain('hunter2-in-the-task-def');
  });
});

describe('custom authenticators', () => {
  test('a stateless firewall with remember_me, and one with a very long lifetime', async () => {
    const app = appWith('custom-authenticators', {
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            pattern: ^/api
            stateless: true
            custom_authenticator: App\\Security\\ApiTokenAuthenticator
            remember_me:
                secret: '%kernel.secret%'
                lifetime: 31536000
                secure: false
        main:
            lazy: true
            custom_authenticators:
                - App\\Security\\LoginFormAuthenticator
                - App\\Security\\MagicLinkAuthenticator
            form_login:
                login_path: app_login
        broken: ~
`,
      'src/Security/ApiTokenAuthenticator.php': `<?php

namespace App\\Security;

use Symfony\\Component\\Security\\Http\\Authenticator\\AbstractAuthenticator;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Passport;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\SelfValidatingPassport;

class ApiTokenAuthenticator extends AbstractAuthenticator
{
    public function supports($request): bool
    {
        return $request->headers->has('X-API-TOKEN');
    }

    public function authenticate($request): Passport
    {
        return new SelfValidatingPassport($this->userBadge($request));
    }
}
`,
    });

    const text = await runModule('custom-authenticators.js', app);

    expect(text).toContain('ApiTokenAuthenticator');
  });
});

describe('doctrine query cache', () => {
  test('caches configured as a service, a pool and a provider, sharing one redis dsn', async () => {
    const app = appWith('query-cache', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(DATABASE_URL)%'
    orm:
        query_cache_driver:
            type: redis
            dsn: 'redis://cache:6379'
        result_cache_driver:
            type: redis
            dsn: 'redis://cache:6379'
        metadata_cache_driver:
            type: pool
            pool: doctrine.system_cache_pool
        second_level_cache:
            enabled: true
            region_cache_driver:
                type: service
                id: cache.app
`,
    });
    const providers = appWith('query-cache-providers', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        query_cache_driver: array
        result_cache_driver:
            cache_provider: my_provider
        metadata_cache_driver:
            type: array
`,
    });

    const text = await runModule('doctrine-query-cache.js', app);
    const providersText = await runModule('doctrine-query-cache.js', providers);

    expect(text).toContain('query_cache');
    expect(providersText.length).toBeGreaterThan(0);
  });
});

describe('lock stores', () => {
  test('every store the lock component understands', async () => {
    const app = appWith('lock-stores', {
      'config/packages/lock.yaml': `framework:
    lock:
        default: 'rediss://cache:6379'
        database: 'postgresql://app:pass@db:5432/acme'
        legacy: 'mysql://app:pass@db:3306/acme'
        memcached: 'memcached://cache:11211'
        memory: 'in_memory'
        mongo: 'mongodb://mongo:27017/locks'
        zk: 'zookeeper://zk:2181'
        weird: 'acme://store'
`,
    });
    const single = appWith('lock-single', {
      'config/packages/framework.yaml': `framework:
    lock: 'flock'
`,
    });

    const text = await runModule('lock.js', app);
    const singleText = await runModule('lock.js', single);

    expect(text).toContain('Redis');
    expect(singleText.length).toBeGreaterThan(0);
  });
});

describe('php jit', () => {
  test('jit disabled, the function mode, an unknown mode and buffer sizes at both ends', async () => {
    const disabled = appWith('jit-disabled', {
      'docker/php/conf.d/opcache.ini': `opcache.enable = 1
opcache.jit = disable
opcache.jit_buffer_size = 0
`,
    });
    const fn = appWith('jit-function', {
      'docker/php/conf.d/jit.ini': `opcache.enable = 1
opcache.jit = function
opcache.jit_buffer_size = 8M
opcache.jit_hot_func = 127
`,
    });
    const unknown = appWith('jit-unknown', {
      'php.ini': `opcache.enable = 1
opcache.jit = sometimes
opcache.jit_buffer_size = 1024M
`,
    });
    const tracing = appWith('jit-tracing', {
      'config/php.ini': `opcache.enable = 1
opcache.jit = tracing
opcache.jit_buffer_size = 256M
`,
    });

    const one = await runModule('php-jit-config.js', disabled);
    const two = await runModule('php-jit-config.js', fn);
    const three = await runModule('php-jit-config.js', unknown);
    const four = await runModule('php-jit-config.js', tracing);

    expect(one).toContain('JIT');
    expect(two).toContain('function');
    expect(three.length).toBeGreaterThan(0);
    expect(four).toContain('tracing');
  });
});

describe('profiler storage layout', () => {
  test('profiles nested the way Symfony writes them', async () => {
    const app = appWith('profiler-files', {
      'var/cache/dev/profiler/23/c1/abc123': "{\"time\": {\"duration\": 128.5, \"initTime\": 12.25}, \"memory\": {\"memory\": 12582912, \"memoryLimit\": \"256M\"}, \"db\": {\"time\": 0.045, \"queries\": [{\"sql\": \"SELECT * FROM invoice WHERE id = ?\", \"executionMS\": 12.5, \"params\": [1]}, {\"sql\": \"SELECT * FROM customer\", \"executionMs\": 3.25, \"params\": []}]}, \"logger\": {\"logs\": [{\"priority\": \"400\", \"priorityName\": \"ERROR\", \"message\": \"Payment failed\", \"channel\": \"app\"}, {\"priority\": \"300\", \"priorityName\": \"WARNING\", \"message\": \"Slow response\", \"channel\": \"request\"}]}, \"exception\": {\"exception\": true, \"class\": \"RuntimeException\", \"message\": \"Payment gateway timeout\"}, \"request\": {\"status_code\": 500, \"request_headers\": {\"accept\": \"text/html\"}, \"response_headers\": {\"content-type\": \"text/html\"}}}",
      'var/cache/dev/profiler/56/f4/def456': '{ "time": { "duration": 5 } }',
      'var/cache/dev/profiler/56/f4/short': 'too short',
    });

    const text = await runModule('profiler.js', app, ['abc123', 'def456']);

    expect(text).toContain('RuntimeException');
  });
});

describe('lock usage in code', () => {
  test('locks acquired and released in a service', async () => {
    const app = appWith('lock-usage', {
      'config/packages/lock.yaml': `framework:
    lock: 'redis://cache:6379'
`,
      'src/Service/ReportLocker.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Lock\\LockFactory;

class ReportLocker
{
    public function __construct(private LockFactory $factory)
    {
    }

    public function run(): void
    {
        $lock = $this->factory->createLock('report', 300, false);
        if (!$lock->acquire(true)) {
            return;
        }

        try {
            $this->build();
        } finally {
            $lock->release();
        }
    }

    public function forgetful(): void
    {
        $lock = $this->factory->createLock('cleanup');
        $lock->acquire();
        $this->cleanup();
    }
}
`,
    });

    const text = await runModule('lock.js', app);

    expect(text).toContain('ReportLocker');
  });
});

describe('pcre security', () => {
  test('patterns that backtrack catastrophically, and a backtrack limit set by hand', async () => {
    const app = appWith('pcre', {
      'src/Validator/PatternValidator.php': `<?php

namespace App\\Validator;

class PatternValidator
{
    public function nested(string $value): bool
    {
        return (bool) preg_match('/^(a+)+$/', $value);
    }

    public function starStar(string $value): bool
    {
        return (bool) preg_match('/^(a*)*$/', $value);
    }

    public function plusStar(string $value): bool
    {
        return (bool) preg_match('/^(x+)*$/', $value);
    }

    public function starPlus(string $value): bool
    {
        return (bool) preg_match('/^(y*)+$/', $value);
    }

    public function possessive(string $value): bool
    {
        return (bool) preg_match('/^[a-z]++$/', $value);
    }

    public function alternation(string $value): bool
    {
        return (bool) preg_match('/^(a|aa)+$/', $value);
    }

    public function greedy(string $value): bool
    {
        return (bool) preg_match('/^.*=.*$/', $value);
    }

    public function limits(): void
    {
        ini_set('pcre.backtrack_limit', '10000000');
        ini_set('pcre.recursion_limit', '100');
    }
}
`,
      'php.ini': `pcre.backtrack_limit = 100000000
pcre.jit = 1
`,
    });

    const text = await runModule('php-pcre-security.js', app);

    expect(text).toContain('backtracking');
  });
});

describe('string helpers', () => {
  test('legacy strpos patterns beside the modern helpers', async () => {
    const app = appWith('string-helpers', {
      'src/Support/Strings.php': `<?php

namespace App\\Support;

class Strings
{
    public function checks(string $haystack, string $needle): bool
    {
        if (strpos($haystack, $needle) !== false) {
            return true;
        }

        if (strpos($haystack, 'prefix') === 0) {
            return true;
        }

        if (str_contains($haystack, $needle)) {
            return true;
        }

        if (str_starts_with($haystack, 'prefix')) {
            return true;
        }

        return false;
    }

    public function lower(string $value): string
    {
        return mb_strtolower($value);
    }

    public function counted(array $rows): int
    {
        return count(array_filter($rows, static fn (array $row): bool => $row['active']));
    }
}
`,
    });

    const text = await runModule('php-string-helpers.js', app);

    expect(text).toContain('strpos');
  });
});

describe('sentry tracing', () => {
  test('a sample rate of one in production and spans that are never finished', async () => {
    const app = appWith('sentry-tracing', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'sentry/sentry-symfony': '^4.9' },
      }, null, 2),
      'config/packages/sentry.yaml': `sentry:
    dsn: '%env(SENTRY_DSN)%'
    options:
        traces_sample_rate: 0.2
        profiles_sample_rate: 0.1
`,
      'config/packages/prod/sentry.yaml': `sentry:
    options:
        traces_sample_rate: 1.0
`,
      '.env': `SENTRY_DSN=https://0123456789abcdef@o1.ingest.sentry.io/1
SENTRY_TRACES_SAMPLE_RATE=1.0
SENTRY_ENVIRONMENT=prod
`,
      'src/Tracing/Tracer.php': `<?php

namespace App\\Tracing;

use Sentry\\Tracing\\SpanContext;
use Sentry\\Tracing\\TransactionContext;

use function Sentry\\startTransaction;

class Tracer
{
    public function trace(): void
    {
        $transaction = \\Sentry\\startTransaction(new TransactionContext('checkout'));
        $span = \\Sentry\\startSpan(new SpanContext());
        $transaction->setTag('area', 'checkout');
        $transaction->setContext('order', ['id' => 1]);
        $transaction->setUser(['id' => 1]);
    }

    public function traced(): void
    {
        $transaction = \\Sentry\\startTransaction(new TransactionContext('invoice'));
        $span = \\Sentry\\startSpan(new SpanContext());
        $span->finish();
        $transaction->finish();
    }
}
`,
    });

    const text = await runModule('sentry-performance-tracing.js', app);

    expect(text).toContain('traces_sample_rate');
  });
});

describe('redis sentinel', () => {
  test('a sentinel dsn with two hosts, and one written in a php config', async () => {
    const app = appWith('redis-sentinel', {
      'config/packages/cache.yaml': `framework:
    cache:
        default_redis_provider: 'redis+sentinel://cache-1:26379,cache-2:26379/mymaster'
        app: cache.adapter.redis
`,
      '.env': `REDIS_SENTINEL_DSN=redis+sentinel://cache-1:26379,cache-2:26379,cache-3:26379/mymaster
REDIS_DSN=redis://cache:6379
`,
      '.env.prod': `REDIS_SENTINEL_DSN=redis+sentinel://cache-1:26379,cache-2:26379,cache-3:26379/mymaster
`,
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'redis+sentinel://cache-1:26379,cache-2:26379/mymaster/messages'
`,
    });

    const text = await runModule('symfony-cache-redis-sentinel.js', app);

    expect(text).toContain('sentinel');
  });
});

describe('http client scopes', () => {
  test('scoped clients with basic auth, ntlm, verify off and a plaintext base uri', async () => {
    const app = appWith('httpclient-scopes', {
      'config/packages/framework.yaml': `framework:
    http_client:
        scoped_clients:
            legacy.client:
                base_uri: 'http://legacy.example.com'
                auth_basic: ['acme', 'hunter2']
                verify_peer: false
                verify_host: false
            windows.client:
                base_uri: 'https://sharepoint.example.com'
                auth_ntlm: 'acme:hunter2'
            safe.client:
                base_uri: 'https://api.example.com'
                auth_bearer: '%env(API_TOKEN)%'
`,
      'src/Client/LegacyClient.php': `<?php

namespace App\\Client;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class LegacyClient
{
    public function __construct(private HttpClientInterface $legacyClient)
    {
    }
}
`,
    });

    const text = await runModule('symfony-httpclient-scopes.js', app);

    expect(text).toContain('legacy.client');
    expect(text).not.toContain('hunter2');
  });
});

describe('processes', () => {
  test('processes built from strings, run without a timeout and with shell emulation', async () => {
    const app = appWith('process', {
      'src/Service/Runner.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Process\\Process;

class Runner
{
    public function fromString(string $name): void
    {
        $process = Process::fromShellCommandline('convert ' . $name . ' out.png');
        $process->enableShellEmulation();
        $process->setTimeout(null);
        $process->run();
    }

    public function quoted(): void
    {
        $process = new Process(['convert', 'in.png', 'out.png']);
        $process->setTimeout(60);
        $process->mustRun();
    }

    public function native(string $name): void
    {
        exec('convert ' . $name);
        shell_exec('ls -la');
        system('whoami');
    }
}
`,
    });

    const text = await runModule('symfony-process.js', app);

    expect(text).toContain('Runner');
  });
});

describe('routing loaders', () => {
  test('a loader that supports everything and one that may return null', async () => {
    const app = appWith('routing-loader', {
      'config/services.yaml': `services:
    App\\Routing\\ExtraLoader:
        tags:
            - 'routing.loader'
    App\\Routing\\LooseLoader:
        tags:
            - { name: routing.loader }
`,
      'src/Routing/ExtraLoader.php': `<?php

namespace App\\Routing;

use Symfony\\Component\\Config\\Loader\\Loader;
use Symfony\\Component\\Routing\\RouteCollection;

class ExtraLoader extends Loader
{
    public function load(mixed $resource, ?string $type = null): RouteCollection
    {
        $routes = new RouteCollection();

        return $routes;
    }

    public function supports(mixed $resource, ?string $type = null): bool
    {
        return 'extra' === $type;
    }
}
`,
      'src/Routing/LooseLoader.php': `<?php

namespace App\\Routing;

use Symfony\\Component\\Config\\Loader\\Loader;

class LooseLoader extends Loader
{
    public function load(mixed $resource, ?string $type = null)
    {
        if (!$resource) {
            return null;
        }

        return $this->collection;
    }

    public function supports(mixed $resource, ?string $type = null): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-routing-loader.js', app);

    expect(text).toContain('ExtraLoader');
  });
});

describe('docker compose health', () => {
  test('services with and without a health check, and depends_on with no condition', async () => {
    const app = appWith('compose-health', {
      'docker-compose.yml': `services:
  app:
    image: registry.example.com/acme:latest
    restart: unless-stopped
    depends_on:
      - database
    deploy:
      replicas: 2

  database:
    image: postgres:16
    restart: always
    healthcheck:
      test: ["CMD", "pg_isready"]
      interval: 10s

  cache:
    build: ./docker/redis
    depends_on:
      database:
        condition: service_healthy
`,
      'docker-compose.prod.yml': `services:
  app:
    image: registry.example.com/acme:1.2.3
`,
    });

    const text = await runModule('docker-compose-health.js', app);

    expect(text).toContain('cache');
  });
});

describe('netlify sections', () => {
  test('sections with comments and blank lines between the settings', async () => {
    const app = appWith('netlify-comments', {
      'netlify.toml': `# Acme deployment

[build]
    # what to run
    command = "composer install"

    publish = "public"

[build.environment]
    # the php version to build with
    PHP_VERSION = "8.3"

    APP_SECRET = "0123456789abcdef0123456789abcdef"

[context.production.environment]
    # production only

    APP_ENV = "prod"

[[headers]]
    # every path
    for = "/*"

    [headers.values]
        # security headers
        X-Frame-Options = "SAMEORIGIN"

[[redirects]]
    # the old path
    from = "/old"

    to = "/new"

[functions]
    # bundling
    directory = "netlify/functions"
`,
    });

    const text = await runModule('netlify-deploy-config.js', app);

    expect(text).toContain('build');
  });
});

describe('scheduler expressions', () => {
  test('periodic tasks written in every interval shape', async () => {
    const app = appWith('scheduler-intervals', {
      'src/Scheduler/PeriodicTasks.php': `<?php

namespace App\\Scheduler;

use Symfony\\Component\\Scheduler\\Attribute\\AsPeriodicTask;

#[AsPeriodicTask('PT30S')]
class EverySecondsTask
{
    public function __invoke(): void
    {
    }
}

#[AsPeriodicTask('PT15M')]
class EveryMinutesTask
{
    public function __invoke(): void
    {
    }
}

#[AsPeriodicTask('PT6H')]
class EveryHoursTask
{
    public function __invoke(): void
    {
    }
}

#[AsPeriodicTask('900')]
class EveryRawSecondsTask
{
    public function __invoke(): void
    {
    }
}

#[AsCronTask('not a cron expression')]
class BrokenCronTask
{
    public function __invoke(): void
    {
    }
}
`,
      'config/packages/scheduler.yaml': `framework:
    scheduler:
        schedules:
            default:
                transport: 'doctrine://default'
                tasks:
                    - id: ReportSchedule
                      expression: 'nonsense'
                    - id: CleanupSchedule
                      frequency: '@daily'
            broken: ~
`,
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);

    expect(text).toContain('EverySecondsTask');
  });
});

describe('voter attributes', () => {
  test('attributes declared in a constant, supported but not handled, and the other way round', async () => {
    const app = appWith('voter-attributes', {
      'config/packages/security.yaml': `security:
    access_control:
        - { path: ^/invoice, roles: [INVOICE_VIEW] }
        - { path: ^/report, roles: REPORT_RUN }
`,
      'src/Security/Voter/InvoiceVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class InvoiceVoter extends Voter
{
    public const ATTRIBUTES = ['INVOICE_VIEW', 'INVOICE_EDIT', 'INVOICE_DELETE'];

    protected function supports(string $attribute, mixed $subject): bool
    {
        return in_array($attribute, self::ATTRIBUTES, true);
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return match ($attribute) {
            'INVOICE_VIEW' => true,
            'INVOICE_EDIT' => false,
            'INVOICE_ARCHIVE' => false,
            default => false,
        };
    }
}
`,
    });

    const text = await runModule('symfony-security-custom-voter.js', app);

    expect(text).toContain('INVOICE_VIEW');
  });
});

describe('translation extractors', () => {
  test('keys used in templates and in php against the catalogues', async () => {
    const app = appWith('translation-extractors', {
      'translations/messages.en.yaml': `app:
    title: 'Dashboard'
    subtitle: 'Everything at a glance'
`,
      'translations/messages+intl-icu.en.yaml': `app:
    count: '{count, plural, one {# item} other {# items}}'
`,
      'templates/home/index.html.twig': `<h1>{{ 'app.title'|trans }}</h1>
<p>{{ 'app.missing'|trans }}</p>
{% trans %}app.subtitle{% endtrans %}
`,
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Contracts\\Translation\\TranslatorInterface;

class HomeController
{
    public function index(TranslatorInterface $translator): string
    {
        $translator->trans('app.title');
        $translator->trans('app.absent', [], 'messages');

        return 'ok';
    }
}
`,
    });

    const text = await runModule('symfony-translation-extractors.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('var dumper casters', () => {
  test('a caster that builds an array by hand, one with no stub and one exposing private state', async () => {
    const app = appWith('var-dumper-casters', {
      'src/Caster/InvoiceCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class InvoiceCaster
{
    public static function cast($invoice, array $a, Stub $stub, bool $isNested): array
    {
        $a = [
            'reference' => $invoice->reference,
            'total' => $invoice->total,
        ];

        return $a;
    }
}
`,
      'src/Caster/AccountCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class AccountCaster
{
    protected $secret;

    private $token;

    public static function cast($account, array $a, Stub $stub, bool $isNested)
    {
        $a['password'] = $account->password;

        return $a;
    }
}
`,
      'config/packages/debug.yaml': `debug:
    dump_destination: 'tcp://%env(VAR_DUMPER_SERVER)%'
`,
    });

    const text = await runModule('symfony-var-dumper-casters.js', app);

    expect(text).toContain('Caster');
  });
});

describe('the remaining branches', () => {
  test('a named pipe under public/', async () => {
    const app = appWith('posix-public', {
      'src/public/tools/pipe.php': `<?php

posix_mkfifo(__DIR__ . '/queue', 0666);
// posix_mkfifo('/tmp/other', 0600);
`,
      'src/Service/Opener.php': `<?php

namespace App\\Service;

class Opener
{
    public function open(): void
    {
        $cmd = $_GET['cmd'];
        $handle = proc_open($cmd, [], $pipes);
    }
}
`,
    });

    const text = await runModule('php-posix-functions.js', app);

    expect(text).toContain('posix_mkfifo');
  });

  test('a typed controller wired in a template', async () => {
    const app = appWith('ux-typed-controller', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/ux-typed': '^2.0' },
      }, null, 2),
      'assets/controllers.json': JSON.stringify({
        controllers: { '@symfony/ux-typed': { typed: { enabled: true } } },
      }, null, 2),
      'assets/controllers/hello_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    connect() {
    }
}
`,
      'templates/home/index.html.twig': `<span data-controller="symfony--ux-typed--typed"></span>
`,
      'templates/home/complete.html.twig': `<span data-controller="symfony--ux-typed--typed"
      data-symfony--ux-typed--typed-strings-value='["one","two"]'
      data-symfony--ux-typed--typed-type-speed-value="50"
      data-symfony--ux-typed--typed-loop-value="true"></span>
`,
    });

    const text = await runModule('symfony-ux-typed.js', app);

    expect(text).toContain('Typed');
  });

  test('a state machine written under state_machines:, with an audit trail', async () => {
    const app = appWith('state-machines-key', {
      'config/packages/workflow.yaml': `framework:
    workflows:
        article:
            type: workflow
            places: [draft, published]
            transitions:
                publish:
                    from: draft
                    to: published
    state_machines:
        invoice:
            audit_trail:
                enabled: true
            marking_store:
                type: method
                property: currentPlace
            supports:
                - App\\Entity\\Invoice
            places:
                - draft
                - review
                - approved
            transitions:
                approve:
                    from:
                        - draft
                        - review
                    to: approved
`,
      'config/workflows/nested/order.yaml': `framework:
    workflows:
        order:
            type: workflow
            places: [new, paid]
            transitions:
                pay:
                    from: new
                    to: paid
`,
    });

    const text = await runModule('symfony-workflow-state-machine.js', app);

    expect(text).toContain('article');
  });

  test('a netlify.toml with a malformed setting and an indented values table', async () => {
    const app = appWith('netlify-malformed', {
      'netlify.toml': `[build]
    = missing key
    command = "composer install"

[build.environment]
    = also missing
    PHP_VERSION = "8.3"

[context.production.environment]
    = nothing here either
    APP_ENV = "prod"

[[headers]]
    for = "/*"
    = broken

[headers.values]
    X-Frame-Options = "SAMEORIGIN"
    = broken too

[[redirects]]
    = broken as well
    from = "/old"
    to = "/new"

[functions]
    = and here
    directory = "netlify/functions"
`,
    });

    const text = await runModule('netlify-deploy-config.js', app);

    expect(text).toContain('build');
  });

  test('an api resource asked for by its full class name', async () => {
    const app = appWith('api-platform-details', {
      'config/packages/api_platform.yaml': `api_platform:
    title: Acme API
    version: 1.0.0
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;
use ApiPlatform\\Metadata\\ApiFilter;
use ApiPlatform\\Metadata\\ApiResource;
use ApiPlatform\\Metadata\\Get;

#[ApiResource(
    description: 'A customer invoice',
    security: "is_granted('ROLE_USER')",
    paginationEnabled: true,
    paginationItemsPerPage: 50,
    operations: [new Get()],
)]
#[ApiFilter(SearchFilter::class, properties: ['reference' => 'exact'])]
class Invoice
{
    public ?int $id = null;
}
`,
    });

    const text = await runModule('api-platform.js', app, ['Invoice', 'App\\Entity\\Invoice']);

    expect(text).toContain('Invoice');
  });
});

describe('docker security', () => {
  test('a Dockerfile with a secret in ENV and a compose file with the hardening switches', async () => {
    const app = appWith('docker-security', {
      'Dockerfile': `FROM php:8.3-fpm

ENV APP_ENV=prod
ENV DATABASE_PASSWORD=hunter2

USER root

COPY . /srv/app
`,
      'docker/Dockerfile.prod': `FROM php:latest

RUN apt-get update && apt-get install -y git

USER www-data
`,
      'docker-compose.yml': `services:
  app:
    image: registry.example.com/acme:1.2.3
    privileged: true
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./var:/srv/app/var

  worker:
    image: registry.example.com/acme:1.2.3
    volumes:
      - /etc/passwd:/etc/passwd:ro
`,
    });

    const text = await runModule('docker-security-config.js', app);

    expect(text).toContain('Dockerfile');
  });
});

describe('entity proxies', () => {
  test('a proxy namespace that collides, entities with a private constructor and generated proxies', async () => {
    const app = appWith('entity-proxy', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: true
        proxy_dir: '%kernel.cache_dir%/doctrine/orm/Proxies'
        proxy_namespace: App\\Entity\\Proxies
`,
      'config/packages/prod/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: false
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    private function __construct()
    {
    }

    public static function create(): self
    {
        return new self();
    }
}
`,
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Customer
{
    public function __construct(private string $name)
    {
    }
}
`,
      'var/cache/prod/doctrine/orm/Proxies/__CG__AppEntityInvoice.php': '<?php // proxy\n',
      'var/cache/prod/doctrine/orm/Proxies/nested/__CG__AppEntityCustomer.php': '<?php // proxy\n',
    });

    const text = await runModule('doctrine-entity-proxy.js', app);

    expect(text).toContain('proxy');
  });
});

describe('migration history', () => {
  test('migrations with a gap of years between them', async () => {
    const migration = (version: string): string => `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version${version} extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }
}
`;

    const app = appWith('migration-history', {
      'config/packages/doctrine_migrations.yaml': `doctrine_migrations:
    migrations_paths:
        - '%kernel.project_dir%/migrations'
        - '%kernel.project_dir%/src/Migrations'
    all_or_nothing: false
    transactional: true
`,
      'migrations/Version20200101000000.php': migration('20200101000000'),
      'migrations/Version20200102000000.php': migration('20200102000000'),
      'migrations/Version20260101000000.php': migration('20260101000000'),
    });

    const text = await runModule('doctrine-migration-history.js', app);

    expect(text).toContain('Version20260101000000');
  });
});

describe('sequence generators', () => {
  test('the platform taken from the driver, the platform key and the database url', async () => {
    const platforms = [
      ['pgsql', `doctrine:\n    dbal:\n        driver: pdo_pgsql\n`],
      ['sqlite', `doctrine:\n    dbal:\n        driver: pdo_sqlite\n`],
      ['mssql', `doctrine:\n    dbal:\n        driver: pdo_sqlsrv\n`],
      ['platform-postgres', `doctrine:\n    dbal:\n        server_version: '16'\n        platform_service: postgresql_platform\n`],
      ['platform-mysql', `doctrine:\n    dbal:\n        platform_service: mysql_platform\n`],
      ['platform-sqlite', `doctrine:\n    dbal:\n        platform_service: sqlite_platform\n`],
    ];

    for (const [name, doctrine] of platforms) {
      const app = appWith(`sequence-${name}`, {
        'config/packages/doctrine.yaml': doctrine,
        'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'SEQUENCE')]
    #[ORM\\SequenceGenerator(sequenceName: 'invoice_seq', allocationSize: 1)]
    private ?int $id = null;
}
`,
      });

      const text = await runModule('doctrine-sequence-generator.js', app);

      expect(text.length).toBeGreaterThan(0);
    }

    const fromEnv = appWith('sequence-env', {
      '.env': `DATABASE_URL=postgresql://app:pass@db:5432/acme
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'AUTO')]
    private ?int $id = null;
}
`,
    });

    const envText = await runModule('doctrine-sequence-generator.js', fromEnv);

    expect(envText.length).toBeGreaterThan(0);
  });
});

describe('interface segregation', () => {
  test('a wide interface, a partial implementation and a file with neither', async () => {
    const app = appWith('interface-segregation', {
      'src/Contract/RepositoryInterface.php': `<?php

namespace App\\Contract;

interface RepositoryInterface
{
    public function find(int $id): ?object;

    public function findAll(): iterable;

    public function save(object $entity): void;

    public function remove(object $entity): void;

    public function flush(): void;

    public function beginTransaction(): void;

    public function commit(): void;

    public function rollback(): void;
}
`,
      'src/Repository/PartialRepository.php': `<?php

namespace App\\Repository;

use App\\Contract\\RepositoryInterface;

class PartialRepository implements RepositoryInterface
{
    public function find(int $id): ?object
    {
        return null;
    }

    public function findAll(): iterable
    {
        return [];
    }

    public function save(object $entity): void
    {
        throw new \\BadMethodCallException('not supported');
    }

    public function remove(object $entity): void
    {
        throw new \\BadMethodCallException('not supported');
    }

    public function flush(): void
    {
    }

    public function beginTransaction(): void
    {
    }

    public function commit(): void
    {
    }

    public function rollback(): void
    {
    }
}
`,
      'src/Support/helpers.php': `<?php

function acme_helper(): string
{
    return 'no class and no interface here';
}
`,
    });

    const text = await runModule('php-interface-segregation.js', app);

    expect(text).toContain('RepositoryInterface');
  });
});

describe('var dumper casters', () => {
  test('dump calls left in the code and a caster that replaces the default casters', async () => {
    const app = appWith('var-dumper-dumps', {
      'src/Controller/DebugController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\VarDumper\\Cloner\\AbstractCloner;

class DebugController
{
    public function index(): void
    {
        dump($this->request);
        dd($this->response);
    }

    public function boot(): void
    {
        AbstractCloner::$defaultCasters = [
            'App\\Entity\\Invoice' => ['App\\Caster\\InvoiceCaster', 'cast'],
        ];
    }

    public function cut(): void
    {
        $cloner = new \\Symfony\\Component\\VarDumper\\Cloner\\VarCloner();
        $cloner->setMaxItems(10);
    }
}
`,
    });

    const text = await runModule('symfony-var-dumper-casters.js', app);

    expect(text).toContain('dump');
  });
});

describe('lazy objects', () => {
  test('lazy ghosts and proxies, with and without the skip attribute', async () => {
    const app = appWith('lazy-objects', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.4', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Service/LazyFactory.php': `<?php

namespace App\\Service;

class LazyFactory
{
    public function ghost(): object
    {
        $reflector = new \\ReflectionClass(HeavyService::class);

        return $reflector->newLazyGhost(static function (HeavyService $service): void {
            $service->__construct();
        });
    }

    public function proxy(): object
    {
        $reflector = new \\ReflectionClass(HeavyService::class);

        return $reflector->newLazyProxy(static fn (): HeavyService => new HeavyService());
    }

    public function reset(object $service): void
    {
        $reflector = new \\ReflectionClass($service);
        $reflector->resetAsLazyGhost($service, static fn () => null);
        $reflector->resetAsLazyProxy($service, static fn () => null);
    }
}
`,
      'src/Service/HeavyService.php': `<?php

namespace App\\Service;

class HeavyService
{
    public function __construct()
    {
        $this->connection = new \\PDO('sqlite::memory:');
        file_put_contents('/tmp/acme.log', 'constructed');
    }
}
`,
    });

    const text = await runModule('php-lazy-objects.js', app);

    expect(text).toContain('Lazy');
  });
});

describe('regex injection', () => {
  test('patterns built from variables at every severity', async () => {
    const app = appWith('regex-injection', {
      'src/Service/Matcher.php': `<?php

namespace App\\Service;

class Matcher
{
    public function fromUser(): bool
    {
        return (bool) preg_match('/' . $_GET['pattern'] . '/', 'subject');
    }

    public function fromVariable(string $pattern): bool
    {
        return (bool) preg_match($pattern, 'subject');
    }

    public function interpolated(string $needle): bool
    {
        return (bool) preg_match("/{$needle}/i", 'subject');
    }

    public function quoted(string $needle): bool
    {
        return (bool) preg_match('/' . preg_quote($needle, '/') . '/', 'subject');
    }

    public function replaced(string $pattern, string $subject): string
    {
        return preg_replace($pattern, 'x', $subject);
    }
}
`,
    });

    const text = await runModule('php-regex-injection.js', app);

    expect(text).toContain('Matcher');
  });
});

describe('static analysis ignores', () => {
  test('ignore comments without a rule code, and many of them in one file', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `        // @phpstan-ignore-next-line\n        $this->call${i}();`).join('\n');
    const app = appWith('ignores', {
      'phpstan.neon': `parameters:
    level: 8
    ignoreErrors:
        - '#Call to an undefined method#'
`,
      'psalm.xml': `<?xml version="1.0"?>
<psalm errorLevel="3">
    <issueHandlers>
        <MissingReturnType errorLevel="suppress"/>
    </issueHandlers>
</psalm>
`,
      'src/Service/Suppressed.php': `<?php

namespace App\\Service;

class Suppressed
{
    /** @phpstan-ignore-next-line */
    public function one(): void
    {
    }

    /** @psalm-suppress MissingReturnType */
    public function two()
    {
    }

    /** @phpstan-ignore-line */
    public function three(): void
    {
    }

    public function many(): void
    {
${lines}
    }
}
`,
    });

    const text = await runModule('php-static-analysis-ignore.js', app);

    expect(text).toContain('phpstan-ignore');
  });
});

describe('phpspec', () => {
  test('suites in the config, spec files and a composer script', async () => {
    const app = appWith('phpspec', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpspec/phpspec': '^7.5' },
        scripts: { spec: 'vendor/bin/phpspec run' },
      }, null, 2),
      'phpspec.yml': `suites:
    app_suite:
        namespace: App
        psr4_prefix: App
        src_path: src
        spec_path: spec
    domain_suite:
        namespace: App\\Domain
        src_path: src/Domain
formatter.name: pretty
`,
      'spec/Service/InvoiceBuilderSpec.php': `<?php

namespace spec\\App\\Service;

use App\\Service\\InvoiceBuilder;
use PhpSpec\\ObjectBehavior;

class InvoiceBuilderSpec extends ObjectBehavior
{
    public function it_is_initializable(): void
    {
        $this->shouldHaveType(InvoiceBuilder::class);
    }
}
`,
      'spec/notes.md': 'not a spec\n',
    });

    const text = await runModule('phpspec-config.js', app);

    expect(text).toContain('namespace-mapping');
  });
});

describe('http2 push', () => {
  test('preload links of every kind and a web_link config', async () => {
    const app = appWith('http2-push', {
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\WebLink\\Link;

class HomeController
{
    public function index(): void
    {
        $this->preload('/build/app.css');
        $this->preload('/build/app.js');
        $this->preload('/build/font.woff2');
        $this->preload('/build/hero.avif');
        $this->preload('/build/data.json');
        $this->prefetch('/build/next.js');
        $this->dnsPrefetch('https://cdn.example.com');
        $this->addLink('/build/late.css', rel: 'preload');
        $response->headers->set('Link', '</build/app.css>; rel=preload; as=style');
    }
}
`,
      'config/packages/web_link.yaml': `framework:
    web_link:
        enabled: true
`,
    });

    const text = await runModule('symfony-http2-push.js', app);

    expect(text).toContain('PRELOAD');
  });
});

describe('json login', () => {
  test('json_login with no handlers, stateless, and a check path shared with form_login', async () => {
    const app = appWith('json-login', {
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            pattern: ^/api
            stateless: true
            json_login:
                check_path: /api/login
                username_path: email
                password_path: password
        main:
            lazy: true
            json_login:
                check_path: /login
                success_handler: App\\Security\\LoginSuccessHandler
                failure_handler: App\\Security\\LoginFailureHandler
            form_login:
                check_path: /login
                login_path: /login
`,
    });

    const text = await runModule('symfony-json-login.js', app);

    expect(text).toContain('json_login');
  });
});

describe('voter attribute shapes', () => {
  test('attributes from a constant, from a match and from an equality check', async () => {
    const app = appWith('voter-shapes', {
      'config/packages/security.yaml': `security:
    access_control:
        - { path: ^/invoice, roles: ['INVOICE_VIEW'] }
`,
      'src/Security/Voter/ConstantVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class ConstantVoter extends Voter
{
    public const SUPPORTED_ATTRIBUTES = ['INVOICE_VIEW', 'INVOICE_EDIT'];

    protected function supports(string $attribute, mixed $subject): bool
    {
        return in_array($attribute, self::SUPPORTED_ATTRIBUTES, true);
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        switch ($attribute) {
            case 'INVOICE_VIEW':
                return true;
            case self::INVOICE_EDIT:
                return false;
        }

        if ($attribute === 'INVOICE_ARCHIVE') {
            return false;
        }

        if ($attribute === self::INVOICE_DELETE) {
            return false;
        }

        return false;
    }
}
`,
    });

    const text = await runModule('symfony-security-custom-voter.js', app);

    expect(text).toContain('ConstantVoter');
  });
});

describe('translation extraction with links', () => {
  test('templates and translations reached through directories', async () => {
    const app = appWith('translation-dirs', {
      'templates/home/index.html.twig': `<h1>{{ 'app.title'|trans }}</h1>
`,
      'templates/mail/welcome.html.twig': `<p>{{ 'app.welcome'|trans }}</p>
`,
      'app/Resources/views/legacy.html.twig': `<p>{{ 'app.legacy'|trans }}</p>
`,
      'translations/messages.en.yaml': `app:
    title: 'Dashboard'
    welcome: 'Welcome'
`,
      'translations/messages.en.xlf': `<?xml version="1.0"?>
<xliff version="1.2">
    <file source-language="en" datatype="plaintext" original="file.ext">
        <body>
            <trans-unit id="1">
                <source>app.legacy</source>
                <target>Legacy</target>
            </trans-unit>
        </body>
    </file>
</xliff>
`,
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Contracts\\Translation\\TranslatorInterface;

class HomeController
{
    public function index(TranslatorInterface $translator): string
    {
        return $translator->trans('app.title');
    }
}
`,
    });

    const text = await runModule('symfony-translation-extractors.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('messenger transports and dsns', () => {
  test('a dsn with credentials, no routing, no buses and an unknown transport', async () => {
    const noRouting = appWith('messenger-no-routing', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'amqp://guest:guest@rabbit:5672/%2f/messages'
            unknown: 'acme://queue'
`,
    });
    const empty = appWith('messenger-empty', {
      'config/packages/messenger.yaml': `framework:
    messenger: ~
`,
      'src/Message/PlainMessage.php': `<?php

namespace App\\Message;

final class PlainMessage
{
}
`,
    });

    const one = await runModule('messenger.js', noRouting, ['async']);
    const two = await runModule('messenger.js', empty, ['PlainMessage']);

    expect(one).not.toContain('guest:guest');
    expect(two.length).toBeGreaterThan(0);
  });
});

describe('covariance shapes', () => {
  test('a child that drops the nullable, one that matches and one with no types at all', async () => {
    const app = appWith('covariance-shapes', {
      'src/Contract/Base.php': `<?php

namespace App\\Contract;

abstract class Base
{
    abstract public function nullable(): ?object;

    abstract public function same(): string;

    abstract public function untyped();

    abstract public function widened(): string;
}
`,
      'src/Impl/Child.php': `<?php

namespace App\\Impl;

use App\\Contract\\Base;

final class Child extends Base
{
    public function nullable(): object
    {
        return new \\stdClass();
    }

    public function same(): string
    {
        return '';
    }

    public function untyped()
    {
        return null;
    }

    public function widened(): string|int
    {
        return '';
    }
}
`,
    });

    const text = await runModule('php-covariance.js', app);

    expect(text).toContain('Child');
  });
});

describe('monolog formatters', () => {
  test('custom formatters extending each base, and formatters named in the config', async () => {
    const app = appWith('monolog-formatter', {
      'config/packages/monolog.yaml': `monolog:
    handlers:
        main:
            type: stream
            path: '%kernel.logs_dir%/%kernel.environment%.log'
            formatter: monolog.formatter.json
        console:
            type: console
            formatter: App\\Logger\\LineFormatter
        broken: ~
`,
      'src/Logger/JsonFormatter.php': `<?php

namespace App\\Logger;

use Monolog\\Formatter\\NormalizerFormatter;

class JsonFormatter extends NormalizerFormatter
{
    public function format(array $record): string
    {
        return json_encode($record);
    }
}
`,
      'src/Logger/PlainFormatter.php': `<?php

namespace App\\Logger;

use Monolog\\Formatter\\LineFormatter;

class PlainFormatter extends LineFormatter
{
    public function format(array $record): string
    {
        return $record['message'];
    }
}
`,
      'src/Logger/OddFormatter.php': `<?php

namespace App\\Logger;

class OddFormatter
{
    public function format(array $record): string
    {
        return print_r($record, true);
    }
}
`,
    });

    const text = await runModule('symfony-monolog-formatter.js', app);

    expect(text).toContain('Formatter');
  });
});

describe('monolog rotation', () => {
  test('handlers with no max_files, with zero, with far too many, in /tmp and not bubbling', async () => {
    const app = appWith('monolog-rotation', {
      'config/packages/prod/monolog.yaml': `monolog:
    handlers:
        unlimited:
            type: rotating_file
            path: '%kernel.logs_dir%/unlimited.log'
        zero:
            type: rotating_file
            path: '%kernel.logs_dir%/zero.log'
            max_files: 0
        huge:
            type: rotating_file
            path: '%kernel.logs_dir%/huge.log'
            max_files: 400
        temporary:
            type: rotating_file
            path: /tmp/acme.log
            max_files: 7
        quiet:
            type: rotating_file
            path: '%kernel.logs_dir%/quiet.log'
            max_files: 7
            bubble: false
        shared_one:
            type: rotating_file
            path: '%kernel.logs_dir%/shared.log'
            max_files: 7
        shared_two:
            type: rotating_file
            path: '%kernel.logs_dir%/shared.log'
            max_files: 7
`,
    });

    const text = await runModule('symfony-monolog-rotation.js', app);

    expect(text).toContain('max_files');
  });
});

describe('trusted proxies', () => {
  test('a wildcard, REMOTE_ADDR, direct header access and getClientIp with no proxies', async () => {
    const wildcard = appWith('trusted-proxies-wildcard', {
      'config/packages/framework.yaml': `framework:
    trusted_proxies: '*'
    trusted_headers: ['x-forwarded-for', 'x-forwarded-proto']
`,
      '.env': `TRUSTED_PROXIES=10.0.0.0/8
`,
      'src/Controller/IpController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;

class IpController
{
    public function index(Request $request): string
    {
        $forwarded = $request->headers->get('X-Forwarded-For');

        return $request->getClientIp() . $forwarded;
    }
}
`,
    });
    const remoteAddr = appWith('trusted-proxies-remote', {
      'config/packages/framework.yaml': `framework:
    trusted_proxies: 'REMOTE_ADDR,10.0.0.0/8'
`,
    });
    const none = appWith('trusted-proxies-none', {
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
`,
      'src/Controller/SecureController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;

class SecureController
{
    public function index(Request $request): bool
    {
        $request->getClientIp();

        return $request->isSecure();
    }
}
`,
    });

    const one = await runModule('symfony-trusted-proxies.js', wildcard);
    const two = await runModule('symfony-trusted-proxies.js', remoteAddr);
    const three = await runModule('symfony-trusted-proxies.js', none);

    expect(one).toContain('trusted_proxies');
    expect(two.length).toBeGreaterThan(0);
    expect(three.length).toBeGreaterThan(0);
  });
});

describe('twig cache configuration', () => {
  test('cache and auto_reload and debug set the wrong way round in each environment', async () => {
    const app = appWith('twig-cache', {
      'config/packages/prod/twig.yaml': `twig:
    cache: false
    auto_reload: true
    debug: true
`,
      'config/packages/dev/twig.yaml': `twig:
    cache: '%kernel.cache_dir%/twig'
    auto_reload: false
    debug: false
`,
      'config/packages/twig.yaml': `twig:
    cache: true
    default_path: '%kernel.project_dir%/templates'
`,
      'config/packages/test/twig.yaml': `twig:
    cache: false
    strict_variables: true
`,
    });

    const text = await runModule('symfony-twig-cache-config.js', app);

    expect(text).toContain('cache');
  });
});

describe('behat steps', () => {
  test('feature steps that match a definition, one that does not and a definition nobody uses', async () => {
    const app = appWith('behat-steps', {
      'features/bootstrap/FeatureContext.php': `<?php

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
    /**
     * @Given I am on the home page
     */
    public function iAmOnTheHomePage(): void
    {
    }

    /**
     * @When I click :label
     */
    public function iClick(string $label): void
    {
    }

    /**
     * @Then /^I should see .*$/
     */
    public function iShouldSee(): void
    {
    }

    /**
     * @Given I am never used anywhere
     */
    public function neverUsed(): void
    {
    }
}
`,
      'features/home.feature': `Feature: The home page

    Scenario: Visiting the home page
        Given I am on the home page
        When I click "Sign in"
        Then I should see the login form

    Scenario: A step nobody defined
        Given I am on the moon
`,
    });

    const text = await runModule('behat-step-coverage.js', app);

    expect(text).toContain('Undefined Steps');
  });
});

describe('bitbucket pipelines', () => {
  test('a privileged step, a secret in a script and steps of every kind', async () => {
    const app = appWith('bitbucket', {
      'bitbucket-pipelines.yml': `image: php:8.3

pipelines:
    default:
        - step:
              name: Test
              script:
                  - composer install
                  - vendor/bin/phpunit
        - step:
              name: Security
              script:
                  - vendor/bin/snyk test
        - step:
              name: Build
              services:
                  - docker
              script:
                  - export REGISTRY_PASSWORD=hunter2
                  - docker build -t acme .
        - step:
              name: Deploy
              deployment: production
              script:
                  - kubectl apply -f k8s/
`,
    });

    const text = await runModule('bitbucket-pipelines-config.js', app);

    expect(text).toContain('Deploy');
  });
});

describe('deptrac', () => {
  test('layers, a ruleset that lets the domain reach infrastructure, and a baseline', async () => {
    const app = appWith('deptrac', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'qossmic/deptrac-shim': '^1.0' },
      }, null, 2),
      'deptrac.yaml': `deptrac:
    paths:
        - ./src
    layers:
        - name: Domain
          collectors:
              - type: directory
                value: src/Domain/.*
        - name: Application
          collectors:
              - type: directory
                value: src/Application/.*
        - name: Infrastructure
          collectors:
              - type: directory
                value: src/Infrastructure/.*
ruleset:
    Domain:
        - Infrastructure
    Application:
        - Domain
        - Infrastructure
skip_violations: []
`,
      '.deptrac.baseline.yaml': `deptrac:
    skip_violations:
        App\\Domain\\Invoice:
            - App\\Infrastructure\\Doctrine\\InvoiceRepository
`,
    });

    const text = await runModule('deptrac-config.js', app);

    expect(text).toContain('Domain');
  });
});

describe('entity graph', () => {
  test('a self-referential entity, a deep inheritance chain and a cycle', async () => {
    const app = appWith('entity-graph', {
      'src/Entity/Category.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Category
{
    #[ORM\\ManyToOne(targetEntity: Category::class)]
    private ?Category $parent = null;

    #[ORM\\OneToMany(targetEntity: Category::class, mappedBy: 'parent')]
    private $children;
}
`,
      'src/Entity/Base.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\InheritanceType('SINGLE_TABLE')]
class Base
{
}
`,
      'src/Entity/Middle.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Middle extends Base
{
}
`,
      'src/Entity/Leaf.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Leaf extends Middle
{
    #[ORM\\ManyToOne(targetEntity: Invoice::class)]
    private ?Invoice $invoice = null;
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\ManyToOne(targetEntity: Customer::class)]
    private ?Customer $customer = null;
}
`,
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Customer
{
    #[ORM\\OneToMany(targetEntity: Invoice::class, mappedBy: 'customer')]
    private $invoices;
}
`,
    });

    const text = await runModule('doctrine-entity-graph.js', app);

    expect(text).toContain('Category');
  });
});

describe('phpstan baseline size', () => {
  test('a baseline named in the config and counted by its messages', async () => {
    const baseline = Array.from({ length: 210 }, (_, i) => `        -\n            message: "#^Error ${i}$#"\n            count: 1\n            path: src/Legacy.php`).join('\n');
    const app = appWith('phpstan-baseline', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpstan/phpstan': '^1.10' },
      }, null, 2),
      'phpstan.dist.neon': `includes:
    - baseline.neon

includeBaseline: baseline.neon

parameters:
    level: 5
    reportUnmatchedIgnoredErrors: false
    paths:
        - src
`,
      'baseline.neon': `parameters:
    ignoreErrors:
${baseline}
`,
    });

    const text = await runModule('phpstan-config.js', app);

    expect(text).toContain('phpstan.dist.neon');
  });
});

describe('process return codes', () => {
  test('run() whose result nobody checks, and one that is checked', async () => {
    const unchecked = appWith('process-unchecked', {
      'src/Service/Deployer.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Process\\Process;

class Deployer
{
    public function deploy(): void
    {
        $process = new Process(['bin/deploy']);
        $process->run();
    }
}
`,
    });
    const checked = appWith('process-checked', {
      'src/Service/Builder.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Process\\Process;

class Builder
{
    public function build(): int
    {
        $process = new Process(['bin/build']);
        $code = $process->run();

        return $code;
    }
}
`,
    });
    const quoted = appWith('process-quoted', {
      'src/Service/Archiver.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Process\\Process;

class Archiver
{
    public function archive(): void
    {
        $process = Process::fromShellCommandline("tar -czf 'archive.tgz' var/");
        $process->mustRun();
    }

    public function plain(): void
    {
        $process = Process::fromShellCommandline('ls -la');
        $process->mustRun();
    }
}
`,
    });

    const one = await runModule('symfony-process.js', unchecked);
    const two = await runModule('symfony-process.js', checked);
    const three = await runModule('symfony-process.js', quoted);

    expect(one).toContain('Deployer');
    expect(two).toContain('Builder');
    expect(three).toContain('Archiver');
  });
});

describe('mysql specifics', () => {
  test('utf8 instead of utf8mb4, a collation and json kept as a string', async () => {
    const app = appWith('mysql-specific', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        driver: pdo_mysql
        charset: utf8
        default_table_options:
            charset: utf8
            collate: utf8_general_ci
`,
      'src/Entity/Payload.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(options: ['charset' => 'utf8', 'collate' => 'utf8_general_ci'])]
class Payload
{
    #[ORM\\Column(type: 'string', length: 4000)]
    private string $json = '{}';

    #[ORM\\Column(type: 'json')]
    private array $data = [];
}
`,
    });

    const text = await runModule('doctrine-mysql-specific.js', app);

    expect(text).toContain('utf8');
  });
});

describe('environment configuration differences', () => {
  test('bundles enabled per environment and packages overridden only in dev', async () => {
    const app = appWith('env-config-diff', {
      'config/bundles.php': `<?php

return [
    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],
    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['dev' => true, 'test' => true],
    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ['dev' => true],
    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],
];
`,
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
`,
      'config/packages/dev/monolog.yaml': `monolog:
    handlers:
        main:
            type: stream
`,
      'config/packages/dev/web_profiler.yaml': `web_profiler:
    toolbar: true
`,
      'config/packages/prod/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: false
`,
      'config/packages/test/framework.yaml': `framework:
    test: true
`,
    });

    const text = await runModule('env-config-diff.js', app);

    expect(text).toContain('dev');
  });
});

describe('fixture dependencies', () => {
  test('fixtures that depend on each other and one that does not', async () => {
    const app = appWith('fixtures-graph', {
      'src/DataFixtures/UserFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class UserFixtures extends Fixture implements DependentFixtureInterface
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }

    public function getDependencies(): array
    {
        return [GroupFixtures::class, RoleFixtures::class];
    }
}
`,
      'src/DataFixtures/GroupFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class GroupFixtures extends Fixture implements DependentFixtureInterface
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }

    public function getDependencies(): array
    {
        return [RoleFixtures::class];
    }
}
`,
      'src/DataFixtures/RoleFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class RoleFixtures extends Fixture
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }
}
`,
      'src/DataFixtures/notes.md': 'not a fixture\n',
    });

    const text = await runModule('fixtures.js', app, ['UserFixtures']);

    expect(text).toContain('UserFixtures');
  });
});

describe('log files', () => {
  test('a log read, searched and summarised', async () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      `[2026-09-0${(i % 9) + 1}T10:0${i % 10}:00+00:00] app.${i % 4 === 0 ? 'ERROR' : 'INFO'}: Message ${i} {"user":"acme"} []`,
    ).join('\n');
    const app = appWith('logs', {
      'var/log/prod.log': lines + '\n',
      'var/log/dev.log': `[2026-09-01T10:00:00+00:00] app.CRITICAL: Boom {"exception":"RuntimeException"} []\n`,
      'var/log/notes.txt': 'not a log\n',
    });

    const text = await runModule('logs.js', app, ['prod.log', 'prod', 'ERROR']);

    expect(text).toContain('prod.log');
  });
});

describe('frankenphp', () => {
  test('a Caddyfile with self-signed tls, http3 and mercure, and worker settings in compose', async () => {
    const app = appWith('frankenphp', {
      'Caddyfile': `{
    frankenphp
    order php_server before file_server
}

acme.example.com {
    tls internal
    root * public/
    encode zstd br gzip
    php_server
    mercure {
        publisher_jwt {env.MERCURE_PUBLISHER_JWT_KEY}
    }
    protocols h3 h2 h1
}
`,
      'docker-compose.yml': `services:
  php:
    image: dunglas/frankenphp
    environment:
      FRANKENPHP_CONFIG: "worker ./public/index.php"
      APP_WORKER_COUNT: 8
      SERVER_NAME: acme.example.com
`,
      'Dockerfile': `FROM dunglas/frankenphp:latest

COPY . /app
`,
    });

    const text = await runModule('frankenphp-config.js', app);

    expect(text).toContain('FrankenPHP');
  });
});

describe('nginx and php-fpm', () => {
  test('a body size limit, access log off, hsts, and an fpm pool', async () => {
    const app = appWith('nginx-fpm', {
      'docker/nginx/default.conf': `server {
    listen 80;
    server_name acme.example.com;
    root /srv/app/public;

    client_max_body_size 512m;
    access_log off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff;

    location ~ ^/index\\.php(/|$) {
        fastcgi_pass php:9000;
    }
}
`,
      'docker/php/www.conf': `[www]
user = www-data
pm = ondemand
pm.max_children = 500
pm.start_servers = 2
request_terminate_timeout = 0
catch_workers_output = yes
`,
    });

    const text = await runModule('nginx-php-fpm.js', app);

    expect(text).toContain('client_max_body_size');
  });
});

describe('opcache and apcu', () => {
  test('opcache off in one file and on without preload in another', async () => {
    const off = appWith('opcache-off', {
      'docker/php/php.ini': `opcache.enable = 0
opcache.validate_timestamps = 1
`,
    });
    const on = appWith('opcache-on', {
      'docker/php.ini': `opcache.enable = 1
opcache.validate_timestamps = 0
opcache.memory_consumption = 256
extension = apcu
apcu.enable = 1
`,
    });

    const one = await runModule('opcache-apcu-config.js', off);
    const two = await runModule('opcache-apcu-config.js', on);

    expect(one).toContain('OPcache');
    expect(two).toContain('OPcache');
  });
});

describe('openai', () => {
  test('an api key in .env, one hardcoded in code and a prompt built from user input', async () => {
    const app = appWith('openai', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'openai-php/client': '^0.10' },
      }, null, 2),
      '.env': `OPENAI_API_KEY=sk-proj-0123456789abcdef0123456789abcdef
OPENAI_MODEL=gpt-4o
`,
      'src/Ai/Assistant.php': `<?php

namespace App\\Ai;

use OpenAI;

class Assistant
{
    public function ask(string $question): string
    {
        $client = OpenAI::client('sk-proj-abcdef0123456789abcdef0123456789');

        $response = $client->chat()->create([
            'model' => 'gpt-4o',
            'messages' => [
                ['role' => 'user', 'content' => $_GET['prompt']],
            ],
        ]);

        return $response->choices[0]->message->content;
    }
}
`,
    });

    const text = await runModule('openai-integration.js', app);

    expect(text).toContain('OPENAI_API_KEY');
    expect(text).not.toContain('sk-proj-0123456789abcdef0123456789abcdef');
  });
});

describe('translation plurals', () => {
  test('catalogues in languages with one, three and four plural forms', async () => {
    const app = appWith('translation-plurals', {
      'translations/messages.ja.yaml': `app:
    apples: 'ringo'
`,
      'translations/messages.pl.yaml': `app:
    apples: 'jablko|jablka|jablek'
`,
      'translations/messages.cy.yaml': `app:
    apples: 'afal|afalau|afalau|afalau'
`,
      'translations/messages.en.yaml': `app:
    apples: 'one apple|%count% apples'
    single: 'no bar here'
`,
      'translations/messages.fr.yaml': `app:
    apples: 'une pomme'
`,
    });

    const text = await runModule('symfony-translation-lint-all.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('panther', () => {
  test('a panther test that asserts without waiting, and the client set up in several ways', async () => {
    const app = appWith('panther', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'symfony/panther': '^2.1' },
      }, null, 2),
      'phpunit.xml': `<?xml version="1.0"?>
<phpunit bootstrap="tests/bootstrap.php">
    <php>
        <server name="PANTHER_APP_ENV" value="panther"/>
        <server name="PANTHER_ERROR_SCREENSHOT_DIR" value="./var/error-screenshots"/>
    </php>
</phpunit>
`,
      'tests/Panther/CheckoutTest.php': `<?php

namespace App\\Tests\\Panther;

use Symfony\\Component\\Panther\\PantherTestCase;

class CheckoutTest extends PantherTestCase
{
    public function testCheckout(): void
    {
        $client = static::createPantherClient();
        $client->request('GET', '/checkout');

        self::assertSelectorExists('.checkout-form');
    }
}
`,
      'tests/Panther/CartTest.php': `<?php

namespace App\\Tests\\Panther;

use Symfony\\Component\\Panther\\PantherTestCase;

class CartTest extends PantherTestCase
{
    public function testCart(): void
    {
        $client = static::createPantherClient(['browser' => PantherTestCase::FIREFOX]);
        $client->request('GET', '/cart');
        $client->waitFor('.cart');

        self::assertSelectorExists('.cart');
    }
}
`,
    });

    const text = await runModule('panther-testing.js', app);

    expect(text).toContain('CheckoutTest');
  });
});

describe('ftp and sftp', () => {
  test('a password in the environment, a plain ftp connection and an sftp one', async () => {
    const app = appWith('ftp-sftp', {
      '.env': `FTP_PASSWORD=hunter2
SFTP_PASSWORD=hunter3
SFTP_PASS=hunter4
`,
      'src/Service/Uploader.php': `<?php

namespace App\\Service;

class Uploader
{
    public function plain(): void
    {
        $conn = ftp_connect('ftp.example.com');
        ftp_login($conn, 'acme', $_ENV['FTP_PASSWORD']);
        ftp_put($conn, 'remote.txt', 'local.txt', FTP_ASCII);
        ftp_close($conn);
    }

    public function secure(): void
    {
        $conn = ftp_ssl_connect('ftp.example.com');
        ftp_login($conn, 'acme', $_ENV['FTP_PASSWORD']);
    }

    public function sftp(): void
    {
        $ssh = ssh2_connect('sftp.example.com', 22);
        ssh2_auth_password($ssh, 'acme', $_ENV['SFTP_PASSWORD']);
        $sftp = ssh2_sftp($ssh);
    }
}
`,
    });

    const text = await runModule('php-ftp-sftp-patterns.js', app);

    expect(text).toContain('ftp');
    expect(text).not.toContain('hunter2');
  });
});

describe('imap', () => {
  test('a mailbox opened from user input and a body printed without sanitising', async () => {
    const app = appWith('imap', {
      'src/Mail/Reader.php': `<?php

namespace App\\Mail;

class Reader
{
    public function open(): void
    {
        $mailbox = imap_open('{' . $_GET['host'] . '}INBOX', $_GET['user'], $_GET['pass']);
        $headers = imap_headers($mailbox);
        $body = imap_body($mailbox, 1);
        echo $body;
        imap_close($mailbox);
    }

    public function search(): void
    {
        $mailbox = imap_open('{mail.example.com}INBOX', 'acme', 'secret');
        $result = imap_search($mailbox, 'SUBJECT "' . $_POST['subject'] . '"');
    }
}
`,
    });

    const text = await runModule('php-imap-patterns.js', app);

    expect(text).toContain('imap');
  });
});

describe('memory management', () => {
  test('a huge range, memory_limit off and a very large limit', async () => {
    const app = appWith('memory', {
      'src/Service/Streamer.php': `<?php

namespace App\\Service;

class Streamer
{
    public function rows(): \\Generator
    {
        yield 1;
    }

    public function eager(): array
    {
        return iterator_to_array($this->rows());
    }

    public function chained(array $rows): array
    {
        return array_values(array_filter(array_map(static fn ($r) => $r, $this->repository->findAll())));
    }

    public function all(): void
    {
        foreach ($this->repository->findAll() as $row) {
            $this->handle($row);
        }
    }

    public function chunked(): void
    {
        foreach (array_chunk($this->ids, 100) as $chunk) {
            $this->handle($chunk);
        }
    }
}
`,
      'src/Entity/Node.php': `<?php

namespace App\\Entity;

class Node
{
    private $parent;

    private ?Node $head = null;

    private $children = [];

    public function addChild(Node $child): void
    {
        $this->children[] = $child;
        $child->parent = $this;
    }
}
`,
      'src/Service/Big.php': `<?php

namespace App\\Service;

class Big
{
    public function build(): array
    {
        ini_set('memory_limit', '-1');

        return range(0, 500000);
    }

    public function bigger(): array
    {
        ini_set('memory_limit', '4G');

        return range(0, 200000);
    }

    public function reasonable(): array
    {
        ini_set('memory_limit', '512M');

        return range(0, 100);
    }
}
`,
    });

    const text = await runModule('php-memory-management.js', app);

    expect(text).toContain('memory_limit');
  });
});

describe('sockets', () => {
  test('plain and tls sockets, and one bound to every interface', async () => {
    const app = appWith('sockets', {
      'src/Net/Client.php': `<?php

namespace App\\Net;

class Client
{
    public function plain(): void
    {
        $socket = fsockopen('example.com', 80, $errno, $errstr, 30);
        $stream = stream_socket_client('tcp://example.com:80');
    }

    public function secure(): void
    {
        $stream = stream_socket_client('tls://example.com:443');
        $other = stream_socket_client('ssl://example.com:443');
    }

    public function server(): void
    {
        $server = stream_socket_server('tcp://0.0.0.0:8080');
        $socket = socket_create(AF_INET, SOCK_STREAM, SOL_TCP);
        socket_bind($socket, '0.0.0.0', 9000);
    }
}
`,
    });

    const text = await runModule('php-socket-programming.js', app);

    expect(text).toContain('socket');
  });
});

describe('regex report sections', () => {
  test('findings of medium and low severity in the report', async () => {
    const app = appWith('regex-severities', {
      'src/Service/Patterns.php': `<?php

namespace App\\Service;

class Patterns
{
    public function indirect(string $pattern): bool
    {
        $built = '/' . $pattern . '/';

        return (bool) preg_match($built, 'subject');
    }

    public function risky(array $parts): bool
    {
        return (bool) preg_match('/' . implode('|', $parts) . '/', 'subject');
    }

    public function split(string $pattern, string $subject): array
    {
        return preg_split($pattern, $subject);
    }

    public function grep(string $pattern, array $rows): array
    {
        return preg_grep($pattern, $rows);
    }
}
`,
    });

    const text = await runModule('php-regex-injection.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('render.com', () => {
  test('services of every type, a free web plan and a plain-text env var', async () => {
    const app = appWith('render', {
      'render.yaml': `services:
  - type: web
    name: acme
    env: php
    plan: free
    buildCommand: composer install
    startCommand: heroku-php-apache2 public/
    envVars:
      - key: APP_ENV
        value: prod
      - key: DATABASE_PASSWORD
        value: hunter2
      - key: APP_SECRET
        sync: false

  - type: worker
    name: acme-worker
    env: php
    plan: starter
    startCommand: php bin/console messenger:consume async

  - type: pserv
    name: acme-private
    env: php

  - type: cron
    name: acme-cron
    schedule: "0 3 * * *"
    command: php bin/console app:cleanup

  - type: static
    name: acme-site
    buildCommand: npm run build
    staticPublishPath: ./public
`,
    });

    const text = await runModule('render-deploy-config.js', app);

    expect(text).toContain('acme');
    expect(text).not.toContain('hunter2');
  });
});

describe('sockets bound to sensitive ports', () => {
  test('a server bound to every interface on a database port, and a tls one', async () => {
    const app = appWith('socket-ports', {
      'src/Net/Server.php': `<?php

namespace App\\Net;

class Server
{
    public function exposed(): void
    {
        $server = stream_socket_server('tcp://0.0.0.0:3306');
        socket_bind($this->socket, '0.0.0.0', 6379);
    }

    public function local(): void
    {
        $server = stream_socket_server('tcp://127.0.0.1:3306');
    }

    public function secure(): void
    {
        $client = stream_socket_client('tls://0.0.0.0:5432');
        // socket_bind($this->socket, '0.0.0.0', 27017);
    }
}
`,
    });

    const text = await runModule('php-socket-programming.js', app);

    expect(text).toContain('Server');
  });
});

describe('phpunit test naming', () => {
  test('tests named with the annotation, the attribute and the test prefix', async () => {
    const app = appWith('test-naming', {
      'tests/Service/InvoiceTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\Attributes\\Test;
use PHPUnit\\Framework\\TestCase;

class InvoiceTest extends TestCase
{
    /**
     * @test
     */
    public function it_builds_an_invoice(): void
    {
        self::assertTrue(true);
    }

    #[Test]
    public function itSendsTheInvoice(): void
    {
        self::assertTrue(true);
    }

    public function testTotalsAreRounded(): void
    {
        self::assertTrue(true);
    }

    public function test_totals_are_rounded_again(): void
    {
        self::assertTrue(true);
    }

    public function helper(): void
    {
    }
}
`,
      'tests/Service/notes.md': 'not a test\n',
    });

    const text = await runModule('phpunit-test-naming.js', app);

    expect(text).toContain('InvoiceTest');
  });
});

describe('prometheus records', () => {
  test('a recording rule with and without labels, and an alert using topk', async () => {
    const app = appWith('prometheus-records', {
      'monitoring/records.rules.yaml': `groups:
    - name: acme-records
      rules:
          - record: job:http_requests:rate5m
            expr: rate(http_requests_total[5m])
            labels:
                job: acme

          - record: job:http_errors:rate5m
            expr: rate(http_errors_total[5m])

          - alert: TopKNoLimit
            expr: topk(http_request_duration_seconds) > 2
            for: 5m
            labels:
                severity: warning
            annotations:
                summary: Slow
                description: Slow responses
`,
    });

    const text = await runModule('prometheus-alerting-rules.js', app);

    expect(text).toContain('job:http_requests:rate5m');
  });
});

describe('log tools', () => {
  test('a log searched, tailed, summarised and asked for by environment', async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      `[2026-09-01T10:${String(i).padStart(2, '0')}:00+00:00] app.${i % 3 === 0 ? 'ERROR' : 'INFO'}: Entry ${i} {"ctx":1} []`,
    ).join('\n');
    const app = appWith('log-tools', {
      'var/log/prod.log': entries + '\n',
      'var/log/dev.log': entries + '\n',
      'var/log/test.log': `[2026-09-01T10:00:00+00:00] app.WARNING: Careful {} []\n`,
    });

    const text = await runModule('logs.js', app, ['prod.log', 'ERROR', 'prod']);

    expect(text).toContain('prod.log');
  });
});

describe('behat step matching', () => {
  test('a definition too long to compile as a regex and one that is not valid', async () => {
    const long = 'a'.repeat(320);
    const app = appWith('behat-long-patterns', {
      'features/bootstrap/FeatureContext.php': `<?php

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
    /**
     * @Given /^${long}$/
     */
    public function veryLong(): void
    {
    }

    /**
     * @When /^I click (unbalanced$/
     */
    public function unbalanced(): void
    {
    }
}
`,
      'features/long.feature': `Feature: Long patterns

    Scenario: A long step
        Given ${long}
        When I click (unbalanced
`,
    });

    const text = await runModule('behat-step-coverage.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('phpspec suites', () => {
  test('suites written at the indentation the parser expects', async () => {
    const app = appWith('phpspec-suites', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpspec/phpspec': '^7.5' },
      }, null, 2),
      'phpspec.yml': `suites:
  app_suite:
    namespace: App
    psr4_prefix: App
    src_path: src
  domain_suite:
    namespace: App\\Domain
    src_path: src/Domain
`,
      'spec/Service/BuilderSpec.php': `<?php

namespace spec\\App\\Service;

use PhpSpec\\ObjectBehavior;

class BuilderSpec extends ObjectBehavior
{
    public function it_is_initializable(): void
    {
    }
}
`,
    });

    const text = await runModule('phpspec-config.js', app);

    expect(text).toContain('suite');
  });
});

describe('configuration extensions', () => {
  test('an extension whose alias is not snake_case and one that sets a hardcoded parameter', async () => {
    const app = appWith('config-extensions', {
      'src/DependencyInjection/AcmeExtension.php': `<?php

namespace App\\DependencyInjection;

use Symfony\\Component\\DependencyInjection\\ContainerBuilder;
use Symfony\\Component\\HttpKernel\\DependencyInjection\\Extension;

class AcmeExtension extends Extension
{
    public function getAlias(): string
    {
        return 'AcmeBundle';
    }

    public function load(array $configs, ContainerBuilder $container): void
    {
        $container->setParameter('acme.api_url', 'https://api.example.com');
        $container->setParameter('acme.token', '%env(ACME_TOKEN)%');
    }
}
`,
      'src/DependencyInjection/OtherExtension.php': `<?php

namespace App\\DependencyInjection;

use Symfony\\Component\\DependencyInjection\\ContainerBuilder;
use Symfony\\Component\\HttpKernel\\DependencyInjection\\Extension;

class OtherExtension extends Extension
{
    public function getAlias(): string
    {
        return 'other_thing';
    }

    public function load(array $configs, ContainerBuilder $container): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-config-extensions.js', app);

    expect(text).toContain('AcmeExtension');
  });
});

describe('html sanitizer', () => {
  test('a sanitizer that allows everything, dangerous elements and event attributes', async () => {
    const app = appWith('html-sanitizer', {
      'config/packages/html_sanitizer.yaml': `framework:
    html_sanitizer:
        sanitizers:
            app.sanitizer:
                allow_all_static_elements: true
                allow_all_attributes: true
                allow_elements:
                    script: ['src']
                    iframe: ['src', 'onload']
                    p: ['class']
                allow_attributes:
                    onclick: '*'
                    onerror: '*'
                    class: '*'
                block_elements: ['style']
`,
      'src/Service/Sanitizer.php': `<?php

namespace App\\Service;

use Symfony\\Component\\HtmlSanitizer\\HtmlSanitizerInterface;

class Sanitizer
{
    public function __construct(private HtmlSanitizerInterface $appSanitizer)
    {
    }

    public function clean(string $html): string
    {
        return $this->appSanitizer->sanitize($html);
    }
}
`,
      'templates/post/show.html.twig': `<div>{{ post.body|sanitize_html('app.sanitizer') }}</div>
`,
    });

    const text = await runModule('symfony-html-sanitizer.js', app);

    expect(text).toContain('sanitizer');
  });
});

describe('mailer failover', () => {
  test('every transport scheme, a failover with one transport and an async one', async () => {
    const app = appWith('mailer-fallback', {
      '.env': `MAILER_DSN=failover(smtp://one.example.com)
`,
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'roundrobin(sendgrid://KEY@default)'
        transports:
            main: 'sendmail://default'
            amazon: 'ses+smtp://KEY:SECRET@default'
            mailchimp: 'mandrill://KEY@default'
            grid: 'sendgrid://KEY@default'
            async: 'messenger://async'
`,
    });

    const text = await runModule('symfony-mailer-smtp-fallback.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('password migration', () => {
  test('a migrating hasher, a long migration chain and a legacy hash call', async () => {
    const app = appWith('password-migrator', {
      'config/packages/security.yaml': `security:
    password_hashers:
        App\\Entity\\User:
            algorithm: auto
            migrate_from:
                - md5
                - sha256
                - bcrypt
                - sodium
        legacy:
            algorithm: md5
            migrate_from: sha1
`,
      'src/Security/UserRepository.php': `<?php

namespace App\\Security;

use Symfony\\Component\\PasswordHasher\\Hasher\\MigratingPasswordHasher;
use Symfony\\Component\\Security\\Core\\User\\PasswordUpgraderInterface;

class UserRepository implements PasswordUpgraderInterface
{
    public function build(): MigratingPasswordHasher
    {
        return new MigratingPasswordHasher($this->best, ...$this->extra);
    }

    public function legacy(string $password): string
    {
        return $this->legacyHasher->hash($password);
    }
}
`,
    });

    const text = await runModule('symfony-password-migrator.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('mailer dsn shapes', () => {
  test('each transport scheme in its own .env, and failover with a single transport', async () => {
    const dsns = [
      ['sendmail', 'sendmail://default'],
      ['ses', 'ses+smtp://KEY:SECRET@default'],
      ['mandrill', 'mandrill://KEY@default'],
      ['sendgrid', 'sendgrid://KEY@default'],
      ['async', 'messenger://async'],
      ['failover-one', 'failover(smtp://only.example.com)'],
      ['roundrobin-one', 'roundrobin(smtp://only.example.com)'],
      ['null', 'null://null'],
    ];

    for (const [name, dsn] of dsns) {
      const app = appWith(`mailer-dsn-${name}`, {
        '.env': `MAILER_DSN=${dsn}\n`,
      });

      const text = await runModule('symfony-mailer-smtp-fallback.js', app);

      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('role hierarchy', () => {
  test('a cycle between roles and a role nobody references', async () => {
    const app = appWith('role-hierarchy', {
      'config/packages/security.yaml': `security:
    role_hierarchy:
        ROLE_ADMIN: [ROLE_USER]
        ROLE_USER: [ROLE_ADMIN]
        ROLE_SUPER_ADMIN: [ROLE_ADMIN, ROLE_ALLOWED_TO_SWITCH]
        ROLE_ORPHAN: [ROLE_USER]
    access_control:
        - { path: ^/admin, roles: ROLE_ADMIN }
`,
      'src/Controller/AdminController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\Security\\Http\\Attribute\\IsGranted;

class AdminController
{
    #[IsGranted('ROLE_ADMIN')]
    public function index(): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-role-hierarchy.js', app);

    expect(text).toContain('ROLE_ADMIN');
  });
});

describe('tagged iterators', () => {
  test('a locator used without has(), and tags written as strings and as maps', async () => {
    const app = appWith('tagged-iterator', {
      'config/services.yaml': `services:
    App\\Handler\\HandlerCollection:
        arguments:
            - tagged_iterator: app.handler

    App\\Handler\\EmailHandler:
        tags:
            - 'app.handler'
            - { name: app.notifier, priority: 10 }
            - { priority: 5 }
`,
      'src/Handler/HandlerCollection.php': `<?php

namespace App\\Handler;

use Symfony\\Component\\DependencyInjection\\Attribute\\AutowireLocator;
use Symfony\\Component\\DependencyInjection\\ServiceLocator;

class HandlerCollection
{
    public function __construct(
        #[AutowireLocator('app.handler')] private ServiceLocator $handlers,
    ) {
    }

    public function get(string $name): object
    {
        return $this->handlers->get($name);
    }
}
`,
    });

    const text = await runModule('symfony-tagged-iterator.js', app);

    expect(text).toContain('app.handler');
  });
});

describe('kernel in tests', () => {
  test('a test that keeps the client between tests and one that resets it', async () => {
    const app = appWith('test-http-kernel', {
      'tests/Controller/LeakyTest.php': `<?php

namespace App\\Tests\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class LeakyTest extends WebTestCase
{
    private static $client;

    protected function setUp(): void
    {
        $this->client = static::createClient();
    }

    public function testHome(): void
    {
        $this->client->request('GET', '/');
        self::assertResponseIsSuccessful();
    }
}
`,
      'tests/Controller/TidyTest.php': `<?php

namespace App\\Tests\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class TidyTest extends WebTestCase
{
    private static $client;

    protected function setUp(): void
    {
        $this->client = static::createClient();
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        $this->client = null;
    }

    public function testHome(): void
    {
        $this->client->request('GET', '/');
        self::assertResponseIsSuccessful();
    }
}
`,
    });

    const text = await runModule('symfony-test-http-kernel.js', app);

    expect(text).toContain('LeakyTest');
  });
});

describe('validator auto mapping', () => {
  test('auto-mapped namespaces, explicit constraints and the compromised password check', async () => {
    const entities = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `src/Entity/Mapped${i}.php`,
        `<?php\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\nclass Mapped${i}\n{\n    #[ORM\\Column(length: 255)]\n    private string $name = '';\n}\n`,
      ]),
    );
    const explicit = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `src/Entity/Explicit${i}.php`,
        `<?php\n\nnamespace App\\Entity;\n\nuse Symfony\\Component\\Validator\\Constraints as Assert;\n\nclass Explicit${i}\n{\n    #[Assert\\NotBlank]\n    private string $name = '';\n}\n`,
      ]),
    );
    const app = appWith('validator-auto-mapping', {
      'config/packages/validator.yaml': `framework:
    validation:
        auto_mapping:
            'App\\Entity\\': []
        not_compromised_password:
            enabled: true
`,
      ...entities,
      ...explicit,
    });

    const text = await runModule('symfony-validator-auto-mapping.js', app);

    expect(text).toContain('auto');
  });
});

describe('var dumper stubs', () => {
  test('a caster that returns without a stub and one that exposes private state', async () => {
    const app = appWith('var-dumper-stubs', {
      'src/Caster/PayloadCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class PayloadCaster
{
    public static function cast($payload, array $a, Stub $stub, bool $isNested): array
    {
        $a['data'] = $payload->data;

        return $a;
    }
}
`,
      'src/Caster/StubbedCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class StubbedCaster
{
    public static function cast($value, array $a, Stub $stub, bool $isNested): array
    {
        $stub->class = 'Acme';

        return $a;
    }
}
`,
      'config/packages/dev/debug.yaml': `debug:
    dump_destination: 'tcp://%env(VAR_DUMPER_SERVER)%'
`,
    });

    const text = await runModule('symfony-var-dumper-casters.js', app);

    expect(text).toContain('Caster');
  });
});

describe('dbal connection pools', () => {
  test('persistent connections, a pool size in the dsn and several named connections', async () => {
    const app = appWith('dbal-pool', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        connections:
            default:
                url: 'postgresql://app:pass@db:5432/acme?pool_size=20'
                driver: pdo_pgsql
                options:
                    12: true
                driverOptions:
                    1002: "SET NAMES utf8mb4"
                    3: 2
            reporting:
                url: 'mysql://app:pass@db:3306/reporting'
                driver: pdo_mysql
                persistent: true
                options:
                    'PDO::ATTR_PERSISTENT': true
`,
    });

    const text = await runModule('dbal-connection-pool.js', app);

    expect(text).toContain('reporting');
  });
});

describe('aws parameter store', () => {
  test('a parameter fetched without decryption and a hardcoded name', async () => {
    const app = appWith('parameter-store', {
      'src/Aws/Parameters.php': `<?php

namespace App\\Aws;

use Aws\\Ssm\\SsmClient;

class Parameters
{
    public function __construct(private SsmClient $ssm)
    {
    }

    public function encrypted(): string
    {
        $result = $this->ssm->getParameter([
            'Name' => '/acme/production/database_password',
            'WithDecryption' => false,
        ]);

        return $result['Parameter']['Value'];
    }

    public function fromEnv(): string
    {
        $result = $this->ssm->getParameter([
            'Name' => getenv('ACME_PARAMETER_NAME'),
            'WithDecryption' => true,
        ]);

        return $result['Parameter']['Value'];
    }

    public function byPath(): array
    {
        return $this->ssm->getParametersByPath([
            'Path' => '/acme/production/',
            'Recursive' => true,
            'WithDecryption' => true,
        ]);
    }
}
`,
      'config/packages/aws.yaml': `aws:
    version: latest
    region: eu-west-1
    Ssm:
        version: '2014-11-06'
`,
    });

    const text = await runModule('aws-parameter-store.js', app);

    expect(text).toContain('WithDecryption');
  });
});

describe('caster prefixes', () => {
  test('a caster using the Caster API on a class with private state', async () => {
    const app = appWith('caster-prefixes', {
      'src/Caster/AccountCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Caster\\Caster;
use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class AccountCaster
{
    protected $secret;

    private $token;

    public static function cast($account, array $a, Stub $stub, bool $isNested): array
    {
        $a[Caster::EXCLUDE_VERBOSE] = true;
        $a['reference'] = $account->reference;

        return $a;
    }
}
`,
      'src/Caster/PrefixedCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Caster\\Caster;
use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class PrefixedCaster
{
    private $token;

    public static function cast($value, array $a, Stub $stub, bool $isNested): array
    {
        $a[Caster::PREFIX_PROTECTED . 'token'] = $value->token;

        return array_merge($a, ['extra' => 1]);
    }
}
`,
    });

    const text = await runModule('symfony-var-dumper-casters.js', app);

    expect(text).toContain('Caster');
  });
});

describe('behat definitions on unreadable and duplicate steps', () => {
  test('two definitions with the same pattern in one context, and a feature with none', async () => {
    const app = appWith('behat-duplicates', {
      'features/bootstrap/FeatureContext.php': `<?php

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
    /**
     * @Given I am on the home page
     */
    public function iAmOnTheHomePage(): void
    {
    }

    /**
     * @Given I am on the home page
     */
    public function duplicate(): void
    {
    }

    /**
     * @Given
     */
    public function empty(): void
    {
    }
}
`,
      'features/empty.feature': `Feature: Nothing here

    Scenario: No steps at all
`,
    });

    const text = await runModule('behat-step-coverage.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('socket helpers', () => {
  test('a tls address on a sensitive port and a commented one', async () => {
    const app = appWith('socket-tls', {
      'src/Net/Secure.php': `<?php

namespace App\\Net;

class Secure
{
    public function tls(): void
    {
        $client = stream_socket_client('tls://0.0.0.0:6379');
    }

    public function ssl(): void
    {
        $client = stream_socket_client('ssl://127.0.0.1:5432');
    }

    public function inline(): void
    {
        $client = stream_socket_client('tcp://0.0.0.0:27017', $errno, $errstr, 30, STREAM_CLIENT_CONNECT);
    }
}
`,
    });

    const text = await runModule('php-socket-programming.js', app);

    expect(text).toContain('Secure');
  });
});

describe('swarm resources and ports', () => {
  test('a service with reservations but no cpu limit, a rollback with no parallelism and ingress ports', async () => {
    const app = appWith('swarm-resources', {
      'docker-compose.prod.yml': `version: "3.8"

services:
  app:
    image: acme:1.0
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 512M
      rollback_config:
        delay: 10s
      update_config:
        order: start-first
    ports:
      - "8080:8080"

  edge:
    image: acme-edge:1.0
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "1.0"
          memory: 256M
      placement:
        constraints:
          - node.role == worker
    ports:
      - target: 443
        published: 443
        mode: ingress
`,
    });

    const text = await runModule('docker-swarm-config.js', app);

    expect(text).toContain('app');
  });
});

describe('gedmo trees', () => {
  test('a closure tree with no closure class and a materialized path with no path fields', async () => {
    const app = appWith('gedmo-tree', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'gedmo/doctrine-extensions': '^3.11' },
      }, null, 2),
      'src/Entity/ClosureCategory.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Mapping\\Annotation as Gedmo;

#[ORM\\Entity]
#[Gedmo\\Tree(type: 'closure')]
class ClosureCategory
{
    #[Gedmo\\TreeLeft]
    private ?int $lft = null;
}
`,
      'src/Entity/PathCategory.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Mapping\\Annotation as Gedmo;

#[ORM\\Entity]
#[Gedmo\\Tree(type: 'materializedPath')]
class PathCategory
{
    #[ORM\\Column]
    private string $title = '';
}
`,
      'src/Entity/StofCategory.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Timestampable\\Traits\\TimestampableEntity;

#[ORM\\Entity]
class StofCategory
{
    use TimestampableEntity;
}
`,
    });

    const text = await runModule('doctrine-gedmo-tree.js', app);

    expect(text).toContain('ClosureCategory');
  });
});

describe('doctrine indexes', () => {
  test('an index built with new Index(), a name over the limit and one made redundant', async () => {
    const longName = 'idx_' + 'a'.repeat(70);
    const app = appWith('doctrine-indexes', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Doctrine\\ORM\\Mapping\\Index;

#[ORM\\Entity]
#[ORM\\Table(
    name: 'invoice',
    indexes: [
        new Index(name: 'idx_customer', columns: ['customer_id']),
        new Index(name: 'idx_customer_issued', columns: ['customer_id', 'issued_at']),
        new ORM\\Index(name: '${longName}', columns: ['reference']),
    ],
)]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-indexes.js', app);

    expect(text).toContain('idx_customer');
  });
});

describe('orm configuration', () => {
  test('mappings by prefix, several entity managers and a proxy directory', async () => {
    const app = appWith('orm-config', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: false
        proxy_dir: '%kernel.cache_dir%/doctrine/orm/Proxies'
        default_entity_manager: default
        entity_managers:
            default:
                connection: default
                mappings:
                    App:
                        is_bundle: false
                        type: attribute
                        dir: '%kernel.project_dir%/src/Entity'
                        prefix: 'App\\Entity'
                        alias: App
                    Legacy:
                        prefix: 'Legacy\\Entity'
                    broken: ~
                dql:
                    string_functions:
                        test_string: App\\DQL\\StringFunction
                    numeric_functions: ~
            reporting:
                connection: reporting
                mappings:
                    Reporting:
                        dir: '%kernel.project_dir%/src/Reporting'
            broken: ~
`,
    });

    const text = await runModule('doctrine-orm-config.js', app);

    expect(text).toContain('reporting');
  });
});

describe('unit of work listeners', () => {
  test('flush inside postFlush, persist inside onClear and business logic in onClear', async () => {
    const app = appWith('uow-flush', {
      'src/EventListener/UnitOfWorkListener.php': `<?php

namespace App\\EventListener;

class UnitOfWorkListener
{
    public function postFlush($args): void
    {
        $args->getObjectManager()->flush();
    }

    public function onClear($args): void
    {
        $this->em->persist($this->entity);
        $this->messageBus->dispatch(new \\App\\Message\\Cleared());
    }

    public function preUpdate($args): void
    {
        $this->em->persist($this->other);
    }
}
`,
    });

    const text = await runModule('doctrine-uow-flush.js', app);

    expect(text).toContain('postFlush');
  });
});

describe('github actions', () => {
  test('write-all permissions, pull_request_target with checkout, a self-hosted runner and a secret in a run', async () => {
    const app = appWith('github-actions', {
      '.github/workflows/ci.yml': `name: ci

on:
    pull_request_target:
        branches: [main]

permissions: write-all

env:
    APP_ENV: prod
    DEPLOY_TOKEN: ghp\x5f0123456789abcdef
    SAFE_TOKEN: \${{ secrets.DEPLOY_TOKEN }}

jobs:
    build:
        runs-on: self-hosted
        steps:
            - uses: actions/checkout@v4
            - uses: actions/cache@v4
              with:
                  path: vendor
                  key: composer-\${{ hashFiles('composer.lock') }}
            - run: export DEPLOY_TOKEN=ghp\x5f0123456789abcdef && bin/deploy
`,
      '.github/workflows/notes.md': 'not a workflow\n',
    });

    const text = await runModule('github-actions-config.js', app);

    expect(text).toContain('self-hosted');
  });
});

describe('mercure hubs', () => {
  test('a hub with jwt config, one with no secret and topics published from code', async () => {
    const app = appWith('mercure-hubs', {
      'config/packages/framework.yaml': `framework:
    mercure:
        url: 'https://single.example.com/.well-known/mercure'
        public: true
        jwt_config:
            secret: '%env(MERCURE_JWT_SECRET)%'
            algorithm: 'hmac.sha256'
`,
      'config/packages/mercure.yaml': `mercure:
    hubs:
        default:
            url: 'https://mercure.example.com/.well-known/mercure'
            jwt_config:
                secret: '%env(MERCURE_JWT_SECRET)%'
                algorithm: 'hmac.sha256'
                publish: ['*']
        public:
            url: 'https://public.example.com/.well-known/mercure'
        broken: ~
`,
      'src/Service/Publisher.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Mercure\\HubInterface;
use Symfony\\Component\\Mercure\\Update;

class Publisher
{
    public function __construct(private HubInterface $hub)
    {
    }

    public function publish(): void
    {
        $this->hub->publish(new Update(['https://example.com/books/1', 'https://example.com/books/2'], '{}'));
    }
}
`,
    });

    const single = appWith('mercure-single', {
      'config/packages/framework.yaml': `framework:
    mercure:
        url: 'https://single.example.com/.well-known/mercure'
        public: true
        jwt_config:
            secret: '%env(MERCURE_JWT_SECRET)%'
            algorithm: 'hmac.sha256'
`,
    });

    const text = await runModule('mercure.js', app);
    const singleText = await runModule('mercure.js', single);

    expect(text).toContain('mercure');
    expect(singleText).toContain('single.example.com');
  });
});

describe('nelmio api doc', () => {
  test('areas with path and host patterns, an Info block and controllers with no 404', async () => {
    const app = appWith('nelmio', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'nelmio/api-doc-bundle': '^4.0' },
      }, null, 2),
      'config/packages/nelmio_api_doc.yaml': `nelmio_api_doc:
    documentation:
        info:
            title: Acme API
            version: 1.0.0
    areas:
        default:
            path_patterns: ['^/api', '^/v2']
            host_patterns: ['^api\\.']
        internal:
            path_patterns: ['^/internal']
`,
      'src/Controller/ApiController.php': `<?php

namespace App\\Controller;

use OpenApi\\Attributes as OA;

#[OA\\Info(version: '1.0.0', title: 'Acme API')]
class ApiController
{
    #[OA\\Get(path: '/api/invoices')]
    #[OA\\Response(response: 200, description: 'ok')]
    public function index(): void
    {
    }
}
`,
      'src/Controller/NoResponsesController.php': `<?php

namespace App\\Controller;

use OpenApi\\Attributes as OA;

class NoResponsesController
{
    #[OA\\Get(path: '/api/customers')]
    public function index(): void
    {
    }
}
`,
    });

    const text = await runModule('nelmio-api-doc.js', app);

    expect(text).toContain('Path patterns');
  });
});

describe('pgbouncer', () => {
  test('a transaction pool with a small limit, plain auth and a direct database url', async () => {
    const app = appWith('pgbouncer', {
      'docker/pgbouncer/pgbouncer.ini': `[databases]
acme = host=db port=5432 dbname=acme

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = trust
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = statement
max_client_conn = 50
default_pool_size = 2
server_reset_query = DISCARD ALL
`,
      '.env': `DATABASE_URL=postgresql://app:pass@db:5432/acme
`,
    });

    const text = await runModule('pgbouncer-config.js', app);

    expect(text).toContain('pool_mode');
  });
});

describe('date intervals', () => {
  test('every interval shape the analyser warns about', async () => {
    const app = appWith('date-interval', {
      'src/Service/Intervals.php': `<?php

namespace App\\Service;

class Intervals
{
    public function zero(): \\DateInterval
    {
        return new DateInterval('0');
    }

    public function concatenated(int $hours): \\DateInterval
    {
        return new DateInterval('PT' . $hours . 'H');
    }

    public function prefixed(int $days): \\DateInterval
    {
        return new DateInterval('P' . $days . 'D');
    }

    public function fromVariable(string $spec): \\DateInterval
    {
        return new DateInterval($spec);
    }

    public function fullDay(): \\DateInterval
    {
        return new DateInterval('PT24H');
    }

    public function longHours(): \\DateInterval
    {
        return new DateInterval('PT48H');
    }

    public function days(\\DateTimeInterface $a, \\DateTimeInterface $b): int
    {
        $diff = $a->diff($b);

        return $diff->days;
    }
}
`,
    });

    const text = await runModule('php-date-interval.js', app);

    expect(text).toContain('DateInterval');
  });
});

describe('static analysis ignores in bulk', () => {
  test('more than ten suppressions in one file and both styles mixed', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      `    /** @phpstan-ignore-next-line */\n    public function ignored${i}(): void\n    {\n    }\n`,
    ).join('\n');
    const mixed = Array.from({ length: 7 }, (_, i) =>
      `    /** @psalm-suppress MissingReturnType */\n    public function suppressed${i}()\n    {\n    }\n`,
    ).join('\n');
    const app = appWith('ignores-bulk', {
      'phpstan.neon': `parameters:
    level: 8
`,
      'src/Service/Suppressed.php': `<?php

namespace App\\Service;

class Suppressed
{
${many}
${mixed}
    /** @phpstan-ignore */
    public function bare(): void
    {
    }
}
`,
    });

    const text = await runModule('php-static-analysis-ignore.js', app);

    expect(text).toContain('phpstan');
  });
});

describe('phpunit attributes', () => {
  test('a #[Test] on a method that does not start with test, and both styles in one project', async () => {
    const app = appWith('phpunit-attributes', {
      'tests/Service/AttributeTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\Attributes\\Before;
use PHPUnit\\Framework\\Attributes\\DataProvider;
use PHPUnit\\Framework\\Attributes\\Group;
use PHPUnit\\Framework\\Attributes\\Test;
use PHPUnit\\Framework\\TestCase;

#[Group('unit')]
class AttributeTest extends TestCase
{
    #[Before]
    public function prepare(): void
    {
    }

    #[Test]
    public function itWorks(): void
    {
    }

    #[Test]
    #[DataProvider('rows')]
    public function testWithProvider(array $row): void
    {
    }

    public static function rows(): array
    {
        return [[['a']]];
    }
}
`,
      'tests/Service/AnnotationTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\TestCase;

class AnnotationTest extends TestCase
{
    /**
     * @test
     * @group legacy
     * @dataProvider rows
     */
    public function it_still_works(array $row): void
    {
    }

    public static function rows(): array
    {
        return [[['a']]];
    }
}
`,
      'tests/Service/notes.md': 'not a test\n',
    });

    const text = await runModule('phpunit-attributes.js', app);

    expect(text).toContain('AttributeTest');
  });
});

describe('phpunit extensions', () => {
  test('an extension registered in the xml, one with no hooks and a deprecated listener', async () => {
    const app = appWith('phpunit-extensions', {
      'phpunit.xml': `<?xml version="1.0"?>
<phpunit bootstrap="tests/bootstrap.php">
    <extensions>
        <bootstrap class="App\\Tests\\Extension\\TimingExtension"/>
        <bootstrap class="App\\Tests\\Extension\\EmptyExtension"/>
        <extension class="App\\Tests\\Extension\\LegacyListener"/>
    </extensions>
</phpunit>
`,
      'tests/Extension/TimingExtension.php': `<?php

namespace App\\Tests\\Extension;

use PHPUnit\\Runner\\Extension\\Extension;
use PHPUnit\\Runner\\Extension\\Facade;
use PHPUnit\\Runner\\Extension\\ParameterCollection;
use PHPUnit\\TextUI\\Configuration\\Configuration;

class TimingExtension implements Extension
{
    public function bootstrap(Configuration $configuration, Facade $facade, ParameterCollection $parameters): void
    {
    }
}
`,
      'tests/Extension/EmptyExtension.php': `<?php

namespace App\\Tests\\Extension;

class EmptyExtension
{
}
`,
      'tests/Extension/LegacyListener.php': `<?php

namespace App\\Tests\\Extension;

use PHPUnit\\Framework\\TestListener;

class LegacyListener implements TestListener
{
}
`,
      'tests/Extension/Unregistered.php': `<?php

namespace App\\Tests\\Extension;

use PHPUnit\\Runner\\Extension\\Extension;

class Unregistered implements Extension
{
}
`,
    });

    const text = await runModule('phpunit-extensions.js', app);

    expect(text).toContain('TimingExtension');
  });
});

describe('parameter store names and credentials', () => {
  test('a hardcoded parameter name, one from the environment, and aws keys in the source', async () => {
    const app = appWith('parameter-names', {
      'src/Aws/Store.php': `<?php

namespace App\\Aws;

use Aws\\Ssm\\SsmClient;

class Store
{
    public function client(): SsmClient
    {
        return new SsmClient([
            'region' => 'eu-west-1',
            'credentials' => [
                'key' => 'AKIAIOSFODNN7EXAMPLE',
                'secretAccessKey' => 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
            ],
        ]);
    }

    public function hardcoded(): array
    {
        return $this->ssm->getParameters([
            'Names' => ['/acme/production/database_password'],
            'WithDecryption' => true,
        ]);
    }

    public function fromEnvironment(): array
    {
        return $this->ssm->getParameters([
            'Names' => [$_ENV['ACME_PARAMETER']],
            'WithDecryption' => true,
        ]);
    }
}
`,
    });

    const text = await runModule('aws-parameter-store.js', app);

    expect(text).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
  });
});

describe('dbal connections in detail', () => {
  test('a connection with host, database, wrapper and driver classes, and replicas', async () => {
    const app = appWith('dbal-detail', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        connections:
            default:
                host: db.example.com
                port: 5432
                dbname: acme
                user: app
                password: '%env(DATABASE_PASSWORD)%'
                driver: pdo_pgsql
                persistent: true
                wrapper_class: App\\Doctrine\\LoggingConnection
                driver_class: App\\Doctrine\\CustomDriver
                options:
                    sslmode: require
                replicas:
                    replica_one:
                        host: replica-1.example.com
                        dbname: acme
                    broken: ~
            reporting:
                url: 'postgresql://app:pass@reporting.example.com:5432/reporting'
            broken: ~
`,
    });

    const text = await runModule('dbal-config.js', app);

    expect(text).toContain('db.example.com');
  });
});

describe('parallel channels', () => {
  test('an unbuffered channel, a buffered one and an object shared into a closure', async () => {
    const app = appWith('parallel-channels', {
      'src/Parallel/Pipeline.php': `<?php

namespace App\\Parallel;

use parallel\\Channel;
use parallel\\Runtime;

class Pipeline
{
    public function run(object $shared): void
    {
        $unbuffered = new parallel\\Channel();
        $buffered = parallel\\Channel::make(64);

        $runtime = new parallel\\Runtime();
        $future = parallel\\Future::run(function () use (&$shared): void {
            $shared->mutate();
        });

        parallel\\run(function (): void {
            echo 'work';
        });

        if (true) {
            $nested = new parallel\\Channel();
        }
    }
}
`,
    });

    const text = await runModule('php-parallel-extension.js', app);

    expect(text).toContain('Channel');
  });
});

describe('suppressions across files', () => {
  test('the same suppression in more than ten files', async () => {
    const files: Record<string, string> = {
      'phpstan.neon': 'parameters:\n    level: 8\n',
    };
    for (let i = 0; i < 12; i++) {
      files[`src/Service/Suppressed${i}.php`] = `<?php

namespace App\\Service;

class Suppressed${i}
{
    /** @phpstan-ignore-next-line */
    public function run(): void
    {
    }
}
`;
    }
    const app = appWith('suppressions-systematic', files);

    const text = await runModule('php-static-analysis-ignore.js', app);

    expect(text).toContain('systematic');
  });
});

describe('self shunting', () => {
  test('a test extending production code, an inner mock class and a mock of the test itself', async () => {
    const app = appWith('self-shunting', {
      'tests/Service/ShuntTest.php': `<?php

namespace App\\Tests\\Service;

use App\\Service\\Importer;
use PHPUnit\\Framework\\TestCase;

class ShuntTest extends Importer
{
    public function testItImports(): void
    {
        $mock = $this->getMockBuilder(get_class($this))
            ->onlyMethods(['fetch'])
            ->getMock();

        self::assertNotNull($mock);
    }
}

class FakeImporter extends Importer
{
    public function fetch(): array
    {
        return [];
    }
}
`,
    });

    const text = await runModule('phpunit-self-shunting.js', app);

    expect(text).toContain('ShuntTest');
  });
});

describe('caster return shapes', () => {
  test('a caster returning an array literal and one merging into the argument', async () => {
    const app = appWith('caster-returns', {
      'src/Caster/LiteralCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class LiteralCaster
{
    public static function cast($value, array $a, Stub $stub, bool $isNested)
    {
        return [
            'reference' => $value->reference,
        ];
    }
}
`,
      'src/Caster/MergingCaster.php': `<?php

namespace App\\Caster;

use Symfony\\Component\\VarDumper\\Cloner\\Stub;

class MergingCaster
{
    public static function cast($value, array $a, Stub $stub, bool $isNested)
    {
        return $a + ['extra' => 1];
    }
}
`,
    });

    const text = await runModule('symfony-var-dumper-casters.js', app);

    expect(text).toContain('Caster');
  });
});

describe('secret vault shapes', () => {
  test('secrets written as sodium, gpg and asc, beside the key files', async () => {
    const app = appWith('vault-shapes', {
      'config/secrets/prod/APP_SECRET.sodium': 'encrypted\n',
      'config/secrets/prod/MAILER_DSN.gpg': 'encrypted\n',
      'config/secrets/prod/DATABASE_URL.asc': 'encrypted\n',
      'config/secrets/prod/prod.decrypt.private.php': '<?php return "key";\n',
      'config/secrets/prod/prod.encrypt.public.php': '<?php return "key";\n',
      'config/secrets/prod/decrypt.sodium': 'key\n',
      'config/secrets/prod/encrypt.sodium': 'key\n',
      'config/secrets/prod/notes.txt': 'not a secret\n',
      'config/packages/framework.yaml': `framework:
    secrets:
        vault_directory: '%kernel.project_dir%/config/secrets/%kernel.environment%'
        local_dotenv_file: '%kernel.project_dir%/.env.%kernel.environment%.local'
`,
    });

    const text = await runModule('secrets-vault.js', app);

    expect(text).toContain('APP_SECRET');
  });
});

describe('sentinel adapters in code', () => {
  test('a sentinel dsn assigned in a php config and an adapter built from it', async () => {
    const app = appWith('sentinel-code', {
      'config/services.php': `<?php

$sentinel = 'redis+sentinel://cache-1:26379,cache-2:26379,cache-3:26379/mymaster';
$plain = 'redis://cache:6379';

return [
    'sentinel' => $sentinel,
];
`,
      'config/packages/cache.php': `<?php

use Symfony\\Component\\Cache\\Adapter\\RedisAdapter;

$connection = RedisAdapter::createConnection('redis+sentinel://cache-1:26379,cache-2:26379/mymaster', [
    'redis_sentinel' => 'mymaster',
]);
`,
    });

    const text = await runModule('symfony-cache-redis-sentinel.js', app);

    expect(text).toContain('sentinel');
  });
});

describe('exception status codes', () => {
  test('a status from a Response constant, a 5xx without logging and two classes on one code', async () => {
    const app = appWith('exception-codes', {
      'src/Exception/StorageException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class StorageException extends HttpException
{
    public function __construct()
    {
        parent::__construct(Response::HTTP_SERVICE_UNAVAILABLE, 'Storage down');
    }
}
`,
      'src/Exception/GatewayException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class GatewayException extends HttpException
{
    public function __construct()
    {
        parent::__construct(503, 'Gateway down');
    }
}
`,
      'src/Exception/LoggedException.php': `<?php

namespace App\\Exception;

use Psr\\Log\\LoggerInterface;
use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class LoggedException extends HttpException
{
    public function __construct(private LoggerInterface $logger)
    {
        $this->logger->error('failed');
        parent::__construct(500, 'Failed');
    }
}
`,
      'config/packages/twig.yaml': `twig:
    exception_controller: 'App\\Controller\\ExceptionController::show'
    paths:
        '%kernel.project_dir%/templates': ~
`,
    });

    const text = await runModule('symfony-exception-mapping.js', app);

    expect(text).toContain('StorageException');
  });
});

describe('http client authentication', () => {
  test('basic auth without https, an api key in the query string and options set in a loop', async () => {
    const app = appWith('http-client-auth', {
      'config/packages/http_client.yaml': `framework:
    http_client:
        scoped_clients:
            legacy.client:
                base_uri: 'http://legacy.example.com'
                auth_basic: ['acme', '%env(LEGACY_PASSWORD)%']
`,
      'src/Client/LegacyClient.php': `<?php

namespace App\\Client;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class LegacyClient
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function fetch(array $ids): array
    {
        $out = [];
        foreach ($ids as $id) {
            $out[] = $this->client->withOptions([
                'auth_basic' => ['acme', 'hunter2'],
            ])->request('GET', 'http://legacy.example.com/item/' . $id);
        }

        return $out;
    }

    public function withKey(string $id): array
    {
        return $this->client->request('GET', 'https://api.example.com/item?api_key=abcdef0123456789&id=' . $id)->toArray();
    }
}
`,
      'src/Controller/TokenController.php': `<?php

namespace App\\Controller;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class TokenController
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function index(): array
    {
        return $this->client->request('GET', 'https://api.example.com/me', [
            'auth_bearer' => 'hardcoded-token-value',
        ])->toArray();
    }
}
`,
    });

    const text = await runModule('symfony-http-client-auth.js', app);

    expect(text).toContain('LegacyClient');
  });
});

describe('mail attachments', () => {
  test('an attachment with no existence check, an embed nobody keeps and a variable path', async () => {
    const app = appWith('mailer-attachments', {
      'src/Mail/Sender.php': `<?php

namespace App\\Mail;

use Symfony\\Component\\Mime\\Email;

class Sender
{
    public function send(string $file): Email
    {
        $email = new Email();
        $email->attachFromPath($file);
        $email->embedFromPath('/srv/app/public/logo.png');

        return $email;
    }

    public function guarded(string $file): Email
    {
        $email = new Email();
        if (file_exists($file)) {
            $path = realpath($file);
            $email->attachFromPath($path);
        }

        $cid = $email->embedFromPath(basename('/srv/app/public/logo.png'));

        return $email;
    }
}
`,
    });

    const text = await runModule('symfony-mailer-attachments.js', app);

    expect(text).toContain('attach');
  });
});

describe('mail bounces', () => {
  test('each provider transport, with no bounce listener and no webhook route', async () => {
    const providers = [
      ['postmark', 'postmark://KEY@default'],
      ['sendgrid', 'sendgrid://KEY@default'],
      ['mailgun', 'mailgun://KEY:DOMAIN@default'],
      ['ses', 'ses+smtp://KEY:SECRET@default'],
    ];

    for (const [name, dsn] of providers) {
      const app = appWith(`mailer-bounce-${name}`, {
        'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: '${dsn}'
`,
      });

      const text = await runModule('symfony-mailer-bounce-handling.js', app);

      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('mailer dsn analysis', () => {
  test('a dsn taken from the environment, null in production and sendmail in a container', async () => {
    const fromEnv = appWith('mailer-dsn-env', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: '%env(MAILER_DSN)%'
`,
      '.env': `APP_ENV=prod
MAILER_DSN=null://null
`,
      '.env.local': `MAILER_DSN=smtp://localhost:1025
`,
      'docker-compose.yml': `services:
  app:
    image: acme
`,
    });
    const sendmail = appWith('mailer-dsn-sendmail', {
      '.env': `APP_ENV=prod
MAILER_DSN=sendmail://default
`,
      'docker-compose.yml': `services:
  app:
    image: acme
`,
    });

    const one = await runModule('symfony-mailer-dsn-analysis.js', fromEnv);
    const two = await runModule('symfony-mailer-dsn-analysis.js', sendmail);

    expect(one.length).toBeGreaterThan(0);
    expect(two).toContain('sendmail');
  });
});

describe('consumer counts', () => {
  test('a single worker in supervisor and a transport nobody consumes', async () => {
    const app = appWith('competing-single', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default'
            lonely: 'doctrine://default?queue_name=lonely'
`,
      'supervisord.conf': `[program:messenger-async]
command=php /srv/app/bin/console messenger:consume async
numprocs=1
`,
      'Makefile': `.PHONY: consume
consume:
	php bin/console messenger:consume async --limit=10
`,
    });

    const text = await runModule('symfony-messenger-competing-consumers.js', app);

    expect(text).toContain('async');
  });
});

describe('messenger transport dsns', () => {
  test('a transport given as a plain string, doctrine with auto_setup, redis with no auth and in-memory outside tests', async () => {
    const app = appWith('messenger-dsn', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default?auto_setup=true'
            cache: 'redis://cache:6379/messages'
            memory: 'in-memory://'
            fromEnv: '%env(MESSENGER_MISSING_DSN)%'
            structured:
                dsn: 'amqp://guest:guest@rabbit:5672/%2f/messages'
                options:
                    auto_setup: false
`,
      '.env': `APP_ENV=prod
MESSENGER_TRANSPORT_DSN=doctrine://default
`,
    });

    const text = await runModule('symfony-messenger-transport-dsn.js', app);

    expect(text).toContain('async');
  });
});

describe('rate limiter policy intervals', () => {
  test('intervals in hours and iso, a rate with no interval and a limit of zero', async () => {
    const app = appWith('limiter-policy-intervals', {
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        hourly:
            policy: 'fixed_window'
            limit: 100
            interval: '2 hours'
        iso_minutes:
            policy: 'sliding_window'
            limit: 10
            interval: 'PT45M'
        iso_hours:
            policy: 'sliding_window'
            limit: 10
            interval: 'PT3H'
        no_interval:
            policy: 'token_bucket'
            limit: 5
        zero_limit:
            policy: 'fixed_window'
            limit: 0
            interval: '1 hour'
        broken: ~
`,
    });

    const text = await runModule('symfony-rate-limiter-policy.js', app);

    expect(text).toContain('hourly');
  });
});

describe('rate limiter storage kinds', () => {
  test('the app pool on apcu and pools named after their adapters', async () => {
    const app = appWith('limiter-storage-kinds', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.apcu
`,
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        on_app:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.app'
        on_redis:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.redis_limiter'
        on_memcached:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.memcached_limiter'
        on_array:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.array_limiter'
        on_filesystem:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.filesystem_limiter'
        on_apcu:
            policy: 'sliding_window'
            limit: 10
            interval: '1 hour'
            cache_pool: 'cache.apcu_limiter'
`,
    });

    const text = await runModule('symfony-rate-limiter-storage.js', app);

    expect(text).toContain('on_redis');
  });
});

describe('symfony runtime', () => {
  test('a runtime configured in composer.json and an index.php that uses it', async () => {
    const app = appWith('symfony-runtime', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/runtime': '^7.0' },
        extra: {
          runtime: {
            class: 'App\\Runtime\\CustomRuntime',
            env_var_name: 'ACME_ENV',
            dotenv_path: '.env.acme',
            prod_envs: ['prod', 'staging'],
            test_envs: ['test'],
            disable_dotenv: false,
          },
        },
      }, null, 2),
      'public/index.php': `<?php

use App\\Kernel;

require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

return function (array $context) {
    return new Kernel($context['ACME_ENV'], (bool) $context['APP_DEBUG']);
};
`,
      'vendor/autoload_runtime.php': `<?php

// generated by symfony/runtime
`,
    });

    const text = await runModule('symfony-runtime.js', app);

    expect(text).toContain('CustomRuntime');
  });
});

describe('password upgrades', () => {
  test('needsRehash without an upgrade, auto rehash turned off and a migrating hasher with no upgrader', async () => {
    const app = appWith('password-upgrade', {
      'config/packages/security.yaml': `security:
    password_hashers:
        App\\Entity\\User:
            algorithm: auto
            auto_rehash_on_login: false
            migrate_from: ['md5', 'sha256']
    providers:
        app_user_provider:
            entity:
                class: App\\Entity\\User
`,
      'src/Security/Checker.php': `<?php

namespace App\\Security;

use Symfony\\Component\\PasswordHasher\\Hasher\\UserPasswordHasherInterface;

class Checker
{
    public function __construct(private UserPasswordHasherInterface $hasher)
    {
    }

    public function check($user, string $plain): bool
    {
        if ($this->hasher->needsRehash($user)) {
            return false;
        }

        return $this->hasher->isPasswordValid($user, $plain);
    }
}
`,
    });

    const text = await runModule('symfony-security-password-upgrade.js', app);

    expect(text).toContain('rehash');
  });
});

describe('service reset', () => {
  test('services tagged kernel.reset as a string and as a map, and a stateful one without reset', async () => {
    const app = appWith('service-reset', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'runtime/frankenphp-symfony': '^0.2' },
      }, null, 2),
      'config/services.yaml': `services:
    App\\Service\\ResettableCache:
        tags:
            - 'kernel.reset'
    App\\Service\\TaggedReset:
        tags:
            - { name: kernel.reset, method: reset }
    App\\Service\\Stateful:
        autowire: true
`,
      'src/Service/ResettableCache.php': `<?php

namespace App\\Service;

use Symfony\\Contracts\\Service\\ResetInterface;

class ResettableCache implements ResetInterface
{
    private array $items = [];

    public function reset(): void
    {
        $this->items = [];
    }
}
`,
      'src/Service/Stateful.php': `<?php

namespace App\\Service;

class Stateful
{
    private array $seen = [];

    private static $instance;

    public function remember(string $key): void
    {
        $this->seen[$key] = true;
    }
}
`,
    });

    const text = await runModule('symfony-service-reset.js', app);

    expect(text).toContain('Stateful');
  });
});

describe('stopwatch', () => {
  test('the stopwatch enabled in framework.yaml and used in a service', async () => {
    const enabled = appWith('stopwatch-on', {
      'config/packages/framework.yaml': `framework:
    stopwatch:
        enabled: true
`,
      'src/Service/Timed.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Stopwatch\\Stopwatch;

class Timed
{
    public function __construct(private Stopwatch $stopwatch)
    {
    }

    public function run(): void
    {
        $this->stopwatch->start('import');
        $this->stopwatch->stop('import');
    }
}
`,
    });
    const disabled = appWith('stopwatch-off', {
      'config/packages/framework.yaml': `framework:
    stopwatch:
        enabled: false
`,
    });

    const one = await runModule('symfony-stopwatch.js', enabled);
    const two = await runModule('symfony-stopwatch.js', disabled);

    expect(one).toContain('stopwatch');
    expect(two.length).toBeGreaterThan(0);
  });
});

describe('user checkers', () => {
  test('a checker named in a firewall that does not throw the account status exception', async () => {
    const app = appWith('user-checker', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            lazy: true
            user_checker: App\\Security\\UserChecker
        api:
            pattern: ^/api
            user_checker: App\\Security\\ApiUserChecker
`,
      'src/Security/UserChecker.php': `<?php

namespace App\\Security;

use Symfony\\Component\\Security\\Core\\User\\UserCheckerInterface;
use Symfony\\Component\\Security\\Core\\User\\UserInterface;

class UserChecker implements UserCheckerInterface
{
    public function checkPreAuth(UserInterface $user): void
    {
    }

    public function checkPostAuth(UserInterface $user): void
    {
        if ($user->isBanned()) {
            throw new \\RuntimeException('banned');
        }
    }
}
`,
      'src/Security/ApiUserChecker.php': `<?php

namespace App\\Security;

use Symfony\\Component\\Security\\Core\\Exception\\AccountStatusException;
use Symfony\\Component\\Security\\Core\\User\\UserCheckerInterface;
use Symfony\\Component\\Security\\Core\\User\\UserInterface;

class ApiUserChecker implements UserCheckerInterface
{
    public function checkPreAuth(UserInterface $user): void
    {
    }

    public function checkPostAuth(UserInterface $user): void
    {
        if ($user->isExpired()) {
            throw new class extends AccountStatusException {};
        }
    }
}
`,
    });

    const text = await runModule('symfony-user-checker.js', app);

    expect(text).toContain('UserChecker');
  });
});

describe('workflow events', () => {
  test('a guard with no blocker, an entered listener that writes the marking and one event subscribed twice', async () => {
    const app = appWith('workflow-events', {
      'src/EventSubscriber/WorkflowSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\Workflow\\Event\\Event;
use Symfony\\Component\\Workflow\\Event\\GuardEvent;

class WorkflowSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'workflow.invoice.guard' => 'onGuard',
            'workflow.invoice.entered' => 'onEntered',
            'workflow.invoice.completed' => 'onCompleted',
        ];
    }

    public function onGuard(GuardEvent $event): void
    {
        if (!$this->allowed) {
            return;
        }
    }

    public function onEntered(Event $event): void
    {
        $event->getMarking()->mark('paid');
    }

    public function onCompleted(Event $event): void
    {
    }
}
`,
      'src/EventSubscriber/SecondWorkflowSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\Workflow\\Event\\Event;

class SecondWorkflowSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'workflow.invoice.completed' => 'onCompleted',
        ];
    }

    public function onCompleted(Event $event): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-workflow-events.js', app);

    expect(text).toContain('workflow.invoice');
  });
});

describe('terraform secrets', () => {
  test('a hardcoded secret in a resource, and directories the walk skips', async () => {
    const app = appWith('terraform-secrets', {
      'infra/main.tf': `resource "aws_secretsmanager_secret_version" "acme" {
  secret_id     = aws_secretsmanager_secret.acme.id
  secret_string = "hunter2-in-the-state"
}

resource "aws_instance" "web" {
  ami           = "ami-0123456789"
  instance_type = "t3.micro"
}
`,
      'infra/.terraform/modules/skipped.tf': `resource "aws_db_instance" "skipped" {
  password = "should-not-be-read"
}
`,
      'infra/node_modules/also-skipped.tf': `resource "aws_db_instance" "skipped" {
  password = "should-not-be-read"
}
`,
    });

    const text = await runModule('terraform-config.js', app);

    expect(text).toContain('aws_secretsmanager_secret_version');
    expect(text).not.toContain('hunter2-in-the-state');
  });
});

describe('ansible tasks', () => {
  test('a task naming a credential without no_log, and one with it', async () => {
    const app = appWith('ansible-tasks', {
      'ansible/site.yml': `---
- name: Deploy
  hosts: web
  become: true
  become_user: deploy
  tasks:
    - name: Write the database password
      copy:
        content: "{{ vault_db_password }}"
        dest: /etc/acme/db_password

    - name: Write the api token safely
      copy:
        content: "{{ vault_api_token }}"
        dest: /etc/acme/api_token
      no_log: true

    - name: Run a shell command
      shell: /srv/app/bin/console cache:clear --env={{ vars.app_env }}
`,
    });

    const text = await runModule('ansible-playbook-config.js', app);

    expect(text).toContain('no_log');
  });
});

describe('apache configuration', () => {
  test('an .htaccess with directory listing, server signature and no rewrite', async () => {
    const app = appWith('apache', {
      'public/.htaccess': `Options +Indexes

ServerSignature On
ServerTokens Full

<IfModule mod_expires.c>
    ExpiresActive On
</IfModule>

AllowOverride None
`,
    });

    const text = await runModule('apache-config.js', app);

    expect(text).toContain('Indexes');
  });
});

describe('problem details', () => {
  test('a problem response with no type, the wrong content type and a mismatched status', async () => {
    const app = appWith('problem-details', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Controller/ErrorController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\JsonResponse;

class ErrorController
{
    public function problem(\\Throwable $e): JsonResponse
    {
        return new JsonResponse([
            'title' => 'Something failed',
            'status' => 500,
            'detail' => $e->getMessage(),
            'trace' => $e->getTraceAsString(),
        ], 503, ['Content-Type' => 'application/json']);
    }
}
`,
    });

    const text = await runModule('api-problem-details.js', app);

    expect(text).toContain('problem');
  });
});

describe('rate limits in the edge', () => {
  test('rate limits declared in code with a burst, and caddy directives', async () => {
    const app = appWith('api-rate-limits', {
      'src/Controller/ApiController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\RateLimiter\\RateLimiterFactory;

class ApiController
{
    public function __construct(private RateLimiterFactory $apiLimiter)
    {
    }

    public function index(): void
    {
        $limiter = $this->apiLimiter->create('api');
        $limiter->consume(1);
    }
}
`,
      'Caddyfile': `acme.example.com {
    rate_limit {
        zone api {
            key {remote_host}
            events 100
            window 1m
        }
    }
    rate_limit static 1000r/s
}
`,
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        api:
            policy: 'token_bucket'
            limit: 100
            rate: { interval: '1 minute', amount: 10 }
`,
    });

    const text = await runModule('api-rate-limits.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('asset mapper entry points', () => {
  test('an importmap with css entries, stimulus controllers and a webpack config', async () => {
    const app = appWith('asset-mapper-entries', {
      'importmap.php': `<?php

return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
    'app.css' => ['path' => './assets/styles/app.css', 'type' => 'css'],
    'bootstrap' => ['url' => 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/+esm'],
];
`,
      'assets/controllers.json': JSON.stringify({
        controllers: {
          '@symfony/ux-turbo': { turbo_core: { enabled: true, fetch: 'eager' } },
        },
        entrypoints: [],
      }, null, 2),
      'assets/controllers/hello_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {}
`,
      'webpack.config.js': `const Encore = require('@symfony/webpack-encore');

Encore
    .addEntry('app', './assets/app.js')
    .addStyleEntry('styles', './assets/styles/app.css');

module.exports = Encore.getWebpackConfig();
`,
      'package.json': JSON.stringify({
        devDependencies: { '@symfony/webpack-encore': '^4.0.0' },
      }, null, 2),
    });

    const text = await runModule('asset-mapper.js', app);

    expect(text).toContain('app');
  });
});

describe('cloudfront', () => {
  test('a distribution configured in code and in a config directory', async () => {
    const app = appWith('cloudfront', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'aws/aws-sdk-php': '^3.0' },
      }, null, 2),
      'src/Aws/Cdn.php': `<?php

namespace App\\Aws;

use Aws\\CloudFront\\CloudFrontClient;

class Cdn
{
    public function invalidate(CloudFrontClient $client): void
    {
        $client->createInvalidation([
            'DistributionId' => 'E123456789',
            'InvalidationBatch' => [
                'CallerReference' => uniqid(),
                'Paths' => ['Quantity' => 1, 'Items' => ['/*']],
            ],
        ]);
    }
}
`,
      'config/aws/cloudfront.yaml': `cloudfront:
    distribution_id: '%env(CLOUDFRONT_DISTRIBUTION_ID)%'
    default_ttl: 86400
`,
      'config/packages/aws.yaml': `aws:
    version: latest
    region: eu-west-1
`,
    });

    const text = await runModule('aws-cloudfront-config.js', app);

    expect(text).toContain('CloudFront');
  });
});

describe('cache inspector', () => {
  test('pools with a directory and a lifetime, and a cache directory with entries', async () => {
    const app = appWith('cache-inspector', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.filesystem
        directory: '%kernel.cache_dir%/pools'
        default_redis_provider: 'redis://cache:6379'
        pools:
            cache.invoices:
                adapter: cache.adapter.filesystem
                default_lifetime: 3600
            cache.reports:
                adapter: cache.adapter.redis
                default_lifetime: 600
`,
      'config/packages/prod/cache.yaml': `framework:
    cache:
        app: cache.adapter.redis
`,
      'var/cache/prod/pools/app/00/entry-one': 'cached\n',
      'var/cache/prod/pools/app/01/entry-two': 'cached\n',
      'var/cache/prod/pools/system/02/entry-three': 'cached\n',
    });

    const text = await runModule('cache-inspector.js', app, ['cache.invoices']);

    expect(text).toContain('cache.invoices');
  });
});

describe('cloudwatch without the sdk', () => {
  test('alarms and retention in code with the sdk absent from composer', async () => {
    const app = appWith('cloudwatch-nosdk', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Aws/Alarms.php': `<?php

namespace App\\Aws;

class Alarms
{
    public function alarm($client): void
    {
        $client->putMetricAlarm(['AlarmName' => 'acme-5xx']);
    }

    public function retention($logs): void
    {
        $logs->putRetentionPolicy(['logGroupName' => '/acme/app', 'retentionInDays' => 14]);
    }
}
`,
      'config/packages/prod/monolog.yaml': `monolog:
    handlers:
        cloudwatch:
            type: service
            id: Maxbanton\\Cwh\\Handler\\CloudWatch
`,
    });

    const text = await runModule('cloudwatch-integration.js', app);

    expect(text).toContain('CloudWatch');
  });
});

describe('codeception cests', () => {
  test('cest files, a bootstrap and a suite with cleanup turned off', async () => {
    const app = appWith('codeception-cests', {
      'codeception.yml': `namespace: App\\Tests
paths:
    tests: tests
    output: var/codeception
settings:
    shuffle: true
`,
      'tests/acceptance.suite.yml': `actor: AcceptanceTester
modules:
    enabled:
        - WebDriver:
              url: http://localhost
        - Db:
              cleanup: false
`,
      'tests/functional.suite.yml': `actor: FunctionalTester
modules:
    enabled:
        - Symfony:
              app_path: src
        - Doctrine2:
              cleanup: true
`,
      'tests/acceptance/LoginCest.php': `<?php

namespace App\\Tests\\Acceptance;

class LoginCest
{
    public function _before(\\AcceptanceTester $I): void
    {
    }

    public function logsIn(\\AcceptanceTester $I): void
    {
        $I->amOnPage('/login');
    }
}
`,
      'tests/_bootstrap.php': `<?php

require dirname(__DIR__) . '/vendor/autoload.php';
`,
    });

    const text = await runModule('codeception-config.js', app);

    expect(text).toContain('acceptance');
  });
});

describe('composer security', () => {
  test('a lock file, allowed plugins and a loose minimum stability', async () => {
    const app = appWith('composer-audit', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'minimum-stability': 'dev',
        'prefer-stable': false,
        config: {
          'allow-plugins': {
            'symfony/flex': true,
            'php-http/discovery': true,
            'composer/package-versions-deprecated': false,
          },
        },
        scripts: {
          'post-install-cmd': ['@auto-scripts'],
        },
      }, null, 2),
      'composer.lock': JSON.stringify({
        'content-hash': 'a1b2c3d4',
        packages: [
          { name: 'symfony/framework-bundle', version: 'v7.0.3' },
          { name: 'symfony/http-kernel', version: 'v7.0.3' },
        ],
        'packages-dev': [],
      }, null, 2),
    });

    const text = await runModule('composer-security-audit.js', app);

    expect(text).toContain('minimum-stability');
  });
});

describe('cypress', () => {
  test('a cypress config with fixtures and a spec that waits on time', async () => {
    const app = appWith('cypress', {
      'cypress.config.js': `const { defineConfig } = require('cypress');

module.exports = defineConfig({
    e2e: {
        baseUrl: 'http://localhost:8000',
        defaultCommandTimeout: 4000,
        video: true,
        retries: 0,
    },
});
`,
      'cypress/fixtures/user.json': JSON.stringify({ email: 'acme@example.com' }, null, 2),
      'cypress/e2e/login.cy.js': `describe('login', () => {
    it('signs in', () => {
        cy.visit('/login');
        cy.wait(5000);
        cy.get('#email').type('acme@example.com');
    });
});
`,
    });

    const text = await runModule('cypress-e2e-config.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('container parameters', () => {
  test('nested parameters, a credential among them and one used from a service', async () => {
    const app = appWith('di-parameters', {
      'config/services.yaml': `parameters:
    app.name: 'Acme'
    app.mailer:
        from: 'noreply@example.com'
        password: 'hunter2'
    app.upload_dir: '%kernel.project_dir%/var/uploads'

services:
    App\\Service\\Uploader:
        arguments:
            $uploadDir: '%app.upload_dir%'
`,
      'src/Service/Uploader.php': `<?php

namespace App\\Service;

class Uploader
{
    public function __construct(private string $uploadDir)
    {
    }

    public function name(): string
    {
        return $this->parameterBag->get('app.name');
    }
}
`,
    });

    const text = await runModule('di-parameters.js', app);

    expect(text).toContain('app.name');
    expect(text).not.toContain('hunter2');
  });
});

describe('entity factories in detail', () => {
  test('a factory with no defaults, one returning nulls, a seeded faker and a large createMany', async () => {
    const app = appWith('entity-factory-detail', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'zenstruck/foundry': '^2.0' },
      }, null, 2),
      'src/Factory/BareFactory.php': `<?php

namespace App\\Factory;

use Zenstruck\\Foundry\\ModelFactory;

final class BareFactory extends ModelFactory
{
    protected static function getClass(): string
    {
        return \\App\\Entity\\Bare::class;
    }
}
`,
      'src/Factory/NullFactory.php': `<?php

namespace App\\Factory;

use Zenstruck\\Foundry\\ModelFactory;

final class NullFactory extends ModelFactory
{
    protected function getDefaults(): array
    {
        return ['name' => null, 'email' => null];
    }

    protected static function getClass(): string
    {
        return \\App\\Entity\\Nulls::class;
    }
}
`,
      'src/Factory/SeededFactory.php': `<?php

namespace App\\Factory;

use Zenstruck\\Foundry\\ModelFactory;

final class SeededFactory extends ModelFactory
{
    protected function getDefaults(): array
    {
        self::faker()->seed(1234);

        return ['name' => self::faker()->name()];
    }

    protected static function getClass(): string
    {
        return \\App\\Entity\\Seeded::class;
    }
}
`,
      'src/DataFixtures/BigFixtures.php': `<?php

namespace App\\DataFixtures;

use App\\Factory\\SeededFactory;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class BigFixtures extends Fixture
{
    public function load(ObjectManager $manager): void
    {
        SeededFactory::createMany(500);
    }
}
`,
    });

    const text = await runModule('doctrine-entity-factory.js', app);

    expect(text).toContain('BareFactory');
  });
});

describe('proxy directories', () => {
  test('generated proxies counted through nested directories, and a colliding namespace', async () => {
    const app = appWith('proxy-count', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: true
        proxy_dir: '%kernel.cache_dir%/doctrine/orm/Proxies'
        proxy_namespace: App
`,
      'var/cache/prod/doctrine/orm/Proxies/__CG__AppEntityInvoice.php': '<?php // proxy\n',
      'var/cache/prod/doctrine/orm/Proxies/nested/__CG__AppEntityCustomer.php': '<?php // proxy\n',
      'var/cache/prod/doctrine/orm/Proxies/nested/deeper/__CG__AppEntityLine.php': '<?php // proxy\n',
      'var/cache/prod/doctrine/orm/Proxies/notes.txt': 'not a proxy\n',
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
}
`,
    });

    const text = await runModule('doctrine-entity-proxy.js', app);

    expect(text).toContain('proxy');
  });
});

describe('inheritance strategies', () => {
  test('table per class, and a joined hierarchy several levels deep', async () => {
    const entity = (name: string, extend: string | null, extra = ''): string => `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
${extra}
class ${name}${extend ? ` extends ${extend}` : ''}
{
}
`;

    const app = appWith('inheritance', {
      'src/Entity/Vehicle.php': entity('Vehicle', null, "#[ORM\\InheritanceType('TABLE_PER_CLASS')]\n#[ORM\\DiscriminatorColumn(name: 'kind', type: 'string')]"),
      'src/Entity/Car.php': entity('Car', 'Vehicle'),
      'src/Entity/Document.php': entity('Document', null, "#[ORM\\InheritanceType('JOINED')]\n#[ORM\\DiscriminatorColumn(name: 'kind', type: 'string')]"),
      'src/Entity/Invoice.php': entity('Invoice', 'Document'),
      'src/Entity/CreditNote.php': entity('CreditNote', 'Invoice'),
      'src/Entity/ProformaNote.php': entity('ProformaNote', 'CreditNote'),
      'src/Entity/DraftProforma.php': entity('DraftProforma', 'ProformaNote'),
      'src/Entity/DeepDraft.php': entity('DeepDraft', 'DraftProforma'),
    });

    const text = await runModule('doctrine-inheritance.js', app);

    expect(text).toContain('TABLE_PER_CLASS');
  });
});

describe('migration graph', () => {
  test('versions with more than a year between them', async () => {
    const migration = (version: string): string => `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version${version} extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }
}
`;
    const app = appWith('migration-graph', {
      'migrations/Version20220101000000.php': migration('20220101000000'),
      'migrations/Version20240101000000.php': migration('20240101000000'),
      'migrations/Version20260101000000.php': migration('20260101000000'),
    });

    const text = await runModule('doctrine-migration-graph.js', app);

    expect(text).toContain('20220101000000');
  });
});

describe('migrations configuration', () => {
  test('the config nested under doctrine, transactional off, organised by year and a colliding table', async () => {
    const app = appWith('migrations-config', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: false

doctrine_migrations:
    migrations_paths:
        'DoctrineMigrations': '%kernel.project_dir%/migrations'
    transactional: false
    organize_migrations: BY_YEAR
    table_name: invoice
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'invoice')]
class Invoice
{
}
`,
      'migrations/Version20260101000000.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }
}
`,
    });

    const text = await runModule('doctrine-migrations-config.js', app);

    expect(text).toContain('transactional');
  });
});

describe('multiple connections', () => {
  test('several entity managers, one with no connection binding and entity dirs on the default', async () => {
    const app = appWith('multi-connection', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        default_connection: default
        connections:
            default:
                host: db.example.com
                dbname: acme
            reporting:
                host: reporting.example.com
                dbname: reporting
            broken: ~
    orm:
        default_entity_manager: default
        entity_managers:
            default:
                mappings:
                    App:
                        dir: '%kernel.project_dir%/src/Entity'
                        prefix: 'App\\Entity'
                    broken: ~
            reporting:
                mappings:
                    Reporting:
                        dir: '%kernel.project_dir%/src/Reporting'
                    broken: ~
            broken: ~
`,
    });

    const text = await runModule('doctrine-multi-connection.js', app);

    expect(text).toContain('reporting');
  });
});

describe('feature flags', () => {
  test('flags in flagception, in parameters and referenced from code', async () => {
    const app = appWith('feature-flags', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'flagception/flagception-bundle': '^3.0' },
      }, null, 2),
      'config/packages/flagception.yaml': `flagception:
    features:
        feature_new_checkout: true
        feature_legacy_import: false
        feature_beta: ~
`,
      'config/services.yaml': `parameters:
    feature.new_dashboard: true
    feature.old_reports: false
    app.name: 'Acme'
`,
      'src/Controller/CheckoutController.php': `<?php

namespace App\\Controller;

use Flagception\\Manager\\FeatureManagerInterface;

class CheckoutController
{
    public function __construct(private FeatureManagerInterface $features)
    {
    }

    public function index(): void
    {
        if ($this->features->isActive('feature_new_checkout')) {
            return;
        }
    }
}
`,
    });

    const text = await runModule('feature-flags.js', app);

    expect(text).toContain('feature_new_checkout');
  });
});

describe('github api', () => {
  test('a webhook secret in .env and a client built in code', async () => {
    const app = appWith('github-api', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'knplabs/github-api': '^3.0' },
      }, null, 2),
      '.env': `GITHUB_TOKEN=ghp\x5f0123456789abcdef0123456789abcdef
GITHUB_WEBHOOK_SECRET=whsec\x5f0123456789abcdef
`,
      '.env.local': `GITHUB_WEBHOOK_SECRET=%env(GITHUB_WEBHOOK_SECRET)%
`,
      'src/Github/Client.php': `<?php

namespace App\\Github;

use Github\\Client as GithubClient;

class Client
{
    public function build(): GithubClient
    {
        $client = new GithubClient();
        $client->authenticate($_ENV['GITHUB_TOKEN'], null, GithubClient::AUTH_ACCESS_TOKEN);

        return $client;
    }

    public function webhook(string $payload, string $signature): bool
    {
        return hash_equals('sha256=' . hash_hmac('sha256', $payload, $_ENV['GITHUB_WEBHOOK_SECRET']), $signature);
    }
}
`,
    });

    const text = await runModule('github-api-integration.js', app);

    expect(text).toContain('GITHUB_WEBHOOK_SECRET');
    expect(text).not.toContain('whsec\x5f0123456789abcdef');
  });
});

describe('google oauth', () => {
  test('a client id and secret in .env and an oauth flow in code', async () => {
    const app = appWith('google-oauth', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'google/apiclient': '^2.15' },
      }, null, 2),
      '.env': `GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-0123456789abcdef
GOOGLE_REDIRECT_URI=https://acme.example.com/oauth/google
`,
      'src/Google/OAuth.php': `<?php

namespace App\\Google;

use Google\\Client;

class OAuth
{
    public function client(): Client
    {
        $client = new Client();
        $client->setClientId($_ENV['GOOGLE_CLIENT_ID']);
        $client->setClientSecret($_ENV['GOOGLE_CLIENT_SECRET']);
        $client->setRedirectUri($_ENV['GOOGLE_REDIRECT_URI']);
        $client->addScope('https://www.googleapis.com/auth/userinfo.email');
        $client->setAccessType('offline');

        return $client;
    }
}
`,
    });

    const text = await runModule('google-oauth-integration.js', app);

    expect(text).toContain('GOOGLE_CLIENT');
    expect(text).not.toContain('GOCSPX-0123456789abcdef');
  });
});

describe('kernel bundles', () => {
  test('bundles enabled only in test and in a mix of environments', async () => {
    const app = appWith('kernel-bundles', {
      'config/bundles.php': `<?php

return [
    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],
    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['dev' => true, 'test' => true],
    Symfony\\Bundle\\MakerBundle\\MakerBundle::class => ['dev' => true],
    DAMA\\DoctrineTestBundle\\DAMADoctrineTestBundle::class => ['test' => true],
    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],
];
`,
      'src/Kernel.php': `<?php

namespace App;

use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
`,
    });

    const text = await runModule('kernel-analysis.js', app);

    expect(text).toContain('Test only');
  });
});

describe('oauth sso', () => {
  test('a client over http, several providers and env vars with no bundle config', async () => {
    const app = appWith('oauth-sso', {
      'config/packages/knpu_oauth2_client.yaml': `knpu_oauth2_client:
    clients:
        google:
            type: google
            client_id: '%env(GOOGLE_CLIENT_ID)%'
            client_secret: '%env(GOOGLE_CLIENT_SECRET)%'
            redirect_route: connect_google_check
            redirect_uri: 'http://acme.example.com/connect/google/check'
            scopes: ['email', 'profile']
        github:
            type: github
            client_id: '%env(GITHUB_CLIENT_ID)%'
            client_secret: '%env(GITHUB_CLIENT_SECRET)%'
            redirect_uri: 'https://acme.example.com/connect/github/check'
        broken: ~
`,
      '.env': `AZURE_CLIENT_ID=azure-id
AZURE_CLIENT_SECRET=azure-secret
`,
    });

    const text = await runModule('oauth-sso.js', app);

    expect(text).toContain('google');
  });
});

describe('owasp dependency check', () => {
  test('an old report and the check wired into the pipeline', async () => {
    const app = appWith('owasp', {
      'dependency-check.xml': `<?xml version="1.0"?>
<analysis>
    <projectInfo>
        <name>acme</name>
        <reportDate>2020-01-01T00:00:00Z</reportDate>
    </projectInfo>
</analysis>
`,
      '.github/workflows/security.yml': `name: security
on: [push]
jobs:
    audit:
        runs-on: ubuntu-latest
        steps:
            - run: dependency-check.sh --project acme --scan .
`,
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        scripts: { audit: 'composer audit' },
      }, null, 2),
    });

    const text = await runModule('owasp-dependency-check.js', app);

    expect(text).toContain('dependency-check');
  });
});

describe('password hashers', () => {
  test('bcrypt with no cost and argon2 with no memory cost', async () => {
    const app = appWith('password-hashers', {
      'config/packages/security.yaml': `security:
    password_hashers:
        App\\Entity\\User:
            algorithm: bcrypt
        App\\Entity\\Admin:
            algorithm: argon2id
        App\\Entity\\Legacy:
            algorithm: sodium
            memory_cost: 65536
            time_cost: 4
            threads: 2
`,
    });

    const text = await runModule('password-hashers.js', app);

    expect(text).toContain('bcrypt');
  });
});

describe('composer autoload', () => {
  test('psr-0 namespaces, a classmap and files loaded on every request', async () => {
    const app = appWith('autoload-optimize', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        autoload: {
          'psr-4': { 'App\\': 'src/' },
          'psr-0': { 'Legacy_': 'lib/' },
          classmap: ['lib/legacy', 'database/seeds'],
          files: ['src/helpers.php', 'src/constants.php'],
        },
        'autoload-dev': {
          'psr-4': { 'App\\Tests\\': 'tests/' },
        },
        config: { optimize_autoloader: false },
      }, null, 2),
    });

    const text = await runModule('php-composer-autoload-optimize.js', app);

    expect(text).toContain('psr-0');
  });
});

describe('cs fixer rules', () => {
  test('rules turned off explicitly, and a rector config beside them', async () => {
    const disabled = Array.from({ length: 12 }, (_, i) => `        'rule_${i}' => false,`).join('\n');
    const app = appWith('cs-fixer-rules', {
      '.php-cs-fixer.dist.php': `<?php

return (new PhpCsFixer\\Config())
    ->setRules([
        '@PSR12' => true,
        'strict_types' => true,
${disabled}
    ])
    ->setFinder(PhpCsFixer\\Finder::create()->in(__DIR__ . '/src'));
`,
      'rector.php': `<?php

use Rector\\Config\\RectorConfig;

return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->paths([__DIR__ . '/src']);
};
`,
    });

    const text = await runModule('php-cs-fixer.js', app);

    expect(text).toContain('PSR12');
  });
});

describe('ffi', () => {
  test('cdef with shell functions, load with a relative and a variable path, and ffi enabled in the ini', async () => {
    const app = appWith('php-ffi', {
      'src/Ffi/Bridge.php': `<?php

namespace App\\Ffi;

class Bridge
{
    public function define(): \\FFI
    {
        return \\FFI::cdef('
            int system(const char *command);
            int execve(const char *path, char *const argv[], char *const envp[]);
        ', 'libc.so.6');
    }

    public function relative(): \\FFI
    {
        return \\FFI::load('./headers/acme.h');
    }

    public function fromVariable(string $path): \\FFI
    {
        return \\FFI::load($path);
    }
}
`,
      'src/Ffi/Scoped.php': `<?php

namespace App\\Ffi;

#[\\FFI\\Scope('acme')]
class Scoped
{
}
`,
      'php.ini': `ffi.enable = true
`,
      'docker/php/conf.d/ffi.ini': `ffi.enable = preload
ffi.preload = /srv/app/headers/acme.h
`,
    });

    const text = await runModule('php-ffi.js', app);

    expect(text).toContain('FFI');
  });
});

describe('integer overflow', () => {
  test('a shift past the word size, a literal over the 32-bit limit and bcmath beside them', async () => {
    const app = appWith('integer-overflow', {
      'src/Math/Big.php': `<?php

namespace App\\Math;

class Big
{
    public function shifted(int $value): int
    {
        return $value << 70;
    }

    public function literal(): int
    {
        return 9223372036854775807;
    }

    public function guarded(string $input): int
    {
        if (!is_numeric($input)) {
            throw new \\InvalidArgumentException('not a number');
        }

        return (int) $input;
    }

    public function precise(string $a, string $b): string
    {
        return bcadd($a, $b, 2);
    }
}
`,
    });

    const text = await runModule('php-integer-overflow.js', app);

    expect(text).toContain('Big');
  });
});

describe('opcache settings', () => {
  test('memory in gigabytes and kilobytes, and a revalidation frequency', async () => {
    const app = appWith('opcache-settings', {
      'docker/php/php.ini': `opcache.enable = 1
opcache.memory_consumption = 1G
opcache.interned_strings_buffer = 8192K
opcache.max_accelerated_files = 4000
opcache.revalidate_freq = 60
opcache.validate_timestamps = 1
opcache.preload = /srv/app/config/preload.php
`,
      'src/Kernel.php': `<?php

namespace App;

class Kernel
{
}
`,
    });

    const text = await runModule('php-opcache-settings.js', app);

    expect(text).toContain('opcache');
  });
});

describe('pdo connections', () => {
  test('a connection with no exception mode, one silenced and one persistent', async () => {
    const app = appWith('pdo-patterns', {
      'src/Db/Connections.php': `<?php

namespace App\\Db;

class Connections
{
    public function bare(): \\PDO
    {
        return new PDO('mysql:host=db;dbname=acme', 'app', 'secret');
    }

    public function silent(): \\PDO
    {
        return new PDO('mysql:host=db;dbname=acme', 'app', 'secret', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT,
        ]);
    }

    public function persistent(): \\PDO
    {
        return new PDO('mysql:host=db;dbname=acme', 'app', 'secret', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_PERSISTENT => true,
        ]);
    }
}
`,
    });

    const text = await runModule('php-pdo-patterns.js', app);

    expect(text).toContain('PDO');
  });
});

describe('rector upgrade sets', () => {
  test('php level sets, a symfony set and a set that is not a version', async () => {
    const app = appWith('rector-sets', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.3', 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'rector/rector': '^1.0' },
      }, null, 2),
      'rector.php': `<?php

use Rector\\Config\\RectorConfig;
use Rector\\Set\\ValueObject\\LevelSetList;
use Rector\\Set\\ValueObject\\SetList;
use Rector\\Symfony\\Set\\SymfonySetList;

return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->sets([
        LevelSetList::UP_TO_PHP_82,
        SetList::CODE_QUALITY,
        SetList::DEAD_CODE,
        SymfonySetList::SYMFONY_64,
    ]);
};
`,
    });

    const text = await runModule('php-rector-upgrade-sets.js', app);

    expect(text).toContain('PHP');
  });
});

describe('static methods', () => {
  test('a utility class of statics and a static called through $this', async () => {
    const statics = Array.from({ length: 9 }, (_, i) => `    public static function helper${i}(): void\n    {\n    }\n`).join('\n');
    const app = appWith('static-methods', {
      'src/Support/Helpers.php': `<?php

namespace App\\Support;

class Helpers
{
${statics}
    public static function format(string $value): string
    {
        return trim($value);
    }

    public function call(): string
    {
        return $this->format('  x  ');
    }
}
`,
    });

    const text = await runModule('php-static-methods.js', app);

    expect(text).toContain('Helpers');
  });
});

describe('type narrowing', () => {
  test('is_null negated, a call on a nullable and the null-safe arrow written wrong', async () => {
    const app = appWith('type-narrowing', {
      'src/Service/Narrow.php': `<?php

namespace App\\Service;

class Narrow
{
    public function check(?object $value): string
    {
        if (!is_null($value)) {
            return 'set';
        }

        return 'unset';
    }

    public function direct(?object $invoice): string
    {
        return $invoice->getReference();
    }

    public function wrongArrow(?object $invoice): string
    {
        return $invoice ??-> getReference();
    }
}
`,
    });

    const text = await runModule('php-type-narrowing.js', app);

    expect(text).toContain('Narrow');
  });
});

describe('typed constants', () => {
  test('constants whose declared type does not match the value, on php 8.3', async () => {
    const app = appWith('typed-constants', {
      'composer.json': JSON.stringify({
        require: { php: '^8.3', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Config/Limits.php': `<?php

namespace App\\Config;

class Limits
{
    const int MAX_ITEMS = 'one hundred';

    const string NAME = 42;

    const bool ENABLED = 'yes';

    const float RATE = 'zero point five';

    const int PAGE_SIZE = 25;
}
`,
    });

    const text = await runModule('php-typed-constants.js', app);

    expect(text).toContain('MAX_ITEMS');
  });
});

describe('phpspec specs on disk', () => {
  test('spec files beside the config, and one that is not a spec', async () => {
    const app = appWith('phpspec-specs', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpspec/phpspec': '^7.5' },
      }, null, 2),
      'phpspec.yaml': `suites:
  main:
    namespace: App
    src_path: src
`,
      'spec/Service/InvoiceSpec.php': `<?php

namespace spec\\App\\Service;

use App\\Service\\Invoice;
use PhpSpec\\ObjectBehavior;

class InvoiceSpec extends ObjectBehavior
{
    public function it_is_initializable(): void
    {
        $this->shouldHaveType(Invoice::class);
    }

    public function it_totals_the_lines(): void
    {
    }
}
`,
      'spec/Service/Helper.php': `<?php

namespace spec\\App\\Service;

class Helper
{
}
`,
    });

    const text = await runModule('phpspec-config.js', app);

    expect(text).toContain('InvoiceSpec');
  });
});

describe('clock in tests', () => {
  test('assertions on time(), a bare DateTime and a SystemClock built by hand', async () => {
    const app = appWith('clock-assertions', {
      'tests/Service/ClockTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\TestCase;
use Symfony\\Component\\Clock\\NativeClock;

class ClockTest extends TestCase
{
    public function testItStampsNow(): void
    {
        self::assertSame(time(), $this->service->stamp());
    }

    public function testItUsesDateTime(): void
    {
        $now = new \\DateTimeImmutable();
        self::assertEquals($now, $this->service->now());
    }

    public function testItBuildsAClock(): void
    {
        $clock = new SystemClock();
        self::assertNotNull($clock);
    }
}
`,
    });

    const text = await runModule('phpunit-clock-assertion.js', app);

    expect(text).toContain('ClockTest');
  });
});

describe('phpunit coverage minimums', () => {
  test('minimum percentages for lines, methods, classes and branches', async () => {
    const app = appWith('phpunit-minimums', {
      'phpunit.xml': `<?xml version="1.0"?>
<phpunit bootstrap="tests/bootstrap.php">
    <testsuites>
        <testsuite name="all">
            <directory>tests</directory>
        </testsuite>
    </testsuites>

    <coverage>
        <report>
            <text outputFile="php://stdout"/>
        </report>
    </coverage>

    <source>
        <include>
            <directory>src</directory>
        </include>
    </source>

    <php>
        <env name="APP_ENV" value="test"/>
    </php>

    <extensions>
        <bootstrap class="App\\Tests\\Extension\\Coverage">
            <parameter name="minLines" value="90"/>
            <parameter name="minMethods" value="85"/>
            <parameter name="minClasses" value="80"/>
            <parameter name="minBranches" value="75"/>
        </bootstrap>
    </extensions>
</phpunit>
`,
    });

    const text = await runModule('phpunit-config.js', app);

    expect(text).toContain('all');
  });
});

describe('psalm', () => {
  test('a permissive error level, many suppressed issues and a large baseline', async () => {
    const suppressed = Array.from({ length: 18 }, (_, i) => `        <Issue${i} errorLevel="suppress"/>`).join('\n');
    const baseline = Array.from({ length: 210 }, () => '        <entry file="src/Legacy.php"/>').join('\n');
    const app = appWith('psalm', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'vimeo/psalm': '^5.0' },
      }, null, 2),
      'psalm.xml': `<?xml version="1.0"?>
<psalm errorLevel="7" resolveFromConfigFile="true" errorBaseline=".psalm/baseline.xml">
    <projectFiles>
        <directory name="src"/>
    </projectFiles>
    <issueHandlers>
${suppressed}
    </issueHandlers>
</psalm>
`,
      '.psalm/baseline.xml': `<?xml version="1.0"?>
<files psalm-version="5.0">
${baseline}
</files>
`,
    });

    const text = await runModule('psalm-config.js', app);

    expect(text).toContain('psalm');
  });
});

describe('asset versioning', () => {
  test('a static version, a manifest that is not there and a cdn over http', async () => {
    const app = appWith('assets-versioning', {
      'config/packages/framework.yaml': `framework:
    assets:
        version: 'v1'
        version_format: '%%s?v=%%s'
        packages:
            cdn:
                base_url: 'http://cdn.example.com'
                version: 'v2'
            built:
                json_manifest_path: '%kernel.project_dir%/public/build/missing.json'
                base_path: /build
`,
    });

    const text = await runModule('symfony-assets-versioning.js', app);

    expect(text).toContain('version');
  });
});

describe('emoji', () => {
  test('a slugger without the transliterator, emoji in an email and twig filters', async () => {
    const app = appWith('emoji', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/string': '^7.0' },
      }, null, 2),
      'src/Service/Slugs.php': `<?php

namespace App\\Service;

use Symfony\\Component\\String\\Slugger\\AsciiSlugger;

class Slugs
{
    public function slug(string $title): string
    {
        $slugger = new AsciiSlugger();

        return (string) $slugger->slug($title);
    }
}
`,
      'src/Mail/Welcome.php': `<?php

namespace App\\Mail;

use Symfony\\Component\\Mime\\Email;

class Welcome
{
    public function build(): Email
    {
        return (new Email())
            ->subject('Bienvenido 🎉')
            ->text('Gracias por registrarte 🚀');
    }
}
`,
      'templates/home/index.html.twig': `<p>{{ title|emojify }}</p>
<p>{{ title|slug }}</p>
`,
    });

    const text = await runModule('symfony-emoji.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('error controller', () => {
  test('an error controller named in the config that does not exist, and an exception with no translation', async () => {
    const app = appWith('error-controller', {
      'config/packages/framework.yaml': `framework:
    error_controller: 'App\\Controller\\MissingErrorController::show'
`,
      'src/Exception/PaymentException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpException;

class PaymentException extends HttpException
{
    public function __construct()
    {
        parent::__construct(402, 'Payment required');
    }
}
`,
    });

    const text = await runModule('symfony-error-controller.js', app);

    expect(text).toContain('error_controller');
  });
});

describe('expression language', () => {
  test('access control with allow_if, a Security attribute and a long expression', async () => {
    const long = "is_granted('ROLE_ADMIN') and user.isActive() and user.getOrganisation().isEnabled() and object.isOwnedBy(user)";
    const app = appWith('expression-language', {
      'config/packages/security.yaml': `security:
    access_control:
        - { path: ^/admin, allow_if: "${long}" }
        - { path: ^/reports, allow_if: "is_granted('ROLE_USER')" }
`,
      'src/Controller/ReportController.php': `<?php

namespace App\\Controller;

use Sensio\\Bundle\\FrameworkExtraBundle\\Configuration\\Security;
use Symfony\\Component\\ExpressionLanguage\\ExpressionLanguage;

class ReportController
{
    /**
     * @Security("${long}")
     */
    public function index(): void
    {
        $language = new ExpressionLanguage();
        $language->evaluate('1 + 1');
    }
}
`,
    });

    const text = await runModule('symfony-expression-language.js', app);

    expect(text).toContain('access_control');
  });
});

describe('compound form types', () => {
  test('a form with many fields that embeds another form deeply', async () => {
    const fields = Array.from({ length: 26 }, (_, i) => `            ->add('field${i}', TextType::class)`).join('\n');
    const app = appWith('compound-forms', {
      'src/Form/OrderType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class OrderType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
${fields}
            ->add('customer', CustomerType::class);
    }
}
`,
      'src/Form/CustomerType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class CustomerType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('name', TextType::class)
            ->add('address', AddressType::class);
    }
}
`,
      'src/Form/AddressType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class AddressType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->add('street', TextType::class);
    }
}
`,
    });

    const text = await runModule('symfony-form-compound-types.js', app);

    expect(text).toContain('OrderType');
  });
});

describe('pre set data listeners', () => {
  test('a listener that checks for null, one that does not and fields added conditionally', async () => {
    const app = appWith('pre-set-data', {
      'src/Form/InvoiceType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\Form\\FormEvent;
use Symfony\\Component\\Form\\FormEvents;

class InvoiceType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event): void {
            $invoice = $event->getData();
            $form = $event->getForm();

            if (null === $invoice) {
                return;
            }

            if ($invoice->isDraft()) {
                $form->add('reference', TextType::class);
            } else {
                $form->add('reference', TextType::class, ['disabled' => true]);
            }
        });

        $builder->addEventListener(FormEvents::PRE_SET_DATA, function (FormEvent $event): void {
            $invoice = $event->getData();
            $event->getForm()->add('total', TextType::class, [
                'data' => $invoice->getTotal(),
            ]);
        });
    }
}
`,
    });

    const text = await runModule('symfony-form-pre-set-data.js', app);

    expect(text).toContain('InvoiceType');
  });
});

describe('repeated fields', () => {
  test('a repeated password on the wrong type and a manual comparison', async () => {
    const app = appWith('form-repeated', {
      'src/Form/RegistrationType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\RepeatedType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class RegistrationType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->add('password', RepeatedType::class, [
            'type' => TextType::class,
            'first_options' => ['label' => 'Password'],
            'second_options' => ['label' => 'Repeat password'],
        ]);
    }
}
`,
      'src/Security/PasswordChecker.php': `<?php

namespace App\\Security;

class PasswordChecker
{
    public function check(string $first, string $second): bool
    {
        return $first === $second;
    }
}
`,
    });

    const text = await runModule('symfony-form-repeated.js', app);

    expect(text).toContain('RepeatedType');
  });
});

describe('http client decorators', () => {
  test('a decorator with request() but no withOptions(), and a mock factory in the test config', async () => {
    const app = appWith('http-client-events', {
      'config/packages/test/framework.yaml': `framework:
    http_client:
        mock_response_factory: 'App\\Tests\\MockResponseFactory'
`,
      'config/packages/framework.yaml': `framework:
    http_client:
        default_options:
            timeout: 10
`,
      'src/Client/LoggingClient.php': `<?php

namespace App\\Client;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;
use Symfony\\Contracts\\HttpClient\\ResponseInterface;

class LoggingClient implements HttpClientInterface
{
    public function __construct(private HttpClientInterface $inner)
    {
    }

    public function request(string $method, string $url, array $options = []): ResponseInterface
    {
        $response = $this->inner->request($method, $url, $options);
        $this->logger->info('called', ['url' => $url]);

        return $response;
    }

    public function stream($responses, ?float $timeout = null): \\Generator
    {
        yield from $this->inner->stream($responses, $timeout);
    }
}
`,
    });

    const text = await runModule('symfony-http-client-events.js', app);

    expect(text).toContain('mock_response_factory');
  });
});

describe('http middleware', () => {
  test('a listener with a very high priority, one that sets a response and two at the same priority', async () => {
    const app = appWith('http-middleware', {
      'src/EventSubscriber/RequestSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;

class RequestSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'kernel.request' => [
                ['onEarly', 512],
                ['onNormal', 10],
                ['onAlso', 10],
            ],
            'kernel.response' => ['onResponse'],
        ];
    }

    public function onEarly(RequestEvent $event): void
    {
        $event->setResponse($this->maintenanceResponse());
    }

    public function onNormal(RequestEvent $event): void
    {
    }

    public function onAlso(RequestEvent $event): void
    {
    }

    public function onResponse($event): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-http-middleware.js', app);

    expect(text).toContain('RequestSubscriber');
  });
});

describe('kubernetes config maps', () => {
  test('a config map with a secret in it and env values from a field reference', async () => {
    const app = appWith('kubernetes-configmap', {
      'k8s/configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
    name: acme-config
data:
    APP_ENV: prod
    DATABASE_PASSWORD: hunter2
    APP_URL: https://acme.example.com
`,
      'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: acme
spec:
    replicas: 2
    template:
        spec:
            containers:
                - name: app
                  image: acme:1.0
                  env:
                      - name: POD_NAME
                        valueFrom:
                          fieldRef:
                            fieldPath: metadata.name
                      - name: APP_ENV
                        value: prod
                  resources:
                      limits:
                          cpu: 500m
                          memory: 512Mi
                  livenessProbe:
                      httpGet:
                          path: /health
                          port: 8080
                  readinessProbe:
                      httpGet:
                          path: /ready
                          port: 8080
`,
      'k8s/broken.yaml': 'not: [valid\n',
    });

    const text = await runModule('symfony-kubernetes.js', app);

    expect(text).toContain('ConfigMap');
  });
});

describe('locale fallbacks', () => {
  test('a locale with translations that is not enabled, and one with no base fallback', async () => {
    const app = appWith('locale-config', {
      'config/packages/translation.yaml': `framework:
    default_locale: en
    enabled_locales: ['en', 'es']
    translator:
        default_path: '%kernel.project_dir%/translations'
        fallbacks:
            es: ['en']
            '*': ['en']
`,
      'translations/messages.en.yaml': `app:
    title: 'Dashboard'
`,
      'translations/messages.es.yaml': `app:
    title: 'Panel'
`,
      'translations/messages.fr_CA.yaml': `app:
    title: 'Tableau de bord'
`,
      'translations/messages.de.yaml': `app:
    title: 'Ubersicht'
`,
    });

    const text = await runModule('symfony-locale-config.js', app);

    expect(text).toContain('fr_CA');
  });
});

describe('lock stores in config', () => {
  test('pdo, zookeeper, in memory and combined stores', async () => {
    const app = appWith('lock-store-config', {
      'config/packages/lock.yaml': `framework:
    lock:
        default: 'mysql://app:pass@db:3306/acme'
        zk: 'zookeeper://zk:2181'
        memory: 'in-memory'
        combined: 'combined-lock:consensus'
`,
    });

    const text = await runModule('symfony-lock-store-config.js', app);

    expect(text).toContain('zookeeper');
  });
});

describe('routing table transports', () => {
  test('a transport list with blank lines and quoted names', async () => {
    const app = appWith('routing-table-quotes', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default'
            failed: 'doctrine://default?queue_name=failed'
        routing:
            'App\\Message\\SendInvoice': "async"

            'App\\Message\\RebuildIndex':
                - 'async'

                - "failed"
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

describe('push notifications', () => {
  test('firebase, onesignal and expo keys written in the config, and a message built from user input', async () => {
    const app = appWith('notifier-push', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'symfony/firebase-notifier': '^7.0' },
      }, null, 2),
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            firebase: 'firebase://AAAA0123456789:APA91bF@default'
            onesignal: 'onesignal://APP_ID:api_key=0123456789abcdef@default'
            expo: 'expo://default'
`,
      'src/Notification/PushSender.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Message\\PushMessage;

class PushSender
{
    public function send(): PushMessage
    {
        return new PushMessage($_GET['title'], $_GET['body'], ['recipient_id' => $_GET['user']]);
    }
}
`,
    });

    const text = await runModule('symfony-notifier-push.js', app);

    expect(text).toContain('firebase');
  });
});

describe('rate limiter algorithms', () => {
  test('each policy in the production configuration', async () => {
    const app = appWith('limiter-algorithms', {
      'config/packages/prod/rate_limiter.yaml': `framework:
    rate_limiter:
        sliding:
            policy: 'sliding_window'
            limit: 100
            interval: '1 hour'
        fixed:
            policy: 'fixed_window'
            limit: 50
            interval: '15 minutes'
        bucket:
            policy: 'token_bucket'
            limit: 10
            rate: { interval: '1 minute', amount: 10 }
        noop:
            policy: 'no_limit'
`,
    });

    const text = await runModule('symfony-rate-limiter-algorithms.js', app);

    expect(text).toContain('Rate Limiter');
  });
});

describe('scheduler intervals in the config', () => {
  test('schedules with expressions in iso and in words', async () => {
    const app = appWith('scheduler-config-intervals', {
      'config/packages/scheduler.yaml': `framework:
    scheduler:
        schedules:
            default:
                transport: 'doctrine://default'
                tasks:
                    - id: EveryMinutes
                      expression: 'PT15M'
                    - id: EveryHours
                      expression: 'PT6H'
                    - id: EverySeconds
                      expression: '90'
                    - id: Nonsense
                      expression: 'whenever'
            broken: ~
`,
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);

    expect(text).toContain('EveryMinutes');
  });
});

describe('two factor authentication', () => {
  test('2fa without trusted devices, without backup codes and totp with no window', async () => {
    const app = appWith('two-factor', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'scheb/2fa-bundle': '^7.0', 'scheb/2fa-totp': '^7.0' },
      }, null, 2),
      'config/packages/scheb_two_factor.yaml': `scheb_two_factor:
    totp:
        enabled: true
        issuer: Acme
    google:
        enabled: true
    email:
        enabled: false
`,
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            lazy: true
            two_factor:
                auth_form_path: 2fa_login
                check_path: 2fa_login_check
`,
      'src/Entity/User.php': `<?php

namespace App\\Entity;

use Scheb\\TwoFactorBundle\\Model\\Totp\\TwoFactorInterface;

class User implements TwoFactorInterface
{
    public function isTotpAuthenticationEnabled(): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-security-two-factor.js', app);

    expect(text).toContain('2FA');
  });
});

describe('semaphores', () => {
  test('a semaphore with max count one, a release outside finally and a single default store', async () => {
    const app = appWith('semaphore', {
      'config/packages/semaphore.yaml': `framework:
    semaphore:
        default: 'redis://cache:6379'
        limited:
            resource: 'redis://cache:6379'
            max_count: 1
        pooled:
            resource: 'redis://cache:6379'
            max_count: 5
`,
      'src/Service/Limited.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Semaphore\\SemaphoreFactory;

class Limited
{
    public function __construct(private SemaphoreFactory $factory)
    {
    }

    public function run(): void
    {
        $semaphore = $this->factory->createSemaphore('import', 1);
        $semaphore->acquire();
        $this->work();
        $semaphore->release();
    }
}
`,
    });

    const text = await runModule('symfony-semaphore.js', app);

    expect(text).toContain('semaphore');
  });
});

describe('sub requests', () => {
  test('the kernel injected into a command and render(controller()) inside a loop', async () => {
    const app = appWith('subrequest', {
      'src/Command/RenderCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\HttpKernel\\HttpKernelInterface;

#[AsCommand(name: 'app:render')]
class RenderCommand extends Command
{
    public function __construct(private HttpKernelInterface $kernel)
    {
        parent::__construct();
    }
}
`,
      'templates/home/index.html.twig': `{% for item in items %}
    {{ render(controller('App\\\\Controller\\\\ItemController::show', { id: item.id })) }}
{% endfor %}

{{ render(controller('App\\\\Controller\\\\SidebarController::index')) }}
`,
    });

    const text = await runModule('symfony-subrequest.js', app);

    expect(text).toContain('render');
  });
});

describe('translation yaml lint', () => {
  test('a duplicate key and an empty value in a catalogue', async () => {
    const app = appWith('translation-yaml-lint', {
      'translations/messages.en.yaml': `app:
    title: 'Dashboard'
    subtitle: ''
    title: 'Dashboard again'
    empty_section:
`,
      'translations/validators.en.yaml': `subscription:
    plan_required: 'Choose a plan'
`,
      'translations/notes.txt': 'not a catalogue\n',
    });

    const text = await runModule('symfony-translation-yaml-lint.js', app);

    expect(text.length).toBeGreaterThan(0);
  });
});

describe('openapi security schemes', () => {
  test('an api key in the query string, an implicit oauth flow and a bearer with no format', async () => {
    const app = appWith('openapi-schemes', {
      'config/packages/nelmio_api_doc.yaml': `nelmio_api_doc:
    documentation:
        components:
            securitySchemes:
                ApiKeyQuery:
                    type: apiKey
                    name: api_key
                    in: query
                OAuthImplicit:
                    type: oauth2
                    flows:
                        implicit:
                            authorizationUrl: https://auth.example.com/authorize
                            scopes: {}
                OAuthNoFlow:
                    type: oauth2
                    flows: {}
                Oidc:
                    type: openIdConnect
                BearerNoFormat:
                    type: http
                    scheme: bearer
`,
    });

    const text = await runModule('api-openapi-security-schemes.js', app);

    expect(text).toContain('ApiKeyQuery');
  });
});

describe('openapi context on properties', () => {
  test('a deprecated property with no reason, an example of the wrong type and a resource with no context', async () => {
    const app = appWith('openapi-context', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiProperty;
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Invoice
{
    #[ApiProperty(deprecationReason: '')]
    #[ApiProperty(openapiContext: ['example' => '42', 'type' => 'integer'])]
    public int $number = 0;

    #[ApiProperty(openapiContext: ['example' => 100, 'type' => 'string'])]
    public string $reference = '';

    #[ApiProperty(openapiContext: ['enum' => ['draft', 'sent']])]
    public string $status = 'draft';
}
`,
    });

    const text = await runModule('api-platform-openapi-context.js', app);

    expect(text).toContain('Invoice');
  });
});

describe('api versioning', () => {
  test('routes in two versions and serializer groups per version', async () => {
    const app = appWith('api-versioning', {
      'src/Controller/V1Controller.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;
use Symfony\\Component\\Serializer\\Attribute\\Groups;

class V1Controller
{
    #[Route('/api/v1/invoices', name: 'v1_invoices')]
    #[Groups(['v1:read'])]
    public function index(): void
    {
    }

    #[Route('/api/v1/customers', name: 'v1_customers')]
    #[Groups(['v1:read'])]
    public function customers(): void
    {
    }

    #[Route('/api/v1/reports', name: 'v1_reports')]
    #[Groups(['v1:read'])]
    public function reports(): void
    {
    }
}
`,
      'src/Controller/V2Controller.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;
use Symfony\\Component\\Serializer\\Attribute\\Groups;

class V2Controller
{
    #[Route('/api/v2/invoices', name: 'v2_invoices')]
    #[Groups(['v2:read'])]
    public function index(): void
    {
    }
}
`,
    });

    const text = await runModule('api-versioning.js', app);

    expect(text).toContain('v1');
  });
});

describe('ses in the mailer', () => {
  test('a ses dsn in the mailer config, an sns topic and a bounce queue', async () => {
    const app = appWith('ses-mailer', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'ses+smtp://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI@default'
`,
      'src/Aws/Bounces.php': `<?php

namespace App\\Aws;

use Aws\\Sns\\SnsClient;
use Aws\\Sqs\\SqsClient;

class Bounces
{
    public function subscribe(SnsClient $sns): void
    {
        $sns->subscribe([
            'TopicArn' => 'arn:aws:sns:eu-west-1:1:acme-bounces',
            'Protocol' => 'https',
            'Endpoint' => 'https://acme.example.com/webhook/ses',
        ]);
    }

    public function read(SqsClient $sqs): array
    {
        return $sqs->receiveMessage(['QueueUrl' => 'https://sqs.eu-west-1.amazonaws.com/1/acme-bounces']);
    }
}
`,
    });

    const text = await runModule('aws-ses-integration.js', app);

    expect(text).not.toContain('wJalrXUtnFEMI');
  });
});

describe('behat configuration', () => {
  test('a behat.yml with sessions and suites, contexts and feature files', async () => {
    const app = appWith('behat-config', {
      'behat.yml': `default:
    suites:
        default:
            paths: ['%paths.base%/features']
            contexts:
                - App\\Tests\\Behat\\FeatureContext
                - App\\Tests\\Behat\\ApiContext
        api:
            paths: ['%paths.base%/features/api']
            contexts: ['App\\Tests\\Behat\\ApiContext']
        broken: ~
    extensions:
        Behat\\MinkExtension:
            base_url: 'http://localhost:8000'
            default_session: symfony
            sessions:
                symfony:
                    symfony: ~
`,
      'features/home.feature': `Feature: Home

    Scenario: Visiting
        Given I am on the home page
`,
      'features/bootstrap/FeatureContext.php': `<?php

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
}
`,
      'tests/Behat/ApiContext.php': `<?php

namespace App\\Tests\\Behat;

use Behat\\Behat\\Context\\Context;

class ApiContext implements Context
{
}
`,
    });

    const text = await runModule('behat-config.js', app);

    expect(text).toContain('default');
  });
});

describe('behat tags', () => {
  test('a slow scenario with no timeout and tags repeated from the feature', async () => {
    const app = appWith('behat-tags', {
      'behat.yaml': `default:
    suites:
        default:
            paths: ['%paths.base%/features']
`,
      'features/checkout.feature': `@checkout @slow
Feature: Checkout

    @checkout
    Scenario: Buying something
        Given I am on the home page

    @wip
    Scenario: Work in progress
        Given I am on the home page
`,
    });

    const text = await runModule('behat-tags.js', app);

    expect(text).toContain('@slow');
  });
});

describe('bitbucket steps', () => {
  test('a privileged step and a hardcoded credential in a script', async () => {
    const app = appWith('bitbucket-steps', {
      'bitbucket-pipelines.yml': `image: php:8.3

pipelines:
    default:
        - step:
              name: Test
              script:
                  - vendor/bin/phpunit
        - step:
              name: Build image
              services:
                  - docker
              privileged: true
              script:
                  - docker login -u acme -p hunter2-password registry.example.com
                  - docker build -t acme .
        - step:
              name: Ship
              script:
                  - helm upgrade acme ./helm/acme
`,
    });

    const text = await runModule('bitbucket-pipelines-config.js', app);

    expect(text).toContain('privileged');
  });
});

describe('blackfire', () => {
  test('the extension in composer, scenario files and the agent in compose', async () => {
    const app = appWith('blackfire', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'ext-blackfire': '*' },
      }, null, 2),
      'composer.lock': JSON.stringify({
        packages: [{ name: 'symfony/framework-bundle', version: 'v7.0.3' }],
      }, null, 2),
      'blackfire/checkout.bkf': `#!blackfire-player

scenario
    name "Checkout"
    visit url('/checkout')
        expect status_code() == 200
`,
      'docker-compose.yml': `services:
  blackfire:
    image: blackfire/blackfire:2
    environment:
      BLACKFIRE_SERVER_ID: server-id
      BLACKFIRE_SERVER_TOKEN: server-token
`,
    });

    const text = await runModule('blackfire-config.js', app);

    expect(text).toContain('blackfire');
  });
});

describe('braintree', () => {
  test('production environment with sandbox credentials and a gateway built in code', async () => {
    const app = appWith('braintree', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0', 'braintree/braintree_php': '^6.0' },
      }, null, 2),
      '.env': `BRAINTREE_ENVIRONMENT=production
BRAINTREE_MERCHANT_ID=sandbox_merchant_id
BRAINTREE_PUBLIC_KEY=sandbox_public_key
BRAINTREE_PRIVATE_KEY=sandbox_private_key
`,
      'src/Payment/Gateway.php': `<?php

namespace App\\Payment;

use Braintree\\Gateway as BraintreeGateway;

class Gateway
{
    public function build(): BraintreeGateway
    {
        return new BraintreeGateway([
            'environment' => 'production',
            'merchantId' => 'hardcoded-merchant',
            'publicKey' => 'hardcoded-public',
            'privateKey' => 'hardcoded-private',
        ]);
    }
}
`,
    });

    const text = await runModule('braintree-integration.js', app);

    expect(text).toContain('BRAINTREE');
  });
});

describe('consul', () => {
  test('a service registered without a sidecar proxy and a health check', async () => {
    const app = appWith('consul', {
      'consul.json': JSON.stringify({
        service: {
          name: 'acme',
          port: 8080,
          tags: ['php', 'symfony'],
          check: {
            http: 'http://localhost:8080/health',
            interval: '10s',
          },
        },
      }, null, 2),
      'config/consul/registration.json': JSON.stringify({
        service: { name: 'acme-worker', port: 9000 },
      }, null, 2),
      'docker-compose.yml': `services:
  consul:
    image: hashicorp/consul:1.18
`,
    });

    const text = await runModule('consul-service-discovery.js', app);

    expect(text).toContain('consul.json');
  });
});

describe('container tags in code', () => {
  test('tags declared as plain strings and a locator consuming them', async () => {
    const app = appWith('container-tags-strings', {
      'config/services.yaml': `services:
    App\\Handler\\EmailHandler:
        tags: ['app.handler', 'kernel.event_listener']

    App\\Handler\\HandlerLocator:
        arguments:
            - tagged_locator: app.handler
`,
      'src/Handler/EmailHandler.php': `<?php

namespace App\\Handler;

class EmailHandler
{
}
`,
    });

    const text = await runModule('container-tags.js', app);

    expect(text).toContain('app.handler');
  });
});

describe('cors', () => {
  test('paths with expose headers, a max age and an origin regex, and one clean policy', async () => {
    const app = appWith('cors', {
      'config/packages/nelmio_cors.yaml': `nelmio_cors:
    defaults:
        origin_regex: true
        allow_origin: ['%env(CORS_ALLOW_ORIGIN)%']
        allow_methods: ['GET', 'POST']
        allow_headers: ['Content-Type', 'Authorization']
        expose_headers: ['Link', 'X-Total-Count']
        max_age: 3600
    paths:
        '^/api':
            allow_origin: ['*']
            allow_credentials: true
            expose_headers: ['Link']
            max_age: 7200
        '^/public':
            allow_origin: ['https://acme.example.com']
        broken: ~
`,
    });
    const clean = appWith('cors-clean', {
      'config/packages/nelmio_cors.yaml': `nelmio_cors:
    defaults:
        allow_origin: ['https://acme.example.com']
        allow_methods: ['GET']
        allow_headers: ['Content-Type']
`,
    });

    const text = await runModule('cors.js', app);
    const cleanText = await runModule('cors.js', clean);

    expect(text).toContain('api');
    expect(cleanText.length).toBeGreaterThan(0);
  });
});

describe('swarm published ports', () => {
  test('replicas publishing a port in ingress mode and booleans written as strings', async () => {
    const app = appWith('swarm-ports', {
      'docker-compose.swarm.yml': `version: "3.8"

services:
  web:
    image: acme:1.0
    deploy:
      replicas: 4
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
      update_config:
        order: start-first
      restart_policy:
        condition: any
      rollback_config:
        parallelism: 1
      placement:
        constraints: []
      labels:
        traefik.enable: "true"
        traefik.docker.lbswarm: "false"
    ports:
      - "80:80"
`,
    });

    const text = await runModule('docker-swarm-config.js', app);

    expect(text).toContain('web');
  });
});

describe('driver options in detail', () => {
  test('emulate prepares on, stringify fetches on, utf8 charset and a strange errmode', async () => {
    const app = appWith('driveroptions-detail', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        connections:
            default:
                driver: pdo_mysql
                charset: utf8
                driverOptions:
                    20: true
                    17: true
                    3: 0
                    connectTimeout: 5
            healthy:
                driver: pdo_mysql
                charset: utf8mb4
                driverOptions:
                    3: 2
                    connectTimeout: 5
`,
    });

    const text = await runModule('doctrine-dbal-driveroptions.js', app);

    expect(text).toContain('EMULATE_PREPARES');
  });
});

describe('entity locking', () => {
  test('a version column of the wrong type, an annotation version and two lock calls', async () => {
    const app = appWith('entity-lock', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Version]
    #[ORM\\Column(type: 'string')]
    private string $version = '';
}
`,
      'src/Entity/LegacyInvoice.php': `<?php

namespace App\\Entity;

/**
 * @ORM\\Entity
 */
class LegacyInvoice
{
    /**
     * @ORM\\Version
     * @ORM\\Column(type="string")
     */
    private $version;
}
`,
      'src/Controller/LockController.php': `<?php

namespace App\\Controller;

use Doctrine\\DBAL\\LockMode;

class LockController
{
    public function index(): void
    {
        $this->em->lock($this->invoice, LockMode::PESSIMISTIC_WRITE);
        $this->em->lock($this->customer, LockMode::OPTIMISTIC, 1);
    }
}
`,
    });

    const text = await runModule('doctrine-entity-lock.js', app);

    expect(text).toContain('Version');
  });
});

describe('sequence platform detection', () => {
  test('the platform read from platform_service, from the driver and from a mysql url', async () => {
    const fromPlatform = appWith('sequence-platform-service', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        platform_service: App\\Doctrine\\PostgreSQLPlatform
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'IDENTITY')]
    private ?int $id = null;
}
`,
    });
    const fromUrl = appWith('sequence-url-mysql', {
      '.env': `DATABASE_URL=mysql://app:pass@db:3306/acme
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'SEQUENCE')]
    private ?int $id = null;
}
`,
    });
    const sqlite = appWith('sequence-url-sqlite', {
      '.env': `DATABASE_URL=sqlite:///%kernel.project_dir%/var/data.db
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    private ?int $id = null;
}
`,
    });

    const one = await runModule('doctrine-sequence-generator.js', fromPlatform);
    const two = await runModule('doctrine-sequence-generator.js', fromUrl);
    const three = await runModule('doctrine-sequence-generator.js', sqlite);

    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(0);
    expect(three.length).toBeGreaterThan(0);
  });
});

describe('environment differences', () => {
  test('values with trailing comments, a long value and a secret committed in .env', async () => {
    const app = appWith('env-diff', {
      '.env': `APP_ENV=prod   # the environment
APP_SECRET=0123456789abcdef0123456789abcdef
DATABASE_URL=postgresql://app:hunter2@db.example.com:5432/acme?serverVersion=16&charset=utf8
MAILER_DSN=null://null
`,
      '.env.local': `APP_ENV=dev
DATABASE_URL=postgresql://app:local@localhost:5432/acme
`,
      '.env.test': `APP_ENV=test
`,
      '.env.local.php': `<?php

return [
    'APP_ENV' => 'prod',
    'APP_SECRET' => 'from-the-cache',
];
`,
    });

    const text = await runModule('env-diff.js', app);

    expect(text).toContain('APP_ENV');
    expect(text).not.toContain('hunter2');
  });
});

describe('fly.io', () => {
  test('services with no health checks and machines that never stop', async () => {
    const app = appWith('fly-io', {
      'fly.toml': `app = "acme"
primary_region = "cdg"

[build]
    dockerfile = "Dockerfile"

[env]
    APP_ENV = "prod"

[http_service]
    internal_port = 8080
    force_https = true

[[services]]
    internal_port = 8080
    protocol = "tcp"

    [[services.ports]]
        port = 443
        handlers = ["tls", "http"]
`,
    });

    const text = await runModule('fly-io-config.js', app);

    expect(text).toContain('fly.toml');
  });
});

describe('grafana', () => {
  test('dashboards, a datasource, provisioned alerting and the agent in compose', async () => {
    const app = appWith('grafana', {
      'grafana/dashboards/acme.json': JSON.stringify({
        title: 'Acme',
        panels: [
          { title: 'Requests', type: 'timeseries', targets: [{ expr: 'rate(http_requests_total[5m])' }] },
          { title: 'Errors', type: 'stat', targets: [{ expr: 'rate(http_errors_total[5m])' }] },
        ],
        refresh: '10s',
      }, null, 2),
      'grafana/provisioning/datasources/prometheus.yaml': `apiVersion: 1
datasources:
    - name: Prometheus
      type: prometheus
      url: http://prometheus:9090
      isDefault: true
      basicAuthPassword: hunter2
`,
      'grafana/provisioning/alerting/rules.yaml': `apiVersion: 1
groups:
    - name: acme
      rules:
          - title: High error rate
            condition: A
`,
      'docker-compose.yml': `services:
  grafana:
    image: grafana/grafana:11.0.0
    environment:
      GF_SECURITY_ADMIN_PASSWORD: hunter2
`,
    });

    const text = await runModule('grafana-dashboard.js', app);

    expect(text).toContain('Grafana');
  });
});

describe('http client scopes in detail', () => {
  test('a scope with redirects and basic auth, and a client used by name', async () => {
    const app = appWith('http-client-scopes-detail', {
      'config/packages/framework.yaml': `framework:
    http_client:
        default_options:
            base_uri: 'https://api.example.com'
            max_redirects: 5
        scoped_clients:
            acme.client:
                base_uri: 'https://acme.example.com'
                max_redirects: 3
                auth_basic: 'acme:hunter2'
`,
      'src/Client/AcmeClient.php': `<?php

namespace App\\Client;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class AcmeClient
{
    public function __construct(private HttpClientInterface $acmeClient)
    {
    }

    public function fetch(): array
    {
        return $this->acmeClient->request('GET', '/items')->toArray();
    }
}
`,
    });

    const text = await runModule('http-client.js', app);

    expect(text).toContain('acme.client');
    expect(text).not.toContain('hunter2');
  });
});

describe('mailer transports', () => {
  test('a null transport, a dsn in the config and templates with attachments', async () => {
    const app = appWith('mailer-null', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'null://null'
        envelope:
            sender: 'noreply@example.com'
`,
      'src/Mail/Welcome.php': `<?php

namespace App\\Mail;

use Symfony\\Bridge\\Twig\\Mime\\TemplatedEmail;

class Welcome
{
    public function build(): TemplatedEmail
    {
        return (new TemplatedEmail())
            ->htmlTemplate('mail/welcome.html.twig')
            ->attachFromPath('/srv/app/public/terms.pdf');
    }
}
`,
      'templates/mail/welcome.html.twig': `<h1>Welcome</h1>
`,
    });

    const text = await runModule('mailer.js', app);

    expect(text).toContain('null');
  });
});

describe('monolog levels', () => {
  test('handlers at several levels, including alerting ones', async () => {
    const app = appWith('monolog-levels', {
      'config/packages/monolog.yaml': `monolog:
    handlers:
        debug:
            type: stream
            level: debug
        info:
            type: stream
            level: info
        warning:
            type: stream
            level: warning
        error:
            type: stream
            level: error
        critical:
            type: stream
            level: critical
        emergency:
            type: stream
            level: emergency
        slack:
            type: slack
            level: critical
            token: '%env(SLACK_TOKEN)%'
        broken: ~
`,
    });

    const text = await runModule('monolog.js', app);

    expect(text).toContain('slack');
  });
});

describe('multi tenancy connections', () => {
  test('tenant entities with no doctrine filter, several connections and tenant env files', async () => {
    const app = appWith('multi-tenancy-connections', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        connections:
            default:
                url: '%env(DATABASE_URL)%'
            tenant_one:
                url: '%env(TENANT_ONE_DATABASE_URL)%'
            tenant_two:
                url: '%env(TENANT_TWO_DATABASE_URL)%'
`,
      '.env.tenant_one': `DATABASE_URL=postgresql://app:pass@db:5432/tenant_one
`,
      '.env.tenant_two': `DATABASE_URL=postgresql://app:pass@db:5432/tenant_two
`,
      'src/Entity/Tenant.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Tenant
{
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\ManyToOne(targetEntity: Tenant::class)]
    private ?Tenant $tenant = null;
}
`,
    });

    const text = await runModule('multi-tenancy.js', app);

    expect(text).toContain('Tenant');
  });
});

describe('pgbouncer sessions', () => {
  test('session pooling with a large limit and a direct database url', async () => {
    const app = appWith('pgbouncer-session', {
      'pgbouncer.ini': `[databases]
acme = host=db port=5432 dbname=acme

[pgbouncer]
pool_mode = session
max_client_conn = 5000
default_pool_size = 100
auth_type = md5
server_reset_query = DISCARD ALL
`,
      '.env.local': `DATABASE_URL=postgres://app:pass@db:5432/acme
`,
    });

    const text = await runModule('pgbouncer-config.js', app);

    expect(text).toContain('session');
  });
});

describe('asymmetric visibility on older php', () => {
  test('private(set) in a project that does not require 8.4', async () => {
    const app = appWith('asymmetric-old', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
      }, null, 2),
      'src/Entity/Account.php': `<?php

namespace App\\Entity;

class Account
{
    public private(set) string $reference = '';

    public protected(set) int $balance = 0;
}
`,
      'src/Support/helpers.php': `<?php

function acme(): string
{
    return 'no class here';
}
`,
    });

    const text = await runModule('php-asymmetric-visibility.js', app);

    expect(text).toContain('reference');
  });
});

describe('benchmark patterns', () => {
  test('a benchmark that times itself and one that does not', async () => {
    const app = appWith('benchmarks', {
      'benchmarks/RoutingBench.php': `<?php

namespace App\\Benchmark;

class RoutingBench
{
    public function benchMatch(): void
    {
        $start = time();
        $this->router->match('/');
        $elapsed = time() - $start;
    }

    public function benchGenerate(): void
    {
        $this->router->generate('home');
    }
}
`,
      'src/Benchmark/InlineBench.php': `<?php

namespace App\\Benchmark;

class InlineBench
{
    public function benchSomething(): void
    {
    }
}
`,
    });

    const text = await runModule('php-benchmark-patterns.js', app);

    expect(text).toContain('Bench');
  });
});

describe('closure scope', () => {
  test('a by-reference capture inside a loop and a plain closure', async () => {
    const app = appWith('closure-scope', {
      'src/Service/Closures.php': `<?php

namespace App\\Service;

class Closures
{
    public function inLoop(array $rows): array
    {
        $callbacks = [];
        foreach ($rows as $row) {
            $total = 0;
            $callbacks[] = function () use (&$total, $row) {
                $total += $row['amount'];

                return $total;
            };
        }

        return $callbacks;
    }

    public function plain(): callable
    {
        return static fn (int $a): int => $a + 1;
    }
}
`,
    });

    const text = await runModule('php-closure-scope.js', app);

    expect(text).toContain('Closures');
  });
});

describe('batch 48: asset pipeline, AWS, Behat, Cypress, Doctrine proxies, Google, Messenger', () => {
  test('an importmap that cannot be read leaves the pipeline empty', async () => {
    // A directory where the file should be: it exists, so the pipeline is
    // asset_mapper, and every read of it fails.
    const app = appWith('asset-mapper-unreadable', {
      'importmap.php/placeholder.txt': 'not a file\n',
    });

    const text = await runModule('asset-mapper.js', app);

    expect(text).toContain('Asset');
  });

  test('a webpack config that cannot be read, with no package.json either', async () => {
    const app = appWith('asset-mapper-webpack-unreadable', {
      'webpack.config.js/placeholder.txt': 'not a file\n',
    });

    const text = await runModule('asset-mapper.js', app);

    expect(text).toContain('Encore');
  });

  test('style entries and more than twenty packages are both reported', async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 25; i++) deps[`@acme/package-${i}`] = '^1.0.0';

    const app = appWith('asset-mapper-encore', {
      'webpack.config.js': `const Encore = require('@symfony/webpack-encore');

Encore
    .setOutputPath('public/build/')
    .setPublicPath('/build')
    .addEntry('app', './assets/app.js')
    .addStyleEntry('theme', './assets/styles/theme.scss')
;

module.exports = Encore.getWebpackConfig();
`,
      'package.json': JSON.stringify({ dependencies: deps }, null, 4) + '\n',
    });

    const text = await runModule('asset-mapper.js', app);

    expect(text).toContain('theme (CSS)');
    expect(text).toContain('and 5 more');
  });

  test('a hardcoded SSM parameter name and a SecureString with no key of its own', async () => {
    const app = appWith('aws-parameter-store-hardcoded', {
      'src/Ssm/ParameterReader.php': `<?php

namespace App\\Ssm;

use Aws\\Ssm\\SsmClient;

class ParameterReader
{
    public function __construct(private SsmClient $client)
    {
    }

    public function databasePassword(): string
    {
        $result = $this->client->getParameter(['Name' => '/acme/production/database_password', 'WithDecryption' => true]);

        return $result['Parameter']['Value'];
    }

    public function write(string $value): void
    {
        $this->client->putParameter([
            'Name' => '/acme/production/database_password',
            'Type' => 'SecureString',
            'Value' => $value,
        ]);
    }
}
`,
    });

    const text = await runModule('aws-parameter-store.js', app);

    expect(text).toContain('hardcoded parameter name');
    expect(text).toContain('SecureString');
  });

  test('a step annotation with nothing but quotes defines no step', async () => {
    const app = appWith('behat-empty-annotation', {
      'features/home.feature': `Feature: Home

    Scenario: Visiting the home page
        Given I am on the home page
`,
      'features/bootstrap/FeatureContext.php': `<?php

class FeatureContext
{
    /**
     * @Given ""
     */
    public function nothing(): void
    {
    }

    /**
     * @Given I am on the home page
     */
    public function home(): void
    {
    }
}
`,
    });

    const text = await runModule('behat-step-coverage.js', app);

    // One definition, not two: the empty annotation is not one.
    expect(text).toContain('Definitions: 1');
  });

  test('a step pattern too long to compile is matched by its opening words', async () => {
    const long = `I am on the checkout page ${'and the basket holds a great many different items '.repeat(6)}`.trim();

    const app = appWith('behat-long-pattern', {
      'features/checkout.feature': `Feature: Checkout

    Scenario: A long step
        Given ${long}
`,
      'features/bootstrap/CheckoutContext.php': `<?php

class CheckoutContext
{
    /**
     * @Given ${long}
     */
    public function longStep(): void
    {
    }
}
`,
    });

    const text = await runModule('behat-step-coverage.js', app);

    expect(text).toContain('Step');
  });

  test('a features directory with no feature file in it', async () => {
    const app = appWith('behat-no-features', {
      'features/README.md': '# Acceptance tests\n\nNothing here yet.\n',
    });

    const text = await runModule('behat-step-coverage.js', app);

    expect(text).toContain('No .feature files');
  });

  test('the AWS SDK without CloudWatch, alarms, retention and X-Ray', async () => {
    const app = appWith('cloudwatch-full', {
      'composer.json': JSON.stringify({ require: { 'aws/aws-sdk-php': '^3.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nAWS_DEFAULT_REGION=eu-west-1\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nXRAY_DAEMON_ADDRESS=127.0.0.1:2000\n',
      'terraform/logs.tf': `resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "acme-errors"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/acme/app"
  retention_in_days = 30
}
`,
    });

    const text = await runModule('cloudwatch-integration.js', app);

    expect(text).toContain('aws/aws-sdk-php found');
    expect(text).toContain('alarm');
    expect(text).toContain('X-Ray');
  });

  test('a Cypress configuration whose only problem is the missing base URL', async () => {
    const app = appWith('cypress-baseurl', {
      'cypress.config.js': `module.exports = {
    e2e: {
        specPattern: 'cypress/e2e/**/*.cy.js',
        retries: { runMode: 2, openMode: 0 },
        video: false,
    },
};
`,
      'cypress/e2e/login.cy.js': 'describe("login", () => { it("works", () => { cy.visit("/login"); }); });\n',
      'cypress/fixtures/user.json': '{"email":"user@example.com"}\n',
    });

    const text = await runModule('cypress-e2e-config.js', app);

    expect(text).toContain('baseUrl');
  });

  test('a Cypress configuration with nothing to report', async () => {
    const app = appWith('cypress-clean', {
      'cypress.config.js': `module.exports = {
    e2e: {
        baseUrl: 'http://localhost:8000',
        specPattern: 'cypress/e2e/**/*.cy.js',
        retries: { runMode: 2, openMode: 0 },
        video: false,
        chromeWebSecurity: true,
    },
};
`,
      'cypress/e2e/login.cy.js': 'describe("login", () => { it("works", () => { cy.visit("/login"); }); });\n',
      'cypress/fixtures/user.json': '{"email":"user@example.com"}\n',
    });

    const text = await runModule('cypress-e2e-config.js', app);

    expect(text).toContain('Cypress');
  });

  test('proxies counted through subdirectories, in a namespace that collides', async () => {
    const app = appWith('doctrine-entity-proxy-collision', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        auto_generate_proxy_classes: true
        proxy_dir: '%kernel.cache_dir%/doctrine/orm/Proxies'
        proxy_namespace: 'App\\Proxies'
`,
      'src/Kernel.php': `<?php

namespace App;

use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;

class Kernel
{
    use MicroKernelTrait;
}
`,
      'var/cache/prod/doctrine/orm/Proxies/__CG__AppEntityUser.php': '<?php\n\nclass Proxy {}\n',
      'var/cache/prod/doctrine/orm/Proxies/nested/__CG__AppEntityOrder.php': '<?php\n\nclass Proxy {}\n',
    });

    const text = await runModule('doctrine-entity-proxy.js', app);

    expect(text).toContain('proxy_namespace');
  });

  test('a Google API key held in an unexpected variable, a hardcoded secret and default credentials', async () => {
    const app = appWith('google-oauth-full', {
      'composer.json': JSON.stringify({ require: { 'google/apiclient': '^2.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nGOOGLE_MAPS_API_KEY=AIzaSyD1234567890abcdefghijklmnop\n',
      'src/Google/Auth.php': `<?php

namespace App\\Google;

use Google\\Client;

class Auth
{
    public function client(): Client
    {
        $client = new Google\\Client();
        $client->setClientId('1234567890-acme.apps.googleusercontent.com');
        $client->setClientSecret('GOCSPX-abcdefghijklmnop');
        $client->useApplicationDefaultCredentials();

        return $client;
    }
}
`,
    });

    const text = await runModule('google-oauth-integration.js', app);

    expect(text).toContain('GOOGLE_MAPS_API_KEY');
    expect(text).toContain('setClientSecret');
    expect(text).toContain('useApplicationDefaultCredentials');
  });

  test('messenger with no transports section at all', async () => {
    const app = appWith('messenger-no-transports', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        default_bus: command.bus
`,
    });

    const text = await runModule('messenger.js', app);

    expect(text).toContain('transports');
  });

  test('messenger with an empty transports section', async () => {
    const app = appWith('messenger-empty-transports', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports: {}
`,
    });

    const text = await runModule('messenger.js', app);

    expect(text).toContain('No transports configured');
  });

  test('a DSN that is not a URL is still masked, and a message with no class in it', async () => {
    const app = appWith('messenger-odd-dsn', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: 'amqp user:s3cr3t@rabbit:5672/%2f/messages'
                failure_transport: failed
            failed: 'doctrine://default?queue_name=failed'
`,
      'src/Message/README.php': `<?php

// The directory holds a note as well as the messages themselves.
`,
      'src/Message/SendInvoice.php': `<?php

namespace App\\Message;

class SendInvoice
{
    public function __construct(public readonly int $invoiceId)
    {
    }
}
`,
    });

    const text = await runModule('messenger.js', app);

    expect(text).toContain('async');
    expect(text).toContain('***');
  });
});

describe('batch 49: OWASP, interfaces, Rector, PHPSpec, PHPUnit, Prometheus, exceptions, mailer', () => {
  test('a dependency-check report older than a month', async () => {
    const app = appWith('owasp-stale-report', {
      'dependency-check.xml': `<?xml version="1.0"?>
<analysis>
    <projectInfo>
        <name>acme</name>
        <reportDate>2020-01-15T09:00:00Z</reportDate>
    </projectInfo>
</analysis>
`,
      '.dependency-check/config.properties': 'odc.autoupdate=false\n',
      'odc-reports/report.html': '<html></html>\n',
      '.github/workflows/security.yml': `name: security
on: [push]
jobs:
    scan:
        runs-on: ubuntu-latest
        steps:
            - uses: dependency-check/Dependency-Check_Action@main
              continue-on-error: true
            - run: npm audit --audit-level=none
            - run: composer audit
            - run: npx retire
`,
    });

    const text = await runModule('owasp-dependency-check.js', app);

    expect(text).toContain('days old');
    expect(text).toContain('continue-on-error');
  });

  test('a marker interface, and files that mention a class or an interface but declare neither', async () => {
    const app = appWith('interface-segregation-marker', {
      'src/Contract/Marker.php': `<?php

namespace App\\Contract;

interface Marker
{
}
`,
      'src/Contract/notes.php': `<?php

// The interface (the contract) and the class - if one is ever written - both
// live somewhere else.
`,
      'src/Contract/Payment.php': `<?php

namespace App\\Contract;

interface Payment
{
    public function charge(int $amount): void;
}
`,
    });

    const text = await runModule('php-interface-segregation.js', app);

    expect(text).toContain('Marker');
  });

  test('withSets with a PHP set, a dead-code set and an ordinary one', async () => {
    const app = appWith('rector-with-sets', {
      'rector.php': `<?php

use Rector\\Config\\RectorConfig;
use Rector\\Set\\ValueObject\\SetList;
use Rector\\DeadCode\\Set\\DeadCodeSetList;

return RectorConfig::configure()
    ->withPaths([__DIR__ . '/src'])
    ->withSets([
        SetList::PHP_82,
        SetList::CODE_QUALITY,
        DeadCodeSetList::DEAD_CODE,
    ]);
`,
    });

    const text = await runModule('php-rector-upgrade-sets.js', app);

    expect(text).toContain('SetList::PHP_82');
    expect(text).toContain('DEAD_CODE');
    expect(text).toContain('CODE_QUALITY');
  });

  test('a spec with a constructor, a helper method and test doubles', async () => {
    const app = appWith('phpspec-spec-file', {
      'composer.json': JSON.stringify({ 'require-dev': { 'phpspec/phpspec': '^7.0' } }, null, 4) + '\n',
      'phpspec.yml': 'suites:\n    main:\n        namespace: App\n',
      'spec/InvoiceSpec.php': `<?php

namespace spec\\App;

use PhpSpec\\ObjectBehavior;

class InvoiceSpec extends ObjectBehavior
{
    public function let(): void
    {
        $this->beConstructedWith(100);
    }

    public function letGo(): void
    {
    }

    public function getMatchers(): array
    {
        return [];
    }

    public function it_totals_the_lines($calculator): void
    {
        $calculator->total()->willReturn(100);
        $this->total()->shouldBeCalled();
    }
}
`,
    });

    const text = await runModule('phpspec-config.js', app);

    expect(text).toContain('beConstructedWith');
    expect(text).toContain('test-double-usage');
  });

  test('a project with no PHPSpec at all', async () => {
    const app = appWith('phpspec-absent', {});

    const text = await runModule('phpspec-config.js', app);

    expect(text).toContain('missing-config');
  });

  test('coverage thresholds of every kind in phpunit.xml', async () => {
    const app = appWith('phpunit-thresholds', {
      'phpunit.xml.dist': `<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/bootstrap.php">
    <testsuites>
        <testsuite name="unit">
            <directory>tests/Unit</directory>
        </testsuite>
    </testsuites>

    <coverage lines="90" methods="85" classes="80" branches="70">
        <include>
            <directory suffix=".php">src</directory>
        </include>
        <exclude>
            <directory>src/Migrations</directory>
        </exclude>
    </coverage>

    <php>
        <env name="APP_ENV" value="test"/>
        <env name="DATABASE_URL" value="sqlite:///:memory:"/>
    </php>
</phpunit>
`,
    });

    const text = await runModule('phpunit-config.js', app);

    expect(text).toContain('Min lines:    90%');
    expect(text).toContain('Min branches: 70%');
  });

  test('an alerting file with a recording rule and a topk without a limit', async () => {
    const app = appWith('prometheus-topk', {
      'monitoring/rules/acme.rules.yml': `groups:
    - name: acme.rules
      rules:
          - record: job:http_requests:rate5m
            expr: sum(rate(http_requests_total[5m])) by (job)

          - alert: HighErrorRate
            expr: topk(error_budget_slots, rate(http_errors_total[5m])) > 0.05
            labels:
                severity: page
            annotations:
                summary: Too many errors
                description: The error rate is above five per cent

          - alert: slow_responses
            expr: histogram_quantile(0.99, rate(http_duration_seconds_bucket[5m])) > 2
            for: 10m
            labels:
                severity: warning
            annotations:
                summary: Slow responses
                description: The ninety-ninth percentile is above two seconds
`,
    });

    const text = await runModule('prometheus-alerting-rules.js', app);

    expect(text).toContain('topk');
    expect(text).toContain('PascalCase');
  });

  test('two exceptions that both claim the same 5xx status, and neither logs', async () => {
    const app = appWith('exception-mapping-duplicate', {
      'src/Exception/ServiceUnavailableException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;

class ServiceUnavailableException extends \\RuntimeException implements HttpExceptionInterface
{
    private const HTTP_SERVICE_UNAVAILABLE = 503;

    public function getStatusCode(): int
    {
        return self::HTTP_SERVICE_UNAVAILABLE;
    }

    public function getHeaders(): array
    {
        return ['Retry-After' => '30'];
    }
}
`,
      'src/Exception/BackendDownException.php': `<?php

namespace App\\Exception;

use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;

class BackendDownException extends \\RuntimeException implements HttpExceptionInterface
{
    private const HTTP_SERVICE_UNAVAILABLE = 503;

    public function getStatusCode(): int
    {
        return self::HTTP_SERVICE_UNAVAILABLE;
    }

    public function getHeaders(): array
    {
        return [];
    }
}
`,
    });

    const text = await runModule('symfony-exception-mapping.js', app);

    expect(text).toContain('503');
    expect(text).toContain('Duplicate HTTP status codes');
  });

  test('a mailer DSN that is only ever a placeholder', async () => {
    const app = appWith('mailer-placeholder', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        transports:
            main: '%env(MAILER_DSN)%'
`,
    });

    const text = await runModule('symfony-mailer-dsn-analysis.js', app);

    expect(text).toContain('placeholder');
  });

  test('a placeholder that resolves to another placeholder in .env.local', async () => {
    const app = appWith('mailer-placeholder-local', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: '%env(MAILER_DSN)%'
`,
      '.env.local': 'MAILER_DSN=%env(SMTP_DSN)%\n',
    });

    const text = await runModule('symfony-mailer-dsn-analysis.js', app);

    expect(text).toContain('Mailer');
  });

  test('a null transport in production drops the mail silently', async () => {
    const app = appWith('mailer-null-prod', {
      '.env': 'APP_ENV=prod\nMAILER_DSN=null://null\n',
    });

    const text = await runModule('symfony-mailer-dsn-analysis.js', app);

    expect(text).toContain('silently dropped');
  });
});

describe('batch 50: workers, rate limiters, validators, Terraform, SES, cache, Consul', () => {
  test('workers counted from supervisor, compose and the environment', async () => {
    const app = appWith('messenger-competing-consumers', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: '%env(MESSENGER_TRANSPORT_DSN)%'
                options:
                    queue_name: async
            failed: 'doctrine://default?queue_name=failed'
`,
      // The one at the root runs the scheduler, not a worker.
      'supervisord.conf': `[program:scheduler]
command=php bin/console app:schedule
numprocs=1
`,
      'docker/supervisord.conf': `[program:messenger-consume]
command=php bin/console messenger:consume async --time-limit=3600
numprocs=4
autostart=true
`,
      'docker-compose.yml': `services:
    php:
        image: acme/php:8.3
`,
      'docker/docker-compose.yml': `services:
    worker:
        image: acme/php:8.3
        command: php bin/console messenger:consume async
        deploy:
            replicas: 2
`,
      '.env': 'APP_ENV=prod\nMESSENGER_TRANSPORT_DSN=amqp://guest:guest@rabbit:5672/%2f/messages\n',
      '.env.local': 'WORKER_COUNT=3\n',
      // A directory where an env file would be, so reading it fails.
      '.env.dist/placeholder.txt': 'not a file\n',
    });

    const text = await runModule('symfony-messenger-competing-consumers.js', app);

    expect(text).toContain('async');
  });

  test('an empty rate limiter file, and a section the next key closes', async () => {
    const app = appWith('rate-limiter-algorithms', {
      'config/packages/rate_limiter.yaml': '',
      'config/rate_limiter.yaml': `framework:
    rate_limiter:
        login:
            policy: sliding_window
            limit: 5
            interval: '15 minutes'

        api:
            policy: token_bucket
            limit: 100
            rate:
                interval: '1 minute'
                amount: 10

services:
    _defaults:
        autowire: true
`,
    });

    const text = await runModule('symfony-rate-limiter-algorithms.js', app);

    expect(text).toContain('login');
    expect(text).toContain('api');
  });

  test('policies that give away too much, too little, or nothing at all', async () => {
    const app = appWith('rate-limiter-policy-shapes', {
      // Not valid YAML, so the loader moves on to the next candidate.
      'config/packages/rate_limiter.yaml': "framework:\n  rate_limiter:\n    login: [unclosed\n",
      'config/packages/framework.yaml': `framework:
    rate_limiter:
        login:
            policy: sliding_window
            limit: 1
            interval: '5 minutes'
        anonymous:
            policy: no_limit
        firehose:
            policy: token_bucket
            limit: 50000
            rate:
                interval: '1 second'
                amount: 1000
        hourly:
            policy: fixed_window
            limit: 1000
            interval: PT2H
        quarter:
            policy: fixed_window
            limit: 100
            interval: PT10M
`,
    });

    const text = await runModule('symfony-rate-limiter-policy.js', app);

    expect(text).toContain('no_limit');
    expect(text).toContain('sliding_window with limit=1');
    expect(text).toContain('very high');
  });

  test('more auto-mapped classes than the report prints', async () => {
    const files: Record<string, string> = {
      'config/packages/validator.yaml': `framework:
    validation:
        auto_mapping:
            'App\\Entity\\': []
`,
    };
    for (let i = 0; i < 22; i++) {
      files[`src/Entity/Thing${i}.php`] = `<?php

namespace App\\Entity;

class Thing${i}
{
    private ?int $id = null;

    public function getId(): ?int
    {
        return $this->id;
    }
}
`;
    }

    const app = appWith('validator-auto-mapping-many', files);

    const text = await runModule('symfony-validator-auto-mapping.js', app);

    expect(text).toContain('Auto-mapped only (22)');
    expect(text).toContain('and 2 more');
  });

  test('a Terraform resource with the password written into it', async () => {
    const app = appWith('terraform-secret', {
      'terraform/rds.tf': `resource "aws_db_instance" "main" {
  identifier = "acme-prod"
  engine     = "postgres"
  username   = "acme"
  password   = "sup3rs3cr3tpassw0rdf0racme"
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-assets"
}
`,
    });

    const text = await runModule('terraform-config.js', app);

    expect(text).toContain('hardcoded secret');
  });

  test('SES in production, its keys, and the same keys again in PHP', async () => {
    const app = appWith('aws-ses-integration', {
      '.env': `APP_ENV=prod
# mailer.dsn: ses+api://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY@default
AWS_SES_REGION=eu-west-1
AWS_SES_CONFIGURATION_SET=acme-prod
SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:123456789012:ses-bounces
`,
      'src/Mailer/SesClientFactory.php': `<?php

namespace App\\Mailer;

use Aws\\SesV2\\SesV2Client;

class SesClientFactory
{
    public function create(): SesV2Client
    {
        return new SesV2Client([
            'region' => 'eu-west-1',
            'credentials' => [
                'AWS_ACCESS_KEY_ID' => 'AKIAIOSFODNN7EXAMPLE',
                'AWS_SECRET_ACCESS_KEY' => 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
            ],
        ]);
    }
}
`,
    });

    const text = await runModule('aws-ses-integration.js', app);

    expect(text).toContain('AWS_SES_REGION');
    expect(text).toContain('Hardcoded AWS access key');
    expect(text).toContain('Hardcoded AWS secret key');
  });

  test('a cache pool with a default lifetime', async () => {
    const app = appWith('cache-default-lifetime', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.redis
        system: cache.adapter.system
        directory: '%kernel.cache_dir%/pools'
        default_lifetime: 3600
        pools:
            doctrine.result_cache_pool:
                adapter: cache.app
                default_lifetime: 600
`,
    });

    const text = await runModule('cache-inspector.js', app);

    expect(text).toContain('Default TTL:    3600s');
  });

  test('Consul native integration with no proxy, on a random port', async () => {
    const app = appWith('consul-native', {
      'consul.json': `{
    "service": {
        "name": "acme",
        "port": 0,
        "connect": {
            "native_integration": true
        }
    }
}
`,
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
`,
    });

    const text = await runModule('consul-service-discovery.js', app);

    expect(text).toContain('native integration');
    expect(text).toContain('port to 0');
  });
});

describe('batch 51: parameters, Swarm, and the PHP analysers', () => {
  test('a short secret, and a parameter half the application reads', async () => {
    const files: Record<string, string> = {
      'config/services.yaml': `parameters:
    app.api_token: 'ab'
    app.upload_dir: '%kernel.project_dir%/var/uploads'

services:
    _defaults:
        autowire: true
`,
    };
    for (let i = 0; i < 6; i++) {
      files[`src/Service/Uploader${i}.php`] = `<?php

namespace App\\Service;

class Uploader${i}
{
    public function __construct(private string $dir = '%app.upload_dir%')
    {
    }
}
`;
    }

    const app = appWith('di-parameters-usage', files);

    const text = await runModule('di-parameters.js', app, ['app.upload_dir']);

    expect(text).toContain('app.upload_dir');
  });

  test('parameters in a project with no source directory', async () => {
    const app = appWith('di-parameters-no-src', {
      'config/services.yaml': "parameters:\n    app.name: 'acme'\n",
    });

    const text = await runModule('di-parameters.js', app, ['app.name']);

    expect(text).toContain('app.name');
  });

  test('a Swarm service that publishes ports across several replicas', async () => {
    const app = appWith('docker-swarm-ports', {
      'docker-compose.prod.yml': `services:
    web:
        image: acme/php:8.3
        ports:
            - "8080:80"
        healthcheck:
            test: ["CMD", "curl", "-f", "http://localhost/health"]
        deploy:
            replicas: 3
            resources:
                limits:
                    cpus: '1.0'
                    memory: 512M
            restart_policy:
                condition: on-failure
            update_config:
                order: start-first
                failure_action: rollback
            rollback_config:
                parallelism: 1
`,
    });

    const text = await runModule('docker-swarm-config.js', app);

    expect(text).toContain('publishes ports');
  });

  test('asymmetric visibility on a project that predates it', async () => {
    const app = appWith('php-asymmetric-visibility', {
      'composer.json': JSON.stringify({ require: { php: '>=8.2' } }, null, 4) + '\n',
      'src/Model/Money.php': `<?php

namespace App\\Model;

final class Money
{
    public private(set) int $amount;

    public protected(set) string $currency;

    public function __construct(int $amount, string $currency)
    {
        $this->amount = $amount;
        $this->currency = $currency;
    }
}
`,
      'src/Model/notes.php': "<?php\n\n// No declaration here, only a note.\n",
    });

    const text = await runModule('php-asymmetric-visibility.js', app);

    expect(text).toContain('Money');
  });

  test('a method that branches every way there is', async () => {
    const app = appWith('php-cognitive-complexity', {
      'src/Service/Router.php': `<?php

namespace App\\Service;

class Router
{
    public function route(array $request): string
    {
        if ($request['method'] === 'GET') {
            $path = $request['path'];
            while (str_ends_with($path, '/')) {
                $path = substr($path, 0, -1);
            }

            return $path;
        } elseif ($request['method'] === 'POST') {
            return 'create';
        } else {
            return 'unknown';
        }
    }
}
`,
    });

    const text = await runModule('php-cognitive-complexity.js', app);

    expect(text).toContain('route');
  });

  test('three ways of locking a file', async () => {
    const app = appWith('php-file-locking', {
      'src/Storage/FileStore.php': `<?php

namespace App\\Storage;

class FileStore
{
    public function append(string $path, string $line): void
    {
        $handle = fopen($path, 'a');
        flock($handle, LOCK_EX);
        fwrite($handle, $line);
        fclose($handle);
    }

    public function write(string $path, string $data): void
    {
        file_put_contents($path, $data, LOCK_EX);
    }

    public function claim(string $path): bool
    {
        // A lock file, claimed by creating it.
        $lock = $path . '.lock';
        touch($lock);

        return true;
    }
}
`,
    });

    const text = await runModule('php-file-locking.js', app);

    expect(text).toContain('flock');
  });

  test('IMAP calls with values that come from the message itself', async () => {
    const app = appWith('php-imap-patterns', {
      'src/Mail/Inbox.php': `<?php

namespace App\\Mail;

class Inbox
{
    public function save($stream, int $messageNumber, string $target): void
    {
        imap_savebody($stream, $target, $messageNumber, '1');
    }

    public function search($stream, string $criteria): array
    {
        return imap_search($stream, $criteria) ?: [];
    }

    public function body(string $raw): string
    {
        return quoted_printable_decode($raw);
    }

    public function safeBody(string $raw): string
    {
        $decoded = quoted_printable_decode($raw);

        return htmlspecialchars($decoded, ENT_QUOTES);
    }
}
`,
    });

    const text = await runModule('php-imap-patterns.js', app);

    expect(text).toContain('imap_savebody');
    expect(text).toContain('imap_search');
  });

  test('lazy ghosts and proxies on a project that can have them', async () => {
    const app = appWith('php-lazy-objects', {
      'composer.json': JSON.stringify({ require: { php: '>=8.4' } }, null, 4) + '\n',
      'src/Service/Loader.php': `<?php

namespace App\\Service;

class Loader
{
    public function __construct(private \\PDO $connection)
    {
        $this->connection->exec('SET NAMES utf8mb4');
        $this->connection->beginTransaction();
    }

    public function ghost(): object
    {
        $reflector = new \\ReflectionClass(self::class);

        return $reflector->newLazyGhost(static function (): void {
        });
    }

    public function proxy(): object
    {
        $reflector = new \\ReflectionClass(self::class);

        return $reflector->newLazyProxy(static fn (): object => new self(new \\PDO('sqlite::memory:')));
    }
}
`,
    });

    const text = await runModule('php-lazy-objects.js', app);

    expect(text).toContain('Lazy ghost');
    expect(text).toContain('Lazy proxy');
  });

  test('a composer.json with no require section at all', async () => {
    const app = appWith('php-lazy-objects-no-require', {
      'composer.json': JSON.stringify({ name: 'acme/app' }, null, 4) + '\n',
      'src/Service/Ghosts.php': `<?php

namespace App\\Service;

class Ghosts
{
    public function make(\\ReflectionClass $reflector): object
    {
        return $reflector->newLazyGhost(static function (): void {
        });
    }
}
`,
    });

    const text = await runModule('php-lazy-objects.js', app);

    expect(text).toContain('composer.json');
  });

  test('nullsafe chains, and a file the analyser skips', async () => {
    const calls = Array.from({ length: 32 }, (_, i) => `        $total${i} = $this->order?->getCustomer()?->getAddress()?->getCity();`).join('\n');

    const app = appWith('php-nullsafe-patterns', {
      'src/Service/Deep.php': `<?php

namespace App\\Service;

class Deep
{
    private ?object $order = null;

    public function city(): ?string
    {
        return $this->order?->getCustomer()?->getAddress()?->getCountry()?->getName();
    }

    public function many(): void
    {
${calls}
    }
}
`,
      // A copy of a framework class, which is not the application's code.
      'src/Vendored/Request.php': `<?php

namespace Symfony\\Component\\HttpFoundation;

class Request
{
    public function host(): ?string
    {
        return $this->server?->get('HTTP_HOST');
    }
}
`,
    });

    const text = await runModule('php-nullsafe-patterns.js', app);

    expect(text).toContain('Deep');
  });
});

describe('batch 52: opcache, redirects, formatting, XSS, benchmarks, doubles, Rector', () => {
  test('an opcache ini in kilobytes, and one that cannot be read', async () => {
    const app = appWith('php-opcache-settings', {
      // A directory in the place of the file.
      'config/php.ini/placeholder.txt': 'not a file\n',
      'docker/php.ini': `[opcache]
opcache.enable=1
opcache.validate_timestamps=0
opcache.memory_consumption=262144K
opcache.max_accelerated_files=4000
opcache.enable_file_override=1
opcache.jit=tracing
opcache.jit_buffer_size=100M
opcache.interned_strings_buffer=8
`,
    });

    const text = await runModule('php-opcache-settings.js', app);

    expect(text).toContain('opcache.jit');
    expect(text).toContain('enable_file_override');
  });

  test('a redirect that is checked against a list, and one that is not', async () => {
    const app = appWith('php-open-redirect', {
      'src/Controller/RedirectController.php': `<?php

namespace App\\Controller;

class RedirectController
{
    private const ALLOWED = ['/home', '/account'];

    public function checked($response, string $target)
    {
        if (!in_array($target, self::ALLOWED, true)) {
            $target = '/home';
        }

        return $response->redirect($target);
    }

    public function unchecked($response, string $target)
    {
        return $response->redirect($target);
    }
}
`,
    });

    const text = await runModule('php-open-redirect.js', app);

    expect(text).toContain('redirect');
  });

  test('formatting calls of every kind, more than the report prints', async () => {
    const many = Array.from({ length: 55 }, (_, i) => `        printf('row %s', $row${i});`).join('\n');

    const app = appWith('php-sprintf-type-safety', {
      'src/Report/Printer.php': `<?php

namespace App\\Report;

class Printer
{
    public function label(int $count): string
    {
        return sprintf('%s items', $count);
    }

    public function money(float $amount): string
    {
        return number_format($amount);
    }

    public function out(array $args): void
    {
        vprintf('%s %s', $args);
        echo vsprintf('%s %s', $args);
    }

    public function rows(array $rows): void
    {
${many}
    }
}
`,
    });

    const text = await runModule('php-sprintf-type-safety.js', app);

    expect(text).toContain('sprintf');
    expect(text).toContain('more issues');
  });

  test('output that is escaped, and output that is not', async () => {
    const app = appWith('php-xss-patterns', {
      'src/Controller/OutputController.php': `<?php

namespace App\\Controller;

class OutputController
{
    public function safeEcho(string $name): void
    {
        $name = htmlspecialchars($name, ENT_QUOTES);
        echo $name;
    }

    public function safePrint(string $name): void
    {
        $clean = strip_tags($name);
        print $clean;
    }

    public function unsafePrint($request): void
    {
        print $request->get('name');
    }
}
`,
      'templates/legacy/profile.phtml': `<div class="profile">
    <?php $safeName = htmlspecialchars($name, ENT_QUOTES); ?>
    <?= $safeName ?>
</div>
`,
    });

    const text = await runModule('php-xss-patterns.js', app);

    expect(text).toContain('print $request->get()');
  });

  test('benchmarks configured without iterations, and kept in src', async () => {
    const app = appWith('phpbench-config', {
      'phpbench.json': JSON.stringify({
        $schema: './vendor/phpbench/phpbench/phpbench.schema.json',
        runner: 'microtime',
        'runner.path': 'benchmarks',
      }, null, 4) + '\n',
      'benchmarks/HashBench.php': `<?php

namespace App\\Benchmarks;

class HashBench
{
    /**
     * @Subject
     */
    public function benchSha256(): void
    {
        hash('sha256', 'acme');
    }
}
`,
      'src/Service/SerializerBench.php': `<?php

namespace App\\Service;

class SerializerBench
{
    /**
     * @Bench
     */
    public function benchSerialize(): void
    {
        serialize(['a' => 1]);
    }
}
`,
    });

    const text = await runModule('phpbench-config.js', app);

    expect(text).toContain('iterations');
    expect(text).toContain('src/');
  });

  test('stubs that expect calls, and mocks that expect nothing', async () => {
    const app = appWith('phpunit-test-doubles', {
      'tests/Service/PaymentTest.php': `<?php

namespace App\\Tests\\Service;

use PHPUnit\\Framework\\TestCase;

class PaymentTest extends TestCase
{
    public function testStubWithExpectation(): void
    {
        $gateway = $this->createStub(Gateway::class);
        $gateway->expects($this->once())->method('charge')->willReturn(true);
    }

    public function testBuilder(): void
    {
        $logger = $this->getMockBuilder(Logger::class)->getMock();
        $logger->expects($this->any())->method('info');
        $logger->expects($this->any())->method('warning');
        $logger->expects($this->any())->method('error');
    }

    public function testMockThatOnlyReturns(): void
    {
        $clock = $this->createMock(Clock::class);
        $clock->method('now')->willReturn(new \\DateTimeImmutable('2026-01-01'));
    }

    public function testMockWithAny(): void
    {
        $mailer = $this->createMock(Mailer::class);
        $mailer->expects($this->any())->method('send');
    }
}
`,
    });

    const text = await runModule('phpunit-test-doubles.js', app);

    expect(text).toContain('createStub');
  });

  test('a Rector config with more rules and skips than the report prints', async () => {
    const rules = Array.from({ length: 18 }, (_, i) => `        Acme\\Rector\\Rule${i}::class,`).join('\n');
    const skips = Array.from({ length: 12 }, (_, i) => `        Acme\\Rector\\Skipped${i}::class,`).join('\n');

    const app = appWith('rector-config-large', {
      // Not valid JSON, so the PHP requirement cannot be read.
      'composer.json': '{ "require": { "php": ">=8.2" }\n',
      'rector.php': `<?php

use Rector\\Config\\RectorConfig;

return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->paths([__DIR__ . '/src']);
    $rectorConfig->parallel();
    $rectorConfig->rules([
${rules}
    ]);
    $rectorConfig->skip([
${skips}
    ]);
};
`,
    });

    const text = await runModule('rector-config.js', app);

    expect(text).toContain('more');
  });

  test('a custom Rector rule that visits every expression', async () => {
    const app = appWith('rector-custom-rules', {
      'rector.php': `<?php

use Rector\\Config\\RectorConfig;
use App\\Rector\\ReplaceLegacyCallRector;
use App\\Rector\\RenameServiceRector;

return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->rule(ReplaceLegacyCallRector::class);
    $rectorConfig->rule(RenameServiceRector::class);
};
`,
      'src/Rector/ReplaceLegacyCallRector.php': `<?php

namespace App\\Rector;

use PhpParser\\Node;
use PhpParser\\Node\\Stmt\\Expression;
use Rector\\Rector\\AbstractRector;

final class ReplaceLegacyCallRector extends AbstractRector
{
    public function getNodeTypes(): array
    {
        return [Expression::class];
    }

    public function refactor(Node $node): ?Node
    {
        return null;
    }
}
`,
      'src/Rector/RenameServiceRector.php': `<?php

namespace App\\Rector;

use PhpParser\\Node;
use PhpParser\\Node\\Expr\\MethodCall;
use Rector\\Rector\\AbstractRector;

final class RenameServiceRector extends AbstractRector
{
    public function getNodeTypes(): array
    {
        return [MethodCall::class];
    }

    public function refactor(Node $node): ?Node
    {
        return null;
    }
}
`,
      'src/Rector/notes.php': "<?php\n\n// How the rules above were written down.\n",
    });

    const text = await runModule('rector-custom-rules.js', app);

    expect(text).toContain('ReplaceLegacyCallRector');
  });
});

describe('batch 53: Redis pub/sub, SQS, assets, console, controllers, forms', () => {
  test('subscribing in a controller, wildcards, and what gets published', async () => {
    const app = appWith('redis-pubsub-patterns', {
      'src/Controller/NotificationController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class NotificationController extends AbstractController
{
    public function listen(\\Redis $redis): Response
    {
        $redis->subscribe(['notifications'], static function (): void {
        });

        return new Response('');
    }

    public function watch(\\Redis $redis): Response
    {
        $redis->psubscribe(['events.*'], static function (): void {
        });

        return new Response('');
    }

    public function announce(\\Redis $redis, Request $request): Response
    {
        $redis->publish($request->get('channel'), 'hello');
        $redis->publish('audit', json_encode(['password' => 'hunter2']));

        return new Response('');
    }
}
`,
    });

    const text = await runModule('redis-pubsub-patterns.js', app);

    expect(text).toContain('subscribe');
  });

  test('a queue that gives up after one failure, and keys left in .env', async () => {
    const app = appWith('sqs-dlq-one-retry', {
      '.env': `APP_ENV=prod
MESSENGER_TRANSPORT_DSN=https://sqs.eu-west-1.amazonaws.com/123456789012/acme
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
`,
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: 'https://sqs.eu-west-1.amazonaws.com/123456789012/acme'
                options:
                    max_receive_count: 1
                    visibility_timeout: 30
`,
      'src/Queue/QueueFactory.php': `<?php

namespace App\\Queue;

use Aws\\Sqs\\SqsClient;

class QueueFactory
{
    public function __construct(private SqsClient $client)
    {
    }

    public function create(string $name): string
    {
        $result = $this->client->createQueue(['QueueName' => $name]);

        return $result['QueueUrl'];
    }
}
`,
      'terraform/sqs.tf': `resource "aws_sqs_queue" "acme" {
  name = "acme"

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 1
  })
}

resource "aws_sqs_queue" "reports" {
  name = "reports"

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 25
  })
}
`,
    });

    const text = await runModule('sqs-dlq-config.js', app);

    expect(text).toContain('max_receive_count=1');
    expect(text).toContain('maxReceiveCount=25');
  });

  test('a queue that retries far too often', async () => {
    const app = appWith('sqs-dlq-many-retries', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: 'https://sqs.eu-west-1.amazonaws.com/123456789012/reports'
                options:
                    max_receive_count: 20
`,
    });

    const text = await runModule('sqs-dlq-config.js', app);

    expect(text).toContain('very high retry count');
  });

  test('assets with integrity but nothing to send it with', async () => {
    const app = appWith('symfony-asset-integrity', {
      'importmap.php': `<?php

return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
];
`,
      'templates/base.html.twig': `<!DOCTYPE html>
<html>
    <head>
        <link rel="preconnect">
        <link rel="stylesheet" href="/build/app.css">
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" integrity="sha384-abc123">
        <script>
            window.acme = true;
        </script>
        <script src="https://cdn.example.com/chart.js" integrity="sha384-def456"></script>
    </head>
    <body></body>
</html>
`,
    });

    const text = await runModule('symfony-asset-integrity.js', app);

    expect(text).toContain('crossorigin');
  });

  test('a command with a name of its own, and one that takes the framework name', async () => {
    const app = appWith('symfony-console-namespaces', {
      'src/Command/ClearCacheCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;

#[AsCommand(name: 'cache:clear', aliases: ['app:import'])]
class ClearCacheCommand extends Command
{
}
`,
      'src/Command/ImportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;

#[AsCommand(name: 'app:import')]
class ImportCommand extends Command
{
}
`,
      'src/Command/LongNameCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;

#[AsCommand(name: 'app:reporting:rebuild-every-monthly-invoice-projection')]
class LongNameCommand extends Command
{
}
`,
    });

    const text = await runModule('symfony-console-namespaces.js', app);

    expect(text).toContain('conflicts');
  });

  test('a directory that mixes invokable controllers with ordinary ones', async () => {
    const app = appWith('symfony-controller-invokable', {
      'src/Controller/ShowInvoiceController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class ShowInvoiceController
{
    public function __invoke(Request $request, int $id, string $format, bool $download): Response
    {
        return new Response('');
    }
}
`,
      'src/Controller/AccountController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class AccountController
{
    public function show(): Response
    {
        return new Response('');
    }

    public function edit(): Response
    {
        return new Response('');
    }
}
`,
      'src/Service/Formatter.php': `<?php

namespace App\\Service;

class Formatter
{
    public function format(string $value): string
    {
        return trim($value);
    }
}
`,
    });

    const text = await runModule('symfony-controller-invokable.js', app);

    expect(text).toContain('__invoke');
  });

  test('a query parameter mapped onto a class that can still be changed', async () => {
    const app = appWith('symfony-controller-map-payload', {
      'composer.json': JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }, null, 4) + '\n',
      'src/Dto/SearchQuery.php': `<?php

namespace App\\Dto;

use Symfony\\Component\\Validator\\Constraints as Assert;

class SearchQuery
{
    #[Assert\\NotBlank]
    public string $term = '';
}
`,
      'src/Controller/SearchController.php': `<?php

namespace App\\Controller;

use App\\Dto\\SearchQuery;
use Symfony\\Component\\HttpKernel\\Attribute\\MapQueryParameter;
use Symfony\\Component\\HttpFoundation\\Response;

class SearchController
{
    public function __invoke(
        #[MapQueryParameter] SearchQuery $query,
    ): Response {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-controller-map-payload.js', app);

    expect(text).toContain('readonly');
  });

  test('a controller with no payload attributes anywhere', async () => {
    const app = appWith('symfony-controller-map-payload-none', {
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class HomeController
{
    public function index(): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-controller-map-payload.js', app);

    expect(text).toContain('No MapRequestPayload/MapQueryString/MapQueryParameter');
  });

  test('form events used at the wrong moment', async () => {
    const app = appWith('symfony-form-pre-set-data', {
      'src/Form/InvoiceType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\Form\\FormEvent;
use Symfony\\Component\\Form\\FormEvents;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;

class InvoiceType extends AbstractType
{
    public function __construct(private object $repository)
    {
    }

    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->add('number', TextType::class);

        if ($options['with_notes']) {
            $builder->add('notes', TextType::class);
        }

        $builder->addEventListener(FormEvents::POST_SET_DATA, function (FormEvent $event): void {
            $form = $event->getForm();
            $form->add('currency', TextType::class);
        });

        $builder->addEventListener(FormEvents::SUBMIT, function (FormEvent $event): void {
            $customer = $this->repository->find($event->getData()->getId());
        });
    }
}
`,
    });

    const text = await runModule('symfony-form-pre-set-data.js', app);

    expect(text).toContain('POST_SET_DATA');
  });
});

describe('batch 54: forms, buses, probes, request bags, LDAP, routing, chat', () => {
  test('passwords compared by hand, with and without hash_equals', async () => {
    const app = appWith('symfony-form-repeated', {
      'src/Controller/PasswordController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class PasswordController
{
    public function change(Request $request): Response
    {
        $password = (string) $request->request->get('password');
        $confirm = (string) $request->request->get('confirm');

        if ($password === $confirm) {
            return new Response('ok');
        }

        return new Response('mismatch', 422);
    }
}
`,
      'src/Controller/ResetController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class ResetController
{
    public function reset(Request $request): Response
    {
        $password = (string) $request->request->get('password');
        $confirm = (string) $request->request->get('confirm');

        if (hash_equals($password, $confirm) && $password === $confirm) {
            return new Response('ok');
        }

        return new Response('mismatch', 422);
    }
}
`,
    });

    const text = await runModule('symfony-form-repeated.js', app);

    expect(text).toContain('manual-password-comparison');
    expect(text).toContain('hash_equals');
  });

  test('a handle() that waits on an asynchronous message', async () => {
    const app = appWith('symfony-handle-trait', {
      'src/Service/InvoiceQuery.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Messenger\\HandleTrait;
use Symfony\\Component\\Messenger\\MessageBusInterface;

class InvoiceQuery
{
    use HandleTrait;

    public function __construct(
        private MessageBusInterface $messageBus,
        private MessageBusInterface $commandBus,
    ) {
    }

    private MessageBusInterface $messageBus;

    public function total(int $id): int
    {
        SendInvoiceAsync $message;

        return $this->handle(new SendInvoiceAsync($id));
    }
}
`,
    });

    const text = await runModule('symfony-handle-trait.js', app);

    expect(text).toContain('handle()');
  });

  test('health endpoints that are open and hit the database', async () => {
    const app = appWith('symfony-health-probe', {
      'src/Controller/HealthController.php': `<?php

namespace App\\Controller;

use Doctrine\\DBAL\\Connection;
use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\Routing\\Attribute\\Route;

class HealthController
{
    public function __construct(private Connection $connection)
    {
    }

    #[Route('/health/live', name: 'health_live')]
    public function live(): JsonResponse
    {
        return new JsonResponse(['status' => 'ok']);
    }

    #[Route('/health/ready', name: 'health_ready')]
    public function ready(): JsonResponse
    {
        $this->connection->executeQuery('SELECT 1');

        return new JsonResponse(['status' => 'ok']);
    }
}
`,
      'docker-compose.yml': `services:
    app:
        image: acme/php:8.3
        depends_on:
            - database
    database:
        image: postgres:16
`,
    });

    const text = await runModule('symfony-health-probe.js', app);

    expect(text).toContain('health');
  });

  test('a healthcheck that runs every two seconds', async () => {
    const app = appWith('symfony-health-probe-interval', {
      'docker-compose.yml': `services:
    app:
        image: acme/php:8.3
        depends_on:
            - database
        healthcheck:
            test: ["CMD", "curl", "-f", "http://localhost/health"]
            interval: 2s
    database:
        image: postgres:16
`,
    });

    const text = await runModule('symfony-health-probe.js', app);

    expect(text).toContain('2s');
  });

  test('every way of reading the request the wrong way round', async () => {
    const app = appWith('symfony-http-foundation-bag', {
      'src/Controller/RequestController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class RequestController
{
    public function index(Request $request): Response
    {
        $payload = $request->request->all();
        $ip = $request->server->get('REMOTE_ADDR');
        $request->query->set('page', 1);
        $apiKey = $request->headers->get('X-Api-Key');

        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-http-foundation-bag.js', app);

    expect(text).toContain('REMOTE_ADDR');
    expect(text).toContain('X-Api-Key');
  });

  test('an LDAP provider with the bind password written into the file', async () => {
    const app = appWith('symfony-ldap-auth', {
      'config/packages/security.yaml': `security:
    providers:
        ldap_users:
            ldap:
                service: Symfony\\Component\\Ldap\\Ldap
                search_dn: 'cn=admin,dc=acme,dc=com'
                search_password: 'hunter2'
                filter: 'uid={username}'

    firewalls:
        main:
            provider: ldap_users
            ldap_login:
                check_path: /login
`,
    });

    const text = await runModule('symfony-ldap-auth.js', app);

    expect(text).toContain('search_password');
    expect(text).toContain('base_dn');
  });

  test('a command bus that accepts messages nothing handles', async () => {
    const app = appWith('symfony-message-buses', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        default_bus: command.bus
        buses:
            command.bus:
                default_middleware:
                    allow_no_handlers: true
                middleware:
                    - validation
            query.bus:
                default_middleware: true
            event.bus:
                default_middleware:
                    enabled: true
                    allow_no_handlers: true
`,
    });

    const text = await runModule('symfony-message-buses.js', app);

    expect(text).toContain('allows no handlers');
  });

  test('a routing table that lists its transports as a block', async () => {
    const app = appWith('symfony-messenger-routing-table', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: '%env(MESSENGER_TRANSPORT_DSN)%'
            audit: 'doctrine://default?queue_name=audit'
        routing:
            'App\\Message\\SendInvoice':
                - async
                - audit
            'App\\Message\\RebuildIndex': async
`,
    });

    const text = await runModule('symfony-messenger-routing-table.js', app);

    expect(text).toContain('SendInvoice');
  });

  test('chat transports of every kind, and a bot token in the environment', async () => {
    const app = appWith('symfony-notifier-chat', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            telegram: 'telegram://123456:ABCDEF@default?channel=%env(TELEGRAM_CHAT_ID)%'
            discord: 'discord://webhook-token@default?webhook_id=1234'
            teams: 'microsoftteams://acme.webhook.office.com/webhookb2/abcdef'
            rocketchat: 'rocketchat://token@rocketchat.acme.com/?channel=alerts'
`,
      '.env': 'APP_ENV=prod\nSLACK_DSN=slack://xoxb\x2d123456789-abcdefghij@default?channel=alerts\n',
    });

    const text = await runModule('symfony-notifier-chat.js', app);

    expect(text).toContain('xoxb');
  });
});

describe('batch 55: processes, RoadRunner, routing, firewalls, login, sessions', () => {
  test('a shell command built at run time, and a run() nobody checks', async () => {
    const app = appWith('symfony-process', {
      'src/Service/Backup.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Process\\Process;

class Backup
{
    public function dump(string $database): void
    {
        $process = Process::fromShellCommandline();
        $process->run();
    }

    public function archive(string $path): void
    {
        exec('tar -czf backup.tgz ' . $path);
        shell_exec('rm -rf /tmp/backup');
    }
}
`,
      'src/Service/ProcessHelper.php': `<?php

namespace App\\Service;

class ProcessHelper
{
    public const CLASS_NAME = 'Symfony\\\\Component\\\\Process\\\\Process';

    public function name(): string
    {
        return self::CLASS_NAME;
    }
}
`,
      'src/Vendored/Process.php': `<?php

namespace Symfony\\Component\\Process;

class Process
{
    public function run(): int
    {
        return 0;
    }
}
`,
    });

    const text = await runModule('symfony-process.js', app);

    expect(text).toContain('Backup');
  });

  test('RoadRunner with one worker, running as root', async () => {
    const app = appWith('symfony-roadrunner-config', {
      '.rr.yaml': `version: '3'

server:
    command: 'php public/index.php'
    user: root

http:
    address: 0.0.0.0:8080
    pool:
        num_workers: 1
        max_jobs: 0
`,
    });

    const text = await runModule('symfony-roadrunner-config.js', app);

    expect(text).toContain('num_workers');
    expect(text).toContain('root');
  });

  test('an .rr.yaml that cannot be read', async () => {
    const app = appWith('symfony-roadrunner-unreadable', {
      '.rr.yaml/placeholder.txt': 'not a file\n',
    });

    const text = await runModule('symfony-roadrunner-config.js', app);

    expect(text).toContain('RoadRunner');
  });

  test('route requirements that accept anything, and a host without a scheme', async () => {
    const app = appWith('symfony-routing-requirements', {
      'src/Controller/PageController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class PageController
{
    #[Route('/page/{slug}', name: 'page_show', requirements: ['slug' => '.+'], host: 'acme.example.com')]
    public function show(string $slug): Response
    {
        return new Response('');
    }

    #[Route('/invoice/{id}', name: 'invoice_show', requirements: ['id' => '[a-z0-9-]+'])]
    public function invoice(string $id): Response
    {
        return new Response('');
    }
}
`,
      'config/routes.yaml': `legacy_page:
    path: /legacy/{slug}
    controller: App\\Controller\\PageController::show
    host: legacy.acme.example.com
    requirements:
        slug: '.*'

legacy_invoice:
    path: /legacy/invoice/{id}
    controller: App\\Controller\\PageController::invoice
    requirements:
        id: '[a-z]+'
`,
    });

    const text = await runModule('symfony-routing-requirements.js', app);

    expect(text).toContain('permissive');
    expect(text).toContain('host');
  });

  test('a firewall that lets everything through', async () => {
    const app = appWith('symfony-security-firewalls', {
      'config/packages/security.yaml': `security:
    access_decision_manager:
        strategy: unanimous

    firewalls:
        internal:
            pattern: ^/internal
            security: false

        main:
            lazy: true
            provider: app_user_provider
            custom_authenticators:
                - App\\Security\\LoginFormAuthenticator
            access_denied_handler: App\\Security\\AccessDeniedHandler
            logout:
                path: app_logout
                invalidate_session: false
            remember_me:
                secret: '%kernel.secret%'
                lifetime: 31536000
`,
    });

    const text = await runModule('symfony-security-firewalls.js', app);

    expect(text).toContain('unanimous');
    expect(text).toContain('access_denied_handler');
  });

  test('login links configured without any code behind them', async () => {
    const app = appWith('symfony-security-login-link', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            login_link:
                check_route: login_check
                signature_properties: ['id']
                lifetime: 600
`,
    });

    const text = await runModule('symfony-security-login-link.js', app);

    expect(text).toContain('login_link');
  });

  test('login throttling with a window measured in seconds', async () => {
    const app = appWith('symfony-security-login-throttle', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            login_throttling:
                max_attempts: 20
                interval: 30
                limiter: app.login_limiter
`,
    });

    const text = await runModule('symfony-security-login-throttle.js', app);

    expect(text).toContain('interval');
    expect(text).toContain('max_attempts');
  });

  test('OIDC through the HWI bundle', async () => {
    const app = appWith('symfony-security-oidc-hwi', {
      'composer.json': JSON.stringify({ require: { 'hwi/oauth-bundle': '^2.0' } }, null, 4) + '\n',
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            oauth:
                resource_owners:
                    keycloak: /login/check-keycloak
`,
    });

    const text = await runModule('symfony-security-oidc.js', app);

    expect(text).toContain('OIDC');
  });

  test('OIDC configured in Symfony itself', async () => {
    const app = appWith('symfony-security-oidc-native', {
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            access_token:
                token_handler:
                    oidc:
                        algorithm: ES256
                        issuers: ['https://sso.acme.com']
                        audience: acme
`,
    });

    const text = await runModule('symfony-security-oidc.js', app);

    expect(text).toContain('oidc');
  });

  test('session cookies described in full', async () => {
    const app = appWith('symfony-security-session-strategy', {
      'config/packages/security.yaml': `security:
    session_fixation_strategy: none

    firewalls:
        main:
            stateless: false
`,
      'config/packages/framework.yaml': `framework:
    session:
        handler_id: null
        cookie_secure: auto
        cookie_httponly: true
        cookie_samesite: lax
        gc_maxlifetime: 1209600
`,
    });

    const text = await runModule('symfony-security-session-strategy.js', app);

    expect(text).toContain('samesite');
  });
});

describe('batch 56: serializer, workflows, Traefik, translations, WebAuthn, Encore', () => {
  test('a name converter registered as a service', async () => {
    const app = appWith('symfony-serializer-name-converter', {
      'config/services.yaml': `services:
    serializer.name_converter.metadata_aware:
        class: Symfony\\Component\\Serializer\\NameConverter\\MetadataAwareNameConverter

    serializer.name_converter.camel_case:
        class: Symfony\\Component\\Serializer\\NameConverter\\CamelCaseToSnakeCaseNameConverter
`,
      'config/packages/framework.yaml': `framework:
    serializer:
        name_converter: 'serializer.name_converter.camel_case'
`,
    });

    const text = await runModule('symfony-serializer-name-converter.js', app);

    expect(text).toContain('NameConverter');
  });

  test('a workflow subscriber that listens to the same event twice', async () => {
    const app = appWith('symfony-workflow-events', {
      'src/EventSubscriber/ArticleWorkflowSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\Workflow\\Event\\GuardEvent;

class ArticleWorkflowSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'workflow.article.guard' => 'onGuard',
            'workflow.article.guard.publish' => 'onGuardPublish',
            'workflow.guard' => 'onAnyGuard',
            'workflow.article.announce' => 'onAnnounce',
        ];
    }

    public function onGuard(GuardEvent $event): void
    {
    }

    public function onGuardPublish(GuardEvent $event): void
    {
    }

    public function onAnyGuard(GuardEvent $event): void
    {
    }

    public function onAnnounce(GuardEvent $event): void
    {
    }
}
`,
      'src/Vendored/WorkflowEvent.php': `<?php

namespace Symfony\\Component\\Workflow\\Event;

class Event
{
    public static function getSubscribedEvents(): array
    {
        return ['workflow.entered' => 'onEntered'];
    }
}
`,
    });

    const text = await runModule('symfony-workflow-events.js', app);

    expect(text).toContain('workflow.article.guard');
  });

  test('Traefik told not to verify the backend certificate', async () => {
    const app = appWith('traefik-config', {
      '.traefik/dynamic.yml': `http:
    services:
        acme:
            loadBalancer:
                serversTransport: insecure
    serversTransports:
        insecure:
            insecureSkipVerify: true
`,
      'docker-compose.yml': `services:
    web:
        image: acme/php:8.3
        labels:
            - "traefik.enable=true"
            - "traefik.http.routers.acme.rule=Host(\`acme.example.com\`)"
`,
    });

    const text = await runModule('traefik-config.js', app);

    expect(text).toContain('insecureSkipVerify');
  });

  test('translations in several formats, one of them broken', async () => {
    const app = appWith('translations-formats', {
      'translations/messages.en.php': `<?php

return [
    'invoice.line.0' => 'Line 0',
    'invoice.line.1' => 'Line 1',
    'invoice.line.2' => 'Line 2',
    'invoice.line.3' => 'Line 3',
    'invoice.line.4' => 'Line 4',
    'invoice.line.5' => 'Line 5',
    'invoice.line.6' => 'Line 6',
    'invoice.line.7' => 'Line 7',
    'invoice.line.8' => 'Line 8',
    'invoice.line.9' => 'Line 9',
    'invoice.line.10' => 'Line 10',
    'invoice.line.11' => 'Line 11',
    'invoice.line.12' => 'Line 12',
    'invoice.line.13' => 'Line 13',
];
`,
      'translations/validators.en.json': '{ "invoice.invalid": "Broken JSON"\n',
      'templates/invoice/show.html.twig': `<h1>{{ 'invoice.line.1'|trans }}</h1>
<p>{% trans %}invoice.footer{% endtrans %}</p>
`,
    });

    const text = await runModule('translations.js', app, ['invoice']);

    expect(text).toContain('invoice');
  });

  test('WebAuthn options, a credential store and the origins it allows', async () => {
    const app = appWith('webauthn-integration', {
      'composer.json': JSON.stringify({ require: { 'web-auth/webauthn-symfony-bundle': '^4.0' } }, null, 4) + '\n',
      'src/Security/WebAuthnService.php': `<?php

namespace App\\Security;

use Webauthn\\PublicKeyCredentialCreationOptions;
use Webauthn\\PublicKeyCredentialRequestOptions;

class WebAuthnService
{
    public function __construct(private CredentialRepository $credentials)
    {
    }

    public function register(): PublicKeyCredentialCreationOptions
    {
        $challenge = random_bytes(32);

        return PublicKeyCredentialCreationOptions::create($this->rp(), $this->user(), $challenge);
    }

    public function login(): PublicKeyCredentialRequestOptions
    {
        return PublicKeyCredentialRequestOptions::create(random_bytes(32));
    }

    public function allowedOrigins(): array
    {
        return ['https://acme.example.com'];
    }
}
`,
    });

    const text = await runModule('webauthn-integration.js', app);

    expect(text).toContain('PublicKeyCredential');
  });

  test('an Encore build with several presets turned on', async () => {
    const app = appWith('webpack-encore', {
      'webpack.config.js': `const Encore = require('@symfony/webpack-encore');

Encore
    .setOutputPath('public/build/')
    .setPublicPath('/build')
    .addEntry('app', './assets/app.js')
    .addEntry('admin', './assets/admin.js')
    .enableSassLoader()
    .enableStimulusBridge('./assets/controllers.json')
    .enableIntegrityHashes()
    .enableSourceMaps(!Encore.isProduction())
    .enableVersioning(Encore.isProduction())
;

module.exports = Encore.getWebpackConfig();
`,
      'package.json': JSON.stringify({ devDependencies: { '@symfony/webpack-encore': '^4.0', webpack: '^5.0' } }, null, 4) + '\n',
    });

    const text = await runModule('webpack-encore.js', app);

    expect(text).toContain('Stimulus');
    expect(text).toContain('Subresource Integrity');
  });

  test('workflows written every way the configuration allows', async () => {
    const app = appWith('workflow-shapes', {
      'config/packages/workflow.yaml': `framework:
    workflows:
        article:
            type: workflow
            marking_store:
                type: method
                property: currentPlace
            supports:
                - App\\Entity\\Article
            places:
                - draft
                - review
                - published
            transitions:
                to_review:
                    from: draft
                    to: review
                publish:
                    from: review
                    to: published

        invoice:
            type: state_machine
            supports: App\\Entity\\Invoice
            initial_marking: new
            places:
                new:
                    metadata:
                        colour: grey
                paid:
                    metadata:
                        colour: green
            transitions:
                pay:
                    from: new
                    to: paid

        empty_one: ~
`,
    });

    const text = await runModule('workflow.js', app);

    expect(text).toContain('article');
    expect(text).toContain('invoice');
  });

  test('Foundry factories in the test suite', async () => {
    const app = appWith('zenstruck-foundry-config', {
      'composer.json': JSON.stringify({ 'require-dev': { 'zenstruck/foundry': '^2.0' } }, null, 4) + '\n',
      'src/Factory/UserFactory.php': `<?php

namespace App\\Factory;

use App\\Entity\\User;
use Zenstruck\\Foundry\\ModelFactory;

final class UserFactory extends ModelFactory
{
    protected function getDefaults(): array
    {
        return [
            'email' => self::faker()->email(),
            'name' => self::faker()->name(),
        ];
    }

    protected static function getClass(): string
    {
        return User::class;
    }
}
`,
    });

    const text = await runModule('zenstruck-foundry-config.js', app);

    expect(text).toContain('Factory');
  });
});

describe('batch 57: versioning, secrets, CI, Codeception, commands, layers, Deptrac', () => {
  test('more versioned routes than the report prints, and versioned groups', async () => {
    const app = appWith('api-versioning', {
      'src/Controller/Api/V1Controller.php': `<?php

namespace App\\Controller\\Api;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class V1Controller
{
    #[Route('/api/v1/thing0', name: 'api_v1_thing0')]
    public function thing0(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing1', name: 'api_v1_thing1')]
    public function thing1(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing2', name: 'api_v1_thing2')]
    public function thing2(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing3', name: 'api_v1_thing3')]
    public function thing3(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing4', name: 'api_v1_thing4')]
    public function thing4(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing5', name: 'api_v1_thing5')]
    public function thing5(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing6', name: 'api_v1_thing6')]
    public function thing6(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing7', name: 'api_v1_thing7')]
    public function thing7(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing8', name: 'api_v1_thing8')]
    public function thing8(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing9', name: 'api_v1_thing9')]
    public function thing9(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing10', name: 'api_v1_thing10')]
    public function thing10(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing11', name: 'api_v1_thing11')]
    public function thing11(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing12', name: 'api_v1_thing12')]
    public function thing12(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing13', name: 'api_v1_thing13')]
    public function thing13(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing14', name: 'api_v1_thing14')]
    public function thing14(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing15', name: 'api_v1_thing15')]
    public function thing15(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing16', name: 'api_v1_thing16')]
    public function thing16(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing17', name: 'api_v1_thing17')]
    public function thing17(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing18', name: 'api_v1_thing18')]
    public function thing18(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing19', name: 'api_v1_thing19')]
    public function thing19(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing20', name: 'api_v1_thing20')]
    public function thing20(): Response
    {
        return new Response('');
    }

    #[Route('/api/v1/thing21', name: 'api_v1_thing21')]
    public function thing21(): Response
    {
        return new Response('');
    }
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Serializer\\Annotation\\Groups;

class Invoice
{
    #[Groups(groups = ['v1:read', 'v2:read'])]
    private int $total = 0;

    #[Groups(groups = ['internal'])]
    private string $note = '';
}
`,
    });

    const text = await runModule('api-versioning.js', app);

    expect(text).toContain('v1');
  });

  test('secret ARNs written into the environment and the code', async () => {
    const app = appWith('aws-secrets-manager', {
      '.env': `APP_ENV=prod
# RotationEnabled: false while the migration runs
DATABASE_SECRET_ARN=arn:aws:secretsmanager:eu-west-1:123456789012:secret:acme/database-AbCdEf
`,
      'src/Secrets/SecretReader.php': `<?php

namespace App\\Secrets;

use Aws\\SecretsManager\\SecretsManagerClient;

class SecretReader
{
    public function __construct(private SecretsManagerClient $client)
    {
    }

    public function database(): string
    {
        $result = $this->client->getSecretValue([
            'SecretId' => 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:acme/database-AbCdEf',
            'RotationEnabled' => false,
            'aws_secret_access_key' => 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
        ]);

        return (string) $result['SecretString'];
    }
}
`,
    });

    const text = await runModule('aws-secrets-manager.js', app);

    expect(text).toContain('secretsmanager');
    expect(text).toContain('Rotation');
  });

  test('a GitLab pipeline with a named environment, and a Makefile', async () => {
    const app = appWith('cicd-config', {
      '.gitlab-ci.yml': `stages:
    - test
    - deploy

test:
    stage: test
    image: php:8.3
    script:
        - composer install
        - vendor/bin/phpunit

deploy:
    stage: deploy
    environment:
        name: production
        url: https://acme.example.com
    script:
        - bin/deploy.sh
`,
      '.github/workflows/notes.yml': '# Nothing but a comment\n',
      'Makefile': `.PHONY: test cache

test:
	vendor/bin/phpunit

cache:
	php bin/console cache:clear
`,
    });

    const text = await runModule('cicd-config.js', app);

    expect(text).toContain('production');
  });

  test('a Codeception suite without an application path', async () => {
    const app = appWith('codeception-config', {
      'codeception.yml': `paths:
    tests: tests
    output: var/tests

modules:
    enabled:
        - Db
`,
      'tests/functional.suite.yml': `actor: FunctionalTester
modules:
    enabled:
        - Symfony
        - Doctrine2
`,
      'tests/functional/LoginCest.php': `<?php

namespace App\\Tests\\Functional;

class LoginCest
{
    public function loginWorks(\\FunctionalTester $I): void
    {
        $I->amOnPage('/login');
    }
}
`,
    });

    const text = await runModule('codeception-config.js', app);

    expect(text).toContain('app-path');
  });

  test('a project with no Codeception in it', async () => {
    const app = appWith('codeception-absent', {});

    const text = await runModule('codeception-config.js', app);

    expect(text).toContain('missing-config');
  });

  test('a command with options of every mode', async () => {
    const app = appWith('commands-options', {
      'src/Command/ImportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputOption;

#[AsCommand(name: 'app:import', description: 'Import the catalogue')]
class ImportCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addOption('file', 'f', InputOption::VALUE_REQUIRED, 'The file to read', 'catalogue.csv')
            ->addOption('locale', 'l', InputOption::VALUE_OPTIONAL, 'Locale to import', 'en')
            ->addOption('tag', 't', InputOption::VALUE_IS_ARRAY | InputOption::VALUE_OPTIONAL, 'Tags')
            ->addOption('dry-run', null, InputOption::VALUE_NONE, 'Do not write anything')
        ;
    }
}
`,
      'src/Command/notes.php': `<?php

// An #[AsCommand] is mentioned here, but nothing is declared.
`,
    });

    const text = await runModule('commands.js', app);

    expect(text).toContain('app:import');
    expect(text).toContain('default:');
  });

  test('a domain class that reaches into the infrastructure', async () => {
    const app = appWith('dependency-graph-layers', {
      'src/Domain/Invoice.php': `<?php

namespace App\\Domain;

use App\\Infrastructure\\DoctrineInvoiceRepository;

class Invoice
{
    public function __construct(private DoctrineInvoiceRepository $repository)
    {
    }
}
`,
      'src/Infrastructure/DoctrineInvoiceRepository.php': `<?php

namespace App\\Infrastructure;

class DoctrineInvoiceRepository
{
    public function find(int $id): ?object
    {
        return null;
    }
}
`,
    });

    const text = await runModule('dependency-graph.js', app);

    expect(text).toContain('Invoice');
  });

  test('Deptrac layers written out one by one', async () => {
    const app = appWith('deptrac-config', {
      'deptrac.yaml': `parameters:
    paths:
        - ./src

    layers:
        -
            name: Domain
            collectors:
                - type: className
                  regex: ^App\\\\Domain\\\\.*
        -
            name: Infrastructure
            collectors:
                - type: className
                  regex: ^App\\\\Infrastructure\\\\.*

    ruleset:
        Infrastructure:
            - Domain
`,
    });

    const text = await runModule('deptrac-config.js', app);

    expect(text).toContain('layer');
  });

  test('a project with no Deptrac in it', async () => {
    const app = appWith('deptrac-absent', {});

    const text = await runModule('deptrac-config.js', app);

    expect(text).toContain('No Deptrac configuration found');
  });

  test('a DBAL connection built by a wrapper class', async () => {
    const app = appWith('doctrine-dbal-connection-factory', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
        wrapper_class: App\\Doctrine\\LoggingConnection
`,
      'src/Doctrine/LoggingConnection.php': `<?php

namespace App\\Doctrine;

use Doctrine\\DBAL\\Connection;

class LoggingConnection extends Connection
{
}
`,
    });

    const text = await runModule('doctrine-dbal-connection-factory.js', app);

    expect(text).toContain('LoggingConnection');
  });
});

describe('batch 58: Doctrine DBAL, ORM mapping, ODM, projections and ECS', () => {
  test('DBAL middleware listed in the configuration', async () => {
    const app = appWith('doctrine-dbal-middleware', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
        middleware:
            - App\\Doctrine\\Middleware\\LoggingMiddleware
            - App\\Doctrine\\Middleware\\TimingMiddleware
`,
    });

    const text = await runModule('doctrine-dbal-middleware.js', app);

    expect(text).toContain('LoggingMiddleware');
  });

  test('a query that mixes positional and named parameters', async () => {
    const app = appWith('doctrine-dbal-prepared-statements', {
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\DBAL\\Connection;

class InvoiceRepository
{
    public function __construct(private Connection $connection)
    {
    }

    public function search(string $status, array $ids): array
    {
        return $this->connection->fetchAllAssociative(
            'SELECT * FROM invoice WHERE status = ? AND customer = :customer AND id IN (:ids)',
            ['customer' => 1, 'ids' => $ids],
            ['ids' => Connection::PARAM_INT_ARRAY],
        );
    }
}
`,
    });

    const text = await runModule('doctrine-dbal-prepared-statements.js', app);

    expect(text).toContain('mixed positional');
  });

  test('a transaction that is never rolled back', async () => {
    const app = appWith('doctrine-dbal-transactions', {
      'src/Service/Ledger.php': `<?php

namespace App\\Service;

use Doctrine\\DBAL\\Connection;

class Ledger
{
    public function __construct(private Connection $connection)
    {
    }

    public function post(array $entries): void
    {
        try {
            $this->connection->beginTransaction();
            foreach ($entries as $entry) {
                $this->connection->insert('ledger', $entry);
            }
            $this->connection->commit();
        } catch (\\Throwable $e) {
            throw $e;
        }
    }
}
`,
    });

    const text = await runModule('doctrine-dbal-transactions.js', app);

    expect(text).toContain('rollBack');
  });

  test('entities that inherit three deep and reference each other', async () => {
    const files: Record<string, string> = {
      'src/Entity/notes.php': "<?php\n\n// Where the entities live.\n",
    };
    const names = ['Base', 'Party', 'Customer', 'PreferredCustomer'];
    names.forEach((name, i) => {
      const parent = i === 0 ? '' : ` extends ${names[i - 1]}`;
      files[`src/Entity/${name}.php`] = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\InheritanceType('JOINED')]
class ${name}${parent}
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\ManyToOne(targetEntity: Address::class)]
    private ?Address $address = null;
}
`;
    });
    files['src/Entity/Address.php'] = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Address
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\ManyToOne(targetEntity: Country::class)]
    private ?Country $country = null;
}
`;
    files['src/Entity/Country.php'] = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Country
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`;

    const app = appWith('doctrine-entity-graph', files);

    const text = await runModule('doctrine-entity-graph.js', app);

    expect(text).toContain('Customer');
  });

  test('a version column declared as a string', async () => {
    const app = appWith('doctrine-entity-lock', {
      'src/Entity/Booking.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Booking
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Version]
    #[ORM\\Column]
    private string $version = '0';
}
`,
      'src/Entity/Seat.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 */
class Seat
{
    /**
     * @ORM\\Version
     * @ORM\\Column(type="string")
     */
    private string $version = '0';
}
`,
    });

    const text = await runModule('doctrine-entity-lock.js', app);

    expect(text).toContain('incompatible type');
  });

  test('translatable fields declared both ways, without a fallback locale', async () => {
    const app = appWith('doctrine-gedmo-translatable', {
      'src/Entity/Article.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Mapping\\Annotation as Gedmo;

#[ORM\\Entity]
class Article
{
    #[Gedmo\\Translatable]
    #[ORM\\Column]
    private string $title = '';

    /**
     * @Gedmo\\Translatable
     * @ORM\\Column
     */
    private string $body = '';

    public function setTranslatableLocale(string $locale): void
    {
        $this->locale = $locale;
    }
}
`,
      'src/Service/ArticleLocale.php': `<?php

namespace App\\Service;

use App\\Entity\\Article;

class ArticleLocale
{
    public function translate(Article $article, string $locale): void
    {
        $article->setTranslatableLocale($locale);
    }
}
`,
    });

    const text = await runModule('doctrine-gedmo-translatable.js', app);

    expect(text).toContain('fallback locale');
  });

  test('a class hierarchy deeper than the mapper follows', async () => {
    const files: Record<string, string> = {};
    const chain = ['Root', 'Level1', 'Level2', 'Level3', 'Level4', 'Level5', 'Level6', 'Level7'];
    chain.forEach((name, i) => {
      const parent = i === 0 ? '' : ` extends ${chain[i - 1]}`;
      files[`src/Entity/${name}.php`] = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\InheritanceType('SINGLE_TABLE')]
#[ORM\\DiscriminatorColumn(name: 'kind', type: 'string')]
class ${name}${parent}
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`;
    });

    const app = appWith('doctrine-inheritance-deep', files);

    const text = await runModule('doctrine-inheritance.js', app);

    expect(text).toContain('Level7');
  });

  test('a MongoDB connection with the password in the configuration', async () => {
    const app = appWith('doctrine-odm-config', {
      'composer.json': JSON.stringify({ require: { 'doctrine/mongodb-odm-bundle': '^4.0' } }, null, 4) + '\n',
      'config/packages/doctrine_mongodb.yaml': `doctrine_mongodb:
    connections:
        default:
            server: 'mongodb://acme:hunter2@mongo:27017/acme'
    default_database: acme
    document_managers:
        default:
            auto_mapping: true
`,
      'src/Document/Order.php': `<?php

namespace App\\Document;

use Doctrine\\ODM\\MongoDB\\Mapping\\Annotations as MongoDB;

#[MongoDB\\Document]
class Order
{
    #[MongoDB\\Id]
    private ?string $id = null;

    #[MongoDB\\ReferenceMany(targetDocument: Line::class)]
    private array $lines = [];
}
`,
    });

    const text = await runModule('doctrine-odm-config.js', app);

    expect(text).toContain('credentials in config');
    expect(text).toContain('ReferenceMany');
  });

  test('ORM profiling that records a backtrace for every query', async () => {
    const app = appWith('doctrine-orm-profiling', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        profiling: true
        logging: true
        profiling_collect_backtrace: true
`,
      'config/packages/dev/doctrine.yaml': `doctrine:
    dbal:
        profiling_collect_backtrace: true
`,
    });

    const text = await runModule('doctrine-orm-profiling.js', app);

    expect(text).toContain('profiling_collect_backtrace');
  });

  test('a projection built from far too many arguments', async () => {
    const app = appWith('doctrine-projections', {
      'src/Query/InvoiceProjection.php': `<?php

namespace App\\Query;

class InvoiceProjection
{
    public function __construct(
        public readonly int $id,
        public readonly string $number,
        public readonly string $status,
        public readonly string $customer,
        public readonly string $currency,
        public readonly int $total,
        public readonly int $tax,
        public readonly string $issuedAt,
        public readonly string $dueAt,
    ) {
    }
}
`,
      'src/Repository/InvoiceQueryRepository.php': `<?php

namespace App\\Repository;

use App\\Query\\InvoiceProjection;
use Doctrine\\ORM\\EntityManagerInterface;

class InvoiceQueryRepository
{
    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    public function all(): array
    {
        return $this->entityManager
            ->createQuery('SELECT NEW App\\\\Query\\\\InvoiceProjection(i.id, i.number, i.status) FROM App\\\\Entity\\\\Invoice i')
            ->getResult();
    }
}
`,
    });

    const text = await runModule('doctrine-projections.js', app);

    expect(text).toContain('InvoiceProjection');
  });

  test('a second-level cache region that is not strict about writes', async () => {
    const app = appWith('doctrine-slc', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        second_level_cache:
            enabled: true
            region_cache_driver:
                type: pool
                pool: doctrine.second_level_cache_pool
            regions:
                invoice_region:
                    lifetime: 3600
                    cache_driver:
                        type: pool
                        pool: doctrine.second_level_cache_pool
                broken_region: ~
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Cache(usage: 'NONSTRICT_READ_WRITE', region: 'invoice_region')]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-slc.js', app);

    expect(text).toContain('NONSTRICT_READ_WRITE');
  });

  test('ECS with parallel runs, a cache and a place in the pipeline', async () => {
    const app = appWith('easy-coding-standard', {
      'ecs.php': `<?php

use Symplify\\EasyCodingStandard\\Config\\ECSConfig;

return ECSConfig::configure()
    ->withPaths([__DIR__ . '/src', __DIR__ . '/tests'])
    ->withPreparedSets(psr12: true)
    ->withParallel()
    ->withCache(__DIR__ . '/var/ecs')
;
`,
      '.gitlab-ci.yml': `stages: [lint]

lint:
    stage: lint
    script:
        - vendor/bin/ecs check
`,
    });

    const text = await runModule('easy-coding-standard.js', app);

    expect(text).toContain('parallel');
    expect(text).toContain('cache');
  });

  test('a project with php-cs-fixer instead of ECS', async () => {
    const app = appWith('easy-coding-standard-fixer', {
      '.php-cs-fixer.php': `<?php

return (new PhpCsFixer\\Config())->setRules(['@PSR12' => true]);
`,
    });

    const text = await runModule('easy-coding-standard.js', app);

    expect(text).toContain('php-cs-fixer');
  });
});

describe('batch 59: env files, events, exports, Firebase, Fly, FOSRest, Grafana, caches', () => {
  test('an .env whose sensitive keys are all placeholders', async () => {
    const app = appWith('env-diff-clean', {
      '.env': `APP_ENV=prod
APP_SECRET=
DATABASE_URL=
MAILER_DSN=
`,
      '.env.local': `APP_SECRET=1a2b3c4d5e6f
DATABASE_URL=postgresql://acme:hunter2@db:5432/acme
`,
    });

    const text = await runModule('env-diff.js', app);

    expect(text).toContain('sensitive');
  });

  test('more keys differing between environments than the report prints', async () => {
    const app = appWith('env-diff-many', {
      '.env': `APP_ENV=prod
KEY_0=dist-value-0
KEY_1=dist-value-1
KEY_2=dist-value-2
KEY_3=dist-value-3
KEY_4=dist-value-4
KEY_5=dist-value-5
KEY_6=dist-value-6
KEY_7=dist-value-7
KEY_8=dist-value-8
KEY_9=dist-value-9
KEY_10=dist-value-10
KEY_11=dist-value-11
KEY_12=dist-value-12
KEY_13=dist-value-13
KEY_14=dist-value-14
KEY_15=dist-value-15
KEY_16=dist-value-16
KEY_17=dist-value-17
`,
      '.env.local': `KEY_0=local-value-0
KEY_1=local-value-1
KEY_2=local-value-2
KEY_3=local-value-3
KEY_4=local-value-4
KEY_5=local-value-5
KEY_6=local-value-6
KEY_7=local-value-7
KEY_8=local-value-8
KEY_9=local-value-9
KEY_10=local-value-10
KEY_11=local-value-11
KEY_12=local-value-12
KEY_13=local-value-13
KEY_14=local-value-14
KEY_15=local-value-15
KEY_16=local-value-16
KEY_17=local-value-17
`,
    });

    const text = await runModule('env-diff.js', app);

    expect(text).toContain('KEY_1');
  });

  test('subscribers and listeners written every way', async () => {
    const app = appWith('events-shapes', {
      'src/EventSubscriber/RequestSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;
use Symfony\\Component\\HttpKernel\\KernelEvents;

class RequestSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::REQUEST => ['onRequest', 128],
            'kernel.response' => 'onResponse',
        ];
    }

    public function onRequest(RequestEvent $event): void
    {
    }

    public function onResponse(RequestEvent $event): void
    {
    }
}
`,
      'src/EventListener/LocaleListener.php': `<?php

namespace App\\EventListener;

use Symfony\\Component\\EventDispatcher\\Attribute\\AsEventListener;
use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;

#[AsEventListener(event: 'kernel.request', method: 'setLocale', priority: 20)]
class LocaleListener
{
    public function setLocale(RequestEvent $event): void
    {
    }
}
`,
      'src/EventListener/notes.php': `<?php

// getSubscribedEvents is described here, with no class to hold it.
`,
    });

    const text = await runModule('events.js', app);

    expect(text).toContain('kernel.request');
  });

  test('the deprecated Excel library, exporting everything at once', async () => {
    const app = appWith('excel-generation', {
      'composer.json': JSON.stringify({ require: { 'phpoffice/phpexcel': '^1.8' } }, null, 4) + '\n',
      'src/Export/InvoiceExport.php': `<?php

namespace App\\Export;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class InvoiceExport
{
    public function download(Request $request): Response
    {
        $spreadsheet = new \\PHPExcel();
        $rows = range(1, 100000);
        foreach ($rows as $row) {
            $spreadsheet->getActiveSheet()->setCellValue('A' . $row, $row);
        }

        $filename = $request->query->get('filename');

        return new Response('', 200, ['Content-Disposition' => 'attachment; filename=' . $filename]);
    }
}
`,
    });

    const text = await runModule('excel-generation.js', app);

    expect(text).toContain('deprecated');
  });

  test('Firebase credentials pointed at a file, and pasted into the code', async () => {
    const app = appWith('firebase-integration', {
      '.env': 'APP_ENV=prod\nFIREBASE_CREDENTIALS=config/firebase/service-account.json\n',
      'config/packages/kreait_firebase.yaml': `kreait_firebase:
    projects:
        default:
            credentials: '%kernel.project_dir%/config/firebase/service-account.json'
`,
      'src/Push/Notifier.php': `<?php

namespace App\\Push;

use Kreait\\Firebase\\Factory;

class Notifier
{
    private const SERVICE_ACCOUNT = '{"type": "service_account", "project_id": "acme"}';

    public function send(string $token): void
    {
        $messaging = (new Factory())->withServiceAccount(self::SERVICE_ACCOUNT)->createMessaging();
        $messaging->send(['token' => $token, 'notification' => ['title' => 'Hello']]);
    }
}
`,
    });

    const text = await runModule('firebase-integration.js', app);

    expect(text).toContain('service account');
  });

  test('a Fly service with no health check', async () => {
    const app = appWith('fly-io-config', {
      'fly.toml': `app = "acme"
primary_region = "cdg"

[env]
    APP_ENV = "prod"
    DATABASE_URL = "postgres://acme:hunter2@db.internal:5432/acme"

[[services]]
    internal_port = 8080
    protocol = "tcp"
`,
    });

    const text = await runModule('fly-io-config.js', app);

    expect(text).toContain('health checks');
  });

  test('FOSRest with templating formats and a query parameter that accepts anything', async () => {
    const app = appWith('fos-rest-bundle', {
      'config/packages/fos_rest.yaml': `fos_rest:
    routing_loader: false
    view:
        view_response_listener: true
        templating_formats:
            html: true
`,
      'src/Controller/SearchController.php': `<?php

namespace App\\Controller;

use FOS\\RestBundle\\Controller\\Annotations\\QueryParam;
use FOS\\RestBundle\\Controller\\AbstractFOSRestController;

class SearchController extends AbstractFOSRestController
{
    /**
     * @QueryParam(name="term", requirements=".+", description="What to search for")
     */
    public function search(): array
    {
        return [];
    }
}
`,
    });

    const text = await runModule('fos-rest-bundle.js', app);

    expect(text).toContain('templating_formats');
  });

  test('Grafana provisioned with a password in plain text and no dashboards', async () => {
    const app = appWith('grafana-dashboard', {
      'grafana/dashboards/README.md': 'Dashboards are imported by hand for now.\n',
      'grafana/provisioning/datasources/prometheus.yaml': `apiVersion: 1

datasources:
    - name: Prometheus
      type: prometheus
      url: http://prometheus:9090
      basicAuth: true
      basicAuthUser: acme
      password: hunter2
`,
    });

    const text = await runModule('grafana-dashboard.js', app);

    expect(text).toContain('Plain-text');
  });

  test('the HTTP cache proxy with a trace level and a long default TTL', async () => {
    const app = appWith('http-cache-config', {
      'config/packages/framework.yaml': `framework:
    http_cache:
        enabled: true
        trace_level: full
        default_ttl: 7200
    trusted_proxies: '192.0.2.0/24'
`,
      'src/Controller/CachedController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Attribute\\Cache;
use Symfony\\Component\\Routing\\Attribute\\Route;

class CachedController
{
    #[Route('/reports', name: 'reports')]
    #[Cache(public: true, maxage: 7200, smaxage: 7200)]
    public function reports(): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('http-cache.js', app);

    expect(text).toContain('Trace level');
  });

  test('HubSpot reached through the retired API key', async () => {
    const app = appWith('hubspot-integration', {
      '.env': 'APP_ENV=prod\nHUBSPOT_API_KEY=pat\x2deu1-abcdef12-3456-7890-abcd-ef1234567890\n',
      'src/Crm/HubspotClient.php': `<?php

namespace App\\Crm;

use HubSpot\\Factory;

class HubspotClient
{
    public function create(): object
    {
        return Factory::createWithApiKey($_ENV['HUBSPOT_API_KEY']);
    }

    public function oauth(): array
    {
        return [
            'client_secret' => 'abcdefghijklmnopqrstuvwxyz012345',
        ];
    }
}
`,
    });

    const text = await runModule('hubspot-integration.js', app);

    expect(text).toContain('createWithApiKey');
  });

  test('a schema registry without a serialization library, and a broken schema file', async () => {
    const app = appWith('kafka-schema-registry', {
      '.env': 'APP_ENV=prod\nSCHEMA_REGISTRY_URL=https://acme:hunter2@schema-registry.acme.com\n',
      'src/Kafka/Producer.php': `<?php

namespace App\\Kafka;

class Producer
{
    public function schema(): object
    {
        return \\AvroSchema::parse('{"type": "record", "name": "Invoice", "fields": []}');
    }
}
`,
      'schemas/invoice.avsc': '{"type": "record", "name": "Invoice"\n',
    });

    const text = await runModule('kafka-schema-registry.js', app);

    expect(text).toContain('Avro');
  });

  test('an API operation documented without a not-found response', async () => {
    const app = appWith('nelmio-api-doc', {
      'config/packages/nelmio_api_doc.yaml': `nelmio_api_doc:
    documentation:
        info:
            title: Acme
            version: 1.0.0
    areas:
        default:
            path_patterns: ['^/api']
`,
      'src/Controller/Api/InvoiceController.php': `<?php

namespace App\\Controller\\Api;

use OpenApi\\Attributes as OA;
use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\Routing\\Attribute\\Route;

class InvoiceController
{
    #[Route('/api/invoices/{id}', name: 'api_invoice_show', methods: ['GET'])]
    #[OA\\Response(response: 200, description: 'The invoice')]
    public function show(int $id): JsonResponse
    {
        return new JsonResponse([]);
    }
}
`,
    });

    const text = await runModule('nelmio-api-doc.js', app);

    expect(text).toContain('InvoiceController');
  });
});

describe('batch 60: Netlify, notifiers, opcache, PayPal, PgBouncer and PHP analysers', () => {
  test('a Netlify build with secrets in the production context', async () => {
    const app = appWith('netlify-deploy-config', {
      'netlify.toml': `[build]
    command = "composer install --no-dev"
    publish = "public"

[dev]
    command = "symfony serve"
    port = 8000

[context.production]
    API_TOKEN = "abcdef1234567890"
    PUBLIC_URL = "https://acme.example.com"

[context.deploy-preview]
    API_TOKEN = "$PREVIEW_TOKEN"

[[headers]]
    for = "/*"

    [headers.values]
        X-Frame-Options = "DENY"
`,
    });

    const text = await runModule('netlify-deploy-config.js', app);

    expect(text).toContain('API_TOKEN');
  });

  test('notifier transports with the credentials written into the DSN', async () => {
    const app = appWith('notifier-transport-config', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        texter_transports:
            twilio: 'twilio://SID:TOKEN@default?from=%2B441234567890'
        chatter_transports:
            slack: '%env(SLACK_DSN)%'
            firebase: 'firebase://acme-project:secret@default'
`,
    });

    const text = await runModule('notifier-transport-config.js', app);

    expect(text).toContain('hardcoded credentials');
  });

  test('a notification class that names its channels', async () => {
    const app = appWith('notifier-classes', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            slack: 'slack://%env(SLACK_TOKEN)%@default?channel=alerts'
        texter_transports:
            twilio: 'twilio://%env(TWILIO_SID)%:%env(TWILIO_TOKEN)%@default'
`,
      'src/Notification/InvoiceOverdue.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;
use Symfony\\Component\\Notifier\\Recipient\\RecipientInterface;

class InvoiceOverdue extends Notification
{
    public function getChannels(RecipientInterface $recipient): array
    {
        return ['chat/slack', 'sms'];
    }

    public function getImportance(): string
    {
        return Notification::IMPORTANCE_URGENT;
    }
}
`,
    });

    const text = await runModule('notifier.js', app);

    expect(text).toContain('channels');
  });

  test('OPcache switched off, revalidating on every request', async () => {
    const app = appWith('opcache-apcu-config', {
      'docker/php.ini': `[opcache]
opcache.enable=0
opcache.validate_timestamps=1
opcache.memory_consumption=64
`,
    });

    const text = await runModule('opcache-apcu-config.js', app);

    expect(text).toContain('OPcache disabled');
  });

  test('PayPal left in sandbox while the application runs in production', async () => {
    const app = appWith('paypal-checkout-v2', {
      'composer.json': JSON.stringify({ require: { 'paypal/paypal-checkout-sdk': '^1.0' } }, null, 4) + '\n',
      '.env': `APP_ENV=prod
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CLIENT_ID=AeA1QIZXiflr1_-r0U2UbWTDXsQrZ2wvKvLtBMDwv7z
`,
      'src/Payment/PaypalClient.php': `<?php

namespace App\\Payment;

use PayPalCheckoutSdk\\Core\\SandboxEnvironment;
use PayPalCheckoutSdk\\Core\\PayPalHttpClient;

class PaypalClient
{
    public function client(): PayPalHttpClient
    {
        return new PayPalHttpClient(new SandboxEnvironment($_ENV['PAYPAL_CLIENT_ID'], $_ENV['PAYPAL_SECRET']));
    }
}
`,
    });

    const text = await runModule('paypal-checkout-v2.js', app);

    expect(text).toContain('sandbox');
  });

  test('a PayPal return URL taken straight from the request', async () => {
    const app = appWith('paypal-integration', {
      '.env': 'APP_ENV=prod\nPAYPAL_MODE=sandbox\nPAYPAL_CLIENT_ID=AeA1QIZXiflr\n',
      'src/Payment/Checkout.php': `<?php

namespace App\\Payment;

use Symfony\\Component\\HttpFoundation\\Request;

class Checkout
{
    public function start(Request $request): array
    {
        // The PayPal order is created from these.
        return [
            'return_url' => $request->get('return_url'),
            'cancel_url' => $request->get('cancel_url'),
        ];
    }
}
`,
      'src/Payment/Confirm.php': `<?php

namespace App\\Payment;

class Confirm
{
    // Where PayPal sends the buyer back to.
    public const PAYPAL_RETURN_URL = 'https://acme.example.com/payment/return';

    public function returnUrl(): string
    {
        return self::PAYPAL_RETURN_URL;
    }
}
`,
    });

    const text = await runModule('paypal-integration.js', app);

    expect(text).toContain('return');
  });

  test('Postgres reached directly, with no pooler in front of it', async () => {
    const app = appWith('pgbouncer-absent', {
      '.env': 'APP_ENV=prod\nDATABASE_URL=postgresql://acme:hunter2@db:5432/acme?serverVersion=16\n',
    });

    const text = await runModule('pgbouncer-config.js', app);

    expect(text).toContain('PgBouncer');
  });

  test('array unpacking by key and by position', async () => {
    const app = appWith('php-array-unpacking', {
      'src/Service/Unpacker.php': `<?php

namespace App\\Service;

class Unpacker
{
    public function byKey(array $row): string
    {
        ['name' => $name, 'email' => $email] = $row;

        return $name . $email;
    }

    public function byPosition(array $row): string
    {
        [$a, $b, $c, $d, $e, $f, $g] = $row;

        return $a . $b . $c . $d . $e . $f . $g;
    }
}
`,
    });

    const text = await runModule('php-array-unpacking.js', app);

    expect(text).toContain('String-keyed');
  });

  test('enums used in ways PHP does not allow', async () => {
    const app = appWith('php-backed-enum-patterns', {
      'src/Enum/Status.php': `<?php

namespace App\\Enum;

enum Status
{
    case Draft;
    case Published;

    public readonly string $label;

    public function describe(): string
    {
        return $this->value;
    }
}
`,
      'src/Repository/StatusRepository.php': `<?php

namespace App\\Repository;

use App\\Enum\\Status;

class StatusRepository
{
    public function save(object $connection, string $id): void
    {
        $status = Status::Draft;
        $connection->insert('article', ['id' => $id, 'status' => $status]);
    }
}
`,
    });

    const text = await runModule('php-backed-enum-patterns.js', app);

    expect(text).toContain('enum');
  });

  test('shell commands built from input, escaped and unescaped', async () => {
    const app = appWith('php-command-injection', {
      'src/Service/Shell.php': `<?php

namespace App\\Service;

class Shell
{
    public function raw(string $path): string
    {
        return \`ls -la $path\`;
    }

    public function fromRequest(): string
    {
        return \`ls -la {$_GET['dir']}\`;
    }

    public function escaped(string $path): string
    {
        $safe = escapeshellarg($path);

        return \`ls -la $safe\`;
    }

    public function withExec(string $name): void
    {
        exec('convert ' . escapeshellarg($name));
        system('rm -rf ' . $_POST['dir']);
    }
}
`,
    });

    const text = await runModule('php-command-injection.js', app);

    expect(text).toContain('command injection');
  });

  test('child classes that change what their parent promised', async () => {
    const app = appWith('php-covariance', {
      'src/Model/Repository.php': `<?php

namespace App\\Model;

class Repository
{
    public function find(int $id): ?Entity
    {
        return null;
    }

    public function all(): iterable
    {
        return [];
    }

    public function flush()
    {
    }
}
`,
      'src/Model/StrictRepository.php': `<?php

namespace App\\Model;

class StrictRepository extends Repository
{
    public function find(int $id): Entity
    {
        return new Entity();
    }

    public function all(): static
    {
        return $this;
    }

    public function flush()
    {
    }
}
`,
      'src/Model/LooseRepository.php': `<?php

namespace App\\Model;

class LooseRepository extends Repository
{
    public function all(): mixed
    {
        return [];
    }
}
`,
    });

    const text = await runModule('php-covariance.js', app);

    expect(text).toContain('nullable');
  });

  test('a magic method that runs a command, and a serialized cookie', async () => {
    const app = appWith('php-deserialization-gadget', {
      'src/Model/Session.php': `<?php

namespace App\\Model;

class Session
{
    private string $command = '';

    public function __destruct()
    {
        system($this->command);
    }

    public function store(array $data): void
    {
        $payload = serialize($data);
        setcookie('acme_session', $payload, time() + 3600);
    }
}
`,
    });

    const text = await runModule('php-deserialization-gadget.js', app);

    expect(text).toContain('gadget');
  });
});

describe('batch 61: php.ini settings, PHP idioms and PHPStan configuration', () => {
  test('a memory limit written in gigabytes', async () => {
    const app = appWith('php-ini-analysis', {
      'docker/php.ini': `[PHP]
memory_limit = 2G
max_execution_time = 30
display_errors = On
expose_php = On
post_max_size = 8M
upload_max_filesize = 2M
`,
    });

    const text = await runModule('php-ini-analysis.js', app);

    expect(text).toContain('display_errors');
  });

  test('the JIT switched on over a disabled opcache, with a huge buffer', async () => {
    const app = appWith('php-jit-config', {
      'php.ini': `[opcache]
opcache.enable=0
opcache.jit=tracing
opcache.jit_buffer_size=2048M
opcache.jit_hot_func=2
`,
      'docker/php.ini': `[opcache]
opcache.enable=1
opcache.jit=function
`,
    });

    const text = await runModule('php-jit-config.js', app);

    expect(text).toContain('jit_buffer_size');
  });

  test('a memory limit too small to run on, and the profiler left on', async () => {
    const app = appWith('php-memory-profiling', {
      'php.ini': `[PHP]
memory_limit = 32M
xdebug.mode = develop,profile
`,
      'docker/php.ini': `[PHP]
memory_limit = 2G
`,
    });

    const text = await runModule('php-memory-profiling.js', app);

    expect(text).toContain('memory_limit');
    expect(text).toContain('xdebug');
  });

  test('null coalescing piled up, and the ternary it replaces', async () => {
    const app = appWith('php-null-coalescing', {
      'src/Service/Defaults.php': `<?php

namespace App\\Service;

class Defaults
{
    public function pick(array $options): string
    {
        return $options['a'] ?? $options['b'] ?? $options['c'] ?? $options['d'] ?? 'fallback';
    }

    public function orElse(?string $value, string $fallback): string
    {
        $result = $value !== null ? $value : $fallback;

        return $result;
    }
}
`,
    });

    const text = await runModule('php-null-coalescing.js', app);

    expect(text).toContain('ternary');
  });

  test('a preload file listing thousands of classes, from the dev configuration', async () => {
    const requires = Array.from({ length: 2100 }, (_, i) => `require_once __DIR__ . '/../src/Generated/Class${i}.php';`).join('\n');

    const app = appWith('php-preloading-config', {
      'php.ini': `[opcache]
opcache.enable=1
opcache.preload=/app/config/preload-dev.php
`,
      'config/preload-dev.php': `<?php

${requires}
`,
    });

    const text = await runModule('php-preloading-config.js', app);

    expect(text).toContain('preload');
  });

  test('variadics in every shape PHP refuses', async () => {
    const app = appWith('php-splat-operator', {
      'src/Service/Spread.php': `<?php

namespace App\\Service;

class Spread
{
    public function badOrder(string ...$parts, int $limit): string
    {
        return implode(',', $parts) . $limit;
    }

    public function untyped(...$args): int
    {
        return count($args);
    }

    public function anything(mixed ...$args): int
    {
        return count($args);
    }

    public function call(array $args): string
    {
        $collected = [...$args, 'extra'];

        return $this->untyped(limit: 5, ...$collected) . implode('', $collected);
    }
}
`,
    });

    const text = await runModule('php-splat-operator.js', app);

    expect(text).toContain('variadic');
  });

  test('values coerced by hand in a file without strict types', async () => {
    const app = appWith('php-type-coercion', {
      'src/Service/Coercion.php': `<?php

namespace App\\Service;

class Coercion
{
    public function convert(array $row): array
    {
        $value = $row['value'];
        settype($value, 'integer');

        return [
            'value' => $value,
            'total' => (int) $row['total'],
            'ratio' => (float) $row['ratio'],
            'label' => (string) $row['label'],
            'payload' => json_decode($row['payload'], true),
            'same' => $row['a'] == $row['b'],
        ];
    }
}
`,
    });

    const text = await runModule('php-type-coercion.js', app);

    expect(text).toContain('settype');
  });

  test('a PHPStan configuration that ignores a great deal and points at nothing', async () => {
    const ignores = Array.from({ length: 22 }, (_, i) => `        - '#Ignored error ${i}#'`).join('\n');

    const app = appWith('phpstan-custom-rules', {
      'phpstan.neon': `parameters:
    level: 8
    paths:
        - src
    scanFiles:
        - stubs/missing.stub
    bootstrapFiles:
        - tests/bootstrap-phpstan.php
    ignoreErrors:
${ignores}

services:
    -
        class: App\\PHPStan\\NoDirectEntityManagerRule
        tags:
            - phpstan.rules.rule
`,
      'src/PHPStan/NoDirectEntityManagerRule.php': `<?php

namespace App\\PHPStan;

use PhpParser\\Node;
use PHPStan\\Analyser\\Scope;
use PHPStan\\Rules\\Rule;

class NoDirectEntityManagerRule implements Rule
{
    public function getNodeType(): string
    {
        return Node\\Expr\\MethodCall::class;
    }

    public function processNode(Node $node, Scope $scope): array
    {
        return [];
    }
}
`,
    });

    const text = await runModule('phpstan-custom-rules.js', app);

    expect(text).toContain('ignoreErrors');
    expect(text).toContain('not found on disk');
  });

  test('a PHPStan configuration with nothing to report', async () => {
    const app = appWith('phpstan-custom-rules-clean', {
      'phpstan.neon': `parameters:
    level: 8
    paths:
        - src

rules:
    - App\\PHPStan\\NoDirectEntityManagerRule
`,
      'src/PHPStan/NoDirectEntityManagerRule.php': `<?php

namespace App\\PHPStan;

use PhpParser\\Node;
use PHPStan\\Analyser\\Scope;
use PHPStan\\Rules\\Rule;
use PHPStan\\Rules\\RuleErrorBuilder;

class NoDirectEntityManagerRule implements Rule
{
    public function getNodeType(): string
    {
        return Node\\Expr\\MethodCall::class;
    }

    public function processNode(Node $node, Scope $scope): array
    {
        return [RuleErrorBuilder::message('Do not call the entity manager here.')->build()];
    }
}
`,
    });

    const text = await runModule('phpstan-custom-rules.js', app);

    expect(text).toContain('No issues detected');
  });

  test('a PHPStan baseline that is listed but missing', async () => {
    const app = appWith('phpstan-config-baseline', {
      'phpstan.neon': `includes:
    - phpstan-baseline.neon

parameters:
    level: 6
    paths:
        - src
`,
      'phpstan-baseline.neon': `parameters:
    ignoreErrors:
        -
            message: '#Cannot call method on null#'
            path: src/Service/Importer.php
`,
    });

    const text = await runModule('phpstan-config.js', app);

    expect(text).toContain('aseline');
  });
});

describe('batch 62: PHPUnit extensions and tests, PWA, limiters, repositories, voters', () => {
  test('a PHPUnit extension registered in the configuration', async () => {
    const app = appWith('phpunit-extensions', {
      'phpunit.xml.dist': `<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/bootstrap.php">
    <extensions>
        <bootstrap class="App\\Tests\\Extension\\ResetDatabaseExtension"/>
    </extensions>
    <testsuites>
        <testsuite name="unit">
            <directory>tests/Unit</directory>
        </testsuite>
    </testsuites>
</phpunit>
`,
      'tests/Extension/ResetDatabaseExtension.php': `<?php

namespace App\\Tests\\Extension;

use PHPUnit\\Event\\Test\\Prepared;
use PHPUnit\\Event\\Test\\PreparedSubscriber as TestPreparedSubscriber;

final class ResetDatabaseExtension implements TestPreparedSubscriber
{
    public function notify(Prepared $event): void
    {
    }
}
`,
    });

    const text = await runModule('phpunit-extensions.js', app);

    expect(text).toContain('ResetDatabaseExtension');
  });

  test('test classes that are slow, flaky and too big', async () => {
    const app = appWith('phpunit-performance', {
      'tests/Unit/ClockTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class ClockTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        self::$connection->executeQuery('TRUNCATE invoice');
        self::$connection->executeQuery('TRUNCATE customer');
        self::$connection->executeQuery('INSERT INTO customer VALUES (1)');
        self::$connection->executeQuery('INSERT INTO invoice VALUES (1)');
    }

    public function testNow(): void
    {
        $this->assertSame(time(), (new \\DateTimeImmutable())->getTimestamp());
    }
}
`,
      'tests/Unit/HugeTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class HugeTest extends TestCase
{
    public function testCase0(): void
    {
        $this->assertTrue(true);
    }

    public function testCase1(): void
    {
        $this->assertTrue(true);
    }

    public function testCase2(): void
    {
        $this->assertTrue(true);
    }

    public function testCase3(): void
    {
        $this->assertTrue(true);
    }

    public function testCase4(): void
    {
        $this->assertTrue(true);
    }

    public function testCase5(): void
    {
        $this->assertTrue(true);
    }

    public function testCase6(): void
    {
        $this->assertTrue(true);
    }

    public function testCase7(): void
    {
        $this->assertTrue(true);
    }

    public function testCase8(): void
    {
        $this->assertTrue(true);
    }

    public function testCase9(): void
    {
        $this->assertTrue(true);
    }

    public function testCase10(): void
    {
        $this->assertTrue(true);
    }

    public function testCase11(): void
    {
        $this->assertTrue(true);
    }

    public function testCase12(): void
    {
        $this->assertTrue(true);
    }

    public function testCase13(): void
    {
        $this->assertTrue(true);
    }

    public function testCase14(): void
    {
        $this->assertTrue(true);
    }

    public function testCase15(): void
    {
        $this->assertTrue(true);
    }

    public function testCase16(): void
    {
        $this->assertTrue(true);
    }

    public function testCase17(): void
    {
        $this->assertTrue(true);
    }

    public function testCase18(): void
    {
        $this->assertTrue(true);
    }

    public function testCase19(): void
    {
        $this->assertTrue(true);
    }

    public function testCase20(): void
    {
        $this->assertTrue(true);
    }

    public function testCase21(): void
    {
        $this->assertTrue(true);
    }

    public function testCase22(): void
    {
        $this->assertTrue(true);
    }

    public function testCase23(): void
    {
        $this->assertTrue(true);
    }

    public function testCase24(): void
    {
        $this->assertTrue(true);
    }

    public function testCase25(): void
    {
        $this->assertTrue(true);
    }

    public function testCase26(): void
    {
        $this->assertTrue(true);
    }

    public function testCase27(): void
    {
        $this->assertTrue(true);
    }

    public function testCase28(): void
    {
        $this->assertTrue(true);
    }

    public function testCase29(): void
    {
        $this->assertTrue(true);
    }

    public function testCase30(): void
    {
        $this->assertTrue(true);
    }

    public function testCase31(): void
    {
        $this->assertTrue(true);
    }

    public function testCase32(): void
    {
        $this->assertTrue(true);
    }

    public function testCase33(): void
    {
        $this->assertTrue(true);
    }

    public function testCase34(): void
    {
        $this->assertTrue(true);
    }

    public function testCase35(): void
    {
        $this->assertTrue(true);
    }

    public function testCase36(): void
    {
        $this->assertTrue(true);
    }

    public function testCase37(): void
    {
        $this->assertTrue(true);
    }

    public function testCase38(): void
    {
        $this->assertTrue(true);
    }

    public function testCase39(): void
    {
        $this->assertTrue(true);
    }

    public function testCase40(): void
    {
        $this->assertTrue(true);
    }

    public function testCase41(): void
    {
        $this->assertTrue(true);
    }

    public function testCase42(): void
    {
        $this->assertTrue(true);
    }

    public function testCase43(): void
    {
        $this->assertTrue(true);
    }

    public function testCase44(): void
    {
        $this->assertTrue(true);
    }

    public function testCase45(): void
    {
        $this->assertTrue(true);
    }

    public function testCase46(): void
    {
        $this->assertTrue(true);
    }

    public function testCase47(): void
    {
        $this->assertTrue(true);
    }

    public function testCase48(): void
    {
        $this->assertTrue(true);
    }

    public function testCase49(): void
    {
        $this->assertTrue(true);
    }

    public function testCase50(): void
    {
        $this->assertTrue(true);
    }

    public function testCase51(): void
    {
        $this->assertTrue(true);
    }

    public function testCase52(): void
    {
        $this->assertTrue(true);
    }

    public function testCase53(): void
    {
        $this->assertTrue(true);
    }

    public function testCase54(): void
    {
        $this->assertTrue(true);
    }
}
`,
      'tests/Unit/OneLongTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class OneLongTest extends TestCase
{
    public function testEverythingAtOnce(): void
    {
        $step0 = 0;
        $step1 = 1;
        $step2 = 2;
        $step3 = 3;
        $step4 = 4;
        $step5 = 5;
        $step6 = 6;
        $step7 = 7;
        $step8 = 8;
        $step9 = 9;
        $step10 = 10;
        $step11 = 11;
        $step12 = 12;
        $step13 = 13;
        $step14 = 14;
        $step15 = 15;
        $step16 = 16;
        $step17 = 17;
        $step18 = 18;
        $step19 = 19;
        $step20 = 20;
        $step21 = 21;
        $step22 = 22;
        $step23 = 23;
        $step24 = 24;
        $step25 = 25;
        $step26 = 26;
        $step27 = 27;
        $step28 = 28;
        $step29 = 29;
        $step30 = 30;
        $step31 = 31;
        $step32 = 32;
        $step33 = 33;
        $step34 = 34;
        $step35 = 35;
        $step36 = 36;
        $step37 = 37;
        $step38 = 38;
        $step39 = 39;
        $step40 = 40;
        $step41 = 41;
        $step42 = 42;
        $step43 = 43;
        $step44 = 44;
        $step45 = 45;
        $step46 = 46;
        $step47 = 47;
        $step48 = 48;
        $step49 = 49;
        $step50 = 50;
        $step51 = 51;
        $step52 = 52;
        $step53 = 53;
        $step54 = 54;
        $step55 = 55;
        $step56 = 56;
        $step57 = 57;
        $step58 = 58;
        $step59 = 59;
        $step60 = 60;
        $step61 = 61;
        $step62 = 62;
        $step63 = 63;
        $step64 = 64;
        $step65 = 65;
        $step66 = 66;
        $step67 = 67;
        $step68 = 68;
        $step69 = 69;
        $step70 = 70;
        $step71 = 71;
        $step72 = 72;
        $step73 = 73;
        $step74 = 74;
        $step75 = 75;
        $step76 = 76;
        $step77 = 77;
        $step78 = 78;
        $step79 = 79;
        $step80 = 80;
        $step81 = 81;
        $step82 = 82;
        $step83 = 83;
        $step84 = 84;
        $step85 = 85;
        $step86 = 86;
        $step87 = 87;
        $step88 = 88;
        $step89 = 89;
        $step90 = 90;
        $step91 = 91;
        $step92 = 92;
        $step93 = 93;
        $step94 = 94;
        $step95 = 95;
        $step96 = 96;
        $step97 = 97;
        $step98 = 98;
        $step99 = 99;
        $step100 = 100;
        $step101 = 101;
        $step102 = 102;
        $step103 = 103;
        $step104 = 104;
        $step105 = 105;
        $step106 = 106;
        $step107 = 107;
        $step108 = 108;
        $step109 = 109;
        $step110 = 110;
        $step111 = 111;
        $step112 = 112;
        $step113 = 113;
        $step114 = 114;
        $step115 = 115;
        $step116 = 116;
        $step117 = 117;
        $step118 = 118;
        $step119 = 119;
        $this->assertTrue(true);
    }
}
`,
    });

    const text = await runModule('phpunit-performance.js', app);

    expect(text).toContain('HugeTest');
  });

  test('tests that share state between themselves', async () => {
    const app = appWith('phpunit-test-isolation', {
      'tests/Functional/OrderTest.php': `<?php

namespace App\\Tests\\Functional;

use PHPUnit\\Framework\\TestCase;

class OrderTest extends TestCase
{
    private static $client;

    protected function setUp(): void
    {
        $_ENV['APP_ENV'] = 'test';
        self::$client = static::getConnection();
    }

    public function testFirst(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @depends testFirst
     */
    public function testSecond(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @depends testSecond
     */
    public function testThird(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @depends testThird
     */
    public function testFourth(): void
    {
        $this->assertTrue(true);
    }

    /**
     * @depends testFourth
     */
    public function testFifth(): void
    {
        $this->assertTrue(true);
    }
}
`,
    });

    const text = await runModule('phpunit-test-isolation.js', app);

    expect(text).toContain('OrderTest');
  });

  test('a web app manifest that will not install', async () => {
    const app = appWith('pwa-manifest-config', {
      'public/manifest.json': JSON.stringify({
        short_name: 'Acme Invoicing Suite',
        display: 'browser',
        start_url: '/',
        icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png' }],
      }, null, 4) + '\n',
    });

    const text = await runModule('pwa-manifest-config.js', app);

    expect(text).toContain('short_name');
  });

  test('rate limiters with their own pool and lock', async () => {
    const app = appWith('rate-limiter-pools', {
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        login:
            policy: sliding_window
            limit: 5
            interval: '15 minutes'
            cache_pool: cache.rate_limiter
            lock_factory: lock.default.factory
        broken: ~
`,
      'src/Controller/LoginController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\RateLimiter\\RateLimiterFactory;

class LoginController
{
    public function __construct(private RateLimiterFactory $loginLimiter)
    {
    }
}
`,
    });

    const text = await runModule('rate-limiter.js', app);

    expect(text).toContain('login');
  });

  test('a repository with nothing of its own, and one with a native query', async () => {
    const app = appWith('repository-analyzer', {
      'src/Repository/PlainRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;
use Doctrine\\Persistence\\ManagerRegistry;

class PlainRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Plain::class);
    }
}
`,
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;
use Doctrine\\Persistence\\ManagerRegistry;

class InvoiceRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Invoice::class);
    }

    public function totalsByMonth(): array
    {
        $sql = 'SELECT month, SUM(total) FROM invoice GROUP BY month ORDER BY month';

        return $this->getEntityManager()->getConnection()->createNativeQuery($sql, new ResultSetMapping())->getResult();
    }
}
`,
    });

    const text = await runModule('repository-analyzer.js', app, ['PlainRepository', 'InvoiceRepository']);

    expect(text).toContain('Repository');
  });

  test('a voter that names the classes it supports', async () => {
    const app = appWith('security-voters', {
      'config/packages/security.yaml': `security:
    role_hierarchy:
        ROLE_ADMIN: [ROLE_USER]
        ROLE_USER: [ROLE_ADMIN]
`,
      'src/Security/Voter/InvoiceVoter.php': `<?php

namespace App\\Security\\Voter;

use App\\Entity\\Invoice;
use Symfony\\Component\\Security\\Core\\Authentication\\Token\\TokenInterface;
use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class InvoiceVoter extends Voter
{
    public const VIEW = 'INVOICE_VIEW';
    public const EDIT = 'INVOICE_EDIT';

    protected function supports(string $attribute, mixed $subject): bool
    {
        if (!in_array($attribute, ['INVOICE_VIEW', 'INVOICE_EDIT'], true)) {
            return false;
        }

        if (is_a($subject, Invoice::class)) {
            return true;
        }

        return $subject instanceof Invoice;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, TokenInterface $token): bool
    {
        return $token->getUser() !== null;
    }
}
`,
    });

    const text = await runModule('security-voters.js', app, ['INVOICE_VIEW']);

    expect(text).toContain('Invoice');
  });

  test('Segment events named the wrong way, carrying personal data', async () => {
    const app = appWith('segment-analytics', {
      'composer.json': JSON.stringify({ require: { 'segmentio/analytics-php': '^3.0' } }, null, 4) + '\n',
      'src/Analytics/Tracker.php': `<?php

namespace App\\Analytics;

use Segment\\Segment;

class Tracker
{
    public function completed(string $userId, string $email): void
    {
        Segment::track([
            'userId' => $userId,
            'event' => 'order_completed',
            'properties' => [
                'email' => $email,
                'total' => 100,
            ],
        ]);
    }
}
`,
    });

    const text = await runModule('segment-analytics.js', app);

    expect(text).toContain('order_completed');
  });

  test('a serialized class with ignored and ungrouped properties', async () => {
    const app = appWith('serializer-groups', {
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Serializer\\Annotation\\Groups;
use Symfony\\Component\\Serializer\\Annotation\\Ignore;
use Symfony\\Component\\Serializer\\Annotation\\SerializedName;

class Customer
{
    #[Groups(['customer:read'])]
    private int $id = 0;

    #[Groups(['customer:read', 'customer:write'])]
    #[SerializedName('display_name')]
    private string $name = '';

    #[Ignore]
    private string $passwordHash = '';

    private string $internalNote = '';
}
`,
    });

    const text = await runModule('serializer.js', app, ['App\\Entity\\Customer', 'Customer']);

    expect(text).toContain('Customer');
  });
});

describe('batch 63: static analysis, Stripe, Swoole, autowiring, console and tests', () => {
  test('Psalm at its strictest, and PHPStan with no baseline', async () => {
    const app = appWith('static-analysis-psalm', {
      'phpstan.neon': `parameters:
    level: 9
    paths:
        - src
`,
      'psalm.xml': `<?xml version="1.0"?>
<psalm errorLevel="1" strictBinaryOperands="true" findUnusedPsalmSuppress="true">
    <projectFiles>
        <directory name="src"/>
    </projectFiles>
    <plugins>
        <pluginClass class="Psalm\\SymfonyPsalmPlugin\\Plugin"/>
    </plugins>
    <issueHandlers>
        <MissingReturnType errorLevel="suppress"/>
        <PossiblyNullReference errorLevel="suppress"/>
    </issueHandlers>
</psalm>
`,
    });

    const text = await runModule('static-analysis.js', app);

    expect(text).toContain('Baseline: none');
    expect(text).toContain('Strict mode');
  });

  test('Stripe with a hardcoded key and a webhook nobody verifies', async () => {
    const app = appWith('stripe-billing-subscriptions', {
      'composer.json': JSON.stringify({ require: { 'stripe/stripe-php': '^13.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nSTRIPE_SECRET_KEY=sk\x5flive_abcdefghijklmnopqrstuvwx\nSTRIPE_PUBLISHABLE_KEY=pk_live_abcdefghij\n',
      'src/Billing/StripeClient.php': `<?php

namespace App\\Billing;

class StripeClient
{
    public function configure(): void
    {
        \\Stripe\\Stripe::setApiKey('sk\x5flive_abcdefghijklmnopqrstuvwx');
    }

    public function portal(string $customerId): object
    {
        \\Stripe\\Customer::retrieve($customerId);

        return \\Stripe\\BillingPortal\\Session::create(['customer' => $customerId]);
    }

    public function webhook(array $payload): string
    {
        return (string) $payload['type'];
    }
}
`,
    });

    const text = await runModule('stripe-billing-subscriptions.js', app);

    expect(text).toContain('hardcoded');
    expect(text).toContain('WEBHOOK_SECRET');
  });

  test('a Stripe test key, which is only worth noting', async () => {
    const app = appWith('stripe-integration-test-key', {
      '.env': 'APP_ENV=dev\nSTRIPE_SECRET_KEY=sk\x5ftest_abcdefghijklmnopqrstuvwx\n',
    });

    const text = await runModule('stripe-integration.js', app);

    expect(text).toContain('test key');
  });

  test('a Swoole server with its worker count set', async () => {
    const app = appWith('swoole-openswoole', {
      'composer.json': JSON.stringify({ require: { 'symfony/runtime': '^7.0' } }, null, 4) + '\n',
      'src/Server/SwooleServer.php': `<?php

namespace App\\Server;

class SwooleServer
{
    public function run(): void
    {
        $server = new Swoole\\Http\\Server('0.0.0.0', 8080);
        $server->set([
            'worker_num' => 4,
            'max_request' => 1000,
        ]);
        $server->start();
    }
}
`,
    });

    const text = await runModule('swoole-openswoole.js', app);

    expect(text).toContain('worker_num');
  });

  test('autowired parameters and iterators', async () => {
    const app = appWith('symfony-autowire-attributes', {
      'src/Service/Reporting.php': `<?php

namespace App\\Service;

use Symfony\\Component\\DependencyInjection\\Attribute\\Autowire;
use Symfony\\Component\\DependencyInjection\\Attribute\\AutowireIterator;
use Symfony\\Component\\DependencyInjection\\Attribute\\AutowireLocator;

class Reporting
{
    public function __construct(
        #[Autowire('%kernel project_dir%')]
        private string $projectDir,
        #[Autowire('%app.reports_dir%')]
        private string $reportsDir,
        #[AutowireIterator('app.report')]
        private object $reports,
        #[AutowireLocator('app.exporter')]
        private object $exporters,
    ) {
    }
}
`,
      'src/Service/Plain.php': `<?php

namespace App\\Service;

class Plain
{
    public function nothing(): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-autowire-attributes.js', app);

    expect(text).toContain('Autowire');
  });

  test('a crawler used without checking what it found', async () => {
    const app = appWith('symfony-browser-kit', {
      'tests/Functional/CrawlerTest.php': `<?php

namespace App\\Tests\\Functional;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class CrawlerTest extends WebTestCase
{
    public function testFollowsTheFirstLink(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $client->click($crawler->filter('.invoice-list > tbody > tr:first-child, .empty + .cta ~ a')->first()->link());
    }
}
`,
    });

    const text = await runModule('symfony-browser-kit.js', app);

    expect(text).toContain('CrawlerTest');
  });

  test('a progress bar that never starts and never finishes', async () => {
    const app = appWith('symfony-console-progress-bar', {
      'src/Command/ImportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Helper\\ProgressBar;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Output\\OutputInterface;

class ImportCommand extends Command
{
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        ProgressBar::setFormatDefinition('minimal', ' %current%/%max%');
        $bar = $this->makeBar($output);
        foreach (range(1, 10) as $i) {
            $bar->advance();
        }

        return Command::SUCCESS;
    }

    private function makeBar(OutputInterface $output): ProgressBar
    {
        return ProgressBar::create($output);
    }
}
`,
    });

    const text = await runModule('symfony-console-progress-bar.js', app);

    expect(text).toContain('advance()');
  });

  test('a command that handles signals but never stops', async () => {
    const app = appWith('symfony-console-signals', {
      'src/Command/WorkerCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Command\\SignalableCommandInterface;

class WorkerCommand extends Command implements SignalableCommandInterface
{
    public function getSubscribedSignals(): array
    {
        return [SIGTERM, SIGINT, 30];
    }

    public function handleSignal(int $signal, int|false $previousExitCode = 0): int|false
    {
        return 0;
    }
}
`,
    });

    const text = await runModule('symfony-console-signals.js', app);

    expect(text).toContain('handleSignal()');
  });

  test('a controller test that requests without asserting', async () => {
    const app = appWith('symfony-controller-test', {
      'tests/Controller/HomeControllerTest.php': `<?php

namespace App\\Tests\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class HomeControllerTest extends WebTestCase
{
    public function testHomeLoads(): void
    {
        $client = static::createClient();
        $client->request('GET', '/');
    }

    public function testAboutLoads(): void
    {
        $client = static::createClient();
        $client->request('GET', '/about');
        $this->assertResponseIsSuccessful();
    }
}
`,
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class HomeController
{
    #[Route('/', name: 'home')]
    public function index(): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-controller-test.js', app);

    expect(text).toContain('HomeController');
  });
});

describe('batch 64: collectors, metadata caches, migrations, emoji, forms and JSON', () => {
  test('a data collector that keeps the password it collected', async () => {
    const app = appWith('symfony-data-collectors', {
      'src/DataCollector/AuthCollector.php': `<?php

namespace App\\DataCollector;

use Symfony\\Bundle\\FrameworkBundle\\DataCollector\\TemplateAwareDataCollectorInterface;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\DataCollector\\DataCollector;

class AuthCollector extends DataCollector implements TemplateAwareDataCollectorInterface
{
    public function collect(Request $request, Response $response, ?\\Throwable $exception = null): void
    {
        $this->data = [
            'user' => $request->request->get('username'),
            'password' => $request->request->get('password'),
        ];
    }

    public function getName(): string
    {
        return 'app.auth';
    }

    public static function getTemplate(): string
    {
        return 'data_collector/auth';
    }
}
`,
    });

    const text = await runModule('symfony-data-collectors.js', app);

    expect(text).toContain('sensitive data');
  });

  test('metadata cached on disk in production', async () => {
    const app = appWith('symfony-doctrine-metadata-cache', {
      'config/packages/prod/doctrine.yaml': `doctrine:
    orm:
        metadata_cache_driver:
            type: pool
            pool: cache.doctrine.filesystem
        query_cache_driver:
            type: array
`,
      'config/packages/test/doctrine.yaml': `doctrine:
    orm:
        metadata_cache_driver:
            type: array
`,
    });

    const text = await runModule('symfony-doctrine-metadata-cache.js', app);

    expect(text).toContain('cache');
  });

  test('a migration whose down() refuses to run, and one that is complete', async () => {
    const app = appWith('symfony-doctrine-migration-rollback', {
      'migrations/Version20260101000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE invoice ADD paid_at DATETIME DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        throw new \\RuntimeException('This migration cannot be reverted.');
    }
}
`,
      'migrations/Version20260102000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260102000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE INDEX idx_invoice_paid_at ON invoice (paid_at)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX idx_invoice_paid_at');
    }
}
`,
    });

    const text = await runModule('symfony-doctrine-migration-rollback.js', app);

    expect(text).toContain('non-reversible');
  });

  test('a slugger that will eat the emoji, and a Twig filter without the package', async () => {
    const app = appWith('symfony-emoji', {
      'src/Service/Slugger.php': `<?php

namespace App\\Service;

use Symfony\\Component\\String\\Slugger\\AsciiSlugger;

class Slugger
{
    public function slug(string $title): string
    {
        // Titles arrive with emoji in them: "🚀 Launch day".
        return (new AsciiSlugger())->slug($title)->toString();
    }
}
`,
      'templates/invoice/show.html.twig': `<h1>{{ title|emoji_to_text }}</h1>
<p>{{ note|text_to_emoji }}</p>
`,
    });

    const text = await runModule('symfony-emoji.js', app);

    expect(text).toContain('emoji');
  });

  test('an expression constraint too long to follow, reaching into a private property', async () => {
    const app = appWith('symfony-form-callback-constraint', {
      'src/Entity/Order.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Validator\\Constraints as Assert;

#[Assert\\Expression(
    'this.total > 0 and this.discount < this.total and this.currency in ["EUR", "GBP", "USD"] and this.customer != null',
    message: 'The order is not consistent.',
)]
class Order
{
    private int $total = 0;

    private int $discount = 0;
}
`,
    });

    const text = await runModule('symfony-form-callback-constraint.js', app);

    expect(text).toContain('Expression');
  });

  test('a form extension applied to every form there is', async () => {
    const app = appWith('symfony-form-type-extension', {
      'src/Form/Extension/HelpExtension.php': `<?php

namespace App\\Form\\Extension;

use Symfony\\Component\\Form\\AbstractTypeExtension;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\FormType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\OptionsResolver\\OptionsResolver;

class HelpExtension extends AbstractTypeExtension
{
    public static function getExtendedTypes(): iterable
    {
        return [FormType::class];
    }

    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults(['help_html' => true]);
    }
}
`,
    });

    const text = await runModule('symfony-form-type-extension.js', app);

    expect(text).toContain('ALL form types');
  });

  test('a JSON-encoded class whose names come out in camel case', async () => {
    const app = appWith('symfony-json-encoder', {
      'src/Dto/InvoiceDto.php': `<?php

namespace App\\Dto;

use Symfony\\Component\\JsonEncoder\\Attribute\\EncodedName;
use Symfony\\Component\\JsonEncoder\\Attribute\\JsonEncodable;

#[JsonEncodable]
class InvoiceDto
{
    public int $invoiceId = 0;

    public string $customerName = '';
}
`,
      'src/Dto/CustomerDto.php': `<?php

namespace App\\Dto;

use Symfony\\Component\\JsonEncoder\\Attribute\\EncodedName;
use Symfony\\Component\\JsonEncoder\\Attribute\\JsonEncodable;

#[JsonEncodable]
class CustomerDto
{
    #[EncodedName('customerId')]
    public readonly int $customerId;

    #[EncodedName('name')]
    public readonly string $name;
}
`,
    });

    const text = await runModule('symfony-json-encoder.js', app);

    expect(text).toContain('camelCase');
  });

  test('a JSON login firewall followed by another top-level section', async () => {
    const app = appWith('symfony-json-login', {
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            pattern: ^/api
            stateless: true
            json_login:
                check_path: /api/login
                username_path: email
                password_path: password

        main:
            lazy: true

when@test:
    security:
        password_hashers:
            Symfony\\Component\\Security\\Core\\User\\PasswordAuthenticatedUserInterface:
                algorithm: plaintext
`,
    });

    const text = await runModule('symfony-json-login.js', app);

    expect(text).toContain('json_login');
  });
});

describe('batch 65: transports, routing loaders, scheduler, IP rules and test kernels', () => {
  test('transports on Redis and AMQP, retried more often than they should be', async () => {
    const app = appWith('symfony-messenger-transport-options', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async:
                dsn: 'redis://redis:6379/messages'
                retry_strategy:
                    max_retries: 25
                    delay: 1000
                    multiplier: 2
            events:
                dsn: 'amqp://guest:guest@rabbit:5672/%2f/events'
            local:
                dsn: 'in-memory://'
`,
    });

    const text = await runModule('symfony-messenger-transport-options.js', app);

    expect(text).toContain('max_retries=25');
    expect(text).toContain('prefetch_count');
  });

  test('a routing loader that answers to everything and returns nothing', async () => {
    const app = appWith('symfony-routing-loader', {
      'src/Routing/LegacyLoader.php': `<?php

namespace App\\Routing;

use Symfony\\Component\\Config\\Loader\\Loader;
use Symfony\\Component\\Routing\\RouteCollection;

class LegacyLoader extends Loader
{
    private bool $loaded = false;

    public function load(mixed $resource, ?string $type = null): mixed
    {
        if ($this->loaded) {
            return null;
        }

        $this->loaded = true;

        return null;
    }

    public function supports(mixed $resource, ?string $type = null): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-routing-loader.js', app);

    expect(text).toContain('supports()');
  });

  test('routing files that import each other in a circle', async () => {
    const app = appWith('symfony-routing-sub-collections', {
      'config/routes.yaml': `admin:
    resource: routes/admin.yaml
    prefix: /{_locale}/admin

api:
    resource: routes/api.yaml
    prefix: /api
`,
      'config/routes/admin.yaml': `admin_api:
    resource: ../routes/api.yaml
    prefix: /admin-api
`,
      'config/routes/api.yaml': `api_admin:
    resource: ../routes.yaml
    prefix: /nested
`,
    });

    const text = await runModule('symfony-routing-sub-collections.js', app);

    expect(text).toContain('_locale');
  });

  test('scheduled tasks written in every notation', async () => {
    const app = appWith('symfony-scheduler-tasks', {
      'src/Scheduler/MainSchedule.php': `<?php

namespace App\\Scheduler;

use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;
use Symfony\\Component\\Scheduler\\RecurringMessage;
use Symfony\\Component\\Scheduler\\Schedule;
use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;

#[AsSchedule('main')]
class MainSchedule implements ScheduleProviderInterface
{
    public function getSchedule(): Schedule
    {
        return (new Schedule())->add(
            RecurringMessage::cron('*/5 8-18 * * mon', new SendReminders()),
            RecurringMessage::every('30 seconds', new PollQueue()),
            RecurringMessage::every('PT15M', new RefreshCache()),
            RecurringMessage::cron('bogus expression here', new BrokenTask()),
        );
    }
}
`,
    });

    const text = await runModule('symfony-scheduler-tasks.js', app);

    expect(text).toContain('Schedule');
  });

  test('an IP rule with a public address and no path', async () => {
    const app = appWith('symfony-security-ip-access', {
      'config/packages/security.yaml': `security:
    access_control:
        - { ips: [203.0.113.4, '2001:db8::1', 192.168.1.0/24], roles: ROLE_ADMIN }
        - { path: ^/admin, roles: ROLE_ADMIN }
        - { roles: PUBLIC_ACCESS }
`,
    });

    const text = await runModule('symfony-security-ip-access.js', app);

    expect(text).toContain('Public IP');
  });

  test('a serializer context built and never used', async () => {
    const app = appWith('symfony-serializer-context-builder', {
      'src/Service/Exporter.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Serializer\\Context\\Normalizer\\ObjectNormalizerContextBuilder;
use Symfony\\Component\\Serializer\\Normalizer\\AbstractNormalizer;
use Symfony\\Component\\Serializer\\SerializerInterface;

class Exporter
{
    public function __construct(private SerializerInterface $serializer)
    {
    }

    public function export(object $invoice): string
    {
        $context = (new ObjectNormalizerContextBuilder())
            ->withContext([AbstractNormalizer::GROUPS => ['invoice:read'], AbstractNormalizer::ATTRIBUTES => ['id']]);

        return $this->serializer->serialize($invoice, 'json');
    }

    public function inline(object $invoice): string
    {
        return $this->serializer->serialize($invoice, 'json', [
            AbstractNormalizer::GROUPS => ['invoice:read'],
            AbstractNormalizer::ATTRIBUTES => ['id'],
        ]);
    }
}
`,
    });

    const text = await runModule('symfony-serializer-context-builder.js', app);

    expect(text).toContain('AbstractNormalizer');
  });

  test('a kernel test that builds a client and logs in twice', async () => {
    const app = appWith('symfony-test-http-kernel', {
      'tests/Integration/AccountTest.php': `<?php

namespace App\\Tests\\Integration;

use Symfony\\Bundle\\FrameworkBundle\\Test\\KernelTestCase;

class AccountTest extends KernelTestCase
{
    public function testLoginThenProfile(): void
    {
        $client = static::createClient();
        $client->request('POST', '/login', ['email' => 'acme@example.com']);
        $client->request('GET', '/profile');
    }
}
`,
    });

    const text = await runModule('symfony-test-http-kernel.js', app);

    expect(text).toContain('createClient');
  });
});

describe('batch 66: translations, UX bridges, validator sequences, workflows and Twig', () => {
  test('translations with a long fallback chain and a call inside a loop', async () => {
    const files: Record<string, string> = {
      'config/packages/framework.yaml': `framework:
    default_locale: en
    translator:
        default_path: '%kernel.project_dir%/translations'
        enabled_locales: [en, fr, de, es]
        fallbacks: [en, fr, de, es]
`,
      'src/Service/Greeter.php': `<?php

namespace App\\Service;

use Symfony\\Contracts\\Translation\\TranslatorInterface;

class Greeter
{
    public function __construct(private TranslatorInterface $translator)
    {
    }

    public function greetAll(array $names): array
    {
        $out = [];
        foreach ($names as $name) {
            $out[] = $this->translator->trans('greeting', ['%name%' => $name]);
        }

        return $out;
    }
}
`,
    };
    // Eleven locales, so the count is worth reporting on its own.
    for (const locale of ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'fi', 'cs']) {
      files[`translations/messages.${locale}.yaml`] = 'greeting: Hello\n';
    }

    const app = appWith('symfony-translation-cache', files);

    const text = await runModule('symfony-translation-cache.js', app);

    expect(text).toContain('fallback');
  });

  test('a Svelte component handed a PHP object', async () => {
    const app = appWith('symfony-ux-svelte', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-svelte': '^2.0' } }, null, 4) + '\n',
      'package.json': JSON.stringify({ dependencies: { svelte: '^4.0' } }, null, 4) + '\n',
      'templates/invoice/show.html.twig': `{{ svelte_component('InvoiceCard', { invoice: new Invoice(), total: 100 }) }}
`,
      'assets/app.js': `import { registerSvelteControllerComponents } from '@symfony/ux-svelte';

registerSvelteControllerComponents(require.context('./svelte/controllers', true, /\\.svelte$/));
`,
      'assets/svelte/controllers/InvoiceCard.svelte': `<div class="invoice-card">
    <h2>Invoice</h2>
</div>
`,
      'assets/svelte/controllers/README.md': 'The components live here.\n',
    });

    const text = await runModule('symfony-ux-svelte.js', app);

    expect(text).toContain('svelte_component');
  });

  test('a Vue component handed a PHP object, and one with no props declared', async () => {
    const app = appWith('symfony-ux-vue', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-vue': '^2.0' } }, null, 4) + '\n',
      'package.json': JSON.stringify({ dependencies: { vue: '^3.0' } }, null, 4) + '\n',
      'templates/invoice/show.html.twig': `{{ vue_component('InvoiceCard', { invoice: new Invoice(), total: 100 }) }}
`,
      'assets/app.js': `import { registerVueControllerComponents } from '@symfony/ux-vue';

registerVueControllerComponents(require.context('./vue/controllers', true, /\\.vue$/));
`,
      'assets/vue/controllers/InvoiceCard.vue': `<template>
    <div class="invoice-card">Invoice</div>
</template>
`,
      'assets/vue/controllers/README.md': 'The components live here.\n',
    });

    const text = await runModule('symfony-ux-vue.js', app);

    expect(text).toContain('vue_component');
  });

  test('a group sequence that leaves Default out', async () => {
    const app = appWith('symfony-validator-sequence-provider', {
      'src/Entity/Registration.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Validator\\Constraints\\GroupSequence;

class Registration
{
    public function sequence(): GroupSequence
    {
        return new GroupSequence(['Basic', 'Strict']);
    }

    public function getGroupSequence(): array
    {
        if ($this->type === 'company') {
            return ['Company'];
        }

        if ($this->type === 'person') {
            return ['Person'];
        }

        switch ($this->country) {
            case 'ES':
                return ['Spain'];
            default:
                break;
        }

        return match ($this->tier) {
            'gold' => ['Gold'],
            default => ['Default'],
        };
    }
}
`,
    });

    const text = await runModule('symfony-validator-sequence-provider.js', app);

    expect(text).toContain('Default');
  });

  test('a workflow that splits and joins, and code that never looks at the marking', async () => {
    const app = appWith('symfony-workflow-parallel-transitions', {
      'config/packages/workflow.yaml': `framework:
    workflows:
        publication:
            type: workflow
            supports:
                - App\\Entity\\Article
            places:
                - draft
                - legal_review
                - copy_review
                - approved
                - published
            transitions:
                start_reviews:
                    from: draft
                    to: [legal_review, copy_review]
                approve:
                    from: [legal_review, copy_review]
                    to: approved
                publish:
                    from: approved
                    to: published
`,
      'src/Service/Publisher.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Workflow\\WorkflowInterface;

class Publisher
{
    public function __construct(private WorkflowInterface $publicationWorkflow)
    {
    }

    public function publish(object $article): void
    {
        if ($this->publicationWorkflow->can($article, 'publish')) {
            $this->publicationWorkflow->apply($article, 'publish');
        }
    }
}
`,
    });

    const text = await runModule('symfony-workflow-parallel-transitions.js', app);

    expect(text).toContain('publish');
  });

  test('a template full of things Twig no longer accepts', async () => {
    const app = appWith('twig-lint', {
      'templates/legacy/list.html.twig': `{% spaceless %}
<ul>
    {% for item in items %}
        <li>{{ item.name|raw }}</li>
        {% if item.id is sameas(current) %}<strong>current</strong>{% endif %}
        {% if item.id is divisibleby(3) %}<em>third</em>{% endif %}
        {{ block('row') }}
    {% endfor %}
</ul>
{{ parent() }}
{% endspaceless %}
`,
    });

    const text = await runModule('twig-lint.js', app, ['legacy/list.html.twig']);

    expect(text).toContain('spaceless');
  });
});

describe('batch 67: API Platform documentation and state, AWS deployments, Behat tags', () => {
  test('a documented resource with a deprecated property and examples of the wrong type', async () => {
    const app = appWith('api-platform-openapi-context', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiProperty;
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Invoice
{
    #[ApiProperty(description: 'The invoice number')]
    private string $number = '';

    #[ApiProperty(deprecationReason: '')]
    #[ApiProperty(description: 'Legacy reference', deprecated: true)]
    private string $legacyReference = '';

    #[ApiProperty(openapiContext: ['type' => 'integer', 'example' => '42'])]
    private int $total = 0;

    #[ApiProperty(openapiContext: ['type' => 'boolean', 'example' => 1])]
    private bool $paid = false;

    #[ApiProperty(description: 'When it was issued')]
    private string $issuedAt = '';
}
`,
    });

    const text = await runModule('api-platform-openapi-context.js', app);

    expect(text).toContain('Invoice');
  });

  test('a processor that flushes unguarded and a provider with no paging', async () => {
    const app = appWith('api-platform-state', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class Invoice
{
    private int $id = 0;
}
`,
      'src/State/InvoiceProcessor.php': `<?php

namespace App\\State;

use ApiPlatform\\Metadata\\Operation;
use ApiPlatform\\State\\ProcessorInterface;
use Doctrine\\ORM\\EntityManagerInterface;

class InvoiceProcessor implements ProcessorInterface
{
    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): mixed
    {
        $this->entityManager->persist($data);
        $this->entityManager->flush();

        return $data;
    }
}
`,
      'src/State/InvoiceProvider.php': `<?php

namespace App\\State;

use ApiPlatform\\Metadata\\Operation;
use ApiPlatform\\State\\ProviderInterface;
use App\\Repository\\InvoiceRepository;

class InvoiceProvider implements ProviderInterface
{
    public function __construct(private InvoiceRepository $repository)
    {
    }

    public function provide(Operation $operation, array $uriVariables = [], array $context = []): iterable
    {
        return $this->repository->findAll();
    }
}
`,
    });

    const text = await runModule('api-platform-state.js', app);

    expect(text).toContain('flush');
  });

  test('an ECS task definition with the secret in its environment', async () => {
    const app = appWith('aws-ecs-config', {
      'deploy/ecs/task-definition.json': JSON.stringify({
        family: 'acme',
        cpu: '512',
        memory: '1024',
        networkMode: 'awsvpc',
        containerDefinitions: [
          {
            name: 'php',
            image: 'acme/php:latest',
            essential: true,
            environment: [
              { name: 'APP_ENV', value: 'prod' },
              { name: 'DATABASE_URL', value: 'postgresql://acme:hunter2@db:5432/acme' },
            ],
          },
        ],
      }, null, 4) + '\n',
    });

    const text = await runModule('aws-ecs-config.js', app);

    expect(text).toContain('task-definition');
  });

  test('a Bref deployment with a long timeout and an SQS transport', async () => {
    const app = appWith('aws-lambda-bref', {
      'composer.json': JSON.stringify({ require: { 'bref/bref': '^2.0' } }, null, 4) + '\n',
      'serverless.yml': `service: acme

provider:
    name: aws
    region: eu-west-1
    runtime: provided.al2

functions:
    web:
        handler: public/index.php
        timeout: 60
        layers:
            - \${bref:layer.php-83-fpm}
        events:
            - httpApi: '*'
`,
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'https://sqs.eu-west-1.amazonaws.com/123456789012/acme'
`,
    });

    const text = await runModule('aws-lambda-bref.js', app);

    expect(text).toContain('timeout');
  });

  test('a serverless file with no PHP runtime in it', async () => {
    const app = appWith('aws-lambda-bref-no-runtime', {
      'composer.json': JSON.stringify({ require: { 'bref/bref': '^2.0' } }, null, 4) + '\n',
      'serverless.yml': `service: acme

provider:
    name: aws
    region: eu-west-1

functions:
    worker:
        handler: bin/worker
`,
    });

    const text = await runModule('aws-lambda-bref.js', app);

    expect(text).toContain('runtime');
  });

  test('Behat tags declared in the suite and used in the features', async () => {
    const app = appWith('behat-tags', {
      'behat.yaml': `default:
    suites:
        default:
            paths: ['%paths.base%/features']
            filters:
                tags: '~@wip'
        smoke:
            paths: ['%paths.base%/features/smoke']
            filters:
                tags: '@smoke'
`,
      'features/checkout.feature': `@checkout @wip
Feature: Checkout

    @smoke
    Scenario: Paying for the basket
        Given I have a basket
        When I pay
        Then the order is placed

    Scenario: Empty basket
        Given I have no basket
        Then I cannot pay
`,
      'features/smoke/home.feature': `@smoke
Feature: Home

    Scenario: The home page loads
        Given I am on the home page
        Then I see the catalogue
`,
    });

    const text = await runModule('behat-tags.js', app, ['@smoke']);

    expect(text).toContain('smoke');
  });
});

describe('batch 68: pipelines, warmers, Cloudinary, console options, fixtures, Datadog', () => {
  test('a Bitbucket pipeline on an unpinned image with a password in the script', async () => {
    const app = appWith('bitbucket-pipelines-config', {
      'bitbucket-pipelines.yml': `image: php:latest

pipelines:
    default:
        - step:
              name: Checks
              script:
                  - composer install
                  - vendor/bin/phpunit
        - step:
              name: Publish
              script:
                  - export DB_PASSWORD=hunter2acme
                  - ./deploy.sh
`,
    });

    const text = await runModule('bitbucket-pipelines-config.js', app);

    expect(text).toContain('php:latest');
  });

  test('a cache warmer that pulls the entity manager in with it', async () => {
    const app = appWith('cache-warmers', {
      'src/Cache/RouteWarmer.php': `<?php

namespace App\\Cache;

use Doctrine\\ORM\\EntityManagerInterface;
use Symfony\\Component\\HttpKernel\\CacheWarmer\\CacheWarmerInterface;

class RouteWarmer implements CacheWarmerInterface
{
    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    public function isOptional(): bool
    {
        return false;
    }

    public function warmUp(string $cacheDir, ?string $buildDir = null): array
    {
        return [];
    }
}
`,
    });

    const text = await runModule('cache-warmers.js', app);

    expect(text).toContain('RouteWarmer');
  });

  test('Cloudinary configured with the secret written twice', async () => {
    const app = appWith('cloudinary-integration', {
      'composer.json': JSON.stringify({ require: { 'cloudinary/cloudinary_php': '^2.0' } }, null, 4) + '\n',
      'config/packages/cloudinary.yaml': `cloudinary:
    cloud_name: acme
    api_key: '123456789012345'
    api_secret: abcdefghijklmnopqrstuvwx
`,
      'src/Media/CloudinaryUploader.php': `<?php

namespace App\\Media;

use Cloudinary\\Cloudinary;

class CloudinaryUploader
{
    public function configure(): void
    {
        Cloudinary::config([
            'cloud_name' => 'acme',
            'api_key' => '123456789012345',
            'api_secret' => 'abcdefghijklmnopqrstuvwx',
        ]);
    }
}
`,
    });

    const text = await runModule('cloudinary-integration.js', app);

    expect(text).toContain('api_secret');
  });

  test('a command with more options than the report prints, in the wrong order', async () => {
    const app = appWith('console-command-options-order', {
      'src/Command/ReportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputArgument;
use Symfony\\Component\\Console\\Input\\InputOption;

#[AsCommand(name: 'app:report')]
class ReportCommand extends Command
{
    protected function configure(): void
    {
        $this
            ->addArgument('period', InputArgument::OPTIONAL, 'Period to report on', 'month')
            ->addArgument('customer', InputArgument::REQUIRED, 'Customer to report on')
            ->addOption('format', 'f', InputOption::VALUE_REQUIRED, 'Output format', 'csv')
            ->addOption('currency', 'c', InputOption::VALUE_REQUIRED, 'Currency', 'EUR')
            ->addOption('locale', 'l', InputOption::VALUE_REQUIRED, 'Locale', 'en')
            ->addOption('limit', null, InputOption::VALUE_REQUIRED, 'Row limit', '100')
            ->addOption('offset', null, InputOption::VALUE_REQUIRED, 'Row offset', '0')
            ->addOption('dry-run', null, InputOption::VALUE_NONE, 'Do not write anything')
            ->addOption('verbose-output', null, InputOption::VALUE_NONE, 'Say more')
        ;
    }
}
`,
    });

    const text = await runModule('console-command-options.js', app);

    expect(text).toContain('more options');
  });

  test('fixtures that depend on each other in a circle', async () => {
    const app = appWith('database-fixture-groups', {
      'src/DataFixtures/UserFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class UserFixtures extends Fixture implements DependentFixtureInterface
{
    public function getGroups(): array
    {
        return ['dev', 'test'];
    }

    public function getDependencies(): array
    {
        return [OrderFixtures::class];
    }

    public function load(ObjectManager $manager): void
    {
    }
}
`,
      'src/DataFixtures/OrderFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\DependentFixtureInterface;
use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class OrderFixtures extends Fixture implements DependentFixtureInterface
{
    public function getGroups(): array
    {
        return ['dev'];
    }

    public function getDependencies(): array
    {
        return ['App\\DataFixtures\\UserFixtures'];
    }

    public function load(ObjectManager $manager): void
    {
    }
}
`,
      'src/DataFixtures/README.php': "<?php\n\n// The fixtures for the Fixture groups live here.\n",
    });

    const text = await runModule('database-fixture-groups.js', app);

    expect(text).toContain('Fixtures');
  });

  test('Datadog traces without a service, an environment or a version', async () => {
    const app = appWith('datadog-integration', {
      'composer.json': JSON.stringify({ require: { 'datadog/dd-trace': '^0.99' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nDD_AGENT_HOST=datadog-agent\nDD_TRACE_ENABLED=1\nDD_API_KEY=abcdef1234567890abcdef1234567890\n',
    });

    const text = await runModule('datadog-integration.js', app);

    expect(text).toContain('DD_SERVICE');
  });

  test('a project with no Datadog anywhere', async () => {
    const app = appWith('datadog-absent', {});

    const text = await runModule('datadog-integration.js', app);

    expect(text).toContain('No Datadog APM integration found');
  });
});

describe('batch 69: schemas, dead code, change tracking, keys, embeddables and factories', () => {
  test('a table with defaults and indexes of every kind', async () => {
    const app = appWith('database-schema', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(name: 'invoice')]
#[ORM\\Index(name: 'idx_invoice_status', columns: ['status'])]
#[ORM\\UniqueConstraint(name: 'uniq_invoice_number', columns: ['number'])]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column(length: 32)]
    private string $number = '';

    #[ORM\\Column(options: ['default' => 'draft'])]
    private string $status = 'draft';

    #[ORM\\Column(nullable: true)]
    private ?string $note = null;
}
`,
    });

    const text = await runModule('database.js', app, ['invoice']);

    expect(text).toContain('invoice');
  });

  test('a controller nothing routes to, and a form type nothing builds', async () => {
    const app = appWith('dead-code', {
      'config/services.yaml': `services:
    _defaults:
        autowire: true

    App\\Service\\Importer:
        arguments:
            $logger: '@monolog.logger.import'
`,
      'config/routes.yaml': `home:
    path: /
    controller: App\\Controller\\HomeController::index
`,
      'src/Controller/HomeController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class HomeController
{
    public function index(): Response
    {
        return new Response('');
    }
}
`,
      'src/Controller/OrphanController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class OrphanController
{
    public function nowhere(): Response
    {
        return new Response('');
    }
}
`,
      'src/Controller/notes.php': "<?php\n\n// A Controller is described here, with no class in it.\n",
      'src/Form/GhostType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class GhostType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
    }
}
`,
      'src/Command/GhostCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;

#[AsCommand(name: 'app:ghost')]
class GhostCommand extends Command
{
}
`,
    });

    const text = await runModule('dead-code.js', app);

    expect(text).toContain('Orphan');
  });

  test('change tracking chosen per entity, with a default entity manager configured', async () => {
    const app = appWith('doctrine-change-tracking-annotations', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        default_entity_manager: default
        entity_managers:
            default:
                auto_mapping: true
`,
      'src/Entity/Ledger.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 * @ORM\\ChangeTrackingPolicy("DEFERRED_EXPLICIT")
 */
class Ledger
{
    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $id;
}
`,
    });

    const text = await runModule('doctrine-change-tracking.js', app);

    expect(text).toContain('DEFERRED');
  });

  test('a composite key written the old way', async () => {
    const app = appWith('doctrine-composite-primary-keys-annotations', {
      'src/Entity/OrderLine.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 */
class OrderLine
{
    /**
     * @Id
     * @Column(type="integer")
     */
    private $orderId;

    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $lineNumber;
}
`,
    });

    const text = await runModule('doctrine-composite-primary-keys.js', app);

    expect(text).toContain('OrderLine');
  });

  test('an embeddable and the entity that holds it', async () => {
    const app = appWith('doctrine-embeddable', {
      'src/Entity/Address.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Embeddable]
class Address
{
    #[ORM\\Column]
    private string $street = '';

    #[ORM\\Column]
    private string $city = '';
}
`,
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Customer
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Embedded(class: Address::class)]
    private Address $address;
}
`,
      'src/Entity/notes.php': "<?php\n\n// @Embeddable and @Embedded are described here.\n",
    });

    const text = await runModule('doctrine-embeddable.js', app);

    expect(text).toContain('Address');
  });

  test('a factory whose defaults are all null', async () => {
    const app = appWith('doctrine-entity-factory', {
      'src/Factory/InvoiceFactory.php': `<?php

namespace App\\Factory;

use App\\Entity\\Invoice;
use Zenstruck\\Foundry\\ModelFactory;

final class InvoiceFactory extends ModelFactory
{
    protected function getDefaults(): array
    {
        return [
            'number' => null,
            'status' => null,
            'total' => null,
        ];
    }

    protected static function getClass(): string
    {
        return Invoice::class;
    }
}
`,
    });

    const text = await runModule('doctrine-entity-factory.js', app);

    expect(text).toContain('InvoiceFactory');
  });
});

describe('batch 70: entity listeners, fetch modes, sequences, env diffs and error pages', () => {
  test('a listener nothing registers, and one with nothing to do', async () => {
    const app = appWith('doctrine-entity-listeners', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 * @ORM\\EntityListeners({"App\\EventListener\\InvoiceListener", "App\\EventListener\\AuditListener"})
 */
class Invoice
{
    /**
     * @ORM\\Id
     * @ORM\\Column(type="integer")
     */
    private $id;
}
`,
      'src/EventListener/InvoiceListener.php': `<?php

namespace App\\EventListener;

use App\\Entity\\Invoice;
use Doctrine\\ORM\\Event\\PrePersistEventArgs;

class InvoiceListener
{
    public function prePersist(Invoice $invoice, PrePersistEventArgs $event): void
    {
    }
}
`,
      'src/EventListener/AuditListener.php': `<?php

namespace App\\EventListener;

class AuditListener
{
    public function describe(): string
    {
        return 'audit';
    }
}
`,
    });

    const text = await runModule('doctrine-entity-listeners.js', app);

    expect(text).toContain('Listener');
  });

  test('associations fetched eagerly, ordered, and lazily where it does not help', async () => {
    const app = appWith('doctrine-fetch-modes', {
      'src/Entity/Order.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\Collections\\Collection;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Order
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\ManyToMany(targetEntity: Tag::class, fetch: 'EAGER')]
    private Collection $tags;

    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'order')]
    #[ORM\\OrderBy(['position' => 'ASC'])]
    private Collection $lines;

    #[ORM\\ManyToOne(targetEntity: Customer::class, fetch: 'EXTRA_LAZY')]
    private ?Customer $customer = null;
}
`,
    });

    const text = await runModule('doctrine-fetch-modes.js', app);

    expect(text).toContain('EXTRA_LAZY');
  });

  test('the platform read from the ORM configuration', async () => {
    const app = appWith('doctrine-sequence-generator', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
    orm:
        database_platform: Doctrine\\DBAL\\Platforms\\PostgreSQLPlatform
        auto_mapping: true
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'SEQUENCE')]
    #[ORM\\SequenceGenerator(sequenceName: 'invoice_id_seq', allocationSize: 1)]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-sequence-generator.js', app);

    expect(text).toContain('sequence');
  });

  test('a package configured for dev and never for prod', async () => {
    const app = appWith('env-config-diff', {
      'config/bundles.php': `<?php

return [
    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],
    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['dev' => true, 'test' => true],
    Doctrine\\Bundle\\DoctrineBundle\\DoctrineBundle::class => ['all' => true],
];
`,
      'config/packages/monolog.yaml': `monolog:
    handlers:
        main:
            type: stream
            path: '%kernel.logs_dir%/%kernel.environment%.log'
`,
      'config/packages/dev/monolog.yaml': `monolog:
    handlers:
        main:
            level: debug
`,
      'config/packages/test/monolog.yaml': `monolog:
    handlers:
        main:
            level: error
`,
    });

    const text = await runModule('env-config-diff.js', app);

    expect(text).toContain('monolog');
  });

  test('error templates alongside something that is not a file', async () => {
    const app = appWith('error-pages', {
      'templates/bundles/TwigBundle/Exception/error404.html.twig': `{% extends 'base.html.twig' %}

{% block body %}<h1>Not found</h1>{% endblock %}
`,
      'templates/bundles/TwigBundle/Exception/error500.html.twig': `<h1>Something went wrong</h1>
`,
      'templates/bundles/TwigBundle/Exception/partials/keep.txt': 'A directory beside the templates.\n',
    });

    const text = await runModule('error-pages.js', app);

    expect(text).toContain('404');
  });
});

describe('batch 71: GraphQL, health checks, Jenkins and kernels', () => {
  test('GraphQL types declared in YAML, with API Platform switched on', async () => {
    const app = appWith('graphql-types', {
      'composer.json': JSON.stringify({ require: { 'api-platform/core': '^3.0' } }, null, 4) + '\n',
      'config/packages/api_platform.yaml': `api_platform:
    title: Acme
    graphql:
        enabled: true
        graphql_playground:
            enabled: false
`,
      'config/graphql/types/Invoice.types.yaml': `Invoice:
    type: object
    config:
        fields:
            id:
                type: 'Int!'
            total:
                type: 'Int!'
`,
      'config/graphql/types/notes.txt': 'Not a type definition.\n',
    });

    const text = await runModule('graphql.js', app);

    expect(text).toContain('Invoice');
  });

  test('health endpoints declared as routes', async () => {
    const app = appWith('health-checks-routes', {
      'config/routes.yaml': `health_live:
    path: /health/live
    controller: App\\Controller\\HealthController::live

health_ready:
    path: /health/ready
    controller: App\\Controller\\HealthController::ready

ping:
    path: /ping
    controller: App\\Controller\\HealthController::ping

home:
    path: /
    controller: App\\Controller\\HomeController::index
`,
    });

    const text = await runModule('health-checks.js', app);

    expect(text).toContain('Liveness:   yes');
  });

  test('a Jenkinsfile with credentials in the environment and a broad rm', async () => {
    const app = appWith('jenkins-config', {
      'Jenkinsfile': `pipeline {
    agent any

    environment {
        DB_PASSWORD = "hunter2acme"
        REGISTRY = "registry.acme.com"
    }

    stages {
        stage('Build') {
            steps {
                sh "composer install"
                sh "rm -rf var/cache"
            }
        }
        stage('Deploy') {
            steps {
                sh "./deploy.sh --token=abcdef123456"
            }
        }
    }
}
`,
    });

    const text = await runModule('jenkins-config.js', app);

    expect(text).toContain('rm -rf');
  });

  test('a scripted Jenkins pipeline', async () => {
    const app = appWith('jenkins-scripted', {
      'Jenkinsfile': `node {
    stage('Checkout') {
        checkout scm
    }
    stage('Test') {
        sh 'vendor/bin/phpunit'
    }
}
`,
    });

    const text = await runModule('jenkins-config.js', app);

    expect(text).toContain('Checkout');
  });

  test('bundles enabled in some environments but not others', async () => {
    const app = appWith('kernel-analysis', {
      'src/Kernel.php': `<?php

namespace App;

use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
`,
      'config/bundles.php': `<?php

return [
    Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle::class => ['all' => true],
    Symfony\\Bundle\\WebProfilerBundle\\WebProfilerBundle::class => ['dev' => true, 'test' => true],
    Symfony\\Bundle\\DebugBundle\\DebugBundle::class => ['dev' => true],
    Symfony\\Bundle\\MonologBundle\\MonologBundle::class => ['prod' => true],
];
`,
    });

    const text = await runModule('kernel-analysis.js', app);

    expect(text).toContain('WebProfilerBundle');
  });
});

describe('batch 72: mailers, Mailgun, Microsoft Graph and the web server', () => {
  test('a mailer DSN that is only an environment reference', async () => {
    const app = appWith('mailer-env-dsn', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'smtp://%env(MAILER_USER)%:%env(MAILER_PASSWORD)%@smtp.acme.com:587'
        envelope:
            sender: 'noreply@acme.example.com'
`,
      'templates/email/invoice.html.twig': `<h1>Your invoice</h1>
<p>Thank you.</p>
`,
      'templates/email/welcome.html.twig': `<h1>Welcome</h1>
${'<p>A paragraph to make the template worth measuring in kilobytes.</p>\n'.repeat(40)}
`,
    });

    const text = await runModule('mailer.js', app);

    expect(text).toContain('smtp');
  });

  test('Mailgun on a sandbox domain with the key in the DSN', async () => {
    const app = appWith('mailgun-integration', {
      'composer.json': JSON.stringify({ require: { 'symfony/mailgun-mailer': '^7.0' } }, null, 4) + '\n',
      '.env.prod': `APP_ENV=prod
MAILGUN_DOMAIN=sandbox1234567890abcdef.mailgun.org
MAILER_DSN=mailgun+api://key\x2d0123456789abcdef0123456789abcdef:sandbox1234567890abcdef.mailgun.org@default
`,
    });

    const text = await runModule('mailgun-integration.js', app);

    expect(text).toContain('sandbox');
  });

  test('Microsoft Graph reached with application permissions and a wide scope', async () => {
    const app = appWith('microsoft-graph-integration', {
      'composer.json': JSON.stringify({ require: { 'microsoft/microsoft-graph': '^2.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nAZURE_TENANT_ID=00000000-0000-0000-0000-000000000000\n',
      'src/Graph/GraphClient.php': `<?php

namespace App\\Graph;

use Microsoft\\Graph\\GraphServiceClient;

class GraphClient
{
    private const CLIENT_SECRET = 'abcdefghij~klmnopqrstuvwxyz012345';

    public function client(): GraphServiceClient
    {
        $token = $this->token([
            'grant_type' => 'client_credentials',
            'scope' => 'Mail.ReadWrite Files.ReadWrite.All',
            'client_secret' => self::CLIENT_SECRET,
        ]);

        return GraphServiceClient::createWithAuthenticationProvider($token);
    }

    private function token(array $params): object
    {
        return (object) $params;
    }
}
`,
    });

    const text = await runModule('microsoft-graph-integration.js', app);

    expect(text).toContain('client_credentials');
  });

  test('an nginx site over TLS with no security headers, and an FPM pool', async () => {
    const app = appWith('nginx-php-fpm', {
      'docker/nginx/default.conf': `server {
    listen 443 ssl http2;
    server_name acme.example.com;

    ssl_certificate /etc/ssl/acme.crt;
    ssl_certificate_key /etc/ssl/acme.key;

    root /var/www/public;

    location / {
        try_files $uri /index.php$is_args$args;
    }

    location ~ ^/index\\.php(/|$) {
        fastcgi_pass php:9000;
        fastcgi_split_path_info ^(.+\\.php)(/.*)$;
        include fastcgi_params;
    }
}
`,
      'docker/php/www.conf': `[www]
user = www-data
group = www-data
listen = 9000
pm = dynamic
pm.max_children = 5
pm.start_servers = 2
pm.max_requests = 0
`,
    });

    const text = await runModule('nginx-php-fpm.js', app);

    expect(text).toContain('Strict-Transport-Security');
  });
});

describe('batch 73: OpenAPI attributes and PHP class patterns', () => {
  test('documented endpoints and schemas', async () => {
    const app = appWith('openapi-attributes', {
      'src/Controller/Api/InvoiceController.php': `<?php

namespace App\\Controller\\Api;

use OpenApi\\Attributes as OA;
use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\Routing\\Attribute\\Route;

class InvoiceController
{
    #[Route('/api/invoices', methods: ['GET'])]
    #[OA\\Get(path: '/api/invoices', tags: ['invoice'], security: [['bearerAuth' => []]])]
    #[OA\\Response(response: 200, description: 'The invoices')]
    public function index(): JsonResponse
    {
        return new JsonResponse([]);
    }

    #[Route('/api/invoices', methods: ['POST'])]
    #[OA\\Post(path: '/api/invoices', tags: ['invoice'])]
    #[OA\\RequestBody(description: 'The invoice to create')]
    #[OA\\Response(response: 201, description: 'Created')]
    public function create(): JsonResponse
    {
        return new JsonResponse([], 201);
    }
}
`,
      'src/Dto/InvoiceSchema.php': `<?php

namespace App\\Dto;

use OpenApi\\Attributes as OA;

#[OA\\Schema(schema: 'Invoice')]
class InvoiceSchema
{
    #[OA\\Property(description: 'The number')]
    public string $number = '';

    #[OA\\Property(description: 'The total')]
    public int $total = 0;
}
`,
      'src/Dto/notes.php': "<?php\n\n// #[OA\\Schema] and #[OA\\Property] are described here.\n",
    });

    const text = await runModule('openapi.js', app);

    expect(text).toContain('InvoiceController');
  });

  test('an abstract class with too many obligations, calling one from its constructor', async () => {
    const app = appWith('php-abstract-patterns', {
      'src/Import/AbstractImporter.php': `<?php

namespace App\\Import;

abstract class AbstractImporter
{
    public function __construct(private string $source)
    {
        $this->prepare();
    }

    abstract protected function prepare(): void;

    abstract protected function step0(): void;

    abstract protected function step1(): void;

    abstract protected function step2(): void;

    abstract protected function step3(): void;

    abstract protected function step4(): void;

    abstract protected function step5(): void;

    abstract protected function step6(): void;

    abstract protected function step7(): void;

    abstract protected function step8(): void;

    abstract protected function step9(): void;

    abstract protected function step10(): void;

    abstract protected function step11(): void;

    public function run(): void
    {
        $this->prepare();
        $this->step0();
    }
}
`,
    });

    const text = await runModule('php-abstract-patterns.js', app);

    expect(text).toContain('AbstractImporter');
  });

  test('array searches that PHP 8.4 would write differently', async () => {
    const app = appWith('php-array-find-functions', {
      'composer.json': JSON.stringify({ require: { php: '>=8.4' } }, null, 4) + '\n',
      'src/Service/Finder.php': `<?php

namespace App\\Service;

class Finder
{
    public function first(array $rows, string $needle): ?array
    {
        $found = array_filter($rows, static fn (array $row): bool => $row['name'] === $needle);

        return array_values($found)[0] ?? null;
    }

    public function position(array $haystack, string $needle): int|string|false
    {
        return array_search($needle, $haystack);
    }
}
`,
    });

    const text = await runModule('php-array-find-functions.js', app);

    expect(text).toContain('array_search');
  });

  test('a benchmark method with nothing to warm it up', async () => {
    const app = appWith('php-benchmark-patterns', {
      'benchmarks/HashBench.php': `<?php

namespace App\\Benchmarks;

class HashBench
{
    /**
     * @Revs(1)
     * @Iterations(1)
     */
    public function benchSha256(): void
    {
        for ($i = 0; $i < 1000; $i++) {
            hash('sha256', (string) $i);
        }
    }

    public function benchNoBraces(): void
    {
        hash('crc32b', 'acme');
    }
}
`,
    });

    const text = await runModule('php-benchmark-patterns.js', app);

    expect(text).toContain('Bench');
  });
});

describe('batch 74: promotion, FPM pools, hashes, HTML parsing, memory and sessions', () => {
  test('a constructor that assigns what it could promote', async () => {
    const app = appWith('php-constructor-promotion', {
      'src/Service/Importer.php': `<?php

namespace App\\Service;

class Importer
{
    private string $source;

    private int $batchSize;

    public function __construct(string $source, int $batchSize)
    {
        $this->source = $source;
        $this->batchSize = $batchSize;
    }
}
`,
      'src/Service/Exporter.php': `<?php

namespace App\\Service;

abstract class Exporter
{
    abstract public function __construct(
        public readonly $format,
        protected $target,
    );
}
`,
    });

    const text = await runModule('php-constructor-promotion.js', app);

    expect(text).toContain('promotion');
  });

  test('an FPM pool that starts every worker at once', async () => {
    const app = appWith('php-fpm-config', {
      'docker/php/www.conf': `[www]
user = www-data
listen = 9000
pm = static
pm.max_children = 120
pm.max_requests = 500
`,
    });

    const text = await runModule('php-fpm-config.js', app);

    expect(text).toContain('static');
  });

  test('a password hashed with something that is not for passwords', async () => {
    const app = appWith('php-hash-algorithm-security', {
      'src/Security/LegacyHasher.php': `<?php

namespace App\\Security;

class LegacyHasher
{
    public function hash(string $password): string
    {
        return md5($password . 'acme-salt');
    }

    public function checksum(string $payload): string
    {
        return sha1($payload);
    }

    public function modern(string $password): string
    {
        return password_hash($password, PASSWORD_ARGON2ID);
    }
}
`,
    });

    const text = await runModule('php-hash-algorithm-security.js', app);

    expect(text).toContain('md5');
  });

  test('HTML parsed the old way and the new way', async () => {
    const app = appWith('php-html5-parser', {
      'src/Scraper/PageParser.php': `<?php

namespace App\\Scraper;

class PageParser
{
    public function legacy(string $html): \\DOMDocument
    {
        libxml_use_internal_errors(true);
        $document = new DOMDocument();
        $document->loadHTML($html);

        return $document;
    }
}
`,
      'src/Scraper/ModernParser.php': `<?php

namespace App\\Scraper;

class ModernParser
{
    public function parse(string $html): object
    {
        return Dom\\HTMLDocument::createFromString($html);
    }

    public function parseXml(string $xml): object
    {
        return Dom\\XMLDocument::createFromString($xml);
    }
}
`,
    });

    const text = await runModule('php-html5-parser.js', app);

    expect(text).toContain('DOMDocument');
  });

  test('a memory limit raised inside the code', async () => {
    const app = appWith('php-memory-management', {
      'php.ini': `[PHP]
memory_limit = 4096M
`,
      'src/Command/ImportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;

class ImportCommand extends Command
{
    public function run(): int
    {
        ini_set('memory_limit', '-1');

        foreach (range(1, 100000) as $i) {
            $rows[] = str_repeat('x', 1024);
        }

        return 0;
    }
}
`,
    });

    const text = await runModule('php-memory-management.js', app);

    expect(text).toContain('memory_limit');
  });

  test('namespaces that do not follow the autoload map', async () => {
    const app = appWith('php-namespace-consistency', {
      'composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
        autoload: { 'psr-4': { 'App\\': 'src/', 'Acme\\': 'lib/' } },
      }, null, 4) + '\n',
      'src/Service/Importer.php': `<?php

namespace App\\Service;

class Importer
{
}
`,
      'src/Service/Wrong.php': `<?php

namespace App\\Wrong\\Place;

class Wrong
{
}
`,
    });

    const text = await runModule('php-namespace-consistency.js', app);

    expect(text).toContain('Wrong');
  });

  test('sessions started and regenerated without their options', async () => {
    const app = appWith('php-session-security', {
      'src/Legacy/SessionBridge.php': `<?php

namespace App\\Legacy;

class SessionBridge
{
    public function start(): void
    {
        session_start();
    }

    public function login(): void
    {
        session_regenerate_id();
        ini_set('session.use_trans_sid', 1);
    }
}
`,
    });

    const text = await runModule('php-session-security.js', app);

    expect(text).toContain('session_start()');
  });
});

describe('batch 75: shared memory, SSRF, traits, PHPUnit tooling and RabbitMQ', () => {
  test('shared memory opened for everyone, holding request data', async () => {
    const app = appWith('php-shmop-ipc', {
      'src/Ipc/SharedCounter.php': `<?php

namespace App\\Ipc;

class SharedCounter
{
    public function open(): mixed
    {
        return shmop_open(0x0a0a, 'c', 0777, 1024);
    }

    public function store(): void
    {
        $segment = shm_attach(0x0b0b);
        shm_put_var($segment, 1, $_GET['value']);
        $value = shm_get_var($segment, 1);
    }
}
`,
    });

    const text = await runModule('php-shmop-ipc.js', app);

    expect(text).toContain('shmop');
  });

  test('a request built from user input, with and without a check', async () => {
    const app = appWith('php-ssrf-patterns', {
      'src/Http/Fetcher.php': `<?php

namespace App\\Http;

class Fetcher
{
    private const ALLOWED_HOSTS = ['api.acme.com'];

    public function fetch(string $url): string
    {
        return (string) file_get_contents($url);
    }

    public function fetchChecked(string $url): string
    {
        $host = parse_url($url, PHP_URL_HOST);
        if (!in_array($host, self::ALLOWED_HOSTS, true)) {
            return '';
        }

        $ch = curl_init($url);

        return (string) curl_exec($ch);
    }
}
`,
    });

    const text = await runModule('php-ssrf-patterns.js', app);

    expect(text).toContain('file_get_contents');
  });

  test('traits that collide, aliased to the name they already had', async () => {
    const app = appWith('php-trait-conflicts', {
      'src/Trait/Timestampable.php': `<?php

namespace App\\Trait;

trait Timestampable
{
    public function touch(): void
    {
    }

    public function reset(): void
    {
    }
}
`,
      'src/Trait/Blameable.php': `<?php

namespace App\\Trait;

trait Blameable
{
    public function touch(): void
    {
    }

    public function reset(): void
    {
    }
}
`,
      'src/Entity/Article.php': `<?php

namespace App\\Entity;

use App\\Trait\\Blameable;
use App\\Trait\\Timestampable;

class Article
{
    use Timestampable, Blameable {
        Timestampable::touch insteadof Blameable;
        reset as reset;
    }
}
`,
    });

    const text = await runModule('php-trait-conflicts.js', app);

    expect(text).toContain('trait');
  });

  test('a custom assertion that never fails, and a constraint with no message', async () => {
    const app = appWith('phpunit-assertions-custom', {
      'tests/Constraint/IsInvoice.php': `<?php

namespace App\\Tests\\Constraint;

use PHPUnit\\Framework\\Constraint\\Constraint;

class IsInvoice extends Constraint
{
    public function toString(): string
    {
        return '';
    }

    protected function matches(mixed $other): bool
    {
        return is_object($other);
    }
}
`,
      'tests/Assertion/InvoiceAssertions.php': `<?php

namespace App\\Tests\\Assertion;

use PHPUnit\\Framework\\Assert;

trait InvoiceAssertions
{
    public static function assertInvoiceIsPaid(object $invoice): void
    {
        Assert::assertTrue($invoice->paid);
    }

    public static function assertInvoiceHasLines(object $invoice): void
    {
        if (count($invoice->lines) === 0) {
            return;
        }
    }
}
`,
    });

    const text = await runModule('phpunit-assertions-custom.js', app);

    expect(text).toContain('assertion');
  });

  test('a large suite run in one process, with static state in it', async () => {
    const app = appWith('phpunit-parallel', {
      'phpunit.xml.dist': `<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/bootstrap.php" processIsolation="true">
    <testsuites>
        <testsuite name="unit">
            <directory>tests</directory>
        </testsuite>
    </testsuites>
</phpunit>
`,
      'tests/Unit/BigTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class BigTest extends TestCase
{
    private static array $cache = [];

    public function testCase0(): void
    {
        $this->assertTrue(true);
    }

    public function testCase1(): void
    {
        $this->assertTrue(true);
    }

    public function testCase2(): void
    {
        $this->assertTrue(true);
    }

    public function testCase3(): void
    {
        $this->assertTrue(true);
    }

    public function testCase4(): void
    {
        $this->assertTrue(true);
    }

    public function testCase5(): void
    {
        $this->assertTrue(true);
    }

    public function testCase6(): void
    {
        $this->assertTrue(true);
    }

    public function testCase7(): void
    {
        $this->assertTrue(true);
    }

    public function testCase8(): void
    {
        $this->assertTrue(true);
    }

    public function testCase9(): void
    {
        $this->assertTrue(true);
    }

    public function testCase10(): void
    {
        $this->assertTrue(true);
    }

    public function testCase11(): void
    {
        $this->assertTrue(true);
    }

    public function testCase12(): void
    {
        $this->assertTrue(true);
    }

    public function testCase13(): void
    {
        $this->assertTrue(true);
    }

    public function testCase14(): void
    {
        $this->assertTrue(true);
    }

    public function testCase15(): void
    {
        $this->assertTrue(true);
    }

    public function testCase16(): void
    {
        $this->assertTrue(true);
    }

    public function testCase17(): void
    {
        $this->assertTrue(true);
    }

    public function testCase18(): void
    {
        $this->assertTrue(true);
    }

    public function testCase19(): void
    {
        $this->assertTrue(true);
    }

    public function testCase20(): void
    {
        $this->assertTrue(true);
    }

    public function testCase21(): void
    {
        $this->assertTrue(true);
    }

    public function testCase22(): void
    {
        $this->assertTrue(true);
    }

    public function testCase23(): void
    {
        $this->assertTrue(true);
    }

    public function testCase24(): void
    {
        $this->assertTrue(true);
    }

    public function testCase25(): void
    {
        $this->assertTrue(true);
    }

    public function testCase26(): void
    {
        $this->assertTrue(true);
    }

    public function testCase27(): void
    {
        $this->assertTrue(true);
    }

    public function testCase28(): void
    {
        $this->assertTrue(true);
    }

    public function testCase29(): void
    {
        $this->assertTrue(true);
    }

    public function testCase30(): void
    {
        $this->assertTrue(true);
    }

    public function testCase31(): void
    {
        $this->assertTrue(true);
    }

    public function testCase32(): void
    {
        $this->assertTrue(true);
    }

    public function testCase33(): void
    {
        $this->assertTrue(true);
    }

    public function testCase34(): void
    {
        $this->assertTrue(true);
    }

    public function testCase35(): void
    {
        $this->assertTrue(true);
    }

    public function testCase36(): void
    {
        $this->assertTrue(true);
    }

    public function testCase37(): void
    {
        $this->assertTrue(true);
    }

    public function testCase38(): void
    {
        $this->assertTrue(true);
    }

    public function testCase39(): void
    {
        $this->assertTrue(true);
    }

    public function testCase40(): void
    {
        $this->assertTrue(true);
    }

    public function testCase41(): void
    {
        $this->assertTrue(true);
    }

    public function testCase42(): void
    {
        $this->assertTrue(true);
    }

    public function testCase43(): void
    {
        $this->assertTrue(true);
    }

    public function testCase44(): void
    {
        $this->assertTrue(true);
    }

    public function testCase45(): void
    {
        $this->assertTrue(true);
    }

    public function testCase46(): void
    {
        $this->assertTrue(true);
    }

    public function testCase47(): void
    {
        $this->assertTrue(true);
    }

    public function testCase48(): void
    {
        $this->assertTrue(true);
    }

    public function testCase49(): void
    {
        $this->assertTrue(true);
    }

    public function testCase50(): void
    {
        $this->assertTrue(true);
    }

    public function testCase51(): void
    {
        $this->assertTrue(true);
    }

    public function testCase52(): void
    {
        $this->assertTrue(true);
    }

    public function testCase53(): void
    {
        $this->assertTrue(true);
    }

    public function testCase54(): void
    {
        $this->assertTrue(true);
    }

    public function testCase55(): void
    {
        $this->assertTrue(true);
    }

    public function testCase56(): void
    {
        $this->assertTrue(true);
    }

    public function testCase57(): void
    {
        $this->assertTrue(true);
    }

    public function testCase58(): void
    {
        $this->assertTrue(true);
    }

    public function testCase59(): void
    {
        $this->assertTrue(true);
    }

    public function testCase60(): void
    {
        $this->assertTrue(true);
    }

    public function testCase61(): void
    {
        $this->assertTrue(true);
    }

    public function testCase62(): void
    {
        $this->assertTrue(true);
    }

    public function testCase63(): void
    {
        $this->assertTrue(true);
    }

    public function testCase64(): void
    {
        $this->assertTrue(true);
    }

    public function testCase65(): void
    {
        $this->assertTrue(true);
    }

    public function testCase66(): void
    {
        $this->assertTrue(true);
    }

    public function testCase67(): void
    {
        $this->assertTrue(true);
    }

    public function testCase68(): void
    {
        $this->assertTrue(true);
    }

    public function testCase69(): void
    {
        $this->assertTrue(true);
    }

    public function testCase70(): void
    {
        $this->assertTrue(true);
    }

    public function testCase71(): void
    {
        $this->assertTrue(true);
    }

    public function testCase72(): void
    {
        $this->assertTrue(true);
    }

    public function testCase73(): void
    {
        $this->assertTrue(true);
    }

    public function testCase74(): void
    {
        $this->assertTrue(true);
    }

    public function testCase75(): void
    {
        $this->assertTrue(true);
    }

    public function testCase76(): void
    {
        $this->assertTrue(true);
    }

    public function testCase77(): void
    {
        $this->assertTrue(true);
    }

    public function testCase78(): void
    {
        $this->assertTrue(true);
    }

    public function testCase79(): void
    {
        $this->assertTrue(true);
    }

    public function testCase80(): void
    {
        $this->assertTrue(true);
    }

    public function testCase81(): void
    {
        $this->assertTrue(true);
    }

    public function testCase82(): void
    {
        $this->assertTrue(true);
    }

    public function testCase83(): void
    {
        $this->assertTrue(true);
    }

    public function testCase84(): void
    {
        $this->assertTrue(true);
    }

    public function testCase85(): void
    {
        $this->assertTrue(true);
    }

    public function testCase86(): void
    {
        $this->assertTrue(true);
    }

    public function testCase87(): void
    {
        $this->assertTrue(true);
    }

    public function testCase88(): void
    {
        $this->assertTrue(true);
    }

    public function testCase89(): void
    {
        $this->assertTrue(true);
    }

    public function testCase90(): void
    {
        $this->assertTrue(true);
    }

    public function testCase91(): void
    {
        $this->assertTrue(true);
    }

    public function testCase92(): void
    {
        $this->assertTrue(true);
    }

    public function testCase93(): void
    {
        $this->assertTrue(true);
    }

    public function testCase94(): void
    {
        $this->assertTrue(true);
    }

    public function testCase95(): void
    {
        $this->assertTrue(true);
    }

    public function testCase96(): void
    {
        $this->assertTrue(true);
    }

    public function testCase97(): void
    {
        $this->assertTrue(true);
    }

    public function testCase98(): void
    {
        $this->assertTrue(true);
    }

    public function testCase99(): void
    {
        $this->assertTrue(true);
    }

    public function testCase100(): void
    {
        $this->assertTrue(true);
    }

    public function testCase101(): void
    {
        $this->assertTrue(true);
    }

    public function testCase102(): void
    {
        $this->assertTrue(true);
    }

    public function testCase103(): void
    {
        $this->assertTrue(true);
    }

    public function testCase104(): void
    {
        $this->assertTrue(true);
    }

    public function testCase105(): void
    {
        $this->assertTrue(true);
    }

    public function testCase106(): void
    {
        $this->assertTrue(true);
    }

    public function testCase107(): void
    {
        $this->assertTrue(true);
    }

    public function testCase108(): void
    {
        $this->assertTrue(true);
    }

    public function testCase109(): void
    {
        $this->assertTrue(true);
    }

    public function testCase110(): void
    {
        $this->assertTrue(true);
    }

    public function testCase111(): void
    {
        $this->assertTrue(true);
    }

    public function testCase112(): void
    {
        $this->assertTrue(true);
    }

    public function testCase113(): void
    {
        $this->assertTrue(true);
    }

    public function testCase114(): void
    {
        $this->assertTrue(true);
    }

    public function testCase115(): void
    {
        $this->assertTrue(true);
    }

    public function testCase116(): void
    {
        $this->assertTrue(true);
    }

    public function testCase117(): void
    {
        $this->assertTrue(true);
    }

    public function testCase118(): void
    {
        $this->assertTrue(true);
    }

    public function testCase119(): void
    {
        $this->assertTrue(true);
    }

    public function testCase120(): void
    {
        $this->assertTrue(true);
    }

    public function testCase121(): void
    {
        $this->assertTrue(true);
    }

    public function testCase122(): void
    {
        $this->assertTrue(true);
    }

    public function testCase123(): void
    {
        $this->assertTrue(true);
    }

    public function testCase124(): void
    {
        $this->assertTrue(true);
    }

    public function testCase125(): void
    {
        $this->assertTrue(true);
    }

    public function testCase126(): void
    {
        $this->assertTrue(true);
    }

    public function testCase127(): void
    {
        $this->assertTrue(true);
    }

    public function testCase128(): void
    {
        $this->assertTrue(true);
    }

    public function testCase129(): void
    {
        $this->assertTrue(true);
    }

    public function testCase130(): void
    {
        $this->assertTrue(true);
    }

    public function testCase131(): void
    {
        $this->assertTrue(true);
    }

    public function testCase132(): void
    {
        $this->assertTrue(true);
    }

    public function testCase133(): void
    {
        $this->assertTrue(true);
    }

    public function testCase134(): void
    {
        $this->assertTrue(true);
    }

    public function testCase135(): void
    {
        $this->assertTrue(true);
    }

    public function testCase136(): void
    {
        $this->assertTrue(true);
    }

    public function testCase137(): void
    {
        $this->assertTrue(true);
    }

    public function testCase138(): void
    {
        $this->assertTrue(true);
    }

    public function testCase139(): void
    {
        $this->assertTrue(true);
    }

    public function testCase140(): void
    {
        $this->assertTrue(true);
    }

    public function testCase141(): void
    {
        $this->assertTrue(true);
    }

    public function testCase142(): void
    {
        $this->assertTrue(true);
    }

    public function testCase143(): void
    {
        $this->assertTrue(true);
    }

    public function testCase144(): void
    {
        $this->assertTrue(true);
    }

    public function testCase145(): void
    {
        $this->assertTrue(true);
    }

    public function testCase146(): void
    {
        $this->assertTrue(true);
    }

    public function testCase147(): void
    {
        $this->assertTrue(true);
    }

    public function testCase148(): void
    {
        $this->assertTrue(true);
    }

    public function testCase149(): void
    {
        $this->assertTrue(true);
    }

    public function testCase150(): void
    {
        $this->assertTrue(true);
    }

    public function testCase151(): void
    {
        $this->assertTrue(true);
    }

    public function testCase152(): void
    {
        $this->assertTrue(true);
    }

    public function testCase153(): void
    {
        $this->assertTrue(true);
    }

    public function testCase154(): void
    {
        $this->assertTrue(true);
    }

    public function testCase155(): void
    {
        $this->assertTrue(true);
    }

    public function testCase156(): void
    {
        $this->assertTrue(true);
    }

    public function testCase157(): void
    {
        $this->assertTrue(true);
    }

    public function testCase158(): void
    {
        $this->assertTrue(true);
    }

    public function testCase159(): void
    {
        $this->assertTrue(true);
    }

    public function testCase160(): void
    {
        $this->assertTrue(true);
    }

    public function testCase161(): void
    {
        $this->assertTrue(true);
    }

    public function testCase162(): void
    {
        $this->assertTrue(true);
    }

    public function testCase163(): void
    {
        $this->assertTrue(true);
    }

    public function testCase164(): void
    {
        $this->assertTrue(true);
    }

    public function testCase165(): void
    {
        $this->assertTrue(true);
    }

    public function testCase166(): void
    {
        $this->assertTrue(true);
    }

    public function testCase167(): void
    {
        $this->assertTrue(true);
    }

    public function testCase168(): void
    {
        $this->assertTrue(true);
    }

    public function testCase169(): void
    {
        $this->assertTrue(true);
    }

    public function testCase170(): void
    {
        $this->assertTrue(true);
    }

    public function testCase171(): void
    {
        $this->assertTrue(true);
    }

    public function testCase172(): void
    {
        $this->assertTrue(true);
    }

    public function testCase173(): void
    {
        $this->assertTrue(true);
    }

    public function testCase174(): void
    {
        $this->assertTrue(true);
    }

    public function testCase175(): void
    {
        $this->assertTrue(true);
    }

    public function testCase176(): void
    {
        $this->assertTrue(true);
    }

    public function testCase177(): void
    {
        $this->assertTrue(true);
    }

    public function testCase178(): void
    {
        $this->assertTrue(true);
    }

    public function testCase179(): void
    {
        $this->assertTrue(true);
    }

    public function testCase180(): void
    {
        $this->assertTrue(true);
    }

    public function testCase181(): void
    {
        $this->assertTrue(true);
    }

    public function testCase182(): void
    {
        $this->assertTrue(true);
    }

    public function testCase183(): void
    {
        $this->assertTrue(true);
    }

    public function testCase184(): void
    {
        $this->assertTrue(true);
    }

    public function testCase185(): void
    {
        $this->assertTrue(true);
    }

    public function testCase186(): void
    {
        $this->assertTrue(true);
    }

    public function testCase187(): void
    {
        $this->assertTrue(true);
    }

    public function testCase188(): void
    {
        $this->assertTrue(true);
    }

    public function testCase189(): void
    {
        $this->assertTrue(true);
    }

    public function testCase190(): void
    {
        $this->assertTrue(true);
    }

    public function testCase191(): void
    {
        $this->assertTrue(true);
    }

    public function testCase192(): void
    {
        $this->assertTrue(true);
    }

    public function testCase193(): void
    {
        $this->assertTrue(true);
    }

    public function testCase194(): void
    {
        $this->assertTrue(true);
    }

    public function testCase195(): void
    {
        $this->assertTrue(true);
    }

    public function testCase196(): void
    {
        $this->assertTrue(true);
    }

    public function testCase197(): void
    {
        $this->assertTrue(true);
    }

    public function testCase198(): void
    {
        $this->assertTrue(true);
    }

    public function testCase199(): void
    {
        $this->assertTrue(true);
    }

    public function testCase200(): void
    {
        $this->assertTrue(true);
    }

    public function testCase201(): void
    {
        $this->assertTrue(true);
    }

    public function testCase202(): void
    {
        $this->assertTrue(true);
    }

    public function testCase203(): void
    {
        $this->assertTrue(true);
    }

    public function testCase204(): void
    {
        $this->assertTrue(true);
    }

    public function testCase205(): void
    {
        $this->assertTrue(true);
    }

    public function testCase206(): void
    {
        $this->assertTrue(true);
    }

    public function testCase207(): void
    {
        $this->assertTrue(true);
    }

    public function testCase208(): void
    {
        $this->assertTrue(true);
    }

    public function testCase209(): void
    {
        $this->assertTrue(true);
    }
}
`,
    });

    const text = await runModule('phpunit-parallel.js', app);

    expect(text).toContain('paratest');
  });

  test('tests named in ways nothing will run', async () => {
    const app = appWith('phpunit-test-naming', {
      'tests/Unit/InvoiceTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class InvoiceTest extends TestCase
{
    public function testItWorks(): void
    {
        $this->assertTrue(true);
    }

    public function checkTheTotal(): void
    {
        $this->assertTrue(true);
    }

    public function test_it_adds_lines(): void
    {
        $this->assertTrue(true);
    }
}
`,
      'tests/Unit/HelperClass.php': `<?php

namespace App\\Tests\\Unit;

class HelperClass
{
    public function help(): void
    {
    }
}
`,
    });

    const text = await runModule('phpunit-test-naming.js', app);

    expect(text).toContain('Invoice');
  });

  test('a Playwright configuration for the end-to-end suite', async () => {
    const app = appWith('playwright-e2e-config', {
      'playwright.config.ts': `import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    retries: 0,
    workers: 1,
    use: {
        trace: 'off',
        video: 'off',
    },
});
`,
      'tests/e2e/login.spec.ts': `import { test, expect } from '@playwright/test';

test('login', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/Acme/);
});
`,
    });

    const text = await runModule('playwright-e2e-config.js', app);

    expect(text).toContain('Playwright');
  });

  test('RabbitMQ still on its default credentials, over plain HTTP', async () => {
    const app = appWith('rabbitmq-management-api', {
      '.env': `APP_ENV=prod
RABBITMQ_MANAGEMENT_URL=http://rabbit.acme.internal:15672
RABBITMQ_DEFAULT_USER=guest
RABBITMQ_DEFAULT_PASS=guest
`,
      'src/Queue/RabbitStats.php': `<?php

namespace App\\Queue;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class RabbitStats
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function queues(): array
    {
        return $this->client->request('GET', 'http://rabbit.acme.internal:15672/api/queues')->toArray();
    }
}
`,
    });

    const text = await runModule('rabbitmq-management-api.js', app);

    expect(text).toContain('guest');
  });
});

describe('batch 76: vaults, scanners, Sentry, locators, Slack, access control and caches', () => {
  test('secrets kept in an encrypted vault', async () => {
    const app = appWith('secrets-vault', {
      'config/secrets/prod/prod.list.php': `<?php

return ['APP_SECRET', 'DATABASE_URL'];
`,
      'config/secrets/prod/APP_SECRET.abcdef.php': "<?php\n\nreturn 'encrypted';\n",
      'config/secrets/prod/prod.decrypt.private.php': "<?php\n\nreturn 'key';\n",
      'config/secrets/prod/prod.encrypt.public.php': "<?php\n\nreturn 'key';\n",
      'config/secrets/prod/notes.gpg': 'encrypted notes\n',
    });

    const text = await runModule('secrets-vault.js', app);

    expect(text).toContain('secret');
  });

  test('debug left on outside production, and CSRF switched off', async () => {
    const app = appWith('security-scanner', {
      '.env': 'APP_ENV=dev\nAPP_DEBUG=true\nAPP_SECRET=0123456789abcdef\n',
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
    csrf_protection: false
`,
    });

    const text = await runModule('security-scanner.js', app);

    expect(text).toContain('CSRF');
  });

  test('Sentry sending everything it can see', async () => {
    const app = appWith('sentry-integration', {
      'composer.json': JSON.stringify({ require: { 'sentry/sentry-symfony': '^4.0' } }, null, 4) + '\n',
      'config/packages/sentry.yaml': `sentry:
    dsn: '%env(SENTRY_DSN)%'
    options:
        send_default_pii: true
        traces_sample_rate: 1.0
        max_breadcrumbs: 200
`,
    });

    const text = await runModule('sentry-integration.js', app);

    expect(text).toContain('send_default_pii');
  });

  test('a tagged service locator declared in YAML', async () => {
    const app = appWith('service-locators', {
      'config/services.yaml': `services:
    App\\Export\\ExporterRegistry:
        arguments:
            - !tagged_locator app.exporter

    App\\Export\\CsvExporter:
        tags: ['app.exporter']
`,
      'src/Export/ExporterRegistry.php': `<?php

namespace App\\Export;

use Psr\\Container\\ContainerInterface;

class ExporterRegistry
{
    public function __construct(private ContainerInterface $exporters)
    {
    }
}
`,
    });

    const text = await runModule('service-locators.js', app);

    expect(text).toContain('locator');
  });

  test('a Slack webhook written into the environment and the code', async () => {
    const app = appWith('slack-webhook-integration', {
      '.env': `APP_ENV=prod
SLACK_WEBHOOK_URL=https://hooks.slack.com\x2fservices/T00000000/B00000000/abcdefghijklmnopqrstuvwx
SLACK_BOT_TOKEN=xoxb\x2d123456789-abcdefghij
`,
      'src/Notifier/SlackNotifier.php': `<?php

namespace App\\Notifier;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class SlackNotifier
{
    private const WEBHOOK = 'https://hooks.slack.com\x2fservices/T00000000/B00000000/abcdefghijklmnopqrstuvwx';

    public function __construct(private HttpClientInterface $client)
    {
    }

    public function notify(string $message): void
    {
        $this->client->request('POST', self::WEBHOOK, ['json' => ['text' => $message]]);
    }
}
`,
    });

    const text = await runModule('slack-webhook-integration.js', app);

    expect(text).toContain('webhook');
  });

  test('an access control rule that matches everything', async () => {
    const app = appWith('symfony-access-control', {
      'config/packages/security.yaml': `security:
    access_control:
        - { roles: ROLE_ADMIN }
        - { path: ^/admin, roles: ROLE_ADMIN }
        - { path: ^/, roles: PUBLIC_ACCESS }
`,
    });

    const text = await runModule('symfony-access-control.js', app);

    expect(text).toContain('Rule without path');
  });

  test('templates that preload what they do not need', async () => {
    const app = appWith('symfony-asset-preload-hints', {
      'templates/base.html.twig': `<!DOCTYPE html>
<html>
    <head>
        <link rel="preload" href="{{ asset('build/app.css') }}" as="style">
        <link rel="preload" href="{{ asset('build/hero.jpg') }}" as="image">
        <link rel="prefetch" href="{{ asset('build/admin.js') }}">
        <link rel="preconnect" href="https://fonts.gstatic.com">
    </head>
    <body>{% block body %}{% endblock %}</body>
</html>
`,
      'templates/invoice/show.html.twig': `{% extends 'base.html.twig' %}

{% block body %}<h1>Invoice</h1>{% endblock %}
`,
    });

    const text = await runModule('symfony-asset-preload-hints.js', app);

    expect(text).toContain('preload');
  });

  test('a pruneable cache pool with nothing scheduled to prune it', async () => {
    const app = appWith('symfony-cache-pool-prune', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.filesystem
        pools:
            doctrine.result_cache_pool:
                adapter: cache.adapter.filesystem
            app.session_pool:
                adapter: cache.adapter.doctrine_dbal
`,
      'src/Command/PruneCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;

class PruneCommand extends Command
{
}
`,
    });

    const text = await runModule('symfony-cache-pool-prune.js', app);

    expect(text).toContain('prune');
  });
});

describe('batch 77: cache stampedes, console tables, CSRF, profiler panels and forms', () => {
  test('a pool used with a short TTL and no stampede protection', async () => {
    const app = appWith('symfony-cache-stampede', {
      'config/packages/cache.yaml': `framework:
    cache:
        pools:
            app.rates_pool:
                adapter: cache.adapter.redis
                default_lifetime: 30
`,
      'src/Service/RateProvider.php': `<?php

namespace App\\Service;

use Psr\\Cache\\CacheItemPoolInterface;

class RateProvider
{
    public function __construct(private CacheItemPoolInterface $appRatesPool)
    {
    }

    public function rate(string $currency): float
    {
        $item = $this->appRatesPool->getItem('app.rates_pool.' . $currency);
        $item->expiresAfter(5);

        return 1.0;
    }
}
`,
    });

    const text = await runModule('symfony-cache-stampede.js', app);

    expect(text).toContain('pool');
  });

  test('a console table too wide to read, filled inside a loop', async () => {
    const app = appWith('symfony-console-table', {
      'src/Command/ReportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Helper\\Table;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Output\\OutputInterface;

class ReportCommand extends Command
{
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $table = new Table($output);
        $table->setHeaders(['col0', 'col1', 'col2', 'col3', 'col4', 'col5', 'col6', 'col7', 'col8', 'col9', 'col10', 'col11', 'col12', 'col13', 'col14', 'col15', 'col16', 'col17', 'col18', 'col19', 'col20', 'col21', 'col22', 'col23']);

        foreach (range(1, 5000) as $i) {
            $table->addRow([$i]);
        }

        return Command::SUCCESS;
    }
}
`,
    });

    const text = await runModule('symfony-console-table.js', app);

    expect(text).toContain('columns');
  });

  test('CSRF switched off for the whole application', async () => {
    const app = appWith('symfony-csrf', {
      'config/packages/framework.yaml': `framework:
    csrf_protection:
        enabled: false
    session:
        cookie_lifetime: 0
`,
    });

    const text = await runModule('symfony-csrf.js', app);

    expect(text).toContain('CSRF');
  });

  test('a profiler panel that takes a name Symfony already uses', async () => {
    const app = appWith('symfony-debug-profiler-panels', {
      'src/DataCollector/RequestCollector.php': `<?php

namespace App\\DataCollector;

use Symfony\\Bundle\\FrameworkBundle\\DataCollector\\TemplateAwareDataCollectorInterface;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\DataCollector\\DataCollector;

class RequestCollector extends DataCollector implements TemplateAwareDataCollectorInterface
{
    public function collect(Request $request, Response $response, ?\\Throwable $exception = null): void
    {
        $this->data = [];
    }

    public function getName(): string
    {
        return 'request';
    }

    public static function getTemplate(): string
    {
        return 'data_collector/request';
    }
}
`,
      'templates/data_collector/request.html.twig': `{% extends '@WebProfiler/Profiler/layout.html.twig' %}
`,
    });

    const text = await runModule('symfony-debug-profiler-panels.js', app);

    expect(text).toContain('request');
  });

  test('casters registered globally and never put back', async () => {
    const app = appWith('symfony-debug-var-dumper', {
      'src/Debug/DumpConfigurator.php': `<?php

namespace App\\Debug;

use Symfony\\Component\\VarDumper\\Cloner\\AbstractCloner;
use Symfony\\Component\\VarDumper\\VarDumper;

class DumpConfigurator
{
    public function configure(): void
    {
        AbstractCloner::addCasters([
            'App\\Entity\\Invoice' => static fn (): array => [],
        ]);

        VarDumper::setHandler(static function ($var): void {
        });
    }
}
`,
    });

    const text = await runModule('symfony-debug-var-dumper.js', app);

    expect(text).toContain('addCasters');
  });

  test('a project told to skip every check', async () => {
    const app = appWith('symfony-enlighten-analysis', {
      '.env': 'APP_ENV=prod\nAPP_DEBUG=true\n',
      'config/packages/framework.yaml': `framework:
    secret: '%env(APP_SECRET)%'
    debug: true
`,
      'enlighten.yaml': `skip_checks:
    - all
`,
    });

    const text = await runModule('symfony-enlighten-analysis.js', app);

    expect(text).toContain('APP_DEBUG');
  });

  test('a form with two submit buttons and nothing to tell them apart', async () => {
    const app = appWith('symfony-form-button', {
      'src/Form/InvoiceType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\SubmitType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class InvoiceType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('save', SubmitType::class, ['label' => 'Save'])
            ->add('saveAndSend', SubmitType::class, ['label' => 'Save and send'])
        ;
    }
}
`,
    });

    const text = await runModule('symfony-form-button.js', app);

    expect(text).toContain('isClicked()');
  });

  test('a compound form type built from another type', async () => {
    const app = appWith('symfony-form-compound-types', {
      'src/Form/AddressType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\OptionsResolver\\OptionsResolver;

class AddressType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('street', TextType::class)
            ->add('city', TextType::class)
        ;
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults(['compound' => true]);
    }
}
`,
      'src/Form/CustomerType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class CustomerType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->add('address', AddressType::class);
    }
}
`,
      'src/Form/notes.php': "<?php\n\n// AbstractType and buildForm are described here.\n",
    });

    const text = await runModule('symfony-form-compound-types.js', app);

    expect(text).toContain('AddressType');
  });
});

describe('batch 78: form events and themes, sanitizers, HTTP caches and mailers', () => {
  test('a PRE_SUBMIT listener that flushes, and a subscriber nothing defines', async () => {
    const app = appWith('symfony-form-events', {
      'src/Form/InvoiceType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;
use Symfony\\Component\\Form\\FormEvent;
use Symfony\\Component\\Form\\FormEvents;

class InvoiceType extends AbstractType
{
    public function __construct(private object $entityManager)
    {
    }

    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder->addEventListener(FormEvents::PRE_SUBMIT, function (FormEvent $event): void {
            $this->entityManager->flush();
        });

        $builder->addEventListener(FormEvents::PRE_SUBMIT, function (FormEvent $event): void {
            $event->stopPropagation();
        });

        $builder->addEventSubscriber(new AddCurrencySubscriber());
    }
}
`,
    });

    const text = await runModule('symfony-form-events.js', app);

    expect(text).toContain('PRE_SUBMIT');
  });

  test('a form theme applied in the templates rather than the configuration', async () => {
    const app = appWith('symfony-form-themes', {
      'config/packages/twig.yaml': `twig:
    form_themes:
        - 'bootstrap_5_layout.html.twig'
`,
      'templates/invoice/new.html.twig': `{% form_theme form 'form/custom_layout.html.twig' %}

{{ form(form) }}
`,
      'templates/invoice/edit.html.twig': `{% form_theme form 'form/custom_layout.html.twig' %}

{{ form(form) }}
`,
      'templates/form/custom_layout.html.twig': `{% block form_row %}{{ form_widget(form) }}{% endblock %}
`,
    });

    const text = await runModule('symfony-form-themes.js', app);

    expect(text).toContain('custom_layout');
  });

  test('a sanitizer that allows scripts and event attributes', async () => {
    const app = appWith('symfony-html-sanitizer', {
      'config/packages/html_sanitizer.yaml': `framework:
    html_sanitizer:
        sanitizers:
            app.post_sanitizer:
                allow_safe_elements: true
                allow_all_attributes: true
                allow_elements:
                    script: []
                    iframe: []
                    p: ['class']
                allow_attributes:
                    onclick: ['*']
                    onerror: ['*']
`,
      'src/Service/PostRenderer.php': `<?php

namespace App\\Service;

use Symfony\\Component\\HtmlSanitizer\\HtmlSanitizerInterface;

class PostRenderer
{
    public function __construct(private HtmlSanitizerInterface $appPostSanitizer)
    {
    }

    public function render(string $html): string
    {
        return $this->appPostSanitizer->sanitize($html);
    }
}
`,
    });

    const text = await runModule('symfony-html-sanitizer.js', app);

    expect(text).toContain('allow_all_attributes');
  });

  test('an ETag built straight from an identifier', async () => {
    const app = appWith('symfony-http-cache-validation', {
      'src/Controller/InvoiceController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class InvoiceController
{
    public function show(Request $request, object $invoice): Response
    {
        $response = new Response();
        $response->setEtag($invoice->getId() . $invoice->getUpdatedAt()->getTimestamp());
        $response->setPublic();

        if ($response->isNotModified($request)) {
            return $response;
        }

        return $response;
    }
}
`,
    });

    const text = await runModule('symfony-http-cache-validation.js', app);

    expect(text).toContain('ETag');
  });

  test('an HTTP client using basic auth over plain HTTP', async () => {
    const app = appWith('symfony-http-client-auth', {
      'src/Http/LegacyApiClient.php': `<?php

namespace App\\Http;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class LegacyApiClient
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function fetch(): array
    {
        return $this->client->request('GET', 'http://legacy.acme.internal/api/invoices', [
            'auth_basic' => ['acme', 'hunter2'],
        ])->toArray();
    }
}
`,
      'src/Http/KeyedApiClient.php': `<?php

namespace App\\Http;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class KeyedApiClient
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function fetch(): array
    {
        return $this->client->request('GET', 'https://api.acme.com/invoices', [
            'headers' => ['X-Api-Key' => '%env(ACME_API_KEY)%'],
        ])->toArray();
    }
}
`,
    });

    const text = await runModule('symfony-http-client-auth.js', app);

    expect(text).toContain('Basic auth');
  });

  test('a kernel listener that answers the request and lets the rest run', async () => {
    const app = appWith('symfony-http-middleware', {
      'src/EventSubscriber/MaintenanceSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Event\\RequestEvent;
use Symfony\\Component\\HttpKernel\\KernelEvents;

class MaintenanceSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::REQUEST => ['onMaintenance', 512],
            KernelEvents::RESPONSE => ['onLocale', 10],
        ];
    }

    public function onMaintenance(RequestEvent $event): void
    {
        $event->setResponse(new Response('Down for maintenance', 503));
    }

    public function onLocale(RequestEvent $event): void
    {
        $event->getRequest()->setLocale('en');
    }
}
`,
    });

    const text = await runModule('symfony-http-middleware.js', app);

    expect(text).toContain('stopPropagation');
  });

  test('an email that inlines CSS without the package, and has no text part', async () => {
    const app = appWith('symfony-mailer-inliner', {
      'templates/email/invoice.html.twig': `{% apply inline_css %}
<html>
    <head>
        <style>body { color: black; }</style>
        <link rel="stylesheet" href="http://acme.example.com/email.css">
    </head>
    <body>
        <h1>Your invoice</h1>
    </body>
</html>
{% endapply %}
`,
      'src/Mailer/InvoiceMailer.php': `<?php

namespace App\\Mailer;

use Symfony\\Bridge\\Twig\\Mime\\TemplatedEmail;
use Symfony\\Component\\Mailer\\MailerInterface;

class InvoiceMailer
{
    public function __construct(private MailerInterface $mailer)
    {
    }

    public function send(string $to): void
    {
        $email = (new TemplatedEmail())
            ->to($to)
            ->htmlTemplate('email/invoice.html.twig');

        $this->mailer->send($email);
    }
}
`,
    });

    const text = await runModule('symfony-mailer-inliner.js', app);

    expect(text).toContain('inline_css');
  });

  test('mail sent over SMTP with nothing to queue it', async () => {
    const app = appWith('symfony-mailer-queuing', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'smtp://acme:hunter2@smtp.acme.com:587'
`,
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default'
`,
    });

    const text = await runModule('symfony-mailer-queuing.js', app);

    expect(text).toContain('synchronously');
  });
});

describe('batch 79: mailer transports, maker, messenger, monolog, notifiers and runtime', () => {
  test('a mailer DSN with the password written into it', async () => {
    const app = appWith('symfony-mailer-transport', {
      'config/packages/mailer.yaml': `framework:
    mailer:
        dsn: 'smtp://acme:hunter2@smtp.acme.com:587'
        headers:
            from: 'noreply@acme.example.com'
            bcc: 'audit@acme.example.com'
`,
    });

    const text = await runModule('symfony-mailer-transport.js', app);

    expect(text).toContain('Credentials hardcoded');
  });

  test('maker configuration with generated code beside it', async () => {
    const app = appWith('symfony-maker-config', {
      'config/packages/maker.yaml': `maker:
    root_namespace: 'App'
    generate_final_classes: false
    generate_final_entities: false
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;

class InvoiceRepository extends ServiceEntityRepository
{
}
`,
    });

    const text = await runModule('symfony-maker-config.js', app);

    expect(text).toContain('maker');
  });

  test('an in-memory transport configured outside the test environment', async () => {
    const app = appWith('symfony-messenger-in-memory', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'in-memory://'
`,
      'config/packages/test/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'in-memory://'
`,
      'tests/Unit/MessageTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;
use Symfony\\Component\\Messenger\\Transport\\InMemory\\InMemoryTransport;

class MessageTest extends TestCase
{
    public function testItDispatches(): void
    {
        $transport = new InMemoryTransport();
        $this->assertCount(0, $transport->getSent());
    }
}
`,
    });

    const text = await runModule('symfony-messenger-in-memory.js', app);

    expect(text).toContain('in-memory');
  });

  test('transports that are all the same priority', async () => {
    const app = appWith('symfony-messenger-priority', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default?queue_name=async'
            events: 'doctrine://default?queue_name=events'
        routing:
            'App\\Message\\SendInvoice': async
            'App\\Message\\RebuildIndex': events
`,
    });

    const text = await runModule('symfony-messenger-priority.js', app);

    expect(text).toContain('priority');
  });

  test('a JSON formatter that escapes unicode, and a line formatter with traces', async () => {
    const app = appWith('symfony-monolog-formatter', {
      'config/packages/monolog.yaml': `monolog:
    handlers:
        main:
            type: stream
            path: '%kernel.logs_dir%/%kernel.environment%.log'
            formatter: monolog.formatter.json
`,
      'config/packages/prod/monolog.yaml': "monolog:\n    handlers:\n        main:\n            type: stream\n",
      'src/Logger/Formatters.php': `<?php

namespace App\\Logger;

use Monolog\\Formatter\\JsonFormatter;
use Monolog\\Formatter\\LineFormatter;

class Formatters
{
    public function json(): JsonFormatter
    {
        return new JsonFormatter();
    }

    public function line(): LineFormatter
    {
        $formatter = new LineFormatter(null, new \\DateTimeZone('Europe/Madrid'));
        $formatter->includeStacktraces = true;

        return $formatter;
    }
}
`,
    });

    const text = await runModule('symfony-monolog-formatter.js', app);

    expect(text).toContain('Formatter');
  });

  test('an admin notification with no recipients configured', async () => {
    const app = appWith('symfony-notifier-admin', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            slack: '%env(SLACK_DSN)%'
`,
      'src/Notification/DiskFullNotification.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;
use Symfony\\Component\\Notifier\\Recipient\\RecipientInterface;

class DiskFullNotification extends Notification implements NotificationInterface
{
    public function getChannels(RecipientInterface $recipient): array
    {
        return ['chat'];
    }
}
`,
      'src/Notifier/AdminNotifier.php': `<?php

namespace App\\Notifier;

use Symfony\\Component\\Notifier\\NotifierInterface;

class AdminNotifier
{
    public function __construct(private NotifierInterface $notifier)
    {
    }
}
`,
    });

    const text = await runModule('symfony-notifier-admin.js', app);

    expect(text).toContain('admin');
  });

  test('a custom property extractor that may not be tagged', async () => {
    const app = appWith('symfony-property-info', {
      'src/PropertyInfo/LegacyExtractor.php': `<?php

namespace App\\PropertyInfo;

use Symfony\\Component\\PropertyInfo\\PropertyTypeExtractorInterface;
use Symfony\\Component\\PropertyInfo\\Type;

class LegacyExtractor implements PropertyTypeExtractorInterface
{
    public function getTypes(string $class, string $property, array $context = []): ?array
    {
        return [new Type(Type::BUILTIN_TYPE_STRING)];
    }
}
`,
      'config/services.yaml': `services:
    _defaults:
        autowire: true
`,
    });

    const text = await runModule('symfony-property-info.js', app);

    expect(text).toContain('Extractor');
  });

  test('a runtime configured through the environment', async () => {
    const app = appWith('symfony-runtime-env', {
      'composer.json': JSON.stringify({
        require: { 'symfony/runtime': '^7.0' },
        extra: { 'runtime': { 'class': 'Runtime\\FrankenPhpSymfony\\Runtime' } },
      }, null, 4) + '\n',
      'public/index.php': `<?php

use App\\Kernel;

require_once dirname(__DIR__) . '/vendor/autoload_runtime.php';

return static function (array $context): Kernel {
    return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
};
`,
      '.env': 'APP_ENV=prod\nAPP_DEBUG=0\nAPP_RUNTIME_ENV=prod\n',
    });

    const text = await runModule('symfony-runtime-env.js', app);

    expect(text).toContain('runtime');
  });
});

describe('batch 80: schedulers, security entry points, passports and serializers', () => {
  test('a scheduler transport written inline', async () => {
    const app = appWith('symfony-scheduler-transport-config', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            scheduler_default: 'schedule://default'
            async: 'doctrine://default'
        routing:
            'Symfony\\Component\\Scheduler\\Messenger\\ScheduledStamp': scheduler_default
`,
      'src/Scheduler/MainSchedule.php': `<?php

namespace App\\Scheduler;

use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;
use Symfony\\Component\\Scheduler\\RecurringMessage;
use Symfony\\Component\\Scheduler\\Schedule;
use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;

#[AsSchedule('default')]
class MainSchedule implements ScheduleProviderInterface
{
    public function getSchedule(): Schedule
    {
        return (new Schedule())->add(RecurringMessage::every('1 hour', new SendReports()));
    }
}
`,
    });

    const text = await runModule('symfony-scheduler-transport-config.js', app);

    expect(text).toContain('schedule');
  });

  test('a firewall with two authenticators and no entry point', async () => {
    const app = appWith('symfony-security-entry-point', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            lazy: true
            custom_authenticators:
                - App\\Security\\LoginFormAuthenticator
                - App\\Security\\ApiTokenAuthenticator
`,
      'src/Security/LoginFormAuthenticator.php': `<?php

namespace App\\Security;

use Symfony\\Component\\HttpFoundation\\RedirectResponse;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Security\\Http\\EntryPoint\\AuthenticationEntryPointInterface;

class LoginFormAuthenticator implements AuthenticationEntryPointInterface
{
    public function start(Request $request, ?\\Throwable $authException = null): Response
    {
        return new RedirectResponse('/login');
    }
}
`,
    });

    const text = await runModule('symfony-security-entry-point.js', app);

    expect(text).toContain('entry_point');
  });

  test('impersonation allowed with nothing listening for it', async () => {
    const app = appWith('symfony-security-impersonation', {
      'config/packages/security.yaml': `security:
    role_hierarchy:
        ROLE_ADMIN: [ROLE_USER, ROLE_ALLOWED_TO_SWITCH]

    firewalls:
        main:
            switch_user: true
`,
      'src/Controller/AdminController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Security\\Http\\Attribute\\IsGranted;

class AdminController
{
    #[IsGranted('ROLE_ALLOWED_TO_SWITCH')]
    public function impersonate(): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-security-impersonation.js', app);

    expect(text).toContain('impersonation');
  });

  test('a stateless authenticator carrying a password badge', async () => {
    const app = appWith('symfony-security-passport', {
      'config/packages/security.yaml': `security:
    firewalls:
        api:
            stateless: true
            custom_authenticators:
                - App\\Security\\ApiAuthenticator
`,
      'src/Security/ApiAuthenticator.php': `<?php

namespace App\\Security;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Security\\Http\\Authenticator\\AbstractAuthenticator;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Badge\\PasswordCredentials;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Badge\\UserBadge;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Passport;

class ApiAuthenticator extends AbstractAuthenticator
{
    public function supports(Request $request): ?bool
    {
        return true;
    }

    public function authenticate(Request $request): Passport
    {
        return new Passport(
            new UserBadge((string) $request->headers->get('X-Api-User')),
            new PasswordCredentials((string) $request->headers->get('X-Api-Password')),
        );
    }
}
`,
      'src/Security/Badge/TenantBadge.php': `<?php

namespace App\\Security\\Badge;

use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Badge\\BadgeInterface;

class TenantBadge implements BadgeInterface
{
    public function isResolved(): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-security-passport.js', app);

    expect(text).toContain('PasswordCredentials');
  });

  test('remember-me without a secret of its own', async () => {
    const app = appWith('symfony-security-remember-me', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            remember_me:
                lifetime: 604800
                path: /
                always_remember_me: true
`,
    });

    const text = await runModule('symfony-security-remember-me.js', app);

    expect(text).toContain('remember_me');
  });

  test('entities that point at each other, serialized without a handler', async () => {
    const app = appWith('symfony-serializer-circular-reference', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\Collections\\Collection;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'invoice')]
    private Collection $lines;
}
`,
      'src/Entity/Line.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Line
{
    #[ORM\\ManyToOne(targetEntity: Invoice::class, inversedBy: 'lines')]
    private ?Invoice $invoice = null;
}
`,
      'src/Service/Exporter.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Serializer\\SerializerInterface;

class Exporter
{
    public function __construct(private SerializerInterface $serializer)
    {
    }

    public function export(object $invoice): string
    {
        return $this->serializer->serialize($invoice, 'json');
    }
}
`,
    });

    const text = await runModule('symfony-serializer-circular-reference.js', app);

    expect(text).toContain('circular');
  });

  test('a discriminator map that names a field the class already has', async () => {
    const app = appWith('symfony-serializer-discriminator', {
      'src/Entity/Payment.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Serializer\\Annotation\\DiscriminatorMap;

#[DiscriminatorMap(typeProperty: 'type', mapping: [
    'card' => CardPayment::class,
    'transfer' => TransferPayment::class,
])]
abstract class Payment
{
    protected string $type = '';
}
`,
      'src/Entity/CardPayment.php': `<?php

namespace App\\Entity;

class CardPayment extends Payment
{
}
`,
      'src/Entity/TransferPayment.php': `<?php

namespace App\\Entity;

class TransferPayment extends Payment
{
}
`,
      'src/Entity/CashPayment.php': `<?php

namespace App\\Entity;

class CashPayment extends Payment
{
}
`,
    });

    const text = await runModule('symfony-serializer-discriminator.js', app);

    expect(text).toContain('iscriminator');
  });

  test('a sub-request rendered inside a loop', async () => {
    const app = appWith('symfony-subrequest', {
      'templates/invoice/list.html.twig': `<ul>
    {% for invoice in invoices %}
        <li>{{ render(controller('App\\\\Controller\\\\InvoiceController::row', { id: invoice.id })) }}</li>
    {% endfor %}
</ul>
`,
      'src/Controller/InvoiceController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class InvoiceController
{
    public function row(int $id): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('symfony-subrequest.js', app);

    expect(text).toContain('sub-request');
  });
});

describe('batch 81: translations, Twig embeds and icons, Stimulus and validator payloads', () => {
  test('plural messages in several forms, more than the report prints', async () => {
    const app = appWith('symfony-translation-plurals', {
      'translations/messages.en.yaml': `# The plural forms of the invoice messages.
invoice.count.0: 'There is one invoice|There are %count% invoices'
invoice.count.1: 'There is one invoice|There are %count% invoices'
invoice.count.2: 'There is one invoice|There are %count% invoices'
invoice.count.3: 'There is one invoice|There are %count% invoices'
invoice.count.4: 'There is one invoice|There are %count% invoices'
invoice.count.5: 'There is one invoice|There are %count% invoices'
invoice.count.6: 'There is one invoice|There are %count% invoices'
invoice.count.7: 'There is one invoice|There are %count% invoices'
invoice.legacy: '{0} No invoices|{1} One invoice|]1,Inf[ %count% invoices'
invoice.broken: 'One invoice|'
`,
      'translations/messages.fr.yaml': `invoice.count.0: 'Il y a une facture'
`,
    });

    const text = await runModule('symfony-translation-plurals.js', app, ['invoice']);

    expect(text).toContain('invoice');
  });

  test('a translation file that does not parse', async () => {
    const app = appWith('symfony-translation-yaml-lint', {
      'translations/messages.en.yaml': `home.title: 'Welcome'
home.subtitle: 'A subtitle'
home.title: 'Welcome again'
home.body: ''
`,
      'translations/messages.fr.yaml': "home.title: 'Bienvenue'\n",
    });

    const text = await runModule('symfony-translation-yaml-lint.js', app);

    expect(text).toContain('DUPLICATE-KEY');
  });

  test('an embed whose template comes from the request', async () => {
    const app = appWith('symfony-twig-embed', {
      'templates/page/show.html.twig': `{% embed app.request.get('template') %}
    {% block content %}{{ body }}{% endblock %}
{% endembed %}

{% embed '../legacy/sidebar.html.twig' %}
    {% block content %}{{ sidebar }}{% endblock %}
{% endembed %}

{% embed 'partials/footer.html.twig' %}
    {% block content %}{{ footer }}{% endblock %}
{% endembed %}
`,
    });

    const text = await runModule('symfony-twig-embed.js', app);

    expect(text).toContain('embed');
  });

  test('icons rendered every way, one of them inside a loop', async () => {
    const app = appWith('symfony-twig-ux-icons', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-icons': '^2.0' } }, null, 4) + '\n',
      'config/packages/ux_icons.yaml': `ux_icons:
    icon_dir: '%kernel.project_dir%/assets/icons'
    icon_sets:
        tabler:
            alias: tb
`,
      'templates/invoice/list.html.twig': `<h1>{{ ux_icon('tabler:file-invoice') }}</h1>

<twig:UX:Icon name="tabler:download" />

{% component 'ux:icon' with {name: 'tabler:printer'} %}{% endcomponent %}

{% for invoice in invoices %}
    {{ ux_icon('tabler:file') }}
{% endfor %}
`,
    });

    const text = await runModule('symfony-twig-ux-icons.js', app);

    expect(text).toContain('icon');
  });

  test('browser notifications without Mercure behind them', async () => {
    const app = appWith('symfony-ux-notify', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-notify': '^2.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\n',
      'src/Notification/DeployFinished.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;
use Symfony\\Component\\Notifier\\Recipient\\RecipientInterface;

class DeployFinished extends Notification implements NotificationInterface
{
    public function getChannels(RecipientInterface $recipient): array
    {
        return ['browser'];
    }
}
`,
    });

    const text = await runModule('symfony-ux-notify.js', app);

    expect(text).toContain('Mercure');
  });

  test('a Stimulus controller that listens and never stops', async () => {
    const app = appWith('symfony-ux-stimulus-controllers', {
      'assets/controllers/dropdown_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    connect() {
        document.addEventListener('click', this.onClick.bind(this));
    }

    onClick(event) {
        this.element.classList.toggle('open');
    }
}
`,
      'assets/controllers.json': '{"controllers":{}}\n',
    });

    const text = await runModule('symfony-ux-stimulus-controllers.js', app);

    expect(text).toContain('dropdown');
  });

  test('Stimulus values declared and used', async () => {
    const app = appWith('symfony-ux-stimulus-values', {
      'assets/controllers/chart_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    static values = { url: String, refresh: Number, live: Boolean };

    connect() {
        fetch(this.urlValue).then(() => this.refreshValue);
    }

    disconnect() {
    }
}
`,
      'templates/invoice/chart.html.twig': `<div {{ stimulus_controller('chart', { url: path('api_invoices'), refresh: 30 }) }}></div>
`,
    });

    const text = await runModule('symfony-ux-stimulus-values.js', app);

    expect(text).toContain('chart');
  });

  test('a constraint whose payload nothing reads', async () => {
    const app = appWith('symfony-validator-payload', {
      'src/Validator/Iban.php': `<?php

namespace App\\Validator;

use Symfony\\Component\\Validator\\Constraint;

class Iban extends Constraint
{
    public string $message = 'This is not a valid IBAN.';

    public $payload;

    public function __construct(?array $options = null)
    {
        parent::__construct($options);
    }
}
`,
      'src/Validator/IbanValidator.php': `<?php

namespace App\\Validator;

use Symfony\\Component\\Validator\\Constraint;
use Symfony\\Component\\Validator\\ConstraintValidator;

class IbanValidator extends ConstraintValidator
{
    public function validate(mixed $value, Constraint $constraint): void
    {
        $payload = $constraint->payload;

        $this->context->buildViolation($constraint->message)->addViolation();
    }
}
`,
    });

    const text = await runModule('symfony-validator-payload.js', app);

    expect(text).toContain('payload');
  });
});

describe('batch 82: XLIFF, Twig globals and namespaces, webhooks, Alpine and Apache', () => {
  test('an XLIFF 1.2 file with no state and no resname', async () => {
    const app = appWith('translation-xliff-format', {
      'translations/messages.en.xlf': `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">
    <file source-language="en" datatype="plaintext" original="file.ext">
        <body>
            <trans-unit id="1">
                <source>home.title</source>
                <target>Welcome</target>
            </trans-unit>
        </body>
    </file>
</xliff>
`,
      'translations/messages.fr.xlf': `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="fr">
    <file id="messages">
        <unit id="home.title">
            <notes><note>The page title</note></notes>
            <segment state="translated">
                <source>Welcome</source>
                <target>Bienvenue</target>
            </segment>
        </unit>
    </file>
</xliff>
`,
    });

    const text = await runModule('translation-xliff-format.js', app);

    expect(text).toContain('resname');
  });

  test('a Twig global that injects a service, and one that shadows app', async () => {
    const app = appWith('twig-globals', {
      'config/packages/twig.yaml': `twig:
    globals:
        app_config: '@App\\Service\\AppConfig'
        app: '@App\\Service\\AppVariable'
        api_token: '%env(ACME_API_TOKEN)%'
        site_name: 'Acme'
`,
      'src/Twig/GlobalsExtension.php': `<?php

namespace App\\Twig;

use Twig\\Extension\\AbstractExtension;
use Twig\\Extension\\GlobalsInterface;

class GlobalsExtension extends AbstractExtension implements GlobalsInterface
{
    public function getGlobals(): array
    {
        return [
            'site_name' => 'Acme',
            'api_token' => 'abcdef1234567890',
        ];
    }
}
`,
    });

    const text = await runModule('twig-globals.js', app);

    expect(text).toContain('site_name');
  });

  test('a Twig namespace pointing at several directories', async () => {
    const app = appWith('twig-namespace-paths', {
      'config/packages/twig.yaml': `twig:
    default_path: '%kernel.project_dir%/templates'
    paths:
        '%kernel.project_dir%/templates/email': email
        '%kernel.project_dir%/templates/admin': admin
        '%kernel.project_dir%/templates/legacy/admin': admin
        '%kernel.project_dir%/templates/shared/admin': admin
        '%kernel.project_dir%/vendor/acme/bundle/templates': admin
`,
      'templates/email/invoice.html.twig': '<h1>Invoice</h1>\n',
      'templates/admin/index.html.twig': '<h1>Admin</h1>\n',
    });

    const text = await runModule('twig-namespace-paths.js', app);

    expect(text).toContain('admin');
  });

  test('webhook routing with a parser and a secret', async () => {
    const app = appWith('webhooks', {
      'config/packages/webhook.yaml': `framework:
    webhook:
        routing:
            stripe:
                service: 'stripe.webhook.request_parser'
                secret: '%env(STRIPE_WEBHOOK_SECRET)%'
            mailer_mailgun:
                service: 'mailer.webhook.request_parser.mailgun'
                secret: '%env(MAILGUN_WEBHOOK_SECRET)%'
            broken: ~
`,
      'src/Webhook/StripeWebhookHandler.php': `<?php

namespace App\\Webhook;

use Symfony\\Component\\RemoteEvent\\Attribute\\AsRemoteEventConsumer;
use Symfony\\Component\\RemoteEvent\\Consumer\\ConsumerInterface;
use Symfony\\Component\\RemoteEvent\\RemoteEvent;

#[AsRemoteEventConsumer('stripe')]
class StripeWebhookHandler implements ConsumerInterface
{
    public function consume(RemoteEvent $event): void
    {
    }
}
`,
    });

    const text = await runModule('webhooks.js', app);

    expect(text).toContain('stripe');
  });

  test('Alpine bound to a password field, with Twig inside x-data', async () => {
    const app = appWith('alpine-js-integration', {
      'package.json': JSON.stringify({ dependencies: { alpinejs: '^3.0' } }, null, 4) + '\n',
      'templates/security/login.html.twig': `<div x-data="{ user: '{{ app.user.email }}', show: false }">
    <input type="password" x-model="password" name="password">
    <button @click="show = !show">Show</button>
</div>
`,
      'config/packages/nelmio_security.yaml': `nelmio_security:
    csp:
        enabled: true
        script-src:
            - 'self'
            - 'unsafe-eval'
`,
    });

    const text = await runModule('alpine-js-integration.js', app);

    expect(text).toContain('unsafe-eval');
  });

  test('an Apache virtual host for the public directory', async () => {
    const app = appWith('apache-config', {
      'docker/apache/000-default.conf': `<VirtualHost *:80>
    ServerName acme.example.com
    DocumentRoot /var/www/public

    <Directory /var/www/public>
        AllowOverride All
        Require all granted
        Options Indexes FollowSymLinks
    </Directory>

    ErrorLog \${APACHE_LOG_DIR}/error.log
</VirtualHost>
`,
      '.htaccess': `RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^(.*)$ index.php [QSA,L]
`,
    });

    const text = await runModule('apache-config.js', app);

    expect(text).toContain('Apache');
  });
});

describe('batch 83: API Platform contexts, Behat configuration, Braintree and cache pools', () => {
  test('a JSON-LD context that points at schema.org over plain HTTP', async () => {
    const app = appWith('api-json-ld-context', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiProperty;
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource(types: ['http://schema.org/Invoice'])]
class Invoice
{
    #[ApiProperty(iris: ['http://schema.org/identifier'])]
    private string $number = '';

    #[ApiProperty(iris: ['https://schema.org/totalPaymentDue'])]
    private int $total = 0;
}
`,
    });

    const text = await runModule('api-json-ld-context.js', app);

    expect(text).toContain('schema.org');
  });

  test('an API with its own error normalizer', async () => {
    const app = appWith('api-platform-error-handling', {
      'config/packages/api_platform.yaml': `api_platform:
    title: Acme
    exception_to_status:
        Symfony\\Component\\Serializer\\Exception\\ExceptionInterface: 400
        App\\Exception\\NotFoundException: 404
`,
      'src/Serializer/ErrorNormalizer.php': `<?php

namespace App\\Serializer;

use Symfony\\Component\\Serializer\\Normalizer\\NormalizerInterface;

class ErrorNormalizer implements NormalizerInterface
{
    public function normalize(mixed $object, ?string $format = null, array $context = []): array
    {
        return ['error' => 'something went wrong'];
    }

    public function supportsNormalization(mixed $data, ?string $format = null, array $context = []): bool
    {
        return $data instanceof \\Throwable;
    }
}
`,
    });

    const text = await runModule('api-platform-error-handling.js', app);

    expect(text).toContain('ormalizer');
  });

  test('a POST protected without checking the object after denormalization', async () => {
    const app = appWith('api-platform-security-post', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;
use ApiPlatform\\Metadata\\Get;
use ApiPlatform\\Metadata\\Post;

#[ApiResource(operations: [
    new Get(security: "is_granted('ROLE_USER')"),
    new Post(security: "is_granted('ROLE_USER')"),
])]
class Invoice
{
    private int $id = 0;
}
`,
    });

    const text = await runModule('api-platform-security.js', app);

    expect(text).toContain('securityPostDenormalize');
  });

  test('a resource normalized without groups on the properties', async () => {
    const app = appWith('api-platform-serialization-context', {
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource(
    normalizationContext: ['groups' => ['customer:read']],
    denormalizationContext: ['groups' => ['customer:write']],
)]
class Customer
{
    private int $id = 0;

    private string $name = '';
}
`,
    });

    const text = await runModule('api-platform-serialization-context.js', app);

    expect(text).toContain('normalizationContext');
  });

  test('Behat suites that point outside the application', async () => {
    const app = appWith('behat-config', {
      'behat.yaml': `default:
    suites:
        default:
            paths: ['%paths.base%/features']
            contexts:
                - App\\Tests\\Behat\\FeatureContext
        legacy:
            paths: ['/var/legacy/features']
            contexts:
                - App\\Tests\\Behat\\LegacyContext

    extensions:
        Behat\\MinkExtension:
            base_url: 'http://localhost:8000'
`,
      'features/home.feature': `Feature: Home

    @smoke
    Scenario: The home page
        Given I am on the home page
`,
      'tests/Behat/FeatureContext.php': `<?php

namespace App\\Tests\\Behat;

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
    /**
     * @Given I am on the home page
     */
    public function home(): void
    {
    }
}
`,
    });

    const text = await runModule('behat-config.js', app);

    expect(text).toContain('default');
  });

  test('Behat contexts, one of them shared between suites', async () => {
    const app = appWith('behat-contexts', {
      'behat.yaml': `default:
    suites:
        default:
            contexts:
                - App\\Tests\\Behat\\FeatureContext
                - App\\Tests\\Behat\\ApiContext
        api:
            contexts:
                - App\\Tests\\Behat\\ApiContext
`,
      'tests/Behat/FeatureContext.php': `<?php

namespace App\\Tests\\Behat;

use Behat\\Behat\\Context\\Context;

class FeatureContext implements Context
{
    /**
     * @Given I am on the home page
     */
    public function home(): void
    {
    }
}
`,
      'tests/Behat/ApiContext.php': `<?php

namespace App\\Tests\\Behat;

use Behat\\Behat\\Context\\Context;

class ApiContext implements Context
{
    /**
     * @When I request :path
     */
    public function request(string $path): void
    {
    }
}
`,
    });

    const text = await runModule('behat-contexts.js', app);

    expect(text).toContain('Context');
  });

  test('Braintree left in its sandbox', async () => {
    const app = appWith('braintree-integration', {
      'composer.json': JSON.stringify({ require: { 'braintree/braintree_php': '^6.0' } }, null, 4) + '\n',
      '.env': `APP_ENV=prod
BRAINTREE_ENVIRONMENT=sandbox
BRAINTREE_MERCHANT_ID=abcdefghijklmnop
BRAINTREE_PRIVATE_KEY=0123456789abcdef0123456789abcdef
`,
      'src/Payment/BraintreeGateway.php': `<?php

namespace App\\Payment;

use Braintree\\Gateway;

class BraintreeGateway
{
    public function gateway(): Gateway
    {
        return new Gateway([
            'environment' => 'sandbox',
            'merchantId' => $_ENV['BRAINTREE_MERCHANT_ID'],
            'privateKey' => $_ENV['BRAINTREE_PRIVATE_KEY'],
        ]);
    }
}
`,
    });

    const text = await runModule('braintree-integration.js', app);

    expect(text).toContain('sandbox');
  });

  test('cache pools with a prefix seed', async () => {
    const app = appWith('cache-pools', {
      'config/packages/cache.yaml': `framework:
    cache:
        prefix_seed: acme/prod
        app: cache.adapter.redis
        default_redis_provider: 'redis://redis:6379'
        pools:
            app.invoice_pool:
                adapter: cache.app
                default_lifetime: 3600
            app.session_pool:
                adapter: cache.adapter.redis
`,
    });

    const text = await runModule('cache-pools.js', app);

    expect(text).toContain('Prefix seed');
  });
});

describe('batch 84: CDN, controllers, CORS, Docker health and Doctrine operations', () => {
  test('a CDN served over plain HTTP, with CORS open to everyone', async () => {
    const app = appWith('cdn-config', {
      'config/packages/framework.yaml': `framework:
    assets:
        base_urls:
            - 'http://cdn.acme.example.com'
`,
      'config/packages/nelmio_cors.yaml': `nelmio_cors:
    defaults:
        allow_origin: ['*']
        allow_methods: ['GET', 'POST']
        allow_headers: ['*']
`,
    });

    const text = await runModule('cdn-config.js', app);

    expect(text).toContain('HTTP');
  });

  test('a controller with a class-level grant and unguarded actions', async () => {
    const app = appWith('controller-security', {
      'src/Controller/AdminController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;
use Symfony\\Component\\Security\\Http\\Attribute\\IsGranted;

#[IsGranted('ROLE_ADMIN')]
class AdminController extends AbstractController
{
    public function __construct(private object $repository)
    {
    }

    #[Route('/admin/invoices', name: 'admin_invoices')]
    public function invoices(): Response
    {
        return new Response('');
    }

    #[Route('/admin/settings', name: 'admin_settings')]
    #[IsGranted('ROLE_SUPER_ADMIN')]
    public function settings(): Response
    {
        return new Response('');
    }
}
`,
      'config/packages/security.yaml': `security:
    access_control:
        - { path: ^/admin, roles: ROLE_ADMIN }
        - ~
`,
    });

    const text = await runModule('controller-security.js', app);

    expect(text).toContain('ROLE_ADMIN');
  });

  test('CORS configured tightly enough to have nothing to report', async () => {
    const app = appWith('cors-clean', {
      'config/packages/nelmio_cors.yaml': `nelmio_cors:
    defaults:
        allow_credentials: false
        allow_origin: ['https://acme.example.com']
        allow_methods: ['GET', 'POST']
        allow_headers: ['Content-Type']
        max_age: 3600
    paths:
        '^/api/':
            origin_regex: true
            allow_origin: ['^https://.*\\.acme\\.example\\.com$']
            allow_methods: ['GET']
            allow_headers: ['Content-Type']
`,
    });

    const text = await runModule('cors.js', app);

    expect(text).toContain('origin_regex');
  });

  test('a DigitalOcean worker beside the web service', async () => {
    const app = appWith('digitalocean-app-platform', {
      '.do/app.yaml': `name: acme
region: fra

services:
    - name: web
      environment_slug: php
      http_port: 8080
      instance_count: 1
      instance_size_slug: basic-xxs

workers:
    - name: messenger
      environment_slug: php
      run_command: php bin/console messenger:consume async
`,
    });

    const text = await runModule('digitalocean-app-platform.js', app);

    expect(text).toContain('worker');
  });

  test('compose services that start before the database is ready', async () => {
    const app = appWith('docker-compose-health-depends', {
      'docker-compose.yml': `services:
    php:
        image: acme/php:8.3
        depends_on:
            - database
    database:
        image: postgres:16
        environment:
            POSTGRES_PASSWORD: hunter2
`,
    });

    const text = await runModule('docker-compose-health.js', app);

    expect(text).toContain('healthcheck');
  });

  test('inserts in a loop with nothing wrapping them', async () => {
    const app = appWith('doctrine-bulk-operations', {
      'src/Import/Importer.php': `<?php

namespace App\\Import;

use Doctrine\\DBAL\\Connection;
use Doctrine\\ORM\\EntityManagerInterface;

class Importer
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
    ) {
    }

    public function importEntities(array $rows): void
    {
        foreach ($rows as $row) {
            $this->entityManager->persist($row);
            $this->entityManager->flush();
            $this->entityManager->clear();
        }
    }

    public function importRows(array $rows): void
    {
        foreach ($rows as $row) {
            $this->connection->insert('invoice', $row);
        }
    }
}
`,
    });

    const text = await runModule('doctrine-bulk-operations.js', app);

    expect(text).toContain('loop');
  });

  test('a Criteria filter that scans the table', async () => {
    const app = appWith('doctrine-criteria-api', {
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\Common\\Collections\\Criteria;
use Doctrine\\Bundle\\DoctrineBundle\\Repository\\ServiceEntityRepository;

class InvoiceRepository extends ServiceEntityRepository
{
    public function search(string $term): array
    {
        $criteria = Criteria::create()
            ->where(Criteria::expr()->contains('number', $term))
            ->orderBy(['issuedAt' => Criteria::DESC]);

        return $this->matching($criteria)->toArray();
    }
}
`,
    });

    const text = await runModule('doctrine-criteria-api.js', app);

    expect(text).toContain('Criteria');
  });

  test('an encryption key in .env and an index on the encrypted column', async () => {
    const app = appWith('doctrine-encryption', {
      '.env': 'APP_ENV=prod\nDATABASE_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef\n',
      'src/Entity/Patient.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Index(name: 'idx_patient_ssn', columns: ['ssn'])]
class Patient
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column(type: 'encrypted_string')]
    private string $ssn = '';
}
`,
    });

    const text = await runModule('doctrine-encryption.js', app);

    expect(text).toContain('ncryption');
  });

  test('a sluggable entity whose slug is not unique', async () => {
    const app = appWith('doctrine-gedmo-sluggable', {
      'src/Entity/Article.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Mapping\\Annotation as Gedmo;

#[ORM\\Entity]
class Article
{
    #[ORM\\Column]
    private string $title = '';

    #[Gedmo\\Slug(fields: ['title'], unique: false)]
    #[ORM\\Column(length: 128)]
    private string $slug = '';
}
`,
      'src/Entity/Page.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 */
class Page
{
    /**
     * @Gedmo\\Slug(fields={"title"}, unique=false)
     * @ORM\\Column(length=128)
     */
    private $slug;
}
`,
    });

    const text = await runModule('doctrine-gedmo-sluggable.js', app);

    expect(text).toContain('slug');
  });
});

describe('batch 85: Doctrine mapping and dialects, EasyAdmin, Elasticsearch, archives and forms', () => {
  test('an entity manager mapped in XML and attributes at once', async () => {
    const app = appWith('doctrine-mapping-format', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        entity_managers:
            default:
                mappings:
                    App:
                        type: attribute
                        dir: '%kernel.project_dir%/src/Entity'
                        prefix: 'App\\Entity'
                    Legacy:
                        type: xml
                        dir: '%kernel.project_dir%/config/doctrine'
                        prefix: 'App\\Legacy'
`,
      'config/doctrine/Legacy.Invoice.orm.xml': `<?xml version="1.0" encoding="UTF-8"?>
<doctrine-mapping>
    <entity name="App\\Legacy\\Invoice" table="legacy_invoice">
        <id name="id" type="integer"/>
    </entity>
</doctrine-mapping>
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-mapping-format.js', app);

    expect(text).toContain('apping');
  });

  test('a MySQL schema still on the three-byte charset', async () => {
    const app = appWith('doctrine-mysql-specific', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
        driver: pdo_mysql
        charset: utf8
        default_table_options:
            charset: utf8
            collate: utf8_unicode_ci
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\Table(options: ['charset' => 'utf8', 'collate' => 'utf8_unicode_ci'])]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-mysql-specific.js', app);

    expect(text).toContain('utf8');
  });

  test('a query cache pointed at a service of its own', async () => {
    const app = appWith('doctrine-query-cache', {
      'config/packages/doctrine.yaml': `doctrine:
    orm:
        query_cache_driver:
            id: app.doctrine.query_cache
        result_cache_driver:
            type: pool
            pool: doctrine.result_cache_pool
`,
    });

    const text = await runModule('doctrine-query-cache.js', app);

    expect(text).toContain('cache');
  });

  test('an entity with validity columns and nothing to check them', async () => {
    const app = appWith('doctrine-temporal-tables', {
      'src/Entity/Price.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Price
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column(type: 'datetime_immutable')]
    private \\DateTimeImmutable $validFrom;

    #[ORM\\Column(type: 'datetime_immutable', nullable: true)]
    private ?\\DateTimeImmutable $validTo = null;

    #[ORM\\Column(type: 'datetime_immutable')]
    private \\DateTimeImmutable $systemFrom;
}
`,
    });

    const text = await runModule('doctrine-temporal-tables.js', app);

    expect(text).toContain('valid_from');
  });

  test('an EasyAdmin CRUD controller with fields of its own', async () => {
    const app = appWith('easyadmin', {
      'composer.json': JSON.stringify({ require: { 'easycorp/easyadmin-bundle': '^4.0' } }, null, 4) + '\n',
      'src/Controller/Admin/InvoiceCrudController.php': `<?php

namespace App\\Controller\\Admin;

use App\\Entity\\Invoice;
use EasyCorp\\Bundle\\EasyAdminBundle\\Controller\\AbstractCrudController;
use EasyCorp\\Bundle\\EasyAdminBundle\\Field\\IdField;
use EasyCorp\\Bundle\\EasyAdminBundle\\Field\\MoneyField;

class InvoiceCrudController extends AbstractCrudController
{
    public static function getEntityFqcn(): string
    {
        return Invoice::class;
    }

    public function configureFields(string $pageName): iterable
    {
        return [
            IdField::new('id'),
            MoneyField::new('total')->setCurrency('EUR'),
        ];
    }
}
`,
      'src/Controller/Admin/DashboardController.php': `<?php

namespace App\\Controller\\Admin;

use EasyCorp\\Bundle\\EasyAdminBundle\\Controller\\AbstractDashboardController;
use EasyCorp\\Bundle\\EasyAdminBundle\\Config\\Dashboard;

class DashboardController extends AbstractDashboardController
{
    public function configureDashboard(): Dashboard
    {
        return Dashboard::new()->setTitle('Acme');
    }
}
`,
    });

    const text = await runModule('easyadmin.js', app);

    expect(text).toContain('InvoiceCrudController');
  });

  test('an Elasticsearch mapping with the source switched off', async () => {
    const app = appWith('elasticsearch-mapping-config', {
      '.env': 'APP_ENV=prod\nELASTICSEARCH_URL=http://elastic.acme.internal:9200\n',
      'config/elasticsearch/invoice.json': JSON.stringify({
        mappings: {
          _source: { enabled: false },
          properties: {
            number: { type: 'keyword' },
            total: { type: 'integer' },
          },
        },
      }, null, 4) + '\n',
    });

    const text = await runModule('elasticsearch-mapping-config.js', app);

    expect(text).toContain('_source');
  });

  test('an entity with neither relations nor indexes', async () => {
    const app = appWith('entities-bare', {
      'src/Entity/Setting.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Setting
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column]
    private string $name = '';
}
`,
    });

    const text = await runModule('entities.js', app, ['Setting']);

    expect(text).toContain('Setting');
  });

  test('a zip extracted wherever its entries point', async () => {
    const app = appWith('file-archive', {
      'src/Import/ArchiveImporter.php': `<?php

namespace App\\Import;

class ArchiveImporter
{
    public function import(string $path, string $target): void
    {
        $zip = new \\ZipArchive();
        $zip->open($path);
        $zip->extractTo($target);

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            file_put_contents($target . '/' . $name, $zip->getFromIndex($i));
        }

        $zip->close();
    }
}
`,
    });

    const text = await runModule('file-archive.js', app);

    expect(text).toContain('extractTo');
  });

  test('a fixture with a dependency and a group', async () => {
    const app = appWith('fixtures-basic', {
      'src/DataFixtures/AppFixtures.php': `<?php

namespace App\\DataFixtures;

use Doctrine\\Bundle\\FixturesBundle\\Fixture;
use Doctrine\\Persistence\\ObjectManager;

class AppFixtures extends Fixture
{
    public function load(ObjectManager $manager): void
    {
        $manager->flush();
    }
}
`,
      'src/DataFixtures/notes.php': "<?php\n\n// The fixtures for the application live here.\n",
    });

    const text = await runModule('fixtures.js', app, ['AppFixtures']);

    expect(text).toContain('AppFixtures');
  });

  test('a form type whose fields cannot be read statically', async () => {
    const app = appWith('forms-dynamic', {
      'src/Form/DynamicType.php': `<?php

namespace App\\Form;

use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\FormBuilderInterface;

class DynamicType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        foreach ($options['fields'] as $field) {
            $builder->add(...$field);
        }
    }

    public function getParent(): string
    {
        return BaseType::class;
    }
}
`,
    });

    const text = await runModule('forms.js', app, ['DynamicType']);

    expect(text).toContain('DynamicType');
  });
});

describe('batch 86: GitLab, Cloud Run, storage, gRPC, Heroku, Intercom, logs and SSO', () => {
  test('a GitLab pipeline with a deployment stage', async () => {
    const app = appWith('gitlab-ci-config', {
      '.gitlab-ci.yml': `stages:
    - test
    - deploy

variables:
    DATABASE_URL: 'postgresql://acme:hunter2@postgres:5432/acme'

test:
    stage: test
    image: php:8.3
    services:
        - postgres:16
    script:
        - composer install
        - vendor/bin/phpunit

deploy:
    stage: deploy
    when: manual
    script:
        - ./deploy.sh
`,
    });

    const text = await runModule('gitlab-ci-config.js', app);

    expect(text).toContain('Deploy stage');
  });

  test('a project with no GitLab CI in it', async () => {
    const app = appWith('gitlab-ci-absent', {});

    const text = await runModule('gitlab-ci-config.js', app);

    expect(text).toContain('No GitLab CI configured');
  });

  test('a Cloud Run service with memory in gigabytes', async () => {
    const app = appWith('google-cloud-run-config', {
      'service.yaml': `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
    name: acme
spec:
    template:
        spec:
            containerConcurrency: 80
            containers:
                - image: gcr.io/acme/app
                  resources:
                      limits:
                          memory: 2Gi
                          cpu: '1'
`,
      'cloudbuild.yaml': `steps:
    - name: gcr.io/cloud-builders/docker
      args: ['build', '-t', 'gcr.io/acme/app', '.']
`,
    });

    const text = await runModule('google-cloud-run-config.js', app);

    expect(text).toContain('Cloud Run');
  });

  test('a storage bucket reached with a key file', async () => {
    const app = appWith('google-cloud-storage', {
      'composer.json': JSON.stringify({ require: { 'google/cloud-storage': '^1.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nGOOGLE_APPLICATION_CREDENTIALS=config/gcp/service-account.json\nGCS_BUCKET=acme-uploads\n',
      'src/Storage/GcsUploader.php': `<?php

namespace App\\Storage;

use Google\\Cloud\\Storage\\StorageClient;

class GcsUploader
{
    public function upload(string $path): void
    {
        $storage = new StorageClient(['keyFilePath' => 'config/gcp/service-account.json']);
        $bucket = $storage->bucket('acme-uploads');
        $bucket->upload(fopen($path, 'r'), ['predefinedAcl' => 'publicRead']);
    }
}
`,
    });

    const text = await runModule('google-cloud-storage.js', app);

    expect(text).toContain('cloud-storage');
  });

  test('a proto file still on proto2, with camelCase fields', async () => {
    const app = appWith('grpc-integration', {
      'proto/invoice.proto': `syntax = "proto2";

package acme;

message Invoice {
    required int32 id = 1;
    optional string invoiceNumber = 2;
    optional int64 totalAmount = 3;
}

service InvoiceService {
    rpc GetInvoice (Invoice) returns (Invoice);
}
`,
    });

    const text = await runModule('grpc-integration.js', app);

    expect(text).toContain('proto3');
  });

  test('a Heroku app with an addon and no plan', async () => {
    const app = appWith('heroku-config', {
      'Procfile': `web: heroku-php-apache2 public/
worker: php bin/console messenger:consume async
`,
      'app.json': JSON.stringify({
        name: 'acme',
        addons: [{ plan: 'heroku-postgresql:standard-0' }, 'papertrail'],
        env: { APP_ENV: { value: 'prod' } },
      }, null, 4) + '\n',
    });

    const text = await runModule('heroku-config.js', app);

    expect(text).toContain('web');
  });

  test('an Intercom token referenced from the code', async () => {
    const app = appWith('intercom-integration', {
      'composer.json': JSON.stringify({ require: { 'intercom/intercom-php': '^4.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nINTERCOM_ACCESS_TOKEN=dG9rOmFiY2RlZmdoaWprbG1ub3A=\n',
      'src/Crm/IntercomClient.php': `<?php

namespace App\\Crm;

use Intercom\\IntercomClient as Client;

class IntercomClient
{
    public function client(): Client
    {
        return new Client($_ENV['INTERCOM_ACCESS_TOKEN'], null);
    }
}
`,
    });

    const text = await runModule('intercom-integration.js', app);

    expect(text).toContain('INTERCOM');
  });

  test('log files read from the var directory', async () => {
    const app = appWith('logs-files', {
      'var/log/prod.log': `[2026-01-01T09:00:00.000000+00:00] request.INFO: Matched route "home". [] []
[2026-01-01T09:00:01.000000+00:00] php.CRITICAL: Uncaught Exception: nope {"exception":"[object] (RuntimeException)"} []
[2026-01-01T09:00:02.000000+00:00] doctrine.DEBUG: SELECT * FROM invoice [] []
`,
      'var/log/dev.log': `[2026-01-01T09:00:00.000000+00:00] app.WARNING: Slow query [] []
`,
    });

    const text = await runModule('logs.js', app, ['prod']);

    expect(text).toContain('log');
  });

  test('a New Relic agent switched off in production', async () => {
    const app = appWith('newrelic-php-agent', {
      'docker/php/newrelic.ini': `[newrelic]
newrelic.enabled = false
newrelic.appname = "Acme (prod)"
newrelic.license = "0123456789abcdef0123456789abcdef01234567"
newrelic.distributed_tracing_enabled = false
`,
    });

    const text = await runModule('newrelic-php-agent.js', app);

    expect(text).toContain('newrelic');
  });

  test('an OAuth client redirected over plain HTTP', async () => {
    const app = appWith('oauth-sso', {
      'composer.json': JSON.stringify({ require: { 'knpuniversity/oauth2-client-bundle': '^2.0' } }, null, 4) + '\n',
      'config/packages/knpu_oauth2_client.yaml': `knpu_oauth2_client:
    clients:
        keycloak:
            type: keycloak
            client_id: '%env(KEYCLOAK_ID)%'
            client_secret: '%env(KEYCLOAK_SECRET)%'
            redirect_uri: 'http://acme.example.com/connect/keycloak/check'
            scope: ['openid', 'profile', 'email']
        broken: ~
`,
    });

    const text = await runModule('oauth-sso.js', app);

    expect(text).toContain('HTTP');
  });
});

describe('batch 87: OAuth2 server, PDF, PHP array, bcmath, sniffer, contracts and enums', () => {
  test('an OAuth2 server with long-lived tokens', async () => {
    const app = appWith('oauth2-server-config', {
      'composer.json': JSON.stringify({ require: { 'league/oauth2-server': '^8.0', 'league/oauth2-server-bundle': '^0.8' } }, null, 4) + '\n',
      'src/OAuth/ServerFactory.php': `<?php

namespace App\\OAuth;

use League\\OAuth2\\Server\\AuthorizationServer;
use League\\OAuth2\\Server\\CryptKey;
use League\\OAuth2\\Server\\Grant\\PasswordGrant;
use League\\OAuth2\\Server\\Grant\\RefreshTokenGrant;

class ServerFactory
{
    public function server(): AuthorizationServer
    {
        $server = new AuthorizationServer(
            $this->clients,
            $this->tokens,
            $this->scopes,
            new CryptKey('/var/oauth/private.key'),
            'abcdef1234567890abcdef1234567890',
        );

        $server->enableGrantType(new PasswordGrant($this->users, $this->refreshTokens));
        $server->enableGrantType(new RefreshTokenGrant($this->refreshTokens));

        return $server;
    }
}
`,
      'config/packages/league_oauth2_server.yaml': `league_oauth2_server:
    authorization_server:
        private_key: '%env(OAUTH_PRIVATE_KEY)%'
        encryption_key: '%env(OAUTH_ENCRYPTION_KEY)%'
        access_token_ttl: P30D
        refresh_token_ttl: P90D
    resource_server:
        public_key: '%env(OAUTH_PUBLIC_KEY)%'
`,
    });

    const text = await runModule('oauth2-server-config.js', app);

    expect(text).toContain('PasswordGrant');
  });

  test('a project generating PDFs with TCPDF', async () => {
    const app = appWith('pdf-generation', {
      'composer.json': JSON.stringify({ require: { 'tecnickcom/tcpdf': '^6.6' } }, null, 4) + '\n',
      'src/Export/InvoicePdf.php': `<?php

namespace App\\Export;

class InvoicePdf
{
    public function render(array $invoice): string
    {
        $pdf = new \\TCPDF();
        $pdf->AddPage();
        $pdf->writeHTML('<h1>' . $invoice['number'] . '</h1>');

        return $pdf->Output('invoice.pdf', 'S');
    }
}
`,
    });

    const text = await runModule('pdf-generation.js', app);

    expect(text).toContain('tcpdf');
  });

  test('array functions used in the ways that surprise people', async () => {
    const app = appWith('php-array-functions', {
      'src/Service/Arrays.php': `<?php

namespace App\\Service;

class Arrays
{
    public function zip(array $a, array $b): array
    {
        return array_map(null, $a, $b);
    }

    public function nested(array $rows): array
    {
        return array_map(static fn (array $row): array => array_map('trim', $row), $rows);
    }

    public function compact(array $rows): array
    {
        return array_values(array_filter($rows));
    }

    public function walk(array $rows): array
    {
        array_walk($rows, static function ($value, $key) {
            return $value;
        });

        return $rows;
    }
}
`,
    });

    const text = await runModule('php-array-functions.js', app);

    expect(text).toContain('array_');
  });

  test('a backtrace taken in production code', async () => {
    const app = appWith('php-backtrace-debug', {
      'src/Service/Tracer.php': `<?php

namespace App\\Service;

class Tracer
{
    public function trace(): array
    {
        // debug_backtrace() is called on the hot path here.
        return debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 5);
    }

    public function dump(): void
    {
        $trace = (new \\Exception())->getTraceAsString();
        error_log($trace);
    }
}
`,
    });

    const text = await runModule('php-backtrace-debug.js', app);

    expect(text).toContain('backtrace');
  });

  test('bcmath dividing without checking, at absurd precision', async () => {
    const app = appWith('php-bcmath-patterns', {
      'src/Money/Calculator.php': `<?php

namespace App\\Money;

class Calculator
{
    public function share(string $total, string $count): string
    {
        return bcdiv($total, $count, 2);
    }

    public function precise(): void
    {
        bcscale(40);
    }
}
`,
    });

    const text = await runModule('php-bcmath-patterns.js', app);

    expect(text).toContain('bc');
  });

  test('a CodeSniffer ruleset, and a project without one', async () => {
    const app = appWith('php-codesniffer-config', {
      'phpcs.xml.dist': `<?xml version="1.0"?>
<ruleset name="Acme">
    <file>src</file>
    <file>tests</file>

    <rule ref="PSR12"/>
    <rule ref="Generic.Files.LineLength">
        <properties>
            <property name="lineLimit" value="120"/>
        </properties>
    </rule>

    <exclude-pattern>src/Migrations/*</exclude-pattern>
</ruleset>
`,
    });

    const text = await runModule('php-codesniffer-config.js', app);

    expect(text).toContain('vendor exclusion');
  });

  test('an interface with several implementations and no contract test', async () => {
    const files: Record<string, string> = {
      'src/Export/ExporterInterface.php': `<?php

namespace App\\Export;

interface ExporterInterface
{
    public function export(array $rows): string;
}
`,
    };
    for (const name of ['Csv', 'Json', 'Xml', 'Pdf']) {
      files[`src/Export/${name}Exporter.php`] = `<?php

namespace App\\Export;

class ${name}Exporter implements ExporterInterface
{
    public function export(array $rows): string
    {
        return '';
    }
}
`;
    }

    const app = appWith('php-contract-tests', files);

    const text = await runModule('php-contract-tests.js', app);

    expect(text).toContain('ExporterInterface');
  });

  test('dates built from the global timezone', async () => {
    const app = appWith('php-date-timezone', {
      'src/Service/Clock.php': `<?php

namespace App\\Service;

class Clock
{
    public function boot(): void
    {
        date_default_timezone_set('Europe/Madrid');
    }

    public function today(): string
    {
        return date('Y-m-d');
    }

    public function stamp(): int
    {
        return mktime(0, 0, 0, 1, 1, 2026);
    }
}
`,
    });

    const text = await runModule('php-date-timezone.js', app);

    expect(text).toContain('timezone');
  });

  test('an enum with many cases, switched on rather than matched', async () => {
    const app = appWith('php-enums-large', {
      'src/Enum/Country.php': `<?php

namespace App\\Enum;

enum Country: string
{
    case Case0 = 'case_0';
    case Case1 = 'case_1';
    case Case2 = 'case_2';
    case Case3 = 'case_3';
    case Case4 = 'case_4';
    case Case5 = 'case_5';
    case Case6 = 'case_6';
    case Case7 = 'case_7';
    case Case8 = 'case_8';
    case Case9 = 'case_9';
    case Case10 = 'case_10';
    case Case11 = 'case_11';
    case Case12 = 'case_12';
    case Case13 = 'case_13';
    case Case14 = 'case_14';
    case Case15 = 'case_15';
    case Case16 = 'case_16';
    case Case17 = 'case_17';
    case Case18 = 'case_18';
    case Case19 = 'case_19';
    case Case20 = 'case_20';
    case Case21 = 'case_21';
    case Case22 = 'case_22';
    case Case23 = 'case_23';
    case Case24 = 'case_24';
    case Case25 = 'case_25';
    case Case26 = 'case_26';
    case Case27 = 'case_27';
    case Case28 = 'case_28';
    case Case29 = 'case_29';
}
`,
      'src/Service/CountryLabel.php': `<?php

namespace App\\Service;

use App\\Enum\\Country;

class CountryLabel
{
    public function label(Country $country): string
    {
        switch ($country) {
            case Country::Case0:
                return 'First';
            default:
                return 'Other';
        }
    }
}
`,
    });

    const text = await runModule('php-enums.js', app);

    expect(text).toContain('Country');
  });
});

describe('batch 88: FFI, callables, FTP, GD, heredocs, integers, LDAP and named arguments', () => {
  test('FFI used with the extension switched off', async () => {
    const app = appWith('php-ffi', {
      'php.ini': `[PHP]
ffi.enable = false
`,
      'src/Native/Bridge.php': `<?php

namespace App\\Native;

#[\\FFI\\Scope('acme')]
class Bridge
{
    public function load(): \\FFI
    {
        return \\FFI::cdef('int add(int a, int b);', 'libacme.so');
    }
}
`,
    });

    const text = await runModule('php-ffi.js', app);

    expect(text).toContain('FFI');
  });

  test('first-class callables taken from nullable values', async () => {
    const app = appWith('php-first-class-callables', {
      'src/Service/Callables.php': `<?php

namespace App\\Service;

class Callables
{
    public function handlers(?object $logger): array
    {
        return [
            $logger?->info(...),
            strlen(...),
            $this->format(...),
        ];
    }

    public function format(string $value): string
    {
        return trim($value);
    }
}
`,
    });

    const text = await runModule('php-first-class-callables.js', app);

    expect(text).toContain('callable');
  });

  test('FTP with the password in the environment and in the code', async () => {
    const app = appWith('php-ftp-sftp-patterns', {
      '.env': `APP_ENV=prod
FTP_HOST=ftp.acme.example.com
FTP_USER=acme
FTP_PASSWORD=hunter2acme
`,
      'src/Transfer/FtpUploader.php': `<?php

namespace App\\Transfer;

class FtpUploader
{
    public function upload(string $path): void
    {
        $connection = ftp_connect('ftp.acme.example.com');
        $user = 'acme';
        $password = 'hunter2acme';
        ftp_login($connection, $user, $password);
        ftp_put($connection, basename($path), $path, FTP_BINARY);
        ftp_close($connection);
    }
}
`,
    });

    const text = await runModule('php-ftp-sftp-patterns.js', app);

    expect(text).toContain('FTP');
  });

  test('images resized from uploaded files', async () => {
    const app = appWith('php-gd-security', {
      'src/Image/Thumbnailer.php': `<?php

namespace App\\Image;

class Thumbnailer
{
    public function thumbnail(string $path): string
    {
        $image = imagecreatefromjpeg($path);
        $thumb = imagecreatetruecolor(200, 200);
        imagecopyresampled($thumb, $image, 0, 0, 0, 0, 200, 200, imagesx($image), imagesy($image));
        imagejpeg($thumb, $path . '.thumb.jpg');
        imagedestroy($thumb);

        return $path . '.thumb.jpg';
    }
}
`,
    });

    const text = await runModule('php-gd-security.js', app);

    expect(text).toContain('image');
  });

  test('SQL built inside a heredoc', async () => {
    const app = appWith('php-heredoc-nowdoc', {
      'src/Repository/ReportRepository.php': `<?php

namespace App\\Repository;

class ReportRepository
{
    public function totals(string $status): string
    {
        $sql = <<<SQL
            SELECT number, total
            FROM invoice
            WHERE status = '{$status}'
            ORDER BY issued_at DESC
            SQL;

        return $sql;
    }

    public function template(): string
    {
        return <<<'TEXT'
            A plain block with no interpolation in it.
            TEXT;
    }
}
`,
    });

    const text = await runModule('php-heredoc-nowdoc.js', app);

    expect(text).toContain('Heredoc');
  });

  test('arithmetic that can overflow, checked and unchecked', async () => {
    const app = appWith('php-integer-overflow', {
      'src/Money/Totals.php': `<?php

namespace App\\Money;

class Totals
{
    public function unchecked(int $a, int $b): int
    {
        return $a * $b;
    }

    public function checked(int $a, int $b): int
    {
        if ($a > PHP_INT_MAX / $b) {
            throw new \\RuntimeException('overflow');
        }

        return $a * $b;
    }

    public function precise(string $a, string $b): string
    {
        return bcmul($a, $b);
    }
}
`,
    });

    const text = await runModule('php-integer-overflow.js', app);

    expect(text).toContain('overflow');
  });

  test('LDAP bound with request data, searched without escaping', async () => {
    const app = appWith('php-ldap-functions', {
      'src/Ldap/DirectoryClient.php': `<?php

namespace App\\Ldap;

class DirectoryClient
{
    public function authenticate(): bool
    {
        $ldap = ldap_connect('ldap://directory.acme.internal');
        ldap_bind($ldap, $_POST['user'], $_POST['password']);

        $result = ldap_search($ldap, 'dc=acme,dc=com', '(uid=' . $_POST['user'] . ')');

        return $result !== false;
    }
}
`,
    });

    const text = await runModule('php-ldap-functions.js', app);

    expect(text).toContain('ldap');
  });

  test('PHPMetrics installed with no configuration', async () => {
    const app = appWith('php-metrics-config', {
      'composer.json': JSON.stringify({ 'require-dev': { 'phpmetrics/phpmetrics': '^2.8' } }, null, 4) + '\n',
    });

    const text = await runModule('php-metrics-config.js', app);

    expect(text).toContain('PHPMetrics');
  });

  test('named arguments used everywhere', async () => {
    const app = appWith('php-named-arguments', {
      'src/Service/Builder.php': `<?php

namespace App\\Service;

class Builder
{
    public function buildAll(): void
    {
        $this->build(name: 'n0', value: 0);
        $this->build(name: 'n1', value: 1);
        $this->build(name: 'n2', value: 2);
        $this->build(name: 'n3', value: 3);
        $this->build(name: 'n4', value: 4);
        $this->build(name: 'n5', value: 5);
        $this->build(name: 'n6', value: 6);
        $this->build(name: 'n7', value: 7);
        $this->build(name: 'n8', value: 8);
        $this->build(name: 'n9', value: 9);
        $this->build(name: 'n10', value: 10);
        $this->build(name: 'n11', value: 11);
        $this->build(name: 'n12', value: 12);
        $this->build(name: 'n13', value: 13);
        $this->build(name: 'n14', value: 14);
        $this->build(name: 'n15', value: 15);
        $this->build(name: 'n16', value: 16);
        $this->build(name: 'n17', value: 17);
        $this->build(name: 'n18', value: 18);
        $this->build(name: 'n19', value: 19);
        $this->build(name: 'n20', value: 20);
        $this->build(name: 'n21', value: 21);
        $this->build(name: 'n22', value: 22);
        $this->build(name: 'n23', value: 23);
    }

    public function build(string $name, int $value): array
    {
        return [$name => $value];
    }
}
`,
    });

    const text = await runModule('php-named-arguments.js', app);

    expect(text).toContain('named argument');
  });
});

describe('batch 89: named constructors, buffering, reflection, ignores and type juggling', () => {
  test('a class with more factories than it needs', async () => {
    const app = appWith('php-named-constructors', {
      'src/Money/Amount.php': `<?php

namespace App\\Money;

class Amount
{
    private function __construct(private int $value)
    {
    }

    public static function from0(int $v): self
    {
        return new self($v);
    }

    public static function from1(int $v): self
    {
        return new self($v);
    }

    public static function from2(int $v): self
    {
        return new self($v);
    }

    public static function from3(int $v): self
    {
        return new self($v);
    }

    public static function from4(int $v): self
    {
        return new self($v);
    }

    public static function from5(int $v): self
    {
        return new self($v);
    }

    public static function from6(int $v): self
    {
        return new self($v);
    }

    public static function fromParent(int $v): self
    {
        parent::__construct($v);

        return new self($v);
    }
}
`,
    });

    const text = await runModule('php-named-constructors.js', app);

    expect(text).toContain('named constructor');
  });

  test('a filename stripped of null bytes, and one that is not', async () => {
    const app = appWith('php-null-byte-injection', {
      'src/Upload/FileReader.php': `<?php

namespace App\\Upload;

class FileReader
{
    public function unsafe(string $name): string
    {
        return (string) file_get_contents('/var/uploads/' . $_GET['file']);
    }

    public function safe(string $name): string
    {
        $clean = str_replace("\\0", '', $_GET['file']);

        return (string) file_get_contents('/var/uploads/' . $clean);
    }
}
`,
    });

    const text = await runModule('php-null-byte-injection.js', app);

    expect(text).toContain('null byte');
  });

  test('output buffering opened and never closed', async () => {
    const app = appWith('php-output-buffering', {
      'src/Render/Renderer.php': `<?php

namespace App\\Render;

class Renderer
{
    public function render(string $template, array $vars): string
    {
        ob_start();
        extract($vars);
        include $template;

        return (string) ob_get_clean();
    }

    public function capture(): void
    {
        ob_start();
        echo 'never flushed';
    }
}
`,
    });

    const text = await runModule('php-output-buffering.js', app);

    expect(text).toContain('ob_');
  });

  test('reflection built inside a loop', async () => {
    const app = appWith('php-reflection-api', {
      'src/Service/Hydrator.php': `<?php

namespace App\\Service;

class Hydrator
{
    public function hydrate(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $reflection = new \\ReflectionClass($row['class']);
            $property = $reflection->getProperty('id');
            $property->setAccessible(true);
            $out[] = $reflection->newInstanceWithoutConstructor();
        }

        return $out;
    }
}
`,
    });

    const text = await runModule('php-reflection-api.js', app);

    expect(text).toContain('Reflection');
  });

  test('static analysis silenced without saying what for', async () => {
    const app = appWith('php-static-analysis-ignore', {
      'src/Service/Legacy.php': `<?php

namespace App\\Service;

class Legacy
{
    public function run(array $rows): int
    {
        /** @phpstan-ignore-next-line */
        $total = $rows['total'];

        /** @psalm-suppress MixedAssignment */
        $count = $rows['count'];

        // @phpstan-ignore-next-line
        return $total + $count;
    }
}
`,
    });

    const text = await runModule('php-static-analysis-ignore.js', app);

    expect(text).toContain('ignore');
  });

  test('a template name taken from the request', async () => {
    const app = appWith('php-template-injection-request', {
      'src/Controller/PageController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class PageController extends AbstractController
{
    public function show(Request $request): Response
    {
        return $this->render($request->query->get('template') . '.html.twig', []);
    }
}
`,
      'templates/page/dynamic.html.twig': `{{ include(app.request.get('partial')) }}
`,
    });

    const text = await runModule('php-template-injection.js', app);

    expect(text).toContain('template');
  });

  test('secrets compared with ==', async () => {
    const app = appWith('php-timing-attack', {
      'src/Security/TokenChecker.php': `<?php

namespace App\\Security;

class TokenChecker
{
    public function check(string $given, string $expected): bool
    {
        return $given === $expected;
    }

    public function checkHash(string $given, string $expected): bool
    {
        return md5($given) == md5($expected);
    }

    public function checkSafely(string $given, string $expected): bool
    {
        return hash_equals($expected, $given);
    }
}
`,
    });

    const text = await runModule('php-timing-attack.js', app);

    expect(text).toContain('timing');
  });

  test('values compared loosely, in switch and in place', async () => {
    const app = appWith('php-type-juggling', {
      'src/Service/Comparisons.php': `<?php

namespace App\\Service;

class Comparisons
{
    public function loose(array $row): bool
    {
        if ($row['id'] == '0') {
            return true;
        }

        switch ($row['status']) {
            case 0:
                return false;
        }

        return in_array($row['id'], [1, 2, 3]);
    }
}
`,
    });

    const text = await runModule('php-type-juggling.js', app);

    expect(text).toContain('==');
  });

  test('a nullable value used without narrowing it', async () => {
    const app = appWith('php-type-narrowing', {
      'src/Service/Narrowing.php': `<?php

namespace App\\Service;

class Narrowing
{
    public function describe(?object $invoice): string
    {
        if ($invoice === null) {
            return '';
        }

        return $invoice->getNumber();
    }

    public function unchecked(?object $invoice): string
    {
        return $invoice->getNumber();
    }
}
`,
    });

    const text = await runModule('php-type-narrowing.js', app);

    expect(text).toContain('Narrowing');
  });
});

describe('batch 90: typed constants, Xdebug, XML, XSL and PHPUnit style', () => {
  test('a typed constant given a number where a boolean belongs', async () => {
    const app = appWith('php-typed-constants', {
      'composer.json': JSON.stringify({ require: { php: '~8.3' } }, null, 4) + '\n',
      'src/Config/Flags.php': `<?php

namespace App\\Config;

class Flags
{
    public const bool ENABLED = 1;

    public const string NAME = 'acme';

    public const int RETRIES = 3;
}
`,
    });

    const text = await runModule('php-typed-constants.js', app);

    expect(text).toContain('const');
  });

  test('Xdebug left in develop mode', async () => {
    const app = appWith('php-xdebug-config', {
      'docker/php/xdebug.ini': `[xdebug]
xdebug.mode = develop,debug,coverage
xdebug.start_with_request = yes
xdebug.client_host = host.docker.internal
xdebug.max_nesting_level = 512
`,
    });

    const text = await runModule('php-xdebug-config.js', app);

    expect(text).toContain('xdebug');
  });

  test('XML loaded with entities enabled', async () => {
    const app = appWith('php-xml-security', {
      'src/Import/XmlImporter.php': `<?php

namespace App\\Import;

class XmlImporter
{
    public function load(string $xml): \\SimpleXMLElement
    {
        libxml_disable_entity_loader(false);

        return simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NOENT | LIBXML_DTDLOAD);
    }

    public function parse(string $xml): \\DOMDocument
    {
        $document = new \\DOMDocument();
        $document->loadXML($xml, LIBXML_NOENT);

        return $document;
    }
}
`,
    });

    const text = await runModule('php-xml-security.js', app);

    expect(text).toContain('XML');
  });

  test('an XSL transformation with PHP functions enabled', async () => {
    const app = appWith('php-xsl-transformation', {
      'src/Export/XslRenderer.php': `<?php

namespace App\\Export;

class XslRenderer
{
    public function render(string $xml, string $xslPath): string
    {
        $processor = new \\XSLTProcessor();
        $processor->registerPHPFunctions();

        $stylesheet = new \\DOMDocument();
        $stylesheet->load($xslPath);
        $processor->importStylesheet($stylesheet);

        $document = new \\DOMDocument();
        $document->loadXML($xml);

        return (string) $processor->transformToXml($document);
    }
}
`,
      'templates/xsl/invoice.xsl': `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:template match="/">
        <html><body><xsl:value-of select="invoice/number"/></body></html>
    </xsl:template>
</xsl:stylesheet>
`,
    });

    const text = await runModule('php-xsl-transformation.js', app);

    expect(text).toContain('XSL');
  });

  test('a suite that mixes annotations with attributes', async () => {
    const app = appWith('phpunit-attributes', {
      'tests/Unit/InvoiceTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\Attributes\\CoversClass;
use PHPUnit\\Framework\\Attributes\\DataProvider;
use PHPUnit\\Framework\\TestCase;

#[CoversClass(\\App\\Entity\\Invoice::class)]
class InvoiceTest extends TestCase
{
    #[DataProvider('totals')]
    public function testTotals(int $a, int $b): void
    {
        $this->assertSame($a, $b);
    }

    public static function totals(): array
    {
        return [[1, 1]];
    }
}
`,
      'tests/Unit/LegacyTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class LegacyTest extends TestCase
{
    /**
     * @covers \\App\\Entity\\Line
     * @dataProvider lines
     */
    public function testLines(int $a): void
    {
        $this->assertSame(1, $a);
    }

    public static function lines(): array
    {
        return [[1]];
    }
}
`,
      'tests/Unit/notes.php': "<?php\n\n// The attributes used by the suite are described here.\n",
    });

    const text = await runModule('phpunit-attributes.js', app);

    expect(text).toContain('attribute');
  });

  test('a test that asserts on the clock', async () => {
    const app = appWith('phpunit-clock-assertion', {
      'tests/Unit/ClockTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class ClockTest extends TestCase
{
    public function testNow(): void
    {
        $this->assertSame(time(), (new \\DateTimeImmutable())->getTimestamp());
    }

    public function testToday(): void
    {
        $this->assertSame(date('Y-m-d'), (new \\DateTimeImmutable())->format('Y-m-d'));
    }
}
`,
    });

    const text = await runModule('phpunit-clock-assertion.js', app);

    expect(text).toContain('clock');
  });

  test('an expected exception declared after the call', async () => {
    const app = appWith('phpunit-expect-exception', {
      'tests/Unit/ValidatorTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class ValidatorTest extends TestCase
{
    public function testItThrows(): void
    {
        $validator = new \\App\\Service\\Validator();
        $validator->validate('bad');

        $this->expectException(\\InvalidArgumentException::class);
    }
}
`,
    });

    const text = await runModule('phpunit-expect-exception.js', app);

    expect(text).toContain('expectException');
  });

  test('a partial mock of the class under test', async () => {
    const app = appWith('phpunit-self-shunting', {
      'tests/Unit/ImporterTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class ImporterTest extends TestCase
{
    public function testImport(): void
    {
        $importer = $this->getMockBuilder(\\App\\Import\\Importer::class)->onlyMethods(['fetch'])->getMock();
        $importer->method('fetch')->willReturn([]);

        $this->assertSame([], $importer->import());
    }
}
`,
    });

    const text = await runModule('phpunit-self-shunting.js', app);

    expect(text).toContain('mock');
  });

  test('snapshot tests with their stored snapshots', async () => {
    const app = appWith('phpunit-snapshot', {
      'tests/Unit/ReportTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class ReportTest extends TestCase
{
    public function testMatchesSnapshot(): void
    {
        $this->assertMatchesJsonSnapshot(['total' => 100]);
    }
}
`,
      'tests/Unit/__snapshots__/ReportTest__testMatchesSnapshot__1.json': '{"total":100}\n',
      'tests/Unit/notes.php': "<?php\n\n// The snapshots live beside the tests.\n",
    });

    const text = await runModule('phpunit-snapshot.js', app);

    expect(text).toContain('napshot');
  });
});

describe('batch 91: profiler, Psalm, Pusher, Render, scheduler, decorators and adapters', () => {
  test('profiler tokens read from the cache directory', async () => {
    const app = appWith('profiler-tokens', {
      'var/cache/dev/profiler/index.csv': `abc123,127.0.0.1,GET,http://localhost/,1767225600,200
def456,127.0.0.1,POST,http://localhost/invoice,1767225601,302
`,
      'var/cache/dev/profiler/23/c1/abc123': '{"time":{"duration":12}}\n',
      'var/cache/dev/profiler/45/d2/def456': '{"time":{"duration":34}}\n',
    });

    const text = await runModule('profiler.js', app, ['abc123']);

    expect(text).toContain('rofiler');
  });

  test('a Psalm configuration with a baseline', async () => {
    const app = appWith('psalm-config', {
      'psalm.xml': `<?xml version="1.0"?>
<psalm errorLevel="3" errorBaseline="psalm-baseline.xml" findUnusedBaselineEntry="true">
    <projectFiles>
        <directory name="src"/>
        <ignoreFiles>
            <directory name="vendor"/>
        </ignoreFiles>
    </projectFiles>
</psalm>
`,
      'psalm-baseline.xml': `<?xml version="1.0" encoding="UTF-8"?>
<files psalm-version="5.0.0">
    <file src="src/Service/Importer.php">
        <MixedAssignment occurrences="3"/>
    </file>
</files>
`,
    });

    const text = await runModule('psalm-config.js', app);

    expect(text).toContain('aseline');
  });

  test('a Pusher private channel triggered without authentication', async () => {
    const app = appWith('pusher-integration', {
      'composer.json': JSON.stringify({ require: { 'pusher/pusher-php-server': '^7.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nPUSHER_APP_KEY=abcdef1234567890\nPUSHER_APP_SECRET=0123456789abcdef\n',
      'src/Realtime/PusherPublisher.php': `<?php

namespace App\\Realtime;

use Pusher\\Pusher;

class PusherPublisher
{
    public function publish(array $payload): void
    {
        $pusher = new Pusher('key', 'secret', 'app', ['debug' => true]);
        $pusher->trigger('private-invoices', 'created', $payload);
    }
}
`,
      'src/Controller/PusherWebhookController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class PusherWebhookController
{
    public function webhook(Request $request): Response
    {
        $payload = json_decode($request->getContent(), true);

        return new Response('');
    }
}
`,
    });

    const text = await runModule('pusher-integration.js', app);

    expect(text).toContain('usher');
  });

  test('a Render service with its environment written in', async () => {
    const app = appWith('render-deploy-config-env', {
      'render.yaml': `services:
    - type: web
      name: acme
      env: php
      buildCommand: composer install --no-dev
      startCommand: heroku-php-apache2 public/
      envVars:
          - key: APP_ENV
            value: prod
          - key: DATABASE_URL
            value: postgresql://acme:hunter2@db:5432/acme
          - key: APP_SECRET
            sync: false
`,
    });

    const text = await runModule('render-deploy-config.js', app);

    expect(text).toContain('plain-text value');
  });

  test('scheduled messages with a timezone of their own', async () => {
    const app = appWith('scheduler-timezone', {
      'src/Scheduler/ReportSchedule.php': `<?php

namespace App\\Scheduler;

use Symfony\\Component\\Scheduler\\Attribute\\AsSchedule;
use Symfony\\Component\\Scheduler\\RecurringMessage;
use Symfony\\Component\\Scheduler\\Schedule;
use Symfony\\Component\\Scheduler\\ScheduleProviderInterface;

#[AsSchedule('reports')]
class ReportSchedule implements ScheduleProviderInterface
{
    public function getSchedule(): Schedule
    {
        return (new Schedule())->add(
            RecurringMessage::cron('0 6 * * *', new SendDailyReport(), new \\DateTimeZone('Europe/Madrid')),
        );
    }
}
`,
    });

    const text = await runModule('scheduler.js', app);

    expect(text).toContain('Schedule');
  });

  test('decorators declared with the attribute, one behind the other', async () => {
    const app = appWith('service-decorators', {
      'src/Cache/CachedExporter.php': `<?php

namespace App\\Cache;

use App\\Export\\ExporterInterface;
use Symfony\\Component\\DependencyInjection\\Attribute\\AsDecorator;

#[AsDecorator(decorates: ExporterInterface::class, priority: 10)]
class CachedExporter implements ExporterInterface
{
    public function __construct(private ExporterInterface $inner)
    {
    }

    public function export(array $rows): string
    {
        return $this->inner->export($rows);
    }
}
`,
      'src/Logging/LoggedExporter.php': `<?php

namespace App\\Logging;

use App\\Cache\\CachedExporter;
use App\\Export\\ExporterInterface;
use Symfony\\Component\\DependencyInjection\\Attribute\\AsDecorator;

#[AsDecorator(decorates: CachedExporter::class, priority: 5, inner_id: 'app.logged.inner')]
class LoggedExporter implements ExporterInterface
{
    public function __construct(private ExporterInterface $inner)
    {
    }

    public function export(array $rows): string
    {
        return $this->inner->export($rows);
    }
}
`,
    });

    const text = await runModule('service-decorators.js', app);

    expect(text).toContain('Exporter');
  });

  test('a filesystem pool with no namespace, behind a chain', async () => {
    const app = appWith('symfony-cache-psr6-adapters', {
      'config/packages/cache.yaml': `framework:
    cache:
        pools:
            app.files_pool:
                adapter: cache.adapter.filesystem
            app.chain_pool:
                adapters:
                    - cache.adapter.filesystem
                    - cache.adapter.redis
`,
    });

    const text = await runModule('symfony-cache-psr6-adapters.js', app);

    expect(text).toContain('dapter');
  });

  test('the clock read directly in application code', async () => {
    const app = appWith('symfony-clock', {
      'src/Service/Billing.php': `<?php

namespace App\\Service;

class Billing
{
    public function due(): \\DateTimeImmutable
    {
        // The clock is read straight from the runtime here.
        return new \\DateTimeImmutable('now');
    }

    public function stamp(): int
    {
        return time();
    }
}
`,
      'tests/Unit/BillingTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class BillingTest extends TestCase
{
    public function testDue(): void
    {
        $this->assertNotNull(new \\DateTimeImmutable('now'));
    }
}
`,
    });

    const text = await runModule('symfony-clock.js', app);

    expect(text).toContain('lock');
  });

  test('a console command that loops for ever', async () => {
    const app = appWith('symfony-console-daemon', {
      'src/Command/WorkerCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Output\\OutputInterface;

#[AsCommand(name: 'app:worker')]
class WorkerCommand extends Command
{
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        while (true) {
            $this->handleOne();
            sleep(1);
        }

        return Command::SUCCESS;
    }

    private function handleOne(): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-console-daemon.js', app);

    expect(text).toContain('WorkerCommand');
  });
});

describe('batch 92: console events and helpers, conditional services, lazy ghosts and clients', () => {
  test('a console error listener that swallows the error', async () => {
    const app = appWith('symfony-console-events', {
      'src/EventSubscriber/ConsoleSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Symfony\\Component\\Console\\ConsoleEvents;
use Symfony\\Component\\Console\\Event\\ConsoleErrorEvent;
use Symfony\\Component\\Console\\Event\\ConsoleSignalEvent;
use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;

class ConsoleSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            ConsoleEvents::ERROR => 'onError',
            ConsoleEvents::SIGNAL => 'onSignal',
        ];
    }

    public function onError(ConsoleErrorEvent $event): void
    {
        $event->setExitCode(0);
    }

    public function onSignal(ConsoleSignalEvent $event): void
    {
        $event->getCommand();
    }
}
`,
    });

    const text = await runModule('symfony-console-events.js', app);

    expect(text).toContain('rror');
  });

  test('a console helper with dependencies of its own', async () => {
    const app = appWith('symfony-console-helper', {
      'src/Console/Helper/ReportHelper.php': `<?php

namespace App\\Console\\Helper;

use Symfony\\Component\\Console\\Helper\\Helper;

class ReportHelper extends Helper
{
    public function __construct(
        private object $repository,
        private object $formatter,
        private object $logger,
    ) {
    }

    public function getName(): string
    {
        return 'report';
    }
}
`,
      'src/Command/ReportCommand.php': `<?php

namespace App\\Command;

use Symfony\\Component\\Console\\Command\\Command;

class ReportCommand extends Command
{
    protected function configure(): void
    {
        $helper = $this->getHelper('report');
    }
}
`,
    });

    const text = await runModule('symfony-console-helper.js', app);

    expect(text).toContain('helper');
  });

  test('a service registered only for the test environment', async () => {
    const app = appWith('symfony-di-conditional-services', {
      'src/Service/FakeMailer.php': `<?php

namespace App\\Service;

use Symfony\\Component\\DependencyInjection\\Attribute\\When;

#[When(env: 'test')]
class FakeMailer
{
    public function send(): void
    {
    }
}
`,
      'config/services_test.yaml': `services:
    App\\Service\\FakeMailer:
        public: true
`,
    });

    const text = await runModule('symfony-di-conditional-services.js', app);

    expect(text).toContain('test');
  });

  test('a lazy service with a constructor that does the work anyway', async () => {
    const app = appWith('symfony-di-lazy-ghost', {
      'src/Service/HeavyService.php': `<?php

namespace App\\Service;

use Symfony\\Component\\DependencyInjection\\Attribute\\Lazy;

#[Lazy]
class HeavyService
{
    public function __construct(
        private object $entityManager,
        private object $httpClient,
        private object $logger,
        private object $cache,
    ) {
    }
}
`,
      'config/services.yaml': `services:
    App\\Service\\HeavyService:
        lazy: true
`,
    });

    const text = await runModule('symfony-di-lazy-ghost.js', app);

    expect(text).toContain('Lazy');
  });

  test('SQL logging through a middleware of its own', async () => {
    const app = appWith('symfony-doctrine-sql-logger', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
        middlewares:
            - App\\Doctrine\\SqlLoggingMiddleware
`,
      'src/Doctrine/SqlLoggingMiddleware.php': `<?php

namespace App\\Doctrine;

use Doctrine\\DBAL\\Driver;
use Doctrine\\DBAL\\Driver\\Middleware;

class SqlLoggingMiddleware implements Middleware
{
    public function wrap(Driver $driver): Driver
    {
        return $driver;
    }
}
`,
    });

    const text = await runModule('symfony-doctrine-sql-logger.js', app);

    expect(text).toContain('custom');
  });

  test('templates that render ESI fragments', async () => {
    const app = appWith('symfony-esi-config', {
      'config/packages/framework.yaml': `framework:
    esi: true
    fragments:
        path: /_fragment
`,
      'templates/base.html.twig': `<div>
    {{ render_esi(controller('App\\\\Controller\\\\SidebarController::show')) }}
    {{ render_esi(url('sidebar')) }}
</div>
`,
      'templates/invoice/show.html.twig': `{{ render_esi(controller('App\\\\Controller\\\\InvoiceController::totals')) }}
`,
    });

    const text = await runModule('symfony-esi-config.js', app);

    expect(text).toContain('esi');
  });

  test('expressions evaluated without caching what was parsed', async () => {
    const app = appWith('symfony-expression-language-ext', {
      'src/Expression/PricingLanguage.php': `<?php

namespace App\\Expression;

use Symfony\\Component\\ExpressionLanguage\\ExpressionFunction;
use Symfony\\Component\\ExpressionLanguage\\ExpressionLanguage;

class PricingLanguage
{
    public function evaluate(string $expression, array $values): mixed
    {
        $language = new ExpressionLanguage();

        return $language->evaluate($expression, $values);
    }

    public function parse(string $expression): object
    {
        $language = new ExpressionLanguage();

        return $language->parse($expression, ['price']);
    }

    public function functions(): array
    {
        return [
            ExpressionFunction::fromPhp('count'),
            new ExpressionFunction('round', static fn ($v): string => "round({$v})", static fn ($args, $v): float => round($v)),
        ];
    }
}
`,
    });

    const text = await runModule('symfony-expression-language-ext.js', app);

    expect(text).toContain('Expression');
  });

  test('a data mapper configured for the forms', async () => {
    const app = appWith('symfony-form-data-mapper', {
      'config/packages/framework.yaml': `framework:
    form:
        data_mapper: App\\Form\\DataMapper\\ImmutableMapper
`,
      'src/Form/DataMapper/ImmutableMapper.php': `<?php

namespace App\\Form\\DataMapper;

use Symfony\\Component\\Form\\DataMapperInterface;

class ImmutableMapper implements DataMapperInterface
{
    public function mapDataToForms(mixed $viewData, \\Traversable $forms): void
    {
    }

    public function mapFormsToData(\\Traversable $forms, mixed &$viewData): void
    {
    }
}
`,
    });

    const text = await runModule('symfony-form-data-mapper.js', app);

    expect(text).toContain('data_mapper');
  });

  test('HTTP requests made one after another instead of together', async () => {
    const app = appWith('symfony-http-client-concurrent', {
      'src/Http/BatchFetcher.php': `<?php

namespace App\\Http;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class BatchFetcher
{
    public function __construct(private HttpClientInterface $client)
    {
    }

    public function fetchOne(string $url): string
    {
        return $this->client->request('GET', $url)->getContent();
    }

    public function cancelFirst(array $urls): void
    {
        $response = $this->client->request('GET', $urls[0]);
        $response->cancel();
    }
}
`,
    });

    const text = await runModule('symfony-http-client-concurrent.js', app);

    expect(text).toContain('getContent()');
  });
});

describe('batch 93: scoped clients, envelopes, workers, mime headers and passwords', () => {
  test('a scoped client that nothing injects', async () => {
    const app = appWith('symfony-httpclient-scopes', {
      'config/packages/framework.yaml': `framework:
    http_client:
        scoped_clients:
            acme.client:
                base_uri: 'https://api.acme.com'
                headers:
                    Accept: application/json
            legacy.client:
                base_uri: 'https://legacy.acme.com'
`,
      'src/Http/AcmeClient.php': `<?php

namespace App\\Http;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class AcmeClient
{
    public function __construct(private HttpClientInterface $acmeClient)
    {
    }
}
`,
    });

    const text = await runModule('symfony-httpclient-scopes.js', app);

    expect(text).toContain('client');
  });

  test('a stamp that is not a stamp, and a delay measured in days', async () => {
    const app = appWith('symfony-messenger-envelope', {
      'src/Message/Stamp/TenantStamp.php': `<?php

namespace App\\Message\\Stamp;

class TenantStamp
{
    public function __construct(public readonly string $tenant)
    {
    }
}
`,
      'src/Service/Dispatcher.php': `<?php

namespace App\\Service;

use Symfony\\Component\\Messenger\\Envelope;
use Symfony\\Component\\Messenger\\MessageBusInterface;
use Symfony\\Component\\Messenger\\Stamp\\DelayStamp;

class Dispatcher
{
    public function __construct(private MessageBusInterface $bus)
    {
    }

    public function dispatch(object $message): void
    {
        $envelope = new Envelope($message, [new DelayStamp(172800000)]);
        $this->bus->dispatch($envelope);
    }

    public function read(Envelope $envelope): mixed
    {
        $stamp = $envelope->last(DelayStamp::class);

        return $stamp->getDelay();
    }
}
`,
    });

    const text = await runModule('symfony-messenger-envelope.js', app);

    expect(text).toContain('Stamp');
  });

  test('workers paused through supervisor alone', async () => {
    const app = appWith('symfony-messenger-pause-resume', {
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default'
# Workers are paused with supervisorctl stop messenger:*
`,
      'src/Messenger/PauseMiddleware.php': `<?php

namespace App\\Messenger;

use Symfony\\Component\\Lock\\LockInterface;
use Symfony\\Component\\Messenger\\Envelope;
use Symfony\\Component\\Messenger\\Middleware\\MiddlewareInterface;
use Symfony\\Component\\Messenger\\Middleware\\StackInterface;

class PauseMiddleware implements MiddlewareInterface
{
    public function __construct(private LockInterface $lock)
    {
    }

    public function handle(Envelope $envelope, StackInterface $stack): Envelope
    {
        return $stack->next()->handle($envelope, $stack);
    }
}
`,
    });

    const text = await runModule('symfony-messenger-pause-resume.js', app);

    expect(text).toContain('supervisor');
  });

  test('a worker unit file with its consume command', async () => {
    const app = appWith('symfony-messenger-worker', {
      'deploy/messenger-worker.service': `[Unit]
Description=Acme messenger worker
After=network.target

[Service]
Type=simple
User=www-data
ExecStart=/usr/bin/php /var/www/bin/console messenger:consume async --time-limit=3600 --memory-limit=128M
Restart=always

[Install]
WantedBy=multi-user.target
`,
      'docker/supervisord.conf': `[program:messenger]
command=php /var/www/bin/console messenger:consume async
numprocs=2
autorestart=true
`,
    });

    const text = await runModule('symfony-messenger-worker.js', app);

    expect(text).toContain('systemd');
  });

  test('an email with headers set by hand', async () => {
    const app = appWith('symfony-mime-message-headers', {
      'src/Mailer/InvoiceMailer.php': `<?php

namespace App\\Mailer;

use Symfony\\Component\\Mime\\Email;

class InvoiceMailer
{
    public function build(): Email
    {
        $email = new Email();
        $headers = $email->getHeaders();
        $headers->addTextHeader('X-Acme-Invoice', '42');
        $headers->addTextHeader('Content-Type', 'text/html');
        $headers->remove('From');

        return $email;
    }
}
`,
    });

    const text = await runModule('symfony-mime-message-headers.js', app);

    expect(text).toContain('header');
  });

  test('notifier transports with a fallback chain', async () => {
    const app = appWith('symfony-notifier-status', {
      'config/packages/notifier.yaml': `framework:
    notifier:
        chatter_transports:
            slack: '%env(SLACK_DSN)%'
        texter_transports:
            twilio: '%env(TWILIO_DSN)%'
        channel_policy:
            urgent: ['chat/slack', 'sms/twilio']
`,
      'src/Notification/FallbackNotification.php': `<?php

namespace App\\Notification;

use Symfony\\Component\\Notifier\\Notification\\Notification;

class FallbackNotification extends Notification
{
    public function getChannels(object $recipient): array
    {
        // A chained policy: chat first, then sms as fallback.
        return ['chat/slack', 'sms/twilio'];
    }
}
`,
    });

    const text = await runModule('symfony-notifier-status.js', app);

    expect(text).toContain('FailedMessageEvent');
  });

  test('a paginator that joins collections', async () => {
    const app = appWith('symfony-paginator', {
      'src/Repository/InvoiceRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\ORM\\Tools\\Pagination\\Paginator;

class InvoiceRepository
{
    public function page(int $page): Paginator
    {
        $query = $this->createQueryBuilder('i')
            ->leftJoin('i.lines', 'l')
            ->setFirstResult(($page - 1) * 20)
            ->setMaxResults(20)
            ->getQuery();

        return new Paginator($query, fetchJoinCollection: true);
    }
}
`,
    });

    const text = await runModule('symfony-paginator.js', app);

    expect(text).toContain('aginator');
  });

  test('a legacy hasher that nothing upgrades', async () => {
    const app = appWith('symfony-password-migrator', {
      'config/packages/security.yaml': `security:
    password_hashers:
        App\\Entity\\User:
            algorithm: auto
            migrate_from:
                - legacy_md5
        legacy_md5:
            algorithm: md5
            encode_as_base64: false
            iterations: 1
`,
      'src/Security/LegacyHasher.php': `<?php

namespace App\\Security;

use Symfony\\Component\\PasswordHasher\\Hasher\\LegacyPasswordHasherInterface;

class LegacyHasher implements LegacyPasswordHasherInterface
{
    public function hash(string $plainPassword, ?string $salt = null): string
    {
        return md5($plainPassword . $salt);
    }
}
`,
    });

    const text = await runModule('symfony-password-migrator.js', app);

    expect(text).toContain('egacy');
  });

  test('a password field with no strength constraint on it', async () => {
    const app = appWith('symfony-password-strength', {
      'src/Entity/User.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Symfony\\Component\\Validator\\Constraints as Assert;

#[ORM\\Entity]
class User
{
    #[ORM\\Column]
    private string $password = '';

    #[Assert\\PasswordStrength(minScore: 1)]
    private string $plainPassword = '';
}
`,
    });

    const text = await runModule('symfony-password-strength.js', app);

    expect(text).toContain('assword');
  });
});

describe('batch 94: responses, access decisions, providers, encoders, aliases and Twig', () => {
  test('a JSON response returned without a status code', async () => {
    const app = appWith('symfony-response-types', {
      'src/Controller/ApiController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpFoundation\\StreamedResponse;

class ApiController
{
    public function create(): JsonResponse
    {
        return new JsonResponse(['created' => true]);
    }

    public function stream(): StreamedResponse
    {
        return new StreamedResponse(static function (): void {
            echo 'rows';
        });
    }

    public function plain(): Response
    {
        return new Response('', Response::HTTP_NO_CONTENT);
    }
}
`,
    });

    const text = await runModule('symfony-response-types.js', app);

    expect(text).toContain('esponse');
  });

  test('a unanimous access decision over several voters', async () => {
    const app = appWith('symfony-security-access-decision', {
      'config/packages/security.yaml': `security:
    access_decision_manager:
        strategy: unanimous
        allow_if_all_abstain: false
`,
      'src/Security/Voter/InvoiceVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class InvoiceVoter extends Voter
{
    protected function supports(string $attribute, mixed $subject): bool
    {
        return true;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return true;
    }
}
`,
      'src/Security/Voter/CustomerVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class CustomerVoter extends Voter
{
    protected function supports(string $attribute, mixed $subject): bool
    {
        return true;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return true;
    }
}
`,
      'src/Security/Voter/TenantVoter.php': `<?php

namespace App\\Security\\Voter;

use Symfony\\Component\\Security\\Core\\Authorization\\Voter\\Voter;

class TenantVoter extends Voter
{
    protected function supports(string $attribute, mixed $subject): bool
    {
        return true;
    }

    protected function voteOnAttribute(string $attribute, mixed $subject, $token): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-security-access-decision.js', app);

    expect(text).toContain('unanimous');
  });

  test('a rehash that is checked and never applied', async () => {
    const app = appWith('symfony-security-password-upgrade', {
      'src/Security/UserChecker.php': `<?php

namespace App\\Security;

use Symfony\\Component\\PasswordHasher\\Hasher\\UserPasswordHasherInterface;

class UserChecker
{
    public function __construct(private UserPasswordHasherInterface $hasher)
    {
    }

    public function check(object $user, string $plain): bool
    {
        if ($this->hasher->needsRehash($user)) {
            return false;
        }

        return $this->hasher->isPasswordValid($user, $plain);
    }
}
`,
    });

    const text = await runModule('symfony-security-password-upgrade.js', app);

    expect(text).toContain('ehash');
  });

  test('a chain of user providers, one of an unknown kind', async () => {
    const app = appWith('symfony-security-user-provider', {
      'config/packages/security.yaml': `security:
    providers:
        app_users:
            entity:
                class: App\\Entity\\User
                property: email
        in_memory_users:
            memory:
                users:
                    admin: { password: '%env(ADMIN_PASSWORD)%', roles: ['ROLE_ADMIN'] }
        custom_users:
            id: App\\Security\\CustomUserProvider
        odd_users: ~
        all_users:
            chain:
                providers: [app_users, in_memory_users]
`,
    });

    const text = await runModule('symfony-security-user-provider.js', app);

    expect(text).toContain('provider');
  });

  test('an encoder that claims every format', async () => {
    const app = appWith('symfony-serializer-encoders', {
      'src/Serializer/CsvEncoder.php': `<?php

namespace App\\Serializer;

use Symfony\\Component\\Serializer\\Encoder\\EncoderInterface;

class CsvEncoder implements EncoderInterface
{
    public function encode(mixed $data, string $format, array $context = []): string
    {
        return '';
    }

    public function supportsEncoding(string $format): bool
    {
        return true;
    }
}
`,
    });

    const text = await runModule('symfony-serializer-encoders.js', app);

    expect(text).toContain('ncod');
  });

  test('a service alias marked deprecated', async () => {
    const app = appWith('symfony-service-aliases', {
      'config/services.yaml': `services:
    App\\Service\\Importer: ~

    app.importer:
        alias: App\\Service\\Importer
        public: true
        deprecated:
            package: acme/app
            version: '2.0'
            message: 'Use App\\Service\\Importer directly.'
`,
    });

    const text = await runModule('symfony-service-aliases.js', app);

    expect(text).toContain('alias');
  });

  test('a Sonata admin class registered for an entity', async () => {
    const app = appWith('symfony-sonata-admin', {
      'composer.json': JSON.stringify({ require: { 'sonata-project/admin-bundle': '^4.0' } }, null, 4) + '\n',
      'src/Admin/InvoiceAdmin.php': `<?php

namespace App\\Admin;

use Sonata\\AdminBundle\\Admin\\AbstractAdmin;
use Sonata\\AdminBundle\\Datagrid\\ListMapper;
use Sonata\\AdminBundle\\Form\\FormMapper;

class InvoiceAdmin extends AbstractAdmin
{
    protected function configureFormFields(FormMapper $form): void
    {
        $form->add('number');
    }

    protected function configureListFields(ListMapper $list): void
    {
        $list->add('number');
    }

    public function getExportFormats(): array
    {
        return ['csv'];
    }

    protected function getClass(): string
    {
        return \\App\\Entity\\Invoice::class;
    }
}
`,
    });

    const text = await runModule('symfony-sonata-admin.js', app);

    expect(text).toContain('Admin');
  });

  test('a tagged locator read without asking whether the service is there', async () => {
    const app = appWith('symfony-tagged-iterator', {
      'src/Export/ExporterRegistry.php': `<?php

namespace App\\Export;

use Psr\\Container\\ContainerInterface;
use Symfony\\Component\\DependencyInjection\\Attribute\\AutowireLocator;

class ExporterRegistry
{
    public function __construct(
        #[AutowireLocator('app.exporter', defaultIndexMethod: 'getFormat')]
        private ContainerInterface $exporters,
    ) {
    }

    public function get(string $format): object
    {
        return $this->exporters->get($format);
    }
}
`,
    });

    const text = await runModule('symfony-tagged-iterator.js', app);

    expect(text).toContain('ocator');
  });

  test('a template that counts inside a loop and includes a dozen partials', async () => {
    const app = appWith('symfony-twig-profiling', {
      'templates/invoice/list.html.twig': `{% for invoice in invoices %}
    <span>{{ invoice.lines|length }}</span>
    <span>{{ invoice.payments|count }}</span>
{% endfor %}

{{ include('partials/row0.html.twig') }}
{{ include('partials/row1.html.twig') }}
{{ include('partials/row2.html.twig') }}
{{ include('partials/row3.html.twig') }}
{{ include('partials/row4.html.twig') }}
{{ include('partials/row5.html.twig') }}
{{ include('partials/row6.html.twig') }}
{{ include('partials/row7.html.twig') }}
{{ include('partials/row8.html.twig') }}
{{ include('partials/row9.html.twig') }}
{{ include('partials/row10.html.twig') }}
{{ include('partials/row11.html.twig') }}
`,
    });

    const text = await runModule('symfony-twig-profiling.js', app);

    expect(text).toContain('include');
  });
});

describe('batch 95: React and Typed bridges, expressions, tests, Turbo, Twig and Vault', () => {
  test('a React component handed a PHP object', async () => {
    const app = appWith('symfony-ux-react', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-react': '^2.0' } }, null, 4) + '\n',
      'package.json': JSON.stringify({ dependencies: { react: '^18.0' } }, null, 4) + '\n',
      'templates/invoice/show.html.twig': `{{ react_component('InvoiceCard', { invoice: new Invoice(), total: 100 }) }}
`,
      'assets/app.js': `import { registerReactControllerComponents } from '@symfony/ux-react';

registerReactControllerComponents(require.context('./react/controllers', true, /\\.jsx$/));
`,
      'assets/react/controllers/InvoiceCard.jsx': `export default function InvoiceCard({ invoice }) {
    return <div>{invoice.number}</div>;
}
`,
    });

    const text = await runModule('symfony-ux-react.js', app);

    expect(text).toContain('react_component');
  });

  test('a typed animation that stops after one pass', async () => {
    const app = appWith('symfony-ux-typed', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-typed': '^2.0' } }, null, 4) + '\n',
      'assets/controllers/typed_controller.js': `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    connect() {
        this.typed = new Typed(this.element, {
            strings: ['Invoices', 'Payments'],
            typeSpeed: 40,
        });
    }
}
`,
      'templates/home/index.html.twig': `<span {{ stimulus_controller('symfony/ux-typed/typed', { strings: ['Invoices'] }) }}></span>
`,
    });

    const text = await runModule('symfony-ux-typed.js', app);

    expect(text).toContain('yped');
  });

  test('an expression constraint reaching into the object', async () => {
    const app = appWith('symfony-validator-expression', {
      'src/Entity/Booking.php': `<?php

namespace App\\Entity;

use Symfony\\Component\\Validator\\Constraints as Assert;

class Booking
{
    #[Assert\\Expression('this.start < this.end', message: 'The end must come after the start.')]
    private \\DateTimeImmutable $start;

    private \\DateTimeImmutable $end;
}
`,
    });

    const text = await runModule('symfony-validator-expression.js', app);

    expect(text).toContain('this.');
  });

  test('tests of every kind in the suite', async () => {
    const app = appWith('tests-inspector', {
      'tests/Unit/InvoiceTest.php': `<?php

namespace App\\Tests\\Unit;

use PHPUnit\\Framework\\TestCase;

class InvoiceTest extends TestCase
{
    public function testTotal(): void
    {
        $this->assertSame(1, 1);
    }
}
`,
      'tests/Integration/RepositoryTest.php': `<?php

namespace App\\Tests\\Integration;

use Symfony\\Bundle\\FrameworkBundle\\Test\\KernelTestCase;

class RepositoryTest extends KernelTestCase
{
    public function testItBoots(): void
    {
        self::bootKernel();
        $this->assertTrue(true);
    }
}
`,
      'tests/Functional/HomeControllerTest.php': `<?php

namespace App\\Tests\\Functional;

use Symfony\\Bundle\\FrameworkBundle\\Test\\WebTestCase;

class HomeControllerTest extends WebTestCase
{
    public function testHome(): void
    {
        $client = static::createClient();
        $client->request('GET', '/');
        $this->assertResponseIsSuccessful();
    }
}
`,
      'tests/notes.php': "<?php\n\n// The suites are described here.\n",
    });

    const text = await runModule('tests-inspector.js', app);

    expect(text).toContain('Functional');
  });

  test('a broadcast entity with no Mercure hub behind it', async () => {
    const app = appWith('turbo-bundle', {
      'composer.json': JSON.stringify({ require: { 'symfony/ux-turbo': '^2.0' } }, null, 4) + '\n',
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Symfony\\UX\\Turbo\\Attribute\\Broadcast;

#[ORM\\Entity]
#[Broadcast]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
      'templates/invoice/list.html.twig': `<turbo-frame id="invoices">
    <turbo-stream action="append" target="invoices"></turbo-stream>
</turbo-frame>
`,
    });

    const text = await runModule('turbo-bundle.js', app);

    expect(text).toContain('Mercure');
  });

  test('a Twig component with props, used in the templates', async () => {
    const app = appWith('twig-components', {
      'src/Twig/Components/InvoiceCard.php': `<?php

namespace App\\Twig\\Components;

use Symfony\\UX\\TwigComponent\\Attribute\\AsTwigComponent;

#[AsTwigComponent('invoice_card')]
class InvoiceCard
{
    public string $number = '';

    public int $total = 0;
}
`,
      'templates/components/invoice_card.html.twig': `<div class="card">{{ number }} — {{ total }}</div>
`,
      'templates/invoice/list.html.twig': `{% for invoice in invoices %}
    <twig:invoice_card number="{{ invoice.number }}" total="{{ invoice.total }}" />
{% endfor %}
`,
    });

    const text = await runModule('twig-components.js', app);

    expect(text).toContain('invoice_card');
  });

  test('a Twig extension declaring filters and functions', async () => {
    const app = appWith('twig-extensions', {
      'src/Twig/AppExtension.php': `<?php

namespace App\\Twig;

use Twig\\Extension\\AbstractExtension;
use Twig\\TwigFilter;
use Twig\\TwigFunction;

class AppExtension extends AbstractExtension
{
    public function getFilters(): array
    {
        return [
            new TwigFilter('money', [$this, 'money']),
            new TwigFilter('invoice_status', [$this, 'status']),
        ];
    }

    public function getFunctions(): array
    {
        return [
            new TwigFunction('acme_asset', [$this, 'asset'], ['is_safe' => ['html']]),
        ];
    }

    public function money(int $cents): string
    {
        return number_format($cents / 100, 2, '.', ',');
    }

    public function status(string $status): string
    {
        return ucfirst($status);
    }

    public function asset(string $path): string
    {
        return '/build/' . $path;
    }
}
`,
    });

    const text = await runModule('twig-extensions.js', app);

    expect(text).toContain('money');
  });

  test('templates inherited five deep, one of them full of blocks', async () => {
    const app = appWith('twig-template-inheritance', {
      'templates/base.html.twig': `<!DOCTYPE html>
<html><body>{% block body %}{% endblock %}</body></html>
`,
      'templates/layout/one.html.twig': "{% extends 'base.html.twig' %}\n",
      'templates/layout/two.html.twig': "{% extends 'layout/one.html.twig' %}\n",
      'templates/layout/three.html.twig': "{% extends 'layout/two.html.twig' %}\n",
      'templates/layout/four.html.twig': "{% extends 'layout/three.html.twig' %}\n",
      'templates/invoice/show.html.twig': `{% extends 'layout/four.html.twig' %}

{% block section0 %}{% endblock %}
{% block section1 %}{% endblock %}
{% block section2 %}{% endblock %}
{% block section3 %}{% endblock %}
{% block section4 %}{% endblock %}
{% block section5 %}{% endblock %}
{% block section6 %}{% endblock %}
{% block section7 %}{% endblock %}
{% block section8 %}{% endblock %}
{% block section9 %}{% endblock %}
{% block section10 %}{% endblock %}
{% block section11 %}{% endblock %}
{% block section12 %}{% endblock %}
{% block section13 %}{% endblock %}
{% block section14 %}{% endblock %}
{% block section15 %}{% endblock %}
{% block section16 %}{% endblock %}
{% block section17 %}{% endblock %}
{% block section18 %}{% endblock %}
{% block section19 %}{% endblock %}
{% block section20 %}{% endblock %}
{% block section21 %}{% endblock %}
`,
    });

    const text = await runModule('twig-template-inheritance.js', app);

    expect(text).toContain('blocks');
  });

  test('Vault reached at a hardcoded address, beside static credentials', async () => {
    const app = appWith('vault-dynamic-secrets', {
      '.env': `APP_ENV=prod
VAULT_ADDR=http://10.0.0.5:8200
VAULT_TOKEN=hvs.abcdefghijklmnopqrstuvwx
`,
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        driver: pdo_pgsql
        host: db.acme.internal
        user: acme
        password: hunter2
        dbname: acme
`,
    });

    const text = await runModule('vault-dynamic-secrets.js', app);

    expect(text).toContain('VAULT_ADDR');
  });
});

describe('batch 96: websockets, Zendesk, API keys, operations, rate limits and AWS', () => {
  test('a websocket server configured beside Mercure', async () => {
    const app = appWith('websocket-integration', {
      'composer.json': JSON.stringify({ require: { 'symfony/mercure-bundle': '^0.3' } }, null, 4) + '\n',
      'config/packages/mercure.yaml': `mercure:
    hubs:
        default:
            url: '%env(MERCURE_URL)%'
            public_url: '%env(MERCURE_PUBLIC_URL)%'
            jwt:
                secret: '%env(MERCURE_JWT_SECRET)%'
                publish: ['*']
`,
      'config/packages/messenger.yaml': `framework:
    messenger:
        transports:
            async: 'doctrine://default'
`,
      '.env': 'APP_ENV=prod\nMERCURE_URL=http://mercure/.well-known/mercure\nWEBSOCKET_URL=ws://acme.example.com:8080\n',
    });

    const text = await runModule('websocket-integration.js', app);

    expect(text).toContain('ercure');
  });

  test('a Zendesk token referenced from the code', async () => {
    const app = appWith('zendesk-integration', {
      'composer.json': JSON.stringify({ require: { 'zendesk/zendesk_api_client_php': '^2.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nZENDESK_SUBDOMAIN=acme\nZENDESK_API_TOKEN=abcdefghijklmnopqrstuvwx\n',
      'src/Support/ZendeskClient.php': `<?php

namespace App\\Support;

use Zendesk\\API\\HttpClient;

class ZendeskClient
{
    public function client(): HttpClient
    {
        $client = new HttpClient($_ENV['ZENDESK_SUBDOMAIN']);
        $client->setAuth('basic', ['username' => 'acme@example.com', 'token' => $_ENV['ZENDESK_API_TOKEN']]);

        return $client;
    }
}
`,
    });

    const text = await runModule('zendesk-integration.js', app);

    expect(text).toContain('ZENDESK');
  });

  test('API keys issued without a version or an expiry', async () => {
    const app = appWith('api-key-rotation', {
      'src/Security/ApiKeyManager.php': `<?php

namespace App\\Security;

class ApiKeyManager
{
    public function issue(string $owner): string
    {
        $apiKey = bin2hex(random_bytes(32));

        $this->store->save([
            'api_key' => $apiKey,
            'owner' => $owner,
        ]);

        return $apiKey;
    }
}
`,
    });

    const text = await runModule('api-key-rotation.js', app);

    expect(text).toContain('key');
  });

  test('a delete operation nothing protects', async () => {
    const app = appWith('api-platform-operations', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Metadata\\ApiResource;
use ApiPlatform\\Metadata\\Delete;
use ApiPlatform\\Metadata\\GetCollection;

#[ApiResource]
#[GetCollection]
#[Delete]
class Invoice
{
    private int $id = 0;
}
`,
    });

    const text = await runModule('api-platform-operations.js', app);

    expect(text).toContain('Delete');
  });

  test('a resource class whose name ends in Resource', async () => {
    const app = appWith('api-platform-resource-metadata', {
      'src/ApiResource/InvoiceResource.php': `<?php

namespace App\\ApiResource;

use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
class InvoiceResource
{
    public int $id = 0;
}
`,
    });

    const text = await runModule('api-platform-resource-metadata.js', app);

    expect(text).toContain('Resource');
  });

  test('a search filter with a strategy of its own', async () => {
    const app = appWith('api-platform-filters', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use ApiPlatform\\Doctrine\\Orm\\Filter\\OrderFilter;
use ApiPlatform\\Doctrine\\Orm\\Filter\\SearchFilter;
use ApiPlatform\\Metadata\\ApiFilter;
use ApiPlatform\\Metadata\\ApiResource;

#[ApiResource]
#[ApiFilter(SearchFilter::class, properties: ['number' => 'partial', 'status' => 'exact'])]
#[ApiFilter(OrderFilter::class, properties: ['issuedAt'], arguments: ['orderParameterName' => 'order'])]
class Invoice
{
    private int $id = 0;

    private string $number = '';
}
`,
    });

    const text = await runModule('api-platform.js', app, ['Invoice']);

    expect(text).toContain('Filter');
  });

  test('rate limits declared per route with a burst', async () => {
    const app = appWith('api-rate-limits', {
      'config/packages/rate_limiter.yaml': `framework:
    rate_limiter:
        api:
            policy: token_bucket
            limit: 100
            rate:
                interval: '1 minute'
                amount: 10
`,
      'docker/nginx/default.conf': `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

server {
    location /api/ {
        limit_req zone=api burst=20 nodelay;
    }
}
`,
      'src/Controller/Api/InvoiceController.php': `<?php

namespace App\\Controller\\Api;

use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\RateLimiter\\RateLimiterFactory;

class InvoiceController
{
    public function __construct(private RateLimiterFactory $apiLimiter)
    {
    }

    public function index(): JsonResponse
    {
        $this->apiLimiter->create()->consume(1);

        return new JsonResponse([]);
    }
}
`,
    });

    const text = await runModule('api-rate-limits.js', app);

    expect(text).toContain('burst');
  });

  test('compression configured in nginx and Apache', async () => {
    const app = appWith('api-response-compression', {
      'docker/nginx/nginx.conf': `server {
    gzip on;
    gzip_types application/json text/css application/javascript;
    gzip_min_length 1024;
}
`,
      'public/.htaccess': `<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE application/json text/html
</IfModule>
`,
    });

    const text = await runModule('api-response-compression.js', app);

    expect(text).toContain('gzip');
  });

  test('a CloudFront distribution in the infrastructure', async () => {
    const app = appWith('aws-cloudfront-config', {
      'terraform/cdn.tf': `resource "aws_cloudfront_distribution" "assets" {
  enabled = true

  default_cache_behavior {
    viewer_protocol_policy = "allow-all"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
`,
      '.env': 'APP_ENV=prod\nCLOUDFRONT_DOMAIN=d111111abcdef8.cloudfront.net\n',
    });

    const text = await runModule('aws-cloudfront-config.js', app);

    expect(text).toContain('loudFront');
  });

  test('an S3 upload made public, into a bucket named in the code', async () => {
    const app = appWith('aws-s3-integration', {
      'composer.json': JSON.stringify({ require: { 'aws/aws-sdk-php': '^3.0' } }, null, 4) + '\n',
      'src/Storage/S3Uploader.php': `<?php

namespace App\\Storage;

use Aws\\S3\\S3Client;

class S3Uploader
{
    public function __construct(private S3Client $client)
    {
    }

    public function upload(string $path): void
    {
        $this->client->putObject([
            'Bucket' => 'acme-production-uploads',
            'Key' => basename($path),
            'SourceFile' => $path,
            'ACL' => 'public-read',
        ]);
    }
}
`,
    });

    const text = await runModule('aws-s3-integration.js', app);

    expect(text).toContain('public-read');
  });
});

describe('batch 97: Azure, Bugsnag, CircleCI, compiler passes, CSP and Docker security', () => {
  test('an Azure connection string written into the code and the configuration', async () => {
    const app = appWith('azure-blob-storage', {
      'composer.json': JSON.stringify({ require: { 'microsoft/azure-storage-blob': '^1.5' } }, null, 4) + '\n',
      'src/Storage/AzureUploader.php': `<?php

namespace App\\Storage;

use MicrosoftAzure\\Storage\\Blob\\BlobRestProxy;

class AzureUploader
{
    public function client(): BlobRestProxy
    {
        return BlobRestProxy::createBlobService('DefaultEndpointsProtocol=https;AccountName=acmestorage;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789==');
    }
}
`,
      'config/packages/azure.yaml': `azure_storage:
    connection_string: 'DefaultEndpointsProtocol=https;AccountName=acmestorage;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789=='
    container: uploads
`,
    });

    const text = await runModule('azure-blob-storage.js', app);

    expect(text).toContain('AccountKey');
  });

  test('Bugsnag with its key written into the code', async () => {
    const app = appWith('bugsnag-integration', {
      'composer.json': JSON.stringify({ require: { 'bugsnag/bugsnag': '^3.0' } }, null, 4) + '\n',
      'src/Error/BugsnagFactory.php': `<?php

namespace App\\Error;

use Bugsnag\\Client;

class BugsnagFactory
{
    public function create(): Client
    {
        return Client::make('api_key: abcdef1234567890abcdef1234567890');
    }
}
`,
      'config/packages/bugsnag.yaml': `bugsnag:
    api_key: abcdef1234567890abcdef1234567890
    app_version: '1.0.0'
`,
    });

    const text = await runModule('bugsnag-integration.js', app);

    expect(text).toContain('ugsnag');
  });

  test('a CircleCI job with a secret in the command and no parallelism', async () => {
    const app = appWith('circleci-config-secret', {
      '.circleci/config.yml': `version: 2.1

jobs:
    test:
        docker:
            - image: cimg/php:8.3
        steps:
            - checkout
            - run:
                  name: Tests
                  command: vendor/bin/phpunit
            - run:
                  name: Deploy
                  command: ./deploy.sh --token=abcdef1234567890

workflows:
    main:
        jobs:
            - test
`,
    });

    const text = await runModule('circleci-config.js', app);

    expect(text).toContain('parallelism');
  });

  test('a compiler pass registered with a priority', async () => {
    const app = appWith('compiler-passes', {
      'src/DependencyInjection/Compiler/ExporterPass.php': `<?php

namespace App\\DependencyInjection\\Compiler;

use Symfony\\Component\\DependencyInjection\\Compiler\\CompilerPassInterface;
use Symfony\\Component\\DependencyInjection\\ContainerBuilder;

class ExporterPass implements CompilerPassInterface
{
    public function process(ContainerBuilder $container): void
    {
        $container->findTaggedServiceIds('app.exporter');
    }
}
`,
      'src/Kernel.php': `<?php

namespace App;

use App\\DependencyInjection\\Compiler\\ExporterPass;
use Symfony\\Component\\DependencyInjection\\Compiler\\PassConfig;
use Symfony\\Component\\DependencyInjection\\ContainerBuilder;
use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    protected function build(ContainerBuilder $container): void
    {
        $container->addCompilerPass(new ExporterPass(), PassConfig::TYPE_BEFORE_OPTIMIZATION, 10);
    }
}
`,
    });

    const text = await runModule('compiler-passes.js', app);

    expect(text).toContain('ExporterPass');
  });

  test('a lock file that is not there', async () => {
    const app = appWith('composer-no-lock', {
      'composer.json': JSON.stringify({
        require: { php: '>=8.2', 'symfony/framework-bundle': '^7.0' },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
      }, null, 4) + '\n',
    });

    const text = await runModule('composer.js', app, ['symfony/framework-bundle']);

    expect(text).toContain('symfony/framework-bundle');
  });

  test('a policy that allows inline scripts with no nonce', async () => {
    const app = appWith('content-security-policy', {
      'config/packages/nelmio_security.yaml': `nelmio_security:
    csp:
        enabled: true
        report_uri: /csp/report
        enforce:
            default-src: ['self']
            script-src: ['self', 'unsafe-inline']
            style-src: ['self', 'unsafe-inline']
`,
    });

    const text = await runModule('content-security-policy.js', app);

    expect(text).toContain('unsafe-inline');
  });

  test('a custom authenticator on a firewall with no throttling', async () => {
    const app = appWith('custom-authenticators', {
      'config/packages/security.yaml': `security:
    firewalls:
        main:
            lazy: true
            custom_authenticators:
                - App\\Security\\LoginFormAuthenticator
`,
      'src/Security/LoginFormAuthenticator.php': `<?php

namespace App\\Security;

use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Security\\Http\\Authenticator\\AbstractLoginFormAuthenticator;
use Symfony\\Component\\Security\\Http\\Authenticator\\Passport\\Passport;

class LoginFormAuthenticator extends AbstractLoginFormAuthenticator
{
    public function authenticate(Request $request): Passport
    {
        throw new \\LogicException('not implemented');
    }

    protected function getLoginUrl(Request $request): string
    {
        return '/login';
    }
}
`,
    });

    const text = await runModule('custom-authenticators.js', app);

    expect(text).toContain('throttling');
  });

  test('an exception mapped to a status code outside the range', async () => {
    const app = appWith('custom-exception-hierarchy', {
      'src/Exception/AppException.php': `<?php

namespace App\\Exception;

class AppException extends \\RuntimeException
{
}
`,
      'src/Exception/OddStatusException.php': `<?php

namespace App\\Exception;

class OddStatusException extends AppException
{
    public function getStatusCode(): int
    {
        return 200;
    }
}
`,
    });

    const text = await runModule('custom-exception-hierarchy.js', app);

    expect(text).toContain('Exception');
  });

  test('a deployment that lets the machines stop entirely', async () => {
    const app = appWith('deployment-config', {
      'fly.toml': `app = "acme"

[http_service]
    internal_port = 8080
    auto_stop_machines = true
    auto_start_machines = true
    min_machines_running = 0
`,
      'Dockerfile': `FROM php:8.3-fpm

USER www-data
`,
    });

    const text = await runModule('deployment-config.js', app);

    expect(text).toContain('machines');
  });

  test('a container mounting the docker socket', async () => {
    const app = appWith('docker-security-config', {
      'docker-compose.yml': `services:
    php:
        image: acme/php:8.3
        privileged: true
        volumes:
            - "/var/run/docker.sock:/var/run/docker.sock"
        security_opt:
            - no-new-privileges:true
`,
    });

    const text = await runModule('docker-security-config.js', app);

    expect(text).toContain('privileged');
  });
});

describe('batch 98: Doctrine associations, migrations, dialects and timestamps', () => {
  test('associations fetched every way, from both attribute styles', async () => {
    const app = appWith('doctrine-association-fetch-styles', {
      'src/Entity/Order.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\Collections\\Collection;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Order
{
    #[ORM\\ManyToOne(targetEntity: Customer::class)]
    private ?Customer $customer = null;

    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'order', fetch: 'EAGER')]
    private Collection $lines;
}
`,
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Customer
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
    });

    const text = await runModule('doctrine-association-fetch.js', app);

    expect(text).toContain('EAGER');
  });

  test('a cascade that deletes the children with the parent', async () => {
    const app = appWith('doctrine-cascade-config', {
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\Collections\\Collection;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'invoice', cascade: ['all'])]
    private Collection $lines;

    #[ORM\\ManyToOne(targetEntity: Customer::class, cascade: ['persist'])]
    private ?Customer $customer = null;
}
`,
    });

    const text = await runModule('doctrine-cascade-config.js', app);

    expect(text).toContain('cascade');
  });

  test('a migration that drops a column and adds another', async () => {
    const app = appWith('doctrine-dbal-schema-diff', {
      'migrations/Version20260301000000.php': `<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260301000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE invoice DROP COLUMN reference');
        $this->addSql('ALTER TABLE invoice ADD COLUMN external_reference VARCHAR(64) NOT NULL');
        $this->addSql('ALTER TABLE invoice CHANGE COLUMN total total BIGINT NOT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE invoice DROP COLUMN external_reference');
    }
}
`,
    });

    const text = await runModule('doctrine-dbal-schema-diff.js', app);

    expect(text).toContain('COLUMN');
  });

  test('a Doctrine subscriber declared the old way', async () => {
    const app = appWith('doctrine-event-subscribers', {
      'src/EventSubscriber/InvoiceSubscriber.php': `<?php

namespace App\\EventSubscriber;

use Doctrine\\Bundle\\DoctrineBundle\\EventSubscriber\\EventSubscriberInterface;
use Doctrine\\ORM\\Event\\LifecycleEventArgs;
use Doctrine\\ORM\\Events;

class InvoiceSubscriber implements EventSubscriberInterface
{
    public function getSubscribedEvents(): array
    {
        return [Events::prePersist, Events::postUpdate];
    }

    public function prePersist(LifecycleEventArgs $args): void
    {
    }

    public function postUpdate(LifecycleEventArgs $args): void
    {
    }
}
`,
    });

    const text = await runModule('doctrine-event-subscribers.js', app);

    expect(text).toContain('ubscriber');
  });

  test('migrations organised into subdirectories', async () => {
    const app = appWith('doctrine-migrations-config', {
      'config/packages/doctrine_migrations.yaml': `doctrine_migrations:
    migrations_paths:
        'DoctrineMigrations': '%kernel.project_dir%/migrations'
    organize_migrations: BY_YEAR_AND_MONTH
    enable_profiler: false
    transactional: true
`,
      'migrations/2026/01/Version20260101000000.php': `<?php

namespace DoctrineMigrations;

use Doctrine\\DBAL\\Schema\\Schema;
use Doctrine\\Migrations\\AbstractMigration;

final class Version20260101000000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('SELECT 1');
    }
}
`,
    });

    const text = await runModule('doctrine-migrations-config.js', app);

    expect(text).toContain('organize_migrations');
  });

  test('several entity managers, one of them empty', async () => {
    const app = appWith('doctrine-orm-config', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        default_connection: default
        connections:
            default:
                url: '%env(resolve:DATABASE_URL)%'
            reporting: ~
    orm:
        default_entity_manager: default
        entity_managers:
            default:
                connection: default
                auto_mapping: true
            reporting: ~
`,
    });

    const text = await runModule('doctrine-orm-config.js', app);

    expect(text).toContain('Entity Manager');
  });

  test('a Postgres sequence that asks the database on every insert', async () => {
    const app = appWith('doctrine-postgres-specific', {
      'config/packages/doctrine.yaml': `doctrine:
    dbal:
        driver: pdo_pgsql
        url: '%env(resolve:DATABASE_URL)%'
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue(strategy: 'SEQUENCE')]
    #[ORM\\SequenceGenerator(sequenceName: 'invoice_id_seq', allocationSize: 1)]
    #[ORM\\Column]
    private ?int $id = null;

    #[ORM\\Column(type: 'json')]
    private array $payload = [];
}
`,
    });

    const text = await runModule('doctrine-postgres-specific.js', app);

    expect(text).toContain('allocationSize');
  });

  test('a result set mapping with entities and no fields', async () => {
    const app = appWith('doctrine-result-set-mapping', {
      'src/Repository/ReportRepository.php': `<?php

namespace App\\Repository;

use Doctrine\\ORM\\Query\\ResultSetMapping;

class ReportRepository
{
    public function totals(): array
    {
        $rsm = new ResultSetMapping();
        $rsm->addEntityResult(\\App\\Entity\\Invoice::class, 'i');
        $rsm->addJoinedEntityResult(\\App\\Entity\\Line::class, 'l', 'i', 'lines');

        return $this->entityManager->createNativeQuery('SELECT * FROM invoice i JOIN line l ON l.invoice_id = i.id', $rsm)->getResult();
    }
}
`,
    });

    const text = await runModule('doctrine-result-set-mapping.js', app);

    expect(text).toContain('RSM');
  });

  test('timestamps kept by a trait in one entity and by hand in another', async () => {
    const app = appWith('doctrine-timestamps', {
      'src/Entity/Trait/TimestampableTrait.php': `<?php

namespace App\\Entity\\Trait;

use Doctrine\\ORM\\Mapping as ORM;

trait TimestampableTrait
{
    #[ORM\\Column(type: 'datetime_immutable')]
    private \\DateTimeImmutable $createdAt;

    #[ORM\\Column(type: 'datetime_immutable', nullable: true)]
    private ?\\DateTimeImmutable $updatedAt = null;
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use App\\Entity\\Trait\\TimestampableTrait;
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    use TimestampableTrait;

    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
      'src/Entity/Customer.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
#[ORM\\HasLifecycleCallbacks]
class Customer
{
    #[ORM\\Column(type: 'datetime_immutable')]
    private \\DateTimeImmutable $createdAt;

    #[ORM\\PrePersist]
    public function onPrePersist(): void
    {
        $this->createdAt = new \\DateTimeImmutable();
    }
}
`,
    });

    const text = await runModule('doctrine-timestamps.js', app);

    expect(text).toContain('imestamp');
  });

  test('a flush called inside the loop that fills the unit of work', async () => {
    const app = appWith('doctrine-uow-flush', {
      'src/Service/Batch.php': `<?php

namespace App\\Service;

use Doctrine\\ORM\\EntityManagerInterface;

class Batch
{
    public function __construct(private EntityManagerInterface $entityManager)
    {
    }

    public function run(array $rows): void
    {
        foreach ($rows as $row) {
            $entity = new \\App\\Entity\\Invoice();
            $this->entityManager->persist($entity);
            $this->entityManager->flush();
        }
    }
}
`,
    });

    const text = await runModule('doctrine-uow-flush.js', app);

    expect(text).toContain('flush');
  });
});

describe('batch 99: upserts, FrankenPHP, GitHub, GrumPHP, HTMX, caches and Kafka', () => {
  test('an upsert without a transaction, and a fetch-then-persist loop', async () => {
    const app = appWith('doctrine-upsert-patterns', {
      'src/Import/Upserter.php': `<?php

namespace App\\Import;

use Doctrine\\DBAL\\Connection;
use Doctrine\\ORM\\EntityManagerInterface;

class Upserter
{
    public function __construct(
        private Connection $connection,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function upsert(array $rows): void
    {
        foreach ($rows as $row) {
            $this->connection->executeStatement(
                'INSERT INTO invoice (number, total) VALUES (?, ?) ON CONFLICT (number) DO UPDATE SET total = EXCLUDED.total',
                [$row['number'], $row['total']],
            );
        }
    }

    public function merge(array $rows): void
    {
        foreach ($rows as $row) {
            $invoice = $this->entityManager->getRepository(\\App\\Entity\\Invoice::class)->findOneBy(['number' => $row['number']]);
            $this->entityManager->persist($invoice ?? new \\App\\Entity\\Invoice());
        }

        $this->entityManager->flush();
    }
}
`,
    });

    const text = await runModule('doctrine-upsert-patterns.js', app);

    expect(text).toContain('upsert');
  });

  test('FrankenPHP in worker mode over HTTP/3', async () => {
    const app = appWith('frankenphp-config', {
      'Caddyfile': `{
    frankenphp {
        worker ./public/index.php
    }
    servers {
        protocols h1 h2 h3
    }
}

acme.example.com {
    root * public/
    encode zstd br gzip
    tls acme@example.com
    php_server

    # http3 and quic are enabled by the protocols above.
    mercure {
        publisher_jwt {env.MERCURE_PUBLISHER_JWT_KEY}
    }
}
`,
      'docker-compose.yml': `services:
    php:
        image: dunglas/frankenphp
        environment:
            FRANKENPHP_WORKER: 'true'
            FRANKENPHP_CONFIG: 'worker ./public/index.php'
`,
    });

    const text = await runModule('frankenphp-config.js', app);

    expect(text).toContain('FRANKENPHP_WORKER');
  });

  test('a GitHub token used from the code', async () => {
    const app = appWith('github-api-integration', {
      'composer.json': JSON.stringify({ require: { 'knplabs/github-api': '^3.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nGITHUB_TOKEN=ghp\x5fabcdefghijklmnopqrstuvwxyz0123456789\n',
      'src/Vcs/GithubClient.php': `<?php

namespace App\\Vcs;

use Github\\Client;

class GithubClient
{
    public function client(): Client
    {
        $client = new Client();
        $client->authenticate($_ENV['GITHUB_TOKEN'], null, Client::AUTH_ACCESS_TOKEN);

        return $client;
    }
}
`,
    });

    const text = await runModule('github-api-integration.js', app);

    expect(text).toContain('GITHUB');
  });

  test('Dependabot watching two ecosystems, and a project without it', async () => {
    const app = appWith('github-dependabot-config', {
      '.github/dependabot.yml': `version: 2
updates:
    - package-ecosystem: composer
      directory: /
      schedule:
          interval: weekly
    - package-ecosystem: npm
      directory: /
      schedule:
          interval: monthly
`,
    });

    const text = await runModule('github-dependabot-config.js', app);

    expect(text).toContain('composer');
  });

  test('a project with no Dependabot configuration', async () => {
    const app = appWith('github-dependabot-absent', {});

    const text = await runModule('github-dependabot-config.js', app);

    expect(text).toContain('Dependabot');
  });

  test('GrumPHP hooked on push with nothing to run', async () => {
    const app = appWith('grumphp-config', {
      'grumphp.yml': `grumphp:
    hooks_dir: ~
    git_hook_variables:
        EXEC_GRUMPHP_COMMAND: php
    tasks:
        composer: ~
        jsonlint: ~
`,
      'composer.json': JSON.stringify({ 'require-dev': { 'phpro/grumphp': '^2.0' } }, null, 4) + '\n',
    });

    const text = await runModule('grumphp-config.js', app);

    expect(text).toContain('phpunit');
  });

  test('a Helm chart with its values', async () => {
    const app = appWith('helm-charts-config-values', {
      'helm/acme/Chart.yaml': `apiVersion: v2
name: acme
description: The Acme application
version: 1.2.3
appVersion: '1.0'
`,
      'helm/acme/values.yaml': `replicaCount: 1

image:
    repository: acme/app
    tag: latest
    pullPolicy: Always

resources: {}

ingress:
    enabled: true
    hosts:
        - host: acme.example.com
`,
      'helm/acme/templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: {{ include "acme.fullname" . }}
spec:
    replicas: {{ .Values.replicaCount }}
`,
    });

    const text = await runModule('helm-charts-config.js', app);

    expect(text).toContain('acme');
  });

  test('HTMX boosting links and returning whole pages', async () => {
    const app = appWith('htmx-integration', {
      'templates/base.html.twig': `<body hx-boost="true">
    <div hx-get="/invoices" hx-target="#list" hx-swap="innerHTML"></div>
</body>
`,
      'src/Controller/InvoiceController.php': `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

class InvoiceController extends AbstractController
{
    public function list(Request $request): Response
    {
        if ($request->headers->has('HX-Request')) {
            return $this->render('base.html.twig', []);
        }

        return $this->render('base.html.twig', []);
    }
}
`,
    });

    const text = await runModule('htmx-integration.js', app);

    expect(text).toContain('hx-');
  });

  test('a named HTTP client used from a service', async () => {
    const app = appWith('http-client-named', {
      'config/packages/framework.yaml': `framework:
    http_client:
        default_options:
            timeout: 5
            max_redirects: 3
        scoped_clients:
            acme.client:
                base_uri: 'https://api.acme.com'
`,
      'src/Http/AcmeApi.php': `<?php

namespace App\\Http;

use Symfony\\Contracts\\HttpClient\\HttpClientInterface;

class AcmeApi
{
    public function __construct(private HttpClientInterface $acmeClient)
    {
    }

    public function invoices(): array
    {
        return $this->acmeClient->request('GET', '/invoices', ['timeout' => 10])->toArray();
    }
}
`,
    });

    const text = await runModule('http-client.js', app);

    expect(text).toContain('client');
  });

  test('a response that varies on everything', async () => {
    const app = appWith('http-response-cache', {
      'src/Controller/ReportController.php': `<?php

namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Response;

class ReportController
{
    public function show(): Response
    {
        $response = new Response('');
        $response->setPublic();
        $response->setMaxAge(3600);
        $response->setVary('*');

        return $response;
    }
}
`,
    });

    const text = await runModule('http-response-cache.js', app);

    expect(text).toContain('Vary');
  });

  test('a Kafka producer serialising by hand, without acknowledgements', async () => {
    const app = appWith('kafka-integration', {
      'composer.json': JSON.stringify({ require: { 'kwn/php-rdkafka-bundle': '^3.0' } }, null, 4) + '\n',
      'src/Kafka/InvoiceProducer.php': `<?php

namespace App\\Kafka;

use RdKafka\\Producer;

class InvoiceProducer
{
    public function publish(array $invoice): void
    {
        $conf = new \\RdKafka\\Conf();
        $conf->set('metadata.broker.list', 'kafka:9092');

        $producer = new Producer($conf);
        $topic = $producer->newTopic('invoices');
        $topic->produce(RD_KAFKA_PARTITION_UA, 0, json_encode($invoice));
        $producer->flush(1000);
    }
}
`,
    });

    const text = await runModule('kafka-integration.js', app);

    expect(text).toContain('Kafka');
  });
});

describe('batch 100: OAuth clients, live components, search, tenancy and security bundles', () => {
  test('an OAuth client using PKCE', async () => {
    const app = appWith('league-oauth2-client', {
      'composer.json': JSON.stringify({ require: { 'league/oauth2-client': '^2.7' } }, null, 4) + '\n',
      'src/OAuth/GoogleProvider.php': `<?php

namespace App\\OAuth;

use League\\OAuth2\\Client\\Provider\\Google;

class GoogleProvider
{
    public function provider(): Google
    {
        return new Google([
            'clientId' => $_ENV['GOOGLE_CLIENT_ID'],
            'clientSecret' => $_ENV['GOOGLE_CLIENT_SECRET'],
            'redirectUri' => 'https://acme.example.com/connect/google/check',
            'pkce_method' => 'S256',
        ]);
    }

    public function authorize(Google $provider): string
    {
        return $provider->getAuthorizationUrl(['state' => bin2hex(random_bytes(16))]);
    }
}
`,
    });

    const text = await runModule('league-oauth2-client.js', app);

    expect(text).toContain('PKCE');
  });

  test('a writable live property with nothing validating it', async () => {
    const app = appWith('live-components', {
      'src/Twig/Components/InvoiceSearch.php': `<?php

namespace App\\Twig\\Components;

use Symfony\\UX\\LiveComponent\\Attribute\\AsLiveComponent;
use Symfony\\UX\\LiveComponent\\Attribute\\LiveProp;
use Symfony\\UX\\LiveComponent\\DefaultActionTrait;

#[AsLiveComponent('invoice_search')]
class InvoiceSearch
{
    use DefaultActionTrait;

    #[LiveProp(writable: true)]
    public string $query = '';

    #[LiveProp]
    public int $page = 1;
}
`,
      'templates/components/invoice_search.html.twig': `<div {{ attributes }}>
    <input data-model="query">
</div>
`,
    });

    const text = await runModule('live-components.js', app);

    expect(text).toContain('LiveProp');
  });

  test('Meilisearch reached over plain HTTP with its master key', async () => {
    const app = appWith('meilisearch-integration', {
      'composer.json': JSON.stringify({ require: { 'meilisearch/meilisearch-php': '^1.0' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nMEILISEARCH_HOST=http://meili.acme.internal:7700\nMEILISEARCH_KEY=masterKeyabcdef1234567890\n',
      'src/Search/MeiliClient.php': `<?php

namespace App\\Search;

use Meilisearch\\Client;

class MeiliClient
{
    public function client(): Client
    {
        return new Client('http://meili.acme.internal:7700', $_ENV['MEILISEARCH_KEY']);
    }

    public function search(string $term): array
    {
        return $this->client()->index('invoices')->search($term)->getHits();
    }
}
`,
    });

    const text = await runModule('meilisearch-integration.js', app);

    expect(text).toContain('eilisearch');
  });

  test('Memcached as the cache adapter, with its extension configured', async () => {
    const app = appWith('memcached-integration', {
      'config/packages/cache.yaml': `framework:
    cache:
        app: cache.adapter.memcached
        default_memcached_provider: 'memcached://memcached:11211'
`,
      'docker/php/php.ini': `[memcached]
extension = memcached.so
memcached.sess_locking = On
memcached.compression_type = fastlz
`,
    });

    const text = await runModule('memcached-integration.js', app);

    expect(text).toContain('emcached');
  });

  test('tenant entities with no Doctrine filter behind them', async () => {
    const app = appWith('multi-tenancy-entities', {
      'src/Entity/Tenant.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Tenant
{
    #[ORM\\Id]
    #[ORM\\Column]
    private ?int $id = null;
}
`,
      'src/Entity/Invoice.php': `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\Entity]
class Invoice
{
    #[ORM\\ManyToOne(targetEntity: Tenant::class)]
    private ?Tenant $tenant = null;
}
`,
      'src/Service/TenantContext.php': `<?php

namespace App\\Service;

class TenantContext
{
    private ?int $tenantId = null;

    public function tenantId(): ?int
    {
        return $this->tenantId;
    }
}
`,
    });

    const text = await runModule('multi-tenancy.js', app);

    expect(text).toContain('enant');
  });

  test('NelmioSecurityBundle configured, and a project without it', async () => {
    const app = appWith('nelmio-security-bundle', {
      'config/packages/nelmio_security.yaml': `nelmio_security:
    clickjacking:
        paths:
            '^/.*': DENY
    content_type:
        nosniff: true
    xss_protection:
        enabled: true
    forced_ssl:
        enabled: true
        hsts_max_age: 31536000
        hsts_subdomains: true
`,
    });

    const text = await runModule('nelmio-security-bundle.js', app);

    expect(text).toContain('lickjacking');
  });

  test('a project with no NelmioSecurityBundle', async () => {
    const app = appWith('nelmio-security-absent', {});

    const text = await runModule('nelmio-security-bundle.js', app);

    expect(text).toContain('not found');
  });

  test('an NGINX Unit application with its processes', async () => {
    const app = appWith('nginx-unit-config', {
      'unit.json': JSON.stringify({
        listeners: { '*:8080': { pass: 'applications/acme' } },
        applications: {
          acme: {
            type: 'php',
            root: '/var/www/public',
            script: 'index.php',
            processes: { max: 20, spare: 2 },
            user: 'root',
          },
        },
      }, null, 4) + '\n',
    });

    const text = await runModule('nginx-unit-config.js', app);

    expect(text).toContain('nit');
  });

  test('OpenTelemetry through a bundle', async () => {
    const app = appWith('opentelemetry-config', {
      'composer.json': JSON.stringify({ require: { 'open-telemetry/sdk': '^1.0', 'glpichon/opentelemetry-bundle': '^0.5' } }, null, 4) + '\n',
      '.env': 'APP_ENV=prod\nOTEL_SERVICE_NAME=acme\nOTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\nOTEL_TRACES_SAMPLER=always_on\n',
    });

    const text = await runModule('opentelemetry-config.js', app);

    expect(text).toContain('glpichon');
  });

  test('closures that bind and rebind their scope', async () => {
    const app = appWith('php-closures-binding', {
      'src/Service/Binder.php': `<?php

namespace App\\Service;

class Binder
{
    public function bind(object $target): \\Closure
    {
        $closure = function (): string {
            return $this->secret;
        };

        return \\Closure::bind($closure, $target, $target::class);
    }

    public function rebind(\\Closure $closure, object $target): \\Closure
    {
        return $closure->bindTo($target, $target::class);
    }
}
`,
    });

    const text = await runModule('php-closures.js', app);

    expect(text).toContain('losure');
  });

  test('constants exposed with no visibility of their own', async () => {
    const app = appWith('php-constant-visibility', {
      'composer.json': JSON.stringify({ require: { php: '>=8.1' } }, null, 4) + '\n',
      'src/Config/LimitsInterface.php': `<?php

namespace App\\Config;

interface LimitsInterface
{
    const MAX_ROWS = 1000;
}
`,
      'src/Config/Limits.php': `<?php

namespace App\\Config;

class Limits implements LimitsInterface
{
    final const DEFAULT_PAGE = 1;

    private const MAX_ROWS = 1000;
}
`,
      'src/Config/LimitsTrait.php': `<?php

namespace App\\Config;

trait LimitsTrait
{
    private const INTERNAL_SEED = 'acme';
}
`,
    });

    const text = await runModule('php-constant-visibility.js', app);

    expect(text).toContain('MAX_ROWS');
  });
});

describe('batch 101: duplication, curl, attributes, intervals, inclusion and generators', () => {
  test('two files that hold the same long method', async () => {
    const app = appWith('php-copy-paste-detector', {
      'src/Service/FirstReport.php': `<?php

namespace App\\Service;

class FirstReport
{
    public function build(): array
    {
        $step0 = 0;
        $step1 = 1;
        $step2 = 2;
        $step3 = 3;
        $step4 = 4;
        $step5 = 5;
        $step6 = 6;
        $step7 = 7;
        $step8 = 8;
        $step9 = 9;
        $step10 = 10;
        $step11 = 11;
        $step12 = 12;
        $step13 = 13;
        $step14 = 14;
        $step15 = 15;
        $step16 = 16;
        $step17 = 17;
        $step18 = 18;
        $step19 = 19;
        $step20 = 20;
        $step21 = 21;
        $step22 = 22;
        $step23 = 23;
        $step24 = 24;
        $step25 = 25;
        $step26 = 26;
        $step27 = 27;
        $step28 = 28;
        $step29 = 29;
        $step30 = 30;
        $step31 = 31;
        $step32 = 32;
        $step33 = 33;
        $step34 = 34;
        $step35 = 35;
        $step36 = 36;
        $step37 = 37;
        $step38 = 38;
        $step39 = 39;
        $step40 = 40;
        $step41 = 41;
        $step42 = 42;
        $step43 = 43;
        $step44 = 44;
        $step45 = 45;
        $step46 = 46;
        $step47 = 47;
        $step48 = 48;
        $step49 = 49;
        $step50 = 50;
        $step51 = 51;
        $step52 = 52;
        $step53 = 53;
        $step54 = 54;
        $step55 = 55;
        $step56 = 56;
        $step57 = 57;
        $step58 = 58;
        $step59 = 59;

        return [];
    }
}
`,
      'src/Service/SecondReport.php': `<?php

namespace App\\Service;

class SecondReport
{
    public function build(): array
    {
        $step0 = 0;
        $step1 = 1;
        $step2 = 2;
        $step3 = 3;
        $step4 = 4;
        $step5 = 5;
        $step6 = 6;
        $step7 = 7;
        $step8 = 8;
        $step9 = 9;
        $step10 = 10;
        $step11 = 11;
        $step12 = 12;
        $step13 = 13;
        $step14 = 14;
        $step15 = 15;
        $step16 = 16;
        $step17 = 17;
        $step18 = 18;
        $step19 = 19;
        $step20 = 20;
        $step21 = 21;
        $step22 = 22;
        $step23 = 23;
        $step24 = 24;
        $step25 = 25;
        $step26 = 26;
        $step27 = 27;
        $step28 = 28;
        $step29 = 29;
        $step30 = 30;
        $step31 = 31;
        $step32 = 32;
        $step33 = 33;
        $step34 = 34;
        $step35 = 35;
        $step36 = 36;
        $step37 = 37;
        $step38 = 38;
        $step39 = 39;
        $step40 = 40;
        $step41 = 41;
        $step42 = 42;
        $step43 = 43;
        $step44 = 44;
        $step45 = 45;
        $step46 = 46;
        $step47 = 47;
        $step48 = 48;
        $step49 = 49;
        $step50 = 50;
        $step51 = 51;
        $step52 = 52;
        $step53 = 53;
        $step54 = 54;
        $step55 = 55;
        $step56 = 56;
        $step57 = 57;
        $step58 = 58;
        $step59 = 59;

        return [];
    }
}
`,
    });

    const text = await runModule('php-copy-paste-detector.js', app);

    expect(text).toContain('Report');
  });

  test('curl with verification switched off', async () => {
    const app = appWith('php-curl-security', {
      'src/Http/CurlClient.php': `<?php

namespace App\\Http;

class CurlClient
{
    public function fetch(string $url): string
    {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

        return (string) curl_exec($ch);
    }
}
`,
    });

    const text = await runModule('php-curl-security.js', app);

    expect(text).toContain('VERIFY');
  });

  test('a custom attribute that nothing reads', async () => {
    const app = appWith('php-custom-attributes', {
      'src/Attribute/AuditLog.php': `<?php

namespace App\\Attribute;

#[\\Attribute(\\Attribute::TARGET_METHOD | \\Attribute::TARGET_CLASS)]
class AuditLog
{
    public function __construct(public readonly string $action)
    {
    }
}
`,
      'src/Controller/InvoiceController.php': `<?php

namespace App\\Controller;

use App\\Attribute\\AuditLog;
use Symfony\\Component\\HttpFoundation\\Response;

class InvoiceController
{
    #[AuditLog('invoice.view')]
    public function show(): Response
    {
        return new Response('');
    }
}
`,
    });

    const text = await runModule('php-custom-attributes.js', app);

    expect(text).toContain('AuditLog');
  });

  test('intervals built from strings and added to dates', async () => {
    const app = appWith('php-date-interval', {
      'src/Service/Terms.php': `<?php

namespace App\\Service;

class Terms
{
    public function due(\\DateTimeImmutable $from): \\DateTimeImmutable
    {
        return $from->add(new \\DateInterval('P30D'));
    }

    public function monthly(\\DateTimeImmutable $from): \\DateTimeImmutable
    {
        return $from->add(new \\DateInterval('P1M'));
    }

    public function diff(\\DateTimeImmutable $a, \\DateTimeImmutable $b): int
    {
        return $a->diff($b)->days;
    }
}
`,
    });

    const text = await runModule('php-date-interval.js', app);

    expect(text).toContain('DateInterval');
  });

  test('a union type written the PHP 8.2 way', async () => {
    const app = appWith('php-dnf-types', {
      'composer.json': JSON.stringify({ require: { php: '>=8.2' } }, null, 4) + '\n',
      'src/Service/Resolver.php': `<?php

namespace App\\Service;

use Countable;
use IteratorAggregate;

class Resolver
{
    public function resolve((Countable&IteratorAggregate)|null $collection): ?int
    {
        return $collection?->count();
    }

    public function widen(Countable|IteratorAggregate|null $value): bool
    {
        return $value !== null;
    }
}
`,
    });

    const text = await runModule('php-dnf-types.js', app);

    expect(text).toContain('Resolver');
  });

  test('an XPath query built from a variable', async () => {
    const app = appWith('php-dom-xpath', {
      'src/Scraper/XPathScraper.php': `<?php

namespace App\\Scraper;

class XPathScraper
{
    public function find(string $html, string $needle): array
    {
        $document = new \\DOMDocument();
        $document->loadHTML($html);

        $xpath = new \\DOMXPath($document);
        $nodes = $xpath->query("//div[@class='" . $needle . "']");

        return iterator_to_array($nodes);
    }
}
`,
    });

    const text = await runModule('php-dom-xpath.js', app);

    expect(text).toContain('XPath');
  });

  test('a file included from a variable path', async () => {
    const app = appWith('php-file-inclusion-security', {
      'src/Legacy/Loader.php': `<?php

namespace App\\Legacy;

class Loader
{
    public function load(string $module): void
    {
        include __DIR__ . '/modules/' . $module . '.php';
    }

    public function loadFromRequest(): void
    {
        require $_GET['page'];
    }
}
`,
    });

    const text = await runModule('php-file-inclusion-security.js', app);

    expect(text).toContain('nclu');
  });

  test('garbage collection switched off in the ini', async () => {
    const app = appWith('php-gc-config', {
      'docker/php/php.ini': `[PHP]
session.gc_probability = 0
session.gc_divisor = 1000
session.gc_maxlifetime = 1440
zend.enable_gc = 0
`,
    });

    const text = await runModule('php-gc-config.js', app);

    expect(text).toContain('gc_');
  });

  test('a generator with a return value and a key', async () => {
    const app = appWith('php-generators', {
      'src/Service/RowReader.php': `<?php

namespace App\\Service;

class RowReader
{
    public function rows(string $path): \\Generator
    {
        $handle = fopen($path, 'r');
        $count = 0;
        while (($line = fgets($handle)) !== false) {
            yield $count++ => trim($line);
        }
        fclose($handle);

        return $count;
    }

    public function all(string $path): array
    {
        return iterator_to_array($this->rows($path));
    }
}
`,
    });

    const text = await runModule('php-generators.js', app);

    expect(text).toContain('enerator');
  });

  test('a value object cloned without copying its collection', async () => {
    const app = appWith('php-immutable-value-objects', {
      'src/Money/Basket.php': `<?php

namespace App\\Money;

final class Basket
{
    private array $lines = [];

    public function __construct(public readonly int $total)
    {
    }

    public function withTotal(int $total): self
    {
        $clone = clone $this;

        return $clone;
    }

    public function __clone(): void
    {
    }
}
`,
    });

    const text = await runModule('php-immutable-value-objects.js', app);

    expect(text).toContain('Basket');
  });
});
