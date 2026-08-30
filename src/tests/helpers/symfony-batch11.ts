// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * An eleventh batch: web app manifests and service workers, Grafana where
 * that module actually looks, Vercel, login throttling, Twig cache,
 * Elasticsearch mappings, JWT, embeddables and property hooks.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function frontend(root: string): void {
  put(root, 'public/manifest.json', JSON.stringify({
    name: 'Acme Storefront',
    short_name: 'Acme',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#111827',
    lang: 'en',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    shortcuts: [{ name: 'Cart', url: '/cart' }],
  }, null, 2) + '\n');

  put(root, 'public/sw.js', [
    'const CACHE = "acme-v1";',
    'const ASSETS = ["/", "/assets/app.js", "/assets/app.css"];',
    '',
    'self.addEventListener("install", (event) => {',
    '    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));',
    '    self.skipWaiting();',
    '});',
    '',
    'self.addEventListener("activate", (event) => {',
    '    event.waitUntil(caches.keys().then((keys) => Promise.all(',
    '        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),',
    '    )));',
    '});',
    '',
    'self.addEventListener("fetch", (event) => {',
    '    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));',
    '});',
    '',
    'self.addEventListener("push", (event) => {',
    '    const data = event.data.json();',
    '    self.registration.showNotification(data.title, { body: data.body });',
    '});',
  ].join('\n') + '\n');

  put(root, 'public/icons/icon-192.png', 'not a real png, a fixture\n');
  put(root, 'public/icons/icon-512.png', 'not a real png, a fixture\n');

  put(root, 'vercel.json', JSON.stringify({
    version: 2,
    framework: null,
    buildCommand: 'composer install --no-dev && bin/console cache:warmup',
    outputDirectory: 'public',
    installCommand: 'composer install',
    regions: ['fra1'],
    functions: { 'api/index.php': { runtime: 'vercel-php@0.6.0', memory: 1024, maxDuration: 10 } },
    routes: [
      { src: '/(.*)', dest: '/api/index.php' },
    ],
    headers: [
      { source: '/(.*)', headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ] },
    ],
    env: { APP_ENV: 'prod', DATABASE_URL: 'postgresql://acme:hunter2@db.example.com:5432/acme' },
    crons: [{ path: '/api/cron', schedule: '0 3 * * *' }],
  }, null, 2) + '\n');

  put(root, 'grafana/dashboards/symfony.json', JSON.stringify({
    title: 'Symfony overview',
    uid: 'symfony',
    schemaVersion: 39,
    refresh: '10s',
    panels: [
      { id: 1, type: 'timeseries', title: 'Requests', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ expr: 'rate(http_requests_total[5m])' }] },
      { id: 2, type: 'gauge', title: 'Queue depth', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ expr: 'messenger_queue_depth' }] },
    ],
    templating: { list: [] },
  }, null, 2) + '\n');

  put(root, 'grafana/provisioning/datasources/prometheus.yaml', [
    'apiVersion: 1',
    'datasources:',
    '    - name: Prometheus',
    '      type: prometheus',
    '      access: proxy',
    '      url: http://prometheus:9090',
    '      isDefault: true',
    '    - name: Loki',
    '      type: loki',
    '      access: proxy',
    '      url: http://loki:3100',
  ].join('\n') + '\n');

  put(root, 'grafana/provisioning/alerting/rules.yaml', [
    'apiVersion: 1',
    'groups:',
    '    - orgId: 1',
    '      name: acme',
    '      folder: Acme',
    '      interval: 1m',
    '      rules:',
    '          - uid: error-rate',
    '            title: Error rate above one percent',
    '            condition: A',
    '            for: 5m',
  ].join('\n') + '\n');
}

