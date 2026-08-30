// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * A seventh batch: profiles the profiler can actually read, a full Netlify
 * file, static-analysis configuration in the shapes the parsers expect, and
 * Kubernetes manifests with the problems the manifest reader looks for.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

function put(root: string, rel: string, content: string | Buffer): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function profile(token: string, opts: { queries: number; errors: number; exception: boolean }): Buffer {
  const data = {
    time: { duration: 184.2, init_time: 12.7, events: {} },
    memory: { memory: 18874368, memory_limit: 134217728 },
    db: {
      query_count: opts.queries,
      time: 0.0421,
      queries: Array.from({ length: Math.min(opts.queries, 25) }, (_, i) => ({
        sql: `SELECT t0.id, t0.title FROM article t0 WHERE t0.slug = ? LIMIT ${i + 1}`,
        executionMS: 0.0012 * (i + 1),
        params: [`slug-${i}`],
      })),
    },
    logger: {
      error_count: opts.errors,
      warning_count: 2,
      logs: [
        { message: 'Matched route "app_home".', priority: '200', priorityName: 'INFO', channel: 'request' },
        { message: 'Slow query detected', priority: '300', priorityName: 'WARNING', channel: 'doctrine' },
        { message: 'Uncaught exception', priority: '400', priorityName: 'ERROR', channel: 'request' },
      ],
    },
    exception: opts.exception
      ? { has_exception: true, class: 'RuntimeException', message: 'Payment gateway timed out', status_code: 500 }
      : { has_exception: false },
    request: {
      method: 'GET',
      status_code: opts.exception ? 500 : 200,
      route: 'app_home',
      controller: 'App\\Controller\\HomeController::index',
    },
  };

  void token;

  return zlib.gzipSync(Buffer.from(JSON.stringify(data)));
}

function profiler(root: string): void {
  // Symfony's own layout: the last two characters, then the two before those.
  const tokens: Array<[string, { queries: number; errors: number; exception: boolean }]> = [
    ['a1b2c3', { queries: 14, errors: 0, exception: false }],
    ['b1c2d3', { queries: 62, errors: 3, exception: true }],
    ['e4f5a6', { queries: 1, errors: 0, exception: false }],
    ['a7b8c9', { queries: 0, errors: 1, exception: false }],
  ];

  for (const [token, opts] of tokens) {
    put(root, path.join('var/cache/dev/profiler', token.slice(-2), token.slice(-4, -2), token), profile(token, opts));
  }

  put(root, 'var/cache/dev/profiler/index.csv', [
    'a1b2c3,127.0.0.1,GET,http://localhost/,1756000000,,200,request',
    'b1c2d3,127.0.0.1,POST,http://localhost/orders,1756000200,,500,request',
    'e4f5a6,10.0.0.4,GET,http://localhost/api/v2/orders,1756000400,,404,request',
    'a7b8c9,10.0.0.4,GET,http://localhost/admin,1756000600,a1b2c3,302,request',
  ].join('\n') + '\n');
}

