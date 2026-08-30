// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The other half of the fixture content: the same files, written the way
 * the analysers complain about.
 *
 * Everything the earlier batches added is correct, or nearly so, which only
 * ever exercises the "this is configured properly" side of each module.
 * These are the same paths with the fault the module was written to find —
 * applied to the problematic application only.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function infrastructure(root: string): void {
  put(root, '.traefik/traefik.yml', [
    'entryPoints:',
    '    web:',
    '        address: ":80"',
    '',
    'providers:',
    '    docker:',
    '        exposedByDefault: true',
    '',
    'api:',
    '    dashboard: true',
    '    insecure: true',
    '',
    'log:',
    '    level: DEBUG',
  ].join('\n') + '\n');

  put(root, 'sonar-project.properties', [
    'sonar.projectKey=acme_app',
    'sonar.sources=.',
    'sonar.login=squ_0123456789abcdef0123456789abcdef0123',
  ].join('\n') + '\n');

  put(root, 'consul.json', JSON.stringify({
    service: { name: 'acme-app', port: 8000 },
    acl: { enabled: false },
  }, null, 2) + '\n');

  put(root, 'monitoring/loki-config.yaml', [
    'auth_enabled: false',
    'server:',
    '    http_listen_port: 3100',
    'limits_config:',
    '    ingestion_rate_mb: 512',
  ].join('\n') + '\n');

  put(root, 'cypress.config.js', [
    'const { defineConfig } = require("cypress");',
    '',
    'module.exports = defineConfig({',
    '    e2e: {',
    '        baseUrl: "http://production.example.com",',
    '        defaultCommandTimeout: 60000,',
    '        video: true,',
    '        chromeWebSecurity: false,',
    '    },',
    '    env: { adminPassword: "hunter2", apiToken: "7f3d9a2b6c1e45089a11bb22cc33dd44" },',
    '});',
  ].join('\n') + '\n');

  put(root, 'k8s/deployment.yaml', [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '    name: acme-app',
    'spec:',
    '    replicas: 1',
    '    template:',
    '        spec:',
    '            hostNetwork: true',
    '            containers:',
    '                - name: php',
    '                  image: acme/app:latest',
    '                  securityContext:',
    '                      privileged: true',
    '                      runAsUser: 0',
    '                  env:',
    '                      - name: APP_SECRET',
    '                        value: "7f3d9a2b6c1e45089a11bb22cc33dd44"',
  ].join('\n') + '\n');

  put(root, 'netlify.toml', [
    '[build]',
    'command = "npm run build"',
    'publish = "public"',
    '',
    '[build.environment]',
    'STRIPE_SECRET = "sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0"',
  ].join('\n') + '\n');

  put(root, 'docker/nginx/default.conf', [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /var/www/html;',
    '',
    '    autoindex on;',
    '    server_tokens on;',
    '',
    '    location / {',
    '        index index.php;',
    '    }',
    '',
    '    location ~ \\.php$ {',
    '        fastcgi_pass php:9000;',
    '        include fastcgi_params;',
    '    }',
    '}',
  ].join('\n') + '\n');
}

