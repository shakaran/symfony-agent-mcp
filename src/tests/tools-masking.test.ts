// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Applications whose credentials are in the file.
 *
 * Every integration module has a masking helper, and it only runs once the
 * module has found something worth masking: a token in an environment
 * file, a DSN with a password, an inline value where a secret reference
 * belongs. This is one application per module, each with two of them so
 * the reports that sort their findings run as well.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symfony-masking-'));
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

const ENV_WITH_SECRETS = [
  'APP_ENV=prod',
  'GITHUB_TOKEN=ghp\x5f0123456789abcdefghijklmnopqrstuvwxyzAB',
  'GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----abcdef-----END RSA PRIVATE KEY-----',
  'MAILGUN_API_KEY=key\x2d0123456789abcdef0123456789abcdef',
  'MAILGUN_DOMAIN=mg.example.com',
  'CLOUDINARY_URL=cloudinary://123456789012345:abcdefghijklmnopqrstuvwxyz@acme',
  'CLOUDINARY_API_KEY=123456789012345',
  'CLOUDINARY_API_SECRET=abcdefghijklmnopqrstuvwxyz12',
  'CLOUDINARY_CLOUD_NAME=acme',
  'STRIPE_SECRET_KEY=sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0',
  'STRIPE_PUBLISHABLE_KEY=pk_live_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0',
  'STRIPE_WEBHOOK_SECRET=whsec\x5f0123456789abcdef0123456789abcdef',
  'STRIPE_PRICE_ID=price_0123456789abcdef',
  'AZURE_CLIENT_ID=11111111-2222-3333-4444-555555555555',
  'AZURE_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz0123456789',
  'AZURE_TENANT_ID=66666666-7777-8888-9999-000000000000',
  'GRAPH_CLIENT_SECRET=zyxwvutsrqponmlkjihgfedcba9876543210',
  'BRAINTREE_MERCHANT_ID=acmemerchant',
  'BRAINTREE_PUBLIC_KEY=abcdefghijklmnop',
  'BRAINTREE_PRIVATE_KEY=0123456789abcdef0123456789abcdef',
  'BRAINTREE_ENVIRONMENT=production',
  'ELASTICSEARCH_URL=http://elastic:hunter2@elasticsearch:9200',
  'MEILISEARCH_URL=http://meili:masterKeyValue@meilisearch:7700',
].join('\n') + '\n';