function symfonyPieces(root: string): void {
  put(root, 'config/packages/twig.yaml', [
    'twig:',
    '    default_path: "%kernel.project_dir%/templates"',
    '    form_themes: ["bootstrap_5_layout.html.twig"]',
    '    globals:',
    '        app_version: "%env(APP_VERSION)%"',
    '    date:',
    '        format: "d/m/Y H:i"',
    '        timezone: Europe/Madrid',
    '    number_format:',
    '        decimals: 2',
    '        decimal_point: ","',
    '        thousands_separator: "."',
  ].join('\n') + '\n');

  put(root, 'config/packages/prod/twig.yaml', [
    'twig:',
    '    cache: "%kernel.cache_dir%/twig"',
    '    auto_reload: false',
    '    strict_variables: false',
    '    debug: false',
    '    optimizations: -1',
  ].join('\n') + '\n');

  put(root, 'config/packages/dev/twig.yaml', [
    'twig:',
    '    auto_reload: true',
    '    strict_variables: true',
    '    debug: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/test/twig.yaml', [
    'twig:',
    '    strict_variables: true',
    '    cache: false',
  ].join('\n') + '\n');

  put(root, 'config/packages/lexik_jwt_authentication.yaml', [
    'lexik_jwt_authentication:',
    '    secret_key: "%env(resolve:JWT_SECRET_KEY)%"',
    '    public_key: "%env(resolve:JWT_PUBLIC_KEY)%"',
    '    pass_phrase: "%env(JWT_PASSPHRASE)%"',
    '    token_ttl: 604800',
    '    clock_skew: 0',
    '    user_id_claim: email',
    '    token_extractors:',
    '        authorization_header:',
    '            enabled: true',
    '            prefix: Bearer',
    '            name: Authorization',
    '        cookie:',
    '            enabled: true',
    '            name: BEARER',
    '        query_parameter:',
    '            enabled: true',
    '            name: bearer',
    '    set_cookies:',
    '        BEARER:',
    '            lifetime: 604800',
    '            samesite: lax',
    '            secure: false',
    '            httpOnly: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/fos_elastica.yaml', [
    'fos_elastica:',
    '    clients:',
    '        default:',
    '            url: "%env(ELASTICSEARCH_URL)%"',
    '            retryOnConflict: 5',
    '    indexes:',
    '        product:',
    '            settings:',
    '                number_of_shards: 1',
    '                number_of_replicas: 0',
    '                analysis:',
    '                    analyzer:',
    '                        default:',
    '                            type: standard',
    '            properties:',
    '                name:',
    '                    type: text',
    '                    analyzer: standard',
    '                sku:',
    '                    type: keyword',
    '                price:',
    '                    type: float',
    '                createdAt:',
    '                    type: date',
    '            persistence:',
    '                driver: orm',
    '                model: App\\Entity\\Product',
    '                provider: ~',
    '                listener: ~',
    '                finder: ~',
  ].join('\n') + '\n');

  put(root, 'config/elasticsearch/product-mapping.json', JSON.stringify({
    settings: { number_of_shards: 1, number_of_replicas: 1, refresh_interval: '1s' },
    mappings: {
      dynamic: 'strict',
      properties: {
        name: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        sku: { type: 'keyword' },
        price: { type: 'scaled_float', scaling_factor: 100 },
        tags: { type: 'keyword' },
        description: { type: 'text', analyzer: 'english' },
        createdAt: { type: 'date', format: 'strict_date_optional_time' },
        location: { type: 'geo_point' },
      },
    },
  }, null, 2) + '\n');

  put(root, 'src/Entity/Address.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Embeddable]',
    'class Address',
    '{',
    '    #[ORM\\Column(length: 255)]',
    '    private string $street = "";',
    '',
    '    #[ORM\\Column(length: 32)]',
    '    private string $postalCode = "";',
    '',
    '    #[ORM\\Column(length: 2)]',
    '    private string $country = "ES";',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Entity/Customer.php', [
    '<?php',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity]',
    'class Customer',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Embedded(class: Address::class, columnPrefix: "billing_")]',
    '    private Address $billingAddress;',
    '',
    '    #[ORM\\Embedded(class: Address::class, columnPrefix: false)]',
    '    private Address $shippingAddress;',
    '',
    '    public function __construct()',
    '    {',
    '        $this->billingAddress = new Address();',
    '        $this->shippingAddress = new Address();',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'src/Domain/Temperature.php', [
    '<?php',
    'namespace App\\Domain;',
    '',
    'final class Temperature',
    '{',
    '    public float $celsius = 0.0 {',
    '        get => $this->celsius;',
    '        set (float $value) {',
    '            if ($value < -273.15) {',
    '                throw new \\InvalidArgumentException("below absolute zero");',
    '            }',
    '            $this->celsius = $value;',
    '        }',
    '    }',
    '',
    '    public float $fahrenheit {',
    '        get => $this->celsius * 9 / 5 + 32;',
    '        set (float $value) => $this->celsius = ($value - 32) * 5 / 9;',
    '    }',
    '',
    '    public string $label {',
    '        get => sprintf("%.1f C", $this->celsius);',
    '    }',
    '}',
  ].join('\n') + '\n');

  // Login throttling lives with the rate limiter, and the firewall names it.
  put(root, 'config/packages/security_throttle.yaml', [
    'security:',
    '    firewalls:',
    '        main:',
    '            login_throttling:',
    '                max_attempts: 5',
    '                interval: "15 minutes"',
    '        api:',
    '            login_throttling:',
    '                max_attempts: 100',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchEleven(root: string): void {
  frontend(root);
  symfonyPieces(root);
}
