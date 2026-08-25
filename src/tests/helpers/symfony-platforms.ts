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
}