function symfonyConfig(root: string): void {
  put(root, 'config/packages/rate_limiter.yaml', [
    'framework:',
    '    rate_limiter:',
    '        anonymous_api:',
    '            policy: "token_bucket"',
    '            limit: 5000000',
    '        internal:',
    '            policy: "no_limit"',
    '        broken:',
    '            policy: "fixed_window"',
  ].join('\n') + '\n');

  put(root, 'config/packages/cache.yaml', [
    'framework:',
    '    cache:',
    '        app: cache.adapter.filesystem',
    '        pools:',
    '            app.cache.forever:',
    '                adapter: cache.adapter.filesystem',
    '                default_lifetime: 0',
  ].join('\n') + '\n');

  put(root, 'config/packages/mailer.yaml', [
    'framework:',
    '    mailer:',
    '        dsn: "smtp://acme:hunter2@smtp.example.com:25"',
  ].join('\n') + '\n');

  put(root, 'config/packages/prod/monolog.yaml', [
    'monolog:',
    '    handlers:',
    '        main:',
    '            type: stream',
    '            path: "%kernel.logs_dir%/prod.log"',
    '            level: debug',
  ].join('\n') + '\n');

  put(root, 'config/packages/sentry.yaml', [
    'sentry:',
    '    dsn: "https://0123456789abcdef@o1.ingest.sentry.io/42"',
    '    options:',
    '        send_default_pii: true',
    '        traces_sample_rate: 1.0',
  ].join('\n') + '\n');

  put(root, 'config/packages/ldap.yaml', [
    'ldap:',
    '    default:',
    '        host: ldap.example.com',
    '        port: 389',
    '        encryption: none',
  ].join('\n') + '\n');

  put(root, 'config/packages/nelmio_api_doc.yaml', [
    'nelmio_api_doc:',
    '    documentation:',
    '        components:',
    '            securitySchemes:',
    '                ApiKey:',
    '                    type: apiKey',
    '                    in: query',
    '                    name: token',
    '                Basic:',
    '                    type: http',
    '                    scheme: basic',
  ].join('\n') + '\n');

  put(root, 'config/packages/lock.yaml', [
    'framework:',
    '    lock:',
    '        default: "flock"',
    '        invoice: "semaphore"',
  ].join('\n') + '\n');

  put(root, 'config/packages/workflow.yaml', [
    'framework:',
    '    workflows:',
    '        publication:',
    '            type: workflow',
    '            supports: [App\\Entity\\Post]',
    '            places: [draft, review, published, orphan]',
    '            transitions:',
    '                submit:',
    '                    from: draft',
    '                    to: review',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine.yaml', [
    'doctrine:',
    '    dbal:',
    '        url: "mysql://root:root@127.0.0.1:3306/acme"',
    '        charset: latin1',
    '    orm:',
    '        auto_generate_proxy_classes: true',
    '        auto_mapping: true',
  ].join('\n') + '\n');

  put(root, 'importmap.php', [
    '<?php',
    '',
    'return [',
    "    'app' => ['path' => './assets/app.js', 'entrypoint' => true],",
    "    'jquery' => [],",
    "    'es-module-shims' => ['url' => 'https://cdn.example.com/shims.js', 'polyfill' => true],",
    "    'moment' => ['url' => 'http://unpkg.com/moment/moment.js'],",
    '];',
  ].join('\n') + '\n');

  put(root, 'phpstan.neon', [
    'parameters:',
    '    level: 1',
    '    paths:',
    '        - .',
    '    reportUnmatchedIgnoredErrors: false',
    '    treatPhpDocTypesAsCertain: true',
  ].join('\n') + '\n');

  put(root, 'phpunit.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<phpunit bootstrap="tests/bootstrap.php" colors="true" stopOnFailure="false">',
    '    <testsuites>',
    '        <testsuite name="all"><directory>tests</directory></testsuite>',
    '    </testsuites>',
    '</phpunit>',
  ].join('\n') + '\n');

  put(root, 'rector.php', [
    '<?php',
    '',
    'use Rector\\Config\\RectorConfig;',
    '',
    'return RectorConfig::configure()',
    '    ->withPaths([__DIR__])',
    '    ->withPhpSets(php53: true, php74: true);',
  ].join('\n') + '\n');

  put(root, 'behat.yaml', [
    'default:',
    '    suites:',
    '        default:',
    '            paths: ["%paths.base%/features"]',
  ].join('\n') + '\n');

  put(root, 'features/checkout.feature', [
    'Feature: Checkout',
    '',
    '    Scenario: Cart totals',
    '        Given I have 2 items in the cart',
    '        Then I should see "2 items"',
  ].join('\n') + '\n');

  put(root, 'php.ini', [
    '[PHP]',
    'display_errors = On',
    'expose_php = On',
    'memory_limit = -1',
    'allow_url_fopen = On',
    'allow_url_include = On',
    'session.cookie_httponly = 0',
    'session.cookie_secure = 0',
    '',
    '[elastic_apm]',
    'elastic_apm.server_url = http://apm:8200',
    'elastic_apm.service_name = the acme storefront',
    'elastic_apm.transaction_sample_rate = 1.0',
    'elastic_apm.log_level = trace',
    'elastic_apm.secret_token = 7f3d9a2b6c1e4508aa11',
    'elastic_apm.api_key = QUJDREVGR0hJSktMTU5PUFFS',
  ].join('\n') + '\n');

  put(root, 'wrangler.toml', [
    'name = "acme-edge"',
    'main = "worker/index.js"',
    'workers_dev = true',
    '',
    '[vars]',
    'API_TOKEN = "7f3d9a2b6c1e45089a11bb22cc33dd44"',
    'DATABASE_URL = "postgresql://acme:hunter2@db.example.com:5432/acme"',
  ].join('\n') + '\n');

  put(root, 'service.yaml', [
    'apiVersion: serving.knative.dev/v1',
    'kind: Service',
    'metadata:',
    '    name: acme-app',
    'spec:',
    '    template:',
    '        spec:',
    '            containerConcurrency: 1',
    '            containers:',
    '                - image: gcr.io/acme/app:latest',
    '                  env:',
    '                      - name: STRIPE_SECRET',
    '                        value: "sk\x5flive_51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0"',
    '                  resources:',
    '                      limits:',
    '                          memory: 128Mi',
  ].join('\n') + '\n');

  put(root, 'config/packages/ux_icons.yaml', [
    'ux_icons:',
    '    icon_dir: "%kernel.project_dir%/assets/missing-icons"',
  ].join('\n') + '\n');

  put(root, 'config/services_decoration.yaml', [
    'services:',
    '    App\\Cache\\LoggingCacheDecorator:',
    '        decorates: cache.app',
    '',
    '    App\\Cache\\SecondDecorator:',
    '        decorates: cache.app',
  ].join('\n') + '\n');

  put(root, 'infection.json', JSON.stringify({
    source: { directories: ['src'] },
    minMsi: 0,
    minCoveredMsi: 0,
    timeout: 120,
  }, null, 2) + '\n');

  put(root, 'phpmetrics.json', JSON.stringify({
    report: { html: 'var/metrics/index.html' },
    includes: ['.'],
  }, null, 2) + '\n');
}

/** Everything in this file. */
export function addBadTwins(root: string): void {
  infrastructure(root);
  symfonyConfig(root);
}
