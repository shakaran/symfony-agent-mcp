/**
 * Health Check & Readiness Probe Inspector
 *
 * Detects health/readiness/liveness endpoints and patterns:
 *
 * 1. Route-based detection: scans routes.yaml + annotations for paths
 *    matching /health, /ping, /ready, /live, /status, /healthz, /readyz
 *
 * 2. Bundle detection:
 *    - liip/monitor-bundle (LiipMonitorBundle)
 *    - symfony/health-check-bundle
 *    - Custom HealthCheckInterface / HealthIndicatorInterface implementations
 *
 * 3. Controller scanning: looks for controller classes/methods whose name
 *    contains health/ping/ready/live/status
 *
 * 4. Check implementations: DiagnosticsController, custom checks implementing
 *    HealthCheck, CheckInterface, HealthIndicator, etc.
 *
 * Reports:
 *   - All health endpoints found with their paths
 *   - Whether DB/Redis/Mailer checks are present
 *   - Missing readiness probe (critical for Kubernetes)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface HealthEndpoint {
  path: string;
  method?: string;
  controller?: string;
  source: 'route' | 'controller' | 'bundle';
}

interface HealthCheck {
  class: string;
  file: string;
  kind: string;
  checks?: string[];
}

// ─── Health route patterns ───────────────────────────────────────────────────

const HEALTH_PATH_PATTERNS = [
  /^\/(health|healthz|health-check)(\/|$)/i,
  /^\/(ready|readiness|readyz)(\/|$)/i,
  /^\/(live|liveness|livez)(\/|$)/i,
  /^\/(ping|status|up)(\/|$)/i,
  /^\/(diagnostic|monitor)(\/|$)/i,
];

function isHealthPath(p: string): boolean {
  return HEALTH_PATH_PATTERNS.some((re) => re.test(p));
}

// ─── File scanning ───────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

// ─── Route scanning ──────────────────────────────────────────────────────────

function scanRoutesForHealth(appPath: string): HealthEndpoint[] {
  const endpoints: HealthEndpoint[] = [];

  // YAML routes
  const routeDirs = [
    path.join(appPath, 'config', 'routes'),
    path.join(appPath, 'config'),
  ];
  const yamlFiles: string[] = [];
  for (const dir of routeDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.yaml') || f.endsWith('.yml')) {
          yamlFiles.push(path.join(dir, f));
        }
      }
    } catch { /* skip */ }
  }

  for (const file of yamlFiles) {
    const raw = parseYamlFile(file) as Record<string, unknown> | null;
    if (!raw) continue;
    for (const [, def] of Object.entries(raw)) {
      if (!def || typeof def !== 'object') continue;
      const route = def as Record<string, unknown>;
      const routePath = route['path'] ? String(route['path']) : '';
      if (isHealthPath(routePath)) {
        endpoints.push({
          path: routePath,
          controller: route['controller'] ? String(route['controller']) : undefined,
          source: 'route',
        });
      }
    }
  }

  return endpoints;
}

// ─── Controller scanning ─────────────────────────────────────────────────────

