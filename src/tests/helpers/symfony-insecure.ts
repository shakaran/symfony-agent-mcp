// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * The other side of every setting the analysers check.
 *
 * Both fixtures were given the same area configuration, so a check of the form
 * "is this enabled" only ever saw one answer and its other branch never ran.
 * This overwrites the area files with the opposite values and applies only to
 * the broken fixture, so between the two every such check sees both.
 *
 * Written as the misconfiguration a real application drifts into, not as
 * nonsense: debug left on in production, a messenger transport with retries
 * disabled, a workflow with an unreachable place, caching turned off.
 */

import * as fs from 'fs';
import * as path from 'path';

function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function addInsecureVariants(root: string): void {
  // Messenger with no failure transport, no retries, everything synchronous.
  put(root, 'config/packages/messenger.yaml', [
    'framework:',
    '    messenger:',
    '        transports:',
    '            async:',
    '                dsn: "sync://"',
    '                retry_strategy:',
    '                    max_retries: 0',
    '            external:',
    '                dsn: "amqp://guest:guest@rabbitmq:5672/%2f/orders"',
    '        routing:',
    '            "App\\Message\\SendEmail": sync',
    '        buses:',
    '            command.bus:',
    '                default_middleware: false',
  ].join('\n') + '\n');

  // A workflow with a place nothing transitions into and no audit trail.
  put(root, 'config/packages/workflow.yaml', [
    'framework:',
    '    workflows:',
    '        broken_flow:',
    '            type: state_machine',
    '            audit_trail:',
    '                enabled: false',
    '            marking_store:',
    '                type: method',
    '                property: status',
    '            supports: ["App\\Entity\\Order"]',
    '            initial_marking: draft',
    '            places: [draft, pending, orphaned, done]',
    '            transitions:',
    '                submit:',
    '                    from: draft',
    '                    to: pending',
    '                finish:',
    '                    from: pending',
    '                    to: done',
  ].join('\n') + '\n');

  // Caching off, profiler collecting in production.
  put(root, 'config/packages/cache.yaml', [
    'framework:',
    '    cache:',
    '        app: cache.adapter.array',
    '        pools: {}',
  ].join('\n') + '\n');

  put(root, 'config/packages/web_profiler.yaml', [
    'web_profiler:',
    '    toolbar: true',
    '    intercept_redirects: true',
    'framework:',
    '    profiler:',
    '        only_exceptions: false',
    '        collect: true',
    '        collect_serializer_data: true',
  ].join('\n') + '\n');

  // Monolog writing everything to one file at debug level, no rotation.
  put(root, 'config/packages/monolog.yaml', [
    'monolog:',
    '    handlers:',
    '        main:',
    '            type: stream',
    '            path: "%kernel.logs_dir%/app.log"',
    '            level: debug',
  ].join('\n') + '\n');

  // Rate limiting with a single permissive policy.
  put(root, 'config/packages/rate_limiter.yaml', [
    'framework:',
    '    rate_limiter:',
    '        api:',
    '            policy: "fixed_window"',
    '            limit: 100000',
    '            interval: "1 second"',
  ].join('\n') + '\n');

  // API Platform paginating without a ceiling and exposing everything.
  put(root, 'config/packages/api_platform.yaml', [
    'api_platform:',
    '    title: Legacy API',
    '    defaults:',
    '        pagination_enabled: true',
    '        pagination_client_items_per_page: true',
    '        pagination_maximum_items_per_page: 10000',
    '    show_webby: true',
  ].join('\n') + '\n');

  // HTTP client with verification off everywhere and no timeout.
  put(root, 'config/packages/http_client.yaml', [
    'framework:',
    '    http_client:',
    '        default_options:',
    '            verify_peer: false',
    '            verify_host: false',
    '            timeout: 0',
    '        scoped_clients:',
    '            insecure.client:',
    '                base_uri: "http://legacy.internal"',
    '                verify_peer: false',
  ].join('\n') + '\n');

  // Serializer with circular references left to blow up.
  put(root, 'config/packages/serializer.yaml', [
    'framework:',
    '    serializer:',
    '        enable_annotations: false',
    '        circular_reference_handler: null',
    '        max_depth_handler: null',
  ].join('\n') + '\n');

  // Lazy services declared but never marked lazy.
  put(root, 'config/packages/lazy_services.yaml', [
    'services:',
    '    "App\\Service\\HeavyService":',
    '        lazy: false',
    '        public: true',
  ].join('\n') + '\n');
}

/**
 * Rename the configuration to the .yml spelling.
 *
 * Symfony loads either, and a project predating Flex — or migrated from
 * Symfony 3 — uses .yml throughout. Applied to the broken fixture only, so
 * between the two every candidate list is exercised in both spellings.
 */
export function useYmlSpelling(root: string): void {
  const dir = path.join(root, 'config', 'packages');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.yaml')) continue;
    const from = path.join(dir, name);
    const to = path.join(dir, name.replace(/\.yaml$/, '.yml'));
    try {
      fs.renameSync(from, to);
    } catch {
      // Leave it where it is if the rename cannot happen.
    }
  }
}
