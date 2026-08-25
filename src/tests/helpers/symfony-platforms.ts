// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Deployment and Symfony configuration files, at the exact paths the
 * analysers join onto the application root.
 *
 * A dozen modules sat between 27% and 40% for one reason: the file they read
 * did not exist. The paths here were taken from the modules themselves, not
 * from what a deployment usually looks like, because being one directory out
 * is the difference between a module analysing everything and analysing
 * nothing — which is how three earlier fixtures went wrong.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Hosting platforms: fly.io, Render, Caddy, DigitalOcean, Cloud Run. */
export function addPlatformFiles(root: string): void {
  put(root, 'fly.toml', [
    'app = "acme-app"',
    'primary_region = "mad"',
    '',
    '[build]',
    '    dockerfile = "docker/php/Dockerfile"',
    '',
    '[env]',
    '    APP_ENV = "prod"',
    '    APP_DEBUG = "0"',
    '',
    '[http_service]',
    '    internal_port = 8080',
    '    force_https = true',
    '    auto_stop_machines = true',
    '    min_machines_running = 1',
    '',
    '[[vm]]',
    '    memory = "512mb"',
    '    cpu_kind = "shared"',
    '    cpus = 1',
    '',
    '[checks.health]',
    '    type = "http"',
    '    path = "/health"',
    '    interval = "15s"',
  ].join('\n') + '\n');

  put(root, 'render.yaml', [
    'services:',
    '    - type: web',
    '      name: acme-app',
    '      env: docker',
    '      dockerfilePath: ./docker/php/Dockerfile',
    '      plan: starter',
    '      healthCheckPath: /health',
    '      autoDeploy: true',
    '      envVars:',
    '          - key: APP_ENV',
    '            value: prod',
    '          - key: DATABASE_URL',
    '            fromDatabase:',
    '                name: acme-db',
    '                property: connectionString',
    'databases:',
    '    - name: acme-db',
    '      plan: starter',
  ].join('\n') + '\n');

  put(root, 'caddy.json', JSON.stringify({
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            routes: [{
              match: [{ host: ['app.example.com'] }],
              handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'php:9000' }] }],
            }],
            automatic_https: { disable: false },
          },
        },
      },
    },
  }, null, 2));

  put(root, '.do/app.yaml', [
    'name: acme-app',
    'region: fra',
    'services:',
    '    - name: web',
    '      dockerfile_path: docker/php/Dockerfile',
    '      http_port: 8080',
    '      instance_count: 2',
    '      instance_size_slug: basic-xs',
    '      health_check:',
    '          http_path: /health',
    '      envs:',
    '          - key: APP_ENV',
    '            value: prod',
    '            scope: RUN_TIME',
    'databases:',
    '    - name: acme-db',
    '      engine: PG',
  ].join('\n') + '\n');

  put(root, 'cloudbuild.yaml', [
    'steps:',
    '    - name: gcr.io/cloud-builders/docker',
    '      args: ["build", "-t", "gcr.io/$PROJECT_ID/acme:$COMMIT_SHA", "."]',
    '    - name: gcr.io/cloud-builders/docker',
    '      args: ["push", "gcr.io/$PROJECT_ID/acme:$COMMIT_SHA"]',
    '    - name: gcr.io/google.com/cloudsdktool/cloud-sdk',
    '      args: ["run", "deploy", "acme", "--image", "gcr.io/$PROJECT_ID/acme:$COMMIT_SHA"]',
    'options:',
    '    logging: CLOUD_LOGGING_ONLY',
  ].join('\n') + '\n');

  put(root, 'cloudrun.yaml', [
    'apiVersion: serving.knative.dev/v1',
    'kind: Service',
    'metadata:',
    '    name: acme',
    'spec:',
    '    template:',
    '        spec:',
    '            containerConcurrency: 80',
    '            timeoutSeconds: 300',
    '            containers:',
    '                - image: gcr.io/project/acme',
    '                  resources:',
    '                      limits:',
    '                          cpu: "1"',
    '                          memory: 512Mi',
  ].join('\n') + '\n');

  put(root, 'bitbucket-pipelines.yml', [
    'image: php:8.3',
    '',
    'definitions:',
    '    caches:',
    '        composer: ~/.composer/cache',
    '',
    'pipelines:',
    '    default:',
    '        - step:',
    '              name: Test',
    '              caches: [composer]',
    '              script:',
    '                  - composer install --no-interaction',
    '                  - vendor/bin/phpunit',
    '    branches:',
    '        main:',
    '            - step:',
    '                  name: Deploy',
    '                  deployment: production',
    '                  script:',
    '                      - ./deploy.sh',
  ].join('\n') + '\n');

  put(root, '.rr.yaml', [
    'version: "3"',
    '',
    'server:',
    '    command: "php public/index.php"',
    '',
    'http:',
    '    address: 0.0.0.0:8080',
    '    pool:',
    '        num_workers: 4',
    '        max_jobs: 1000',
    '        supervisor:',
    '            max_worker_memory: 128',
    '',
    'logs:',
    '    level: warn',
    '    mode: production',
    '',
    'metrics:',
    '    address: 127.0.0.1:2112',
  ].join('\n') + '\n');
}