function deployment(root: string): void {
  put(root, 'netlify.toml', [
    '[build]',
    '    command = "composer install --no-dev && bin/console cache:warmup"',
    '    publish = "public"',
    '    functions = "netlify/functions"',
    '',
    '[build.environment]',
    '    PHP_VERSION = "8.3"',
    '    NODE_VERSION = "20"',
    '    API_TOKEN = "7f3d9a2b6c1e45089a11bb22cc33dd44"',
    '',
    '[[redirects]]',
    '    from = "/api/*"',
    '    to = "https://api.example.com/:splat"',
    '    status = 200',
    '    force = true',
    '',
    '[[redirects]]',
    '    from = "/*"',
    '    to = "/index.html"',
    '    status = 200',
    '',
    '[[headers]]',
    '    for = "/*"',
    '',
    '    [headers.values]',
    '        X-Frame-Options = "DENY"',
    '        X-Content-Type-Options = "nosniff"',
    '        Content-Security-Policy = "default-src \'self\'"',
    '        Permissions-Policy = "geolocation=()"',
    '        Authorization = "Bearer 7f3d9a2b6c1e45089a11bb22cc33dd44"',
    '',
    '[functions]',
    '    directory = "netlify/functions"',
    '    node_bundler = "esbuild"',
    '',
    '[dev]',
    '    command = "symfony serve"',
    '    port = 8888',
    '',
    '[context.production.environment]',
    '    APP_ENV = "prod"',
    '    DATABASE_URL = "postgresql://acme:hunter2@db.example.com:5432/acme"',
  ].join('\n') + '\n');

  put(root, 'k8s/deployment.yaml', [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '    name: acme-app',
    '    labels:',
    '        app: acme',
    'spec:',
    '    replicas: 1',
    '    selector:',
    '        matchLabels:',
    '            app: acme',
    '    template:',
    '        metadata:',
    '            labels:',
    '                app: acme',
    '        spec:',
    '            containers:',
    '                - name: php',
    '                  image: acme/app:latest',
    '                  imagePullPolicy: Always',
    '                  ports:',
    '                      - containerPort: 9000',
    '                  env:',
    '                      - name: APP_ENV',
    '                        value: prod',
    '                      - name: DATABASE_PASSWORD',
    '                        value: "hunter2-in-the-manifest"',
    '                  securityContext:',
    '                      runAsUser: 0',
    '                      privileged: true',
    '                      allowPrivilegeEscalation: true',
  ].join('\n') + '\n');

  put(root, 'k8s/service.yaml', [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '    name: acme-app',
    'spec:',
    '    type: LoadBalancer',
    '    selector:',
    '        app: acme',
    '    ports:',
    '        - port: 80',
    '          targetPort: 9000',
  ].join('\n') + '\n');

  put(root, 'k8s/worker.yaml', [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '    name: acme-worker',
    'spec:',
    '    replicas: 3',
    '    template:',
    '        spec:',
    '            containers:',
    '                - name: worker',
    '                  image: acme/app:1.4.0',
    '                  command: ["bin/console", "messenger:consume", "async"]',
    '                  resources:',
    '                      requests:',
    '                          cpu: 100m',
    '                          memory: 256Mi',
    '                      limits:',
    '                          cpu: 500m',
    '                          memory: 512Mi',
    '                  livenessProbe:',
    '                      exec:',
    '                          command: ["bin/console", "messenger:stats"]',
    '                      initialDelaySeconds: 30',
    '                  readinessProbe:',
    '                      httpGet:',
    '                          path: /health',
    '                          port: 9000',
  ].join('\n') + '\n');

  put(root, 'k8s/ingress.yaml', [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '    name: acme-app',
    '    annotations:',
    '        nginx.ingress.kubernetes.io/proxy-body-size: 20m',
    'spec:',
    '    tls:',
    '        - hosts: [acme.example.com]',
    '          secretName: acme-tls',
    '    rules:',
    '        - host: acme.example.com',
    '          http:',
    '              paths:',
    '                  - path: /',
    '                    pathType: Prefix',
    '                    backend:',
    '                        service:',
    '                            name: acme-app',
    '                            port:',
    '                                number: 80',
  ].join('\n') + '\n');

  put(root, 'k8s/hpa.yaml', [
    'apiVersion: autoscaling/v2',
    'kind: HorizontalPodAutoscaler',
    'metadata:',
    '    name: acme-app',
    'spec:',
    '    scaleTargetRef:',
    '        apiVersion: apps/v1',
    '        kind: Deployment',
    '        name: acme-app',
    '    minReplicas: 2',
    '    maxReplicas: 10',
    '    metrics:',
    '        - type: Resource',
    '          resource:',
    '              name: cpu',
    '              target:',
    '                  type: Utilization',
    '                  averageUtilization: 70',
  ].join('\n') + '\n');

  put(root, 'k8s/configmap.yaml', [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '    name: acme-config',
    'data:',
    '    APP_ENV: prod',
    '    APP_DEBUG: "0"',
    '    MAILER_DSN: "smtp://acme:hunter2@smtp.example.com:25"',
  ].join('\n') + '\n');

  put(root, 'k8s/secret.yaml', [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '    name: acme-secrets',
    'type: Opaque',
    'stringData:',
    '    DATABASE_PASSWORD: hunter2',
    '    APP_SECRET: 7f3d9a2b6c1e45089a11bb22cc33dd44',
  ].join('\n') + '\n');
}

/** Everything in this file. */
export function addBatchSeven(root: string): void {
  profiler(root);
  deployment(root);
}