describe('credentials the modules have to mask', () => {
  test('the integrations that read the environment file', async () => {
    const app = appWith('integration-env', {
      '.env': ENV_WITH_SECRETS,
      '.env.local': ENV_WITH_SECRETS,
      'config/packages/mailer.yaml': [
        'framework:',
        '    mailer:',
        '        dsn: "mailgun+api://key\x2d0123456789abcdef0123456789abcdef:mg.example.com@default"',
      ].join('\n') + '\n',
      'src/Service/Payments.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Braintree\\Gateway;',
        'use Stripe\\StripeClient;',
        '',
        'class Payments',
        '{',
        '    public function braintree(): Gateway',
        '    {',
        '        return new Gateway([',
        '            "environment" => "production",',
        '            "merchantId" => $_ENV["BRAINTREE_MERCHANT_ID"],',
        '            "publicKey" => $_ENV["BRAINTREE_PUBLIC_KEY"],',
        '            "privateKey" => "0123456789abcdef0123456789abcdef",',
        '        ]);',
        '    }',
        '',
        '    public function stripe(): StripeClient',
        '    {',
        '        $client = new StripeClient("sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0");',
        '        $client->subscriptions->create(["customer" => "cus_1", "items" => [["price" => "price_0123456789abcdef"]]]);',
        '        $client->webhookEndpoints->create(["url" => "https://acme.example.com/webhook", "enabled_events" => ["invoice.paid", "customer.subscription.deleted"]]);',
        '',
        '        return $client;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Service/Uploads.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Cloudinary\\Cloudinary;',
        '',
        'class Uploads',
        '{',
        '    public function client(): Cloudinary',
        '    {',
        '        return new Cloudinary("cloudinary://123456789012345:abcdefghijklmnopqrstuvwxyz@acme");',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Service/Repos.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Github\\Client;',
        '',
        'class Repos',
        '{',
        '    public function client(): Client',
        '    {',
        '        $client = new Client();',
        '        $client->authenticate("ghp\x5f0123456789abcdefghijklmnopqrstuvwxyzAB", null, Client::AUTH_ACCESS_TOKEN);',
        '',
        '        return $client;',
        '    }',
        '}',
      ].join('\n') + '\n',
      'src/Service/GraphClient.php': [
        '<?php',
        'namespace App\\Service;',
        '',
        'use Microsoft\\Graph\\GraphServiceClient;',
        '',
        'class GraphClient',
        '{',
        '    public function client(): GraphServiceClient',
        '    {',
        '        return GraphServiceClient::createWithAuthenticationProvider($this->provider);',
        '    }',
        '}',
      ].join('\n') + '\n',
      'config/packages/fos_elastica.yaml': [
        'fos_elastica:',
        '    clients:',
        '        default:',
        '            host: "http://elastic:hunter2@elasticsearch:9200"',
        '        secondary:',
        '            host: "http://elastic:hunter2@elasticsearch-2:9200"',
        '    indexes:',
        '        product:',
        '            persistence:',
        '                driver: orm',
        '                model: App\\Entity\\Product',
      ].join('\n') + '\n',
      'config/packages/meilisearch.yaml': [
        'meilisearch:',
        '    host: "http://meili:masterKeyValue@meilisearch:7700"',
        '    prefix: acme_',
      ].join('\n') + '\n',
    }, {
      'knplabs/github-api': '^3.13',
      'mailgun/mailgun-php': '^4.2',
      'cloudinary/cloudinary_php': '^2.13',
      'stripe/stripe-php': '^13.0',
      'microsoft/microsoft-graph': '^2.0',
      'braintree/braintree_php': '^6.16',
      'friendsofsymfony/elastica-bundle': '^6.4',
      'meilisearch/search-bundle': '^0.14',
    });

    const results = await Promise.all([
      runModule('github-api-integration.js', app),
      runModule('mailgun-integration.js', app),
      runModule('cloudinary-integration.js', app),
      runModule('stripe-billing-subscriptions.js', app),
      runModule('microsoft-graph-integration.js', app),
      runModule('braintree-integration.js', app),
      runModule('search-integration.js', app),
      runModule('aws-ses-integration.js', app),
    ]);

    expect(results.join('').length).toBeGreaterThan(0);
  });

  test('deployment descriptors with the values written inline', async () => {
    const app = appWith('deployment-secrets', {
      '.do/app.yaml': [
        'name: acme',
        'region: fra',
        'services:',
        '    - name: web',
        '      github:',
        '          repo: acme/app',
        '          branch: main',
        '      instance_size_slug: basic-xxs',
        '      instance_count: 1',
        '      http_port: 8080',
        '      envs:',
        '          - key: APP_ENV',
        '            value: prod',
        '          - key: APP_SECRET',
        '            value: 0123456789abcdef0123456789abcdef',
        '          - key: DATABASE_URL',
        '            value: "postgresql://acme:hunter2@db.example.com:5432/acme"',
        '    - name: worker',
        '      envs:',
        '          - key: MESSENGER_TRANSPORT_DSN',
        '            value: "amqp://guest:guest@rabbitmq:5672/%2f"',
      ].join('\n') + '\n',
      'fly.toml': [
        'app = "acme"',
        'primary_region = "cdg"',
        '',
        '[build]',
        '  dockerfile = "Dockerfile"',
        '',
        '[env]',
        '  APP_ENV = "prod"',
        '  APP_SECRET = "0123456789abcdef0123456789abcdef"',
        '  DATABASE_URL = "postgresql://acme:hunter2@db.internal:5432/acme"',
        '',
        '[http_service]',
        '  internal_port = 8080',
        '  force_https = true',
        '  auto_stop_machines = true',
        '  min_machines_running = 0',
        '',
        '[[vm]]',
        '  size = "shared-cpu-1x"',
        '  memory = "256mb"',
      ].join('\n') + '\n',
      'ansible/site.yml': [
        '- hosts: web',
        '  become: true',
        '  vars:',
        '      db_password: hunter2',
        '      api_token: 0123456789abcdef0123456789abcdef',
        '      app_env: prod',
        '  tasks:',
        '      - name: Write the environment file',
        '        copy:',
        '            dest: /var/www/html/.env.local',
        '            content: "DATABASE_URL=postgresql://acme:hunter2@db:5432/acme"',
        '      - name: Restart',
        '        service: { name: php8.3-fpm, state: restarted }',
      ].join('\n') + '\n',
      'docker-compose.yml': [
        'services:',
        '    app:',
        '        image: acme/app:1.4.0',
        '        environment:',
        '            APP_ENV: prod',
        '            APP_SECRET: 0123456789abcdef0123456789abcdef',
        '            DATABASE_PASSWORD: hunter2',
        '            MAILER_DSN: "smtp://acme:hunter2@smtp.example.com:25"',
        '        volumes:',
        '            - ./:/var/www/html',
        '            - ./vendor:/var/www/html/vendor',
        '        ports:',
        '            - "8080:8080"',
        '    worker:',
        '        image: acme/app:1.4.0',
        '        environment:',
        '            APP_ENV: prod',
        '            REDIS_PASSWORD: hunter2',
        '        volumes:',
        '            - ./var:/var/www/html/var',
        '    db:',
        '        image: postgres:16',
        '        environment:',
        '            POSTGRES_PASSWORD: hunter2',
      ].join('\n') + '\n',
    });

    const results = await Promise.all([
      runModule('digitalocean-app-platform.js', app),
      runModule('fly-io-config.js', app),
      runModule('ansible-playbook-config.js', app),
      runModule('docker-inspector.js', app, ['app', 'worker']),
    ]);

    expect(results.join('').length).toBeGreaterThan(0);
  });
});
