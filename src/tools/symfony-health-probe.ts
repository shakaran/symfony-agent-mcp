/**
 * Symfony Health Probe Inspector
 *
 * Scans src/ PHP for:
 *   - HealthIndicatorInterface implementations
 *   - AbstractHealthIndicator
 *   - Health check HTTP endpoints (#[Route('/health')], /ready, /ping, /status, /livez, /readyz)
 *
 * Reads docker-compose.yml, Dockerfile, kubernetes manifests (*.yaml in deploy/ or k8s/)
 * for healthcheck: and livenessProbe:/readinessProbe:.
 *
 * Detects:
 *   - Readiness vs liveness probe distinction
 *
 * Warns:
 *   - Single /health endpoint for both liveness and readiness (K8s restarts healthy app when DB slow)
 *   - Health endpoint hitting DB without timeout (slow DB causes cascade)
 *   - Health probe not authenticated (info exposure)
 *   - Missing health probe in Docker config when DB dependency exists
 *   - Health probe with too frequent check interval (<5s)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface HealthProbeInfo {
  file?: string;
  routePath?: string;
  type: 'liveness' | 'readiness' | 'generic';
  hasDbCheck: boolean;
  hasTimeout: boolean;
  isAuthenticated: boolean;
  dockerInterval?: string;
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getYamlFiles(full));
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

// ─── Health route constants ───────────────────────────────────────────────────

const HEALTH_ROUTE_PATTERNS = [
  '/health', '/ready', '/readyz', '/livez', '/ping', '/status', '/healthz',
];

const LIVENESS_PATTERNS  = ['/livez', '/liveness', '/alive'];
const READINESS_PATTERNS = ['/readyz', '/readiness', '/ready'];

const DB_CHECK_INDICATORS = [
  'entityManager', 'getRepository', 'createQuery', 'connection',
  'DBAL', 'PDO', 'executeQuery', '$em->', 'doctrine',
];

// ─── PHP health endpoint scanning ────────────────────────────────────────────

function scanPhpHealthEndpoints(appPath: string): HealthProbeInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const probes: HealthProbeInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isHealthIndicator =
      content.includes('HealthIndicatorInterface') ||
      content.includes('AbstractHealthIndicator');

    // Scan for route-based health endpoints
    const routeRe = /#\[Route\s*\(\s*['"]([^'"]{1,100})['"]/g;
    let routeM: RegExpExecArray | null;
    const foundRoutes: string[] = [];
    while ((routeM = routeRe.exec(content)) !== null) {
      const routePath = routeM[1];
      if (HEALTH_ROUTE_PATTERNS.some((p) => routePath.includes(p))) {
        foundRoutes.push(routePath);
      }
    }

    if (!isHealthIndicator && foundRoutes.length === 0) continue;

    const hasDbCheck = DB_CHECK_INDICATORS.some((ind) => content.includes(ind));
    const hasTimeout =
      content.includes('timeout') ||
      content.includes('Timeout') ||
      content.includes('setOption') ||
      content.includes('CURLOPT_TIMEOUT');
    const isAuthenticated =
      content.includes('#[IsGranted') ||
      content.includes('#[Security') ||
      content.includes('denyAccessUnlessGranted') ||
      content.includes('isGranted');

    if (isHealthIndicator) {
      const issues: string[] = [];
      if (hasDbCheck && !hasTimeout) {
        issues.push(
          `HealthIndicator hits DB without apparent timeout. ` +
          `A slow DB will cause the health check to time out, cascading failures.`,
        );
      }
      probes.push({
        file: path.basename(file),
        type: 'generic',
        hasDbCheck,
        hasTimeout,
        isAuthenticated,
        issues,
      });
    }

    for (const routePath of foundRoutes) {
      const issues: string[] = [];
      let type: HealthProbeInfo['type'] = 'generic';
      if (LIVENESS_PATTERNS.some((p) => routePath.includes(p))) type = 'liveness';
      else if (READINESS_PATTERNS.some((p) => routePath.includes(p))) type = 'readiness';

      if (!isAuthenticated) {
        issues.push(
          `Health endpoint ${routePath} is not authenticated. ` +
          `Could expose infrastructure information to unauthenticated callers.`,
        );
      }
      if (hasDbCheck && !hasTimeout) {
        issues.push(
          `Health endpoint ${routePath} hits DB without apparent timeout. ` +
          `A slow DB will cause the health probe to time out and trigger restarts.`,
        );
      }

      probes.push({
        file: path.basename(file),
        routePath,
        type,
        hasDbCheck,
        hasTimeout,
        isAuthenticated,
        issues,
      });
    }
  }

  return probes;
}

// ─── Docker / K8s health config scanning ─────────────────────────────────────

interface DockerHealthInfo {
  hasHealthcheck: boolean;
  interval?: string;
  hasDbDependency: boolean;
  hasDependsOn: boolean;
}

function scanDockerConfig(appPath: string): DockerHealthInfo {
  const candidates = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
    path.join(appPath, 'Dockerfile'),
  ];

  let hasHealthcheck = false;
  let interval: string | undefined;
  let hasDbDependency = false;
  let hasDependsOn = false;

  for (const f of candidates) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('healthcheck:') || /HEALTHCHECK\s/.test(content)) {
        hasHealthcheck = true;
        const intervalM = /interval\s*:\s*([^\n]{1,20})/.exec(content);
        if (intervalM) interval = intervalM[1].trim();
        const dockerfileIntervalM = /--interval=([^\s]{1,20})/.exec(content);
        if (dockerfileIntervalM) interval = dockerfileIntervalM[1];
      }
      if (/postgres|mysql|mariadb|mongodb|redis|elasticsearch/i.test(content)) {
        hasDbDependency = true;
      }
      if (content.includes('depends_on:')) hasDependsOn = true;
    } catch { /* skip */ }
  }

  return { hasHealthcheck, interval, hasDbDependency, hasDependsOn };
}