/** Symfony configuration a dozen analysers read and none of the fixtures had. */
export function addSymfonyConfigFiles(root: string): void {
  put(root, 'config/packages/mailer.yaml', [
    'framework:',
    '    mailer:',
    '        dsn: "%env(MAILER_DSN)%"',
    '        envelope:',
    '            sender: "noreply@example.com"',
    '        headers:',
    '            From: "Acme <noreply@example.com>"',
    '        message_bus: messenger.default_bus',
  ].join('\n') + '\n');

  put(root, 'config/packages/notifier.yaml', [
    'framework:',
    '    notifier:',
    '        texter_transports:',
    '            twilio: "%env(TWILIO_DSN)%"',
    '        chatter_transports:',
    '            slack: "%env(SLACK_DSN)%"',
    '            telegram: "%env(TELEGRAM_DSN)%"',
    '        channel_policy:',
    '            urgent: ["chat/slack", "sms/twilio"]',
    '            high: ["email"]',
    '            medium: ["email"]',
    '            low: ["email"]',
    '        admin_recipients:',
    '            - { email: ops@example.com }',
  ].join('\n') + '\n');

  put(root, 'config/packages/translation.yaml', [
    'framework:',
    '    default_locale: en',
    '    translator:',
    '        default_path: "%kernel.project_dir%/translations"',
    '        fallbacks: [en]',
    '        providers:',
    '            crowdin:',
    '                dsn: "%env(CROWDIN_DSN)%"',
    '                domains: ["messages"]',
    '                locales: ["en", "es"]',
    '            loco:',
    '                dsn: "%env(LOCO_DSN)%"',
  ].join('\n') + '\n');

  put(root, 'config/packages/doctrine_migrations.yaml', [
    'doctrine_migrations:',
    '    migrations_paths:',
    '        "DoctrineMigrations": "%kernel.project_dir%/migrations"',
    '    enable_profiler: false',
    '    transactional: true',
    '    check_database_platform: true',
    '    all_or_nothing: true',
  ].join('\n') + '\n');

  // XLIFF, which the translation format analyser reads and YAML files cannot
  // stand in for.
  put(root, 'translations/messages.en.xlf', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">',
    '    <file source-language="en" target-language="en" datatype="plaintext" original="file.ext">',
    '        <body>',
    '            <trans-unit id="app.title" resname="app.title">',
    '                <source>app.title</source>',
    '                <target>Demo</target>',
    '            </trans-unit>',
    '            <trans-unit id="app.greeting">',
    '                <source>app.greeting</source>',
    '                <target state="needs-translation">Hello</target>',
    '            </trans-unit>',
    '        </body>',
    '    </file>',
    '</xliff>',
  ].join('\n') + '\n');

  put(root, 'translations/messages.es.xlf', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="es">',
    '    <file id="messages">',
    '        <unit id="app.title">',
    '            <segment>',
    '                <source>app.title</source>',
    '                <target>Demostración</target>',
    '            </segment>',
    '        </unit>',
    '    </file>',
    '</xliff>',
  ].join('\n') + '\n');

  // symfony.lock, which the recipe analyser reads.
  put(root, 'symfony.lock', JSON.stringify({
    'symfony/framework-bundle': {
      version: '7.1',
      recipe: { repo: 'github.com/symfony/recipes', branch: 'main', version: '6.4', ref: 'abc123' },
      files: ['config/packages/framework.yaml', 'src/Kernel.php'],
    },
    'symfony/console': {
      version: '7.1',
      recipe: { repo: 'github.com/symfony/recipes', branch: 'main', version: '5.3', ref: 'def456' },
    },
    'doctrine/doctrine-bundle': { version: '2.12' },
  }, null, 2));

  // Playwright, read from e2e/ or tests/.
  put(root, 'e2e/playwright.config.ts', [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "    testDir: './specs',",
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
  ].join('\n') + '\n');
  put(root, 'e2e/specs/home.spec.ts', [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('home page loads', async ({ page }) => {",
    "    await page.goto('/');",
    '    await expect(page).toHaveTitle(/Demo/);',
    '});',
  ].join('\n') + '\n');
}

/** Both groups. */
export function addPlatformAndConfig(root: string): void {
  addPlatformFiles(root);
  addSymfonyConfigFiles(root);
  addFrameworkBlocks(root);
  addToolingFiles(root);
}

/** Framework configuration blocks several analysers read from framework.yaml. */
export function addFrameworkBlocks(root: string): void {
  put(root, 'config/packages/framework.yaml', [
    'framework:',
    '    secret: "%env(APP_SECRET)%"',
    '    session:',
    '        handler_id: null',
    '        cookie_secure: auto',
    '        cookie_samesite: lax',
    '    php_errors:',
    '        log: true',
    '    trusted_proxies: "127.0.0.1,10.0.0.0/8"',
    '    trusted_headers: ["x-forwarded-for", "x-forwarded-proto"]',
    '',
    '    assets:',
    '        version: "v3"',
    '        version_format: "%%s?version=%%s"',
    '        json_manifest_path: "%kernel.project_dir%/public/build/manifest.json"',
    '        packages:',
    '            images:',
    '                base_urls: ["https://cdn.example.com"]',
    '',
    '    http_client:',
    '        default_options:',
    '            timeout: 30',
    '            max_redirects: 3',
    '        scoped_clients:',
    '            github.client:',
    '                base_uri: "https://api.github.com"',
    '                auth_bearer: "%env(GITHUB_TOKEN)%"',
    '            internal.client:',
    '                base_uri: "http://127.0.0.1:8080"',
    '                verify_peer: false',
    '            legacy.client:',
    '                base_uri: "http://localhost:9000"',
    '',
    '    translator:',
    '        default_path: "%kernel.project_dir%/translations"',
    '        fallbacks: [en]',
    '        providers:',
    '            crowdin:',
    '                dsn: "%env(CROWDIN_DSN)%"',
    '                locales: [en, es]',
    '',
    '    rate_limiter:',
    '        anonymous:',
    '            policy: "sliding_window"',
    '            limit: 100',
    '            interval: "60 minutes"',
    '        authenticated:',
    '            policy: "token_bucket"',
    '            limit: 5000',
    '            rate: { interval: "15 minutes", amount: 500 }',
  ].join('\n') + '\n');

  put(root, 'config/packages/twig.yaml', [
    'twig:',
    '    default_path: "%kernel.project_dir%/templates"',
    '    form_themes: ["bootstrap_5_layout.html.twig"]',
    '    paths:',
    '        "%kernel.project_dir%/templates/email": email',
    '        "%kernel.project_dir%/vendor/acme/theme/templates": AcmeTheme',
    '    globals:',
    '        app_name: "Demo"',
    '    strict_variables: true',
  ].join('\n') + '\n');

  put(root, 'config/packages/saml.yaml', [
    'nbgrp_onelogin_saml:',
    '    onelogin_settings:',
    '        default:',
    '            idp:',
    '                entityId: "https://idp.example.com/metadata"',
    '                singleSignOnService:',
    '                    url: "https://idp.example.com/sso"',
    '                    binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"',
    '            sp:',
    '                entityId: "https://app.example.com/saml/metadata"',
    '                assertionConsumerService:',
    '                    url: "https://app.example.com/saml/acs"',
    '            security:',
    '                wantAssertionsSigned: true',
    '                wantMessagesSigned: true',
    '                requestedAuthnContext: false',
  ].join('\n') + '\n');
}

/** Static-analysis and container configuration read from their own files. */
export function addToolingFiles(root: string): void {
  put(root, 'taskdef.json', JSON.stringify({
    family: 'acme-app',
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    containerDefinitions: [{
      name: 'php',
      image: 'acme/app:latest',
      essential: true,
      privileged: false,
      portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
      environment: [{ name: 'APP_ENV', value: 'prod' }],
      secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:aws:ssm:eu-west-1:0:parameter/db' }],
      healthCheck: { command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'], interval: 30 },
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/acme' } },
    }],
  }, null, 2));

  put(root, 'deptrac.yaml', [
    'deptrac:',
    '    paths: ["./src"]',
    '    layers:',
    '        - name: Controller',
    '          collectors:',
    '              - type: directory',
    '                value: src/Controller/.*',
    '        - name: Service',
    '          collectors:',
    '              - type: directory',
    '                value: src/Service/.*',
    '        - name: Entity',
    '          collectors:',
    '              - type: directory',
    '                value: src/Entity/.*',
    '    ruleset:',
    '        Controller: [Service]',
    '        Service: [Entity]',
    '        Entity: ~',
  ].join('\n') + '\n');

  put(root, 'ecs.php', [
    '<?php',
    '',
    'use Symplify\\EasyCodingStandard\\Config\\ECSConfig;',
    '',
    'return ECSConfig::configure()',
    '    ->withPaths([__DIR__ . "/src", __DIR__ . "/tests"])',
    '    ->withPreparedSets(psr12: true, common: true)',
    '    ->withPhpCsFixerSets(symfony: true);',
  ].join('\n') + '\n');

  put(root, 'docker/nginx/default.conf', [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /var/www/public;',
    '',
    '    location / {',
    '        try_files $uri /index.php$is_args$args;',
    '    }',
    '',
    '    location ~ ^/index\\.php(/|$) {',
    '        fastcgi_pass php:9000;',
    '        fastcgi_split_path_info ^(.+\\.php)(/.*)$;',
    '        include fastcgi_params;',
    '        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;',
    '        fastcgi_buffers 16 16k;',
    '        fastcgi_read_timeout 60;',
    '        internal;',
    '    }',
    '',
    '    location ~ \\.php$ {',
    '        return 404;',
    '    }',
    '}',
  ].join('\n') + '\n');

  put(root, 'docker/php/www.conf', [
    '[www]',
    'user = www-data',
    'group = www-data',
    'listen = 9000',
    'pm = dynamic',
    'pm.max_children = 20',
    'pm.start_servers = 4',
    'pm.min_spare_servers = 2',
    'pm.max_spare_servers = 6',
    'pm.max_requests = 500',
    'clear_env = no',
  ].join('\n') + '\n');
}