function scanHealthControllers(appPath: string): HealthEndpoint[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const endpoints: HealthEndpoint[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;
    const className = classM[1];

    // Class name check
    const isHealthClass = /health|ping|ready|liveness|status|diagnostic|monitor/i.test(className);

    // Extract #[Route] paths from health-looking methods or classes
    for (const m of content.matchAll(/#\[Route\s*\(\s*['"]([^'"]+)['"]/g)) {
      const routePath = m[1];
      if (isHealthPath(routePath) || isHealthClass) {
        endpoints.push({ path: routePath, controller: className, source: 'controller' });
      }
    }
  }

  return endpoints;
}

// ─── Bundle / check implementation scanning ──────────────────────────────────

const HEALTH_CHECK_INTERFACES = [
  'HealthCheck',
  'CheckInterface',
  'HealthIndicator',
  'HealthIndicatorInterface',
  'DiagnosticInterface',
  'AbstractHealthCheck',
];

function scanHealthChecks(appPath: string): HealthCheck[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const checks: HealthCheck[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isCheck = HEALTH_CHECK_INTERFACES.some((iface) => content.includes(iface));
    if (!isCheck) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const kind = HEALTH_CHECK_INTERFACES.find((iface) => content.includes(iface)) ?? 'HealthCheck';

    // Detect what it checks
    const checkTargets: string[] = [];
    if (content.includes('DatabaseChecker') || content.includes('EntityManager') || content.includes('Connection')) checkTargets.push('database');
    if (content.includes('Redis') || content.includes('RedisClient'))  checkTargets.push('redis');
    if (content.includes('Mailer') || content.includes('MailerInterface')) checkTargets.push('mailer');
    if (content.includes('HttpClient') || content.includes('HttpClientInterface')) checkTargets.push('http');
    if (content.includes('Memcached') || content.includes('Memcache')) checkTargets.push('memcached');

    checks.push({
      class: classM[1],
      file: path.basename(file),
      kind,
      checks: checkTargets,
    });
  }

  return checks.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Bundle detection ────────────────────────────────────────────────────────

function detectHealthBundles(appPath: string): string[] {
  const bundlesFile = path.join(appPath, 'config', 'bundles.php');
  const bundles: string[] = [];

  try {
    const content = fs.readFileSync(bundlesFile, 'utf-8');
    if (content.includes('LiipMonitor'))   bundles.push('liip/monitor-bundle');
    if (content.includes('HealthCheck'))   bundles.push('symfony/health-check-bundle');
    if (content.includes('PingController'))bundles.push('custom health bundle');
  } catch { /* skip */ }

  // Check composer.json
  try {
    const composerRaw = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    const composer = JSON.parse(composerRaw) as Record<string, Record<string, string>>;
    const allDeps = { ...composer['require'], ...composer['require-dev'] };
    if (allDeps['liip/monitor-bundle'])           bundles.push('liip/monitor-bundle (composer)');
    if (allDeps['symfony/health-check-bundle'])   bundles.push('symfony/health-check-bundle (composer)');
  } catch { /* skip */ }

  return [...new Set(bundles)];
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listHealthChecks(appPath: string): McpToolResult {
  try {
    const routeEndpoints = scanRoutesForHealth(appPath);
    const controllerEndpoints = scanHealthControllers(appPath);
    const checks = scanHealthChecks(appPath);
    const bundles = detectHealthBundles(appPath);

    const allEndpoints = [...routeEndpoints, ...controllerEndpoints];
    const uniquePaths = [...new Set(allEndpoints.map((e) => e.path))];

    const hasLiveness   = uniquePaths.some((p) => /live|livez/i.test(p));
    const hasReadiness  = uniquePaths.some((p) => /ready|readyz/i.test(p));
    const hasHealth     = uniquePaths.some((p) => /health|healthz/i.test(p));
    const hasPing       = uniquePaths.some((p) => /ping/i.test(p));

    let text = `Health Checks & Readiness Probes\n${'='.repeat(55)}\n`;

    if (bundles.length > 0) {
      text += `\nHealth bundles: ${bundles.join(', ')}\n`;
    }

    if (uniquePaths.length === 0) {
      text += `\n⚠ No health endpoints found.\n`;
      text += `\nRecommended (Kubernetes):\n`;
      text += `  /healthz    — overall health\n`;
      text += `  /readyz     — readiness probe (app ready to serve traffic)\n`;
      text += `  /livez      — liveness probe (app alive, restart if fails)\n`;
    } else {
      text += `\nHealth endpoints (${uniquePaths.length}):\n`;
      for (const ep of allEndpoints) {
        const ctrl = ep.controller ? `  → ${ep.controller}` : '';
        text += `  ${ep.path.padEnd(30)} [${ep.source}]${ctrl}\n`;
      }

      const k8sStatus: string[] = [];
      if (hasLiveness)  k8sStatus.push('liveness');
      if (hasReadiness) k8sStatus.push('readiness');
      if (hasHealth)    k8sStatus.push('health');
      if (hasPing)      k8sStatus.push('ping');

      text += `\nKubernetes probe coverage:\n`;
      text += `  Liveness:   ${hasLiveness  ? 'yes' : '⚠ missing'}\n`;
      text += `  Readiness:  ${hasReadiness ? 'yes' : '⚠ missing'}\n`;
    }

    if (checks.length > 0) {
      text += `\nHealth check implementations (${checks.length}):\n`;
      for (const c of checks) {
        const targets = c.checks && c.checks.length > 0 ? `  [checks: ${c.checks.join(', ')}]` : '';
        text += `  ${c.class.padEnd(40)} ${c.kind}${targets}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHealthCheckStats(appPath: string): McpToolResult {
  try {
    const routeEndpoints = scanRoutesForHealth(appPath);
    const controllerEndpoints = scanHealthControllers(appPath);
    const checks = scanHealthChecks(appPath);
    const bundles = detectHealthBundles(appPath);

    const allPaths = [...new Set([...routeEndpoints, ...controllerEndpoints].map((e) => e.path))];

    let text = `Health Check Statistics\n${'='.repeat(40)}\n\n`;
    text += `Health endpoints:    ${allPaths.length}\n`;
    text += `Check implementations: ${checks.length}\n`;
    text += `Health bundles:      ${bundles.length}\n`;
    text += `Liveness probe:      ${allPaths.some((p) => /live/i.test(p)) ? 'yes' : 'no'}\n`;
    text += `Readiness probe:     ${allPaths.some((p) => /ready/i.test(p)) ? 'yes' : 'no'}\n`;

    if (allPaths.length === 0) {
      text += `\n⚠ No health endpoints detected — recommended for Kubernetes/Docker deployments.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getHealthCheckTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_health_checks',
      description: 'List health check and readiness probe endpoints (/health, /readyz, /livez), check implementations, health bundles, Kubernetes probe coverage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_health_check_stats',
      description: 'Show health check statistics: endpoint count, check implementations, liveness/readiness coverage, health bundle detection',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