interface K8sProbeInfo {
  hasLivenessProbe: boolean;
  hasReadinessProbe: boolean;
  periodSeconds?: number;
}

function scanK8sManifests(appPath: string): K8sProbeInfo {
  const dirs = ['deploy', 'k8s', 'kubernetes', '.kubernetes'];
  let hasLivenessProbe = false;
  let hasReadinessProbe = false;
  let periodSeconds: number | undefined;

  for (const dir of dirs) {
    const fullDir = path.join(appPath, dir);
    if (!fs.existsSync(fullDir)) continue;
    for (const f of getYamlFiles(fullDir)) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        if (content.includes('livenessProbe:')) hasLivenessProbe = true;
        if (content.includes('readinessProbe:')) hasReadinessProbe = true;
        const periodM = /periodSeconds\s*:\s*(\d{1,5})/.exec(content);
        if (periodM) {
          const val = parseInt(periodM[1], 10);
          periodSeconds = periodSeconds === undefined ? val : Math.min(periodSeconds, val);
        }
      } catch { /* skip */ }
    }
  }

  return { hasLivenessProbe, hasReadinessProbe, periodSeconds };
}

// ─── Main analysis ────────────────────────────────────────────────────────────

function analyze(appPath: string): {
  probes: HealthProbeInfo[];
  systemIssues: string[];
} {
  const probes = scanPhpHealthEndpoints(appPath);
  const docker = scanDockerConfig(appPath);
  const k8s    = scanK8sManifests(appPath);
  const systemIssues: string[] = [];

  // Single generic endpoint for both liveness and readiness
  const genericProbes = probes.filter((p) => p.type === 'generic' && p.routePath);
  const livenessProbes  = probes.filter((p) => p.type === 'liveness');
  const readinessProbes = probes.filter((p) => p.type === 'readiness');

  if (genericProbes.length > 0 && livenessProbes.length === 0 && readinessProbes.length === 0) {
    systemIssues.push(
      `Only generic health endpoints found (no /livez or /readyz). ` +
      `Kubernetes uses separate liveness and readiness probes — a combined endpoint ` +
      `causes K8s to restart the pod when the DB is slow (liveness=readiness problem).`,
    );
  }

  if (docker.hasDbDependency && !docker.hasHealthcheck) {
    systemIssues.push(
      `docker-compose has DB dependency but no healthcheck: defined. ` +
      `The app container may start before the DB is ready without a health check.`,
    );
  }

  if (k8s.hasLivenessProbe && !k8s.hasReadinessProbe) {
    systemIssues.push(
      `Kubernetes manifests have livenessProbe but no readinessProbe. ` +
      `Without a readinessProbe, traffic is sent to pods that are not yet ready.`,
    );
  }

  if (k8s.periodSeconds !== undefined && k8s.periodSeconds < 5) {
    systemIssues.push(
      `Kubernetes probe period is ${k8s.periodSeconds}s (<5s). ` +
      `Very frequent probes create unnecessary load on the application and DB.`,
    );
  }

  // Docker interval check
  if (docker.interval) {
    const secM = /(\d{1,4})s/.exec(docker.interval);
    const ms = secM ? parseInt(secM[1], 10) : null;
    if (ms !== null && ms < 5) {
      systemIssues.push(
        `Docker healthcheck interval is ${docker.interval} (<5s). ` +
        `Frequent health checks create unnecessary load.`,
      );
    }
  }

  return { probes, systemIssues };
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listHealthProbes(appPath: string): McpToolResult {
  try {
    const { probes, systemIssues } = analyze(appPath);

    if (probes.length === 0 && systemIssues.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No health probes found in src/ or Docker/Kubernetes configs.\n\n' +
            'Add health endpoints:\n' +
            '  #[Route(\'/health\')]\n' +
            '  #[Route(\'/readyz\')]\n' +
            '  #[Route(\'/livez\')]\n\n' +
            'Or implement HealthIndicatorInterface for Symfony health checks.',
        }],
      };
    }

    const withIssues  = probes.filter((p) => p.issues.length > 0);
    const liveness    = probes.filter((p) => p.type === 'liveness');
    const readiness   = probes.filter((p) => p.type === 'readiness');
    const generic     = probes.filter((p) => p.type === 'generic');

    let text = `Symfony Health Probe Analysis\n${'='.repeat(55)}\n`;
    text += `  Total probes:     ${probes.length}\n`;
    text += `  Liveness:         ${liveness.length}\n`;
    text += `  Readiness:        ${readiness.length}\n`;
    text += `  Generic:          ${generic.length}\n`;
    text += `  With issues:      ${withIssues.length + systemIssues.length}\n\n`;

    if (systemIssues.length > 0) {
      text += `System-level issues:\n`;
      for (const issue of systemIssues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    for (const probe of probes) {
      const label = probe.routePath ?? probe.file ?? '(unknown)';
      text += `${label} [${probe.type}]`;
      if (probe.file) text += ` (${probe.file})`;
      text += '\n';
      text += `  DB check: ${probe.hasDbCheck ? 'yes' : 'no'}`;
      text += `  timeout: ${probe.hasTimeout ? 'yes' : 'no'}`;
      text += `  authenticated: ${probe.isAuthenticated ? 'yes' : 'no'}\n`;
      for (const issue of probe.issues) {
        text += `  WARN: ${issue}\n`;
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getHealthProbeStats(appPath: string): McpToolResult {
  try {
    const { probes, systemIssues } = analyze(appPath);

    let text = `Health Probe Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total probes:          ${probes.length}\n`;
    text += `Liveness probes:       ${probes.filter((p) => p.type === 'liveness').length}\n`;
    text += `Readiness probes:      ${probes.filter((p) => p.type === 'readiness').length}\n`;
    text += `Generic probes:        ${probes.filter((p) => p.type === 'generic').length}\n`;
    text += `With DB check:         ${probes.filter((p) => p.hasDbCheck).length}\n`;
    text += `With timeout:          ${probes.filter((p) => p.hasTimeout).length}\n`;
    text += `Authenticated:         ${probes.filter((p) => p.isAuthenticated).length}\n`;
    text += `Probe-level issues:    ${probes.filter((p) => p.issues.length > 0).length}\n`;
    text += `System-level issues:   ${systemIssues.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getHealthProbeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_health_probes',
      description: 'List health probes: liveness/readiness distinction, DB timeout warnings, authentication check, Docker/K8s probe config validation, probe frequency',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_health_probe_stats',
      description: 'Show health probe statistics: liveness/readiness/generic counts, DB check coverage, timeout coverage, authentication rate, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
