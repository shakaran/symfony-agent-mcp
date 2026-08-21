/**
 * Symfony Kubernetes Configuration Inspector
 *
 * Scans project for Kubernetes manifests: deploy/, k8s/, kubernetes/, helm/, .helm/,
 * *deployment*.yaml, *service*.yaml, *ingress*.yaml, *configmap*.yaml.
 * Parses YAML files for: Deployment, Service, Ingress, ConfigMap, Secret references.
 *
 * Warns about:
 *   - Image with :latest tag (non-reproducible deployments)
 *   - Container without resource limits (OOM kill risk)
 *   - Missing readinessProbe (traffic before app ready)
 *   - Missing livenessProbe (crashed app not restarted)
 *   - Env vars with plaintext secrets in Deployment YAML (use SecretKeyRef)
 *   - Ingress without TLS (HTTP only)
 *   - Single replica without PodDisruptionBudget (zero downtime deploys fail)
 *   - No resource requests set (scheduler blind to pod needs)
 *   - ConfigMap data containing passwords (use Secret instead)
 *
 * Pure static analysis — no execution.
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

interface KubernetesConfigInfo {
  file: string;
  resourceType: string;
  name: string;
  hasReadinessProbe: boolean;
  hasLivenessProbe: boolean;
  hasResourceLimits: boolean;
  hasLatestTag: boolean;
  issues: string[];
}

const K8S_DIRS = ['deploy', 'k8s', 'kubernetes', 'helm', '.helm', 'infra', 'chart', 'charts'];
const K8S_FILENAME_PATTERNS = [
  'deployment', 'service', 'ingress', 'configmap', 'config-map',
  'statefulset', 'daemonset', 'cronjob', 'job', 'hpa',
];

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        files.push(...getAllYamlFiles(full));
      } else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function isK8sFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (K8S_FILENAME_PATTERNS.some((p) => basename.includes(p))) return true;

  try {
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 500);
    return content.includes('apiVersion:') && content.includes('kind:');
  } catch {
    return false;
  }
}

function collectK8sFiles(appPath: string): string[] {
  const files: string[] = [];

  for (const dir of K8S_DIRS) {
    const fullDir = path.join(appPath, dir);
    if (fs.existsSync(fullDir)) {
      files.push(...getAllYamlFiles(fullDir));
    }
  }

  // Also check root-level yaml files matching k8s patterns
  try {
    const rootEntries = fs.readdirSync(appPath, { withFileTypes: true });
    for (const e of rootEntries) {
      if (e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml'))) {
        const full = path.join(appPath, e.name);
        if (isK8sFile(full)) files.push(full);
      }
    }
  } catch { /* skip */ }

  return [...new Set(files)];
}

function containsPasswordInData(data: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    const v = String(value ?? '').toLowerCase();
    if (
      k.includes('password') || k.includes('passwd') || k.includes('secret') ||
      k.includes('token') || k.includes('api_key') || k.includes('apikey')
    ) {
      if (v && !v.startsWith('$(') && v.length > 0) return true;
    }
  }
  return false;
}

function parseDeployment(filePath: string, raw: Record<string, unknown>): KubernetesConfigInfo {
  const metadata = (raw['metadata'] ?? {}) as Record<string, unknown>;
  const name = String(metadata['name'] ?? path.basename(filePath));
  const issues: string[] = [];

  const spec = (raw['spec'] ?? {}) as Record<string, unknown>;
  const template = (spec['template'] ?? {}) as Record<string, unknown>;
  const podSpec = (template['spec'] ?? {}) as Record<string, unknown>;
  const containers = (podSpec['containers'] ?? []) as Array<Record<string, unknown>>;

  let hasReadinessProbe = false;
  let hasLivenessProbe = false;
  let hasResourceLimits = false;
  let hasLatestTag = false;
  let hasResourceRequests = false;

  for (const container of containers) {
    if (container['readinessProbe']) hasReadinessProbe = true;
    if (container['livenessProbe']) hasLivenessProbe = true;

    const resources = (container['resources'] ?? {}) as Record<string, unknown>;
    if (resources['limits'] && Object.keys(resources['limits'] as Record<string, unknown>).length > 0) {
      hasResourceLimits = true;
    }
    if (resources['requests'] && Object.keys(resources['requests'] as Record<string, unknown>).length > 0) {
      hasResourceRequests = true;
    }

    const image = String(container['image'] ?? '');
    if (image.endsWith(':latest') || (!image.includes(':') && image.length > 0)) {
      hasLatestTag = true;
    }

    // Check for plaintext secrets in env
    const env = (container['env'] ?? []) as Array<Record<string, unknown>>;
    for (const envVar of env) {
      const envName = String(envVar['name'] ?? '').toLowerCase();
      const envValue = envVar['value'];
      if (
        envValue !== undefined &&
        envValue !== null &&
        typeof envValue === 'string' &&
        (envName.includes('password') || envName.includes('secret') || envName.includes('token') || envName.includes('api_key'))
      ) {
        issues.push(`Container env var "${envVar['name']}" contains plaintext sensitive value in Deployment YAML — use secretKeyRef instead`);
        break;
      }
    }
  }

  if (!hasReadinessProbe) {
    issues.push(`Deployment "${name}" has no readinessProbe — Kubernetes will route traffic before the app is ready to serve requests`);
  }
  if (!hasLivenessProbe) {
    issues.push(`Deployment "${name}" has no livenessProbe — crashed or deadlocked containers will not be automatically restarted`);
  }
  if (!hasResourceLimits) {
    issues.push(`Deployment "${name}" has no container resource limits — containers can consume unlimited memory and trigger OOM kills`);
  }
  if (!hasResourceRequests) {
    issues.push(`Deployment "${name}" has no resource requests — the Kubernetes scheduler cannot make informed placement decisions`);
  }
  if (hasLatestTag) {
    issues.push(`Deployment "${name}" uses :latest image tag (or untagged image) — non-reproducible deployments; use a specific digest or version tag`);
  }

  // Check replica count
  const replicas = spec['replicas'] as number | undefined;
  if (replicas === 1 || replicas === undefined) {
    issues.push(`Deployment "${name}" has ${replicas ?? 'default (1)'} replica(s) — without a PodDisruptionBudget, rolling updates will cause brief downtime`);
  }

  return {
    file: filePath,
    resourceType: 'Deployment',
    name,
    hasReadinessProbe,
    hasLivenessProbe,
    hasResourceLimits,
    hasLatestTag,
    issues,
  };
}

function parseIngress(filePath: string, raw: Record<string, unknown>): KubernetesConfigInfo {
  const metadata = (raw['metadata'] ?? {}) as Record<string, unknown>;
  const name = String(metadata['name'] ?? path.basename(filePath));
  const issues: string[] = [];
  const spec = (raw['spec'] ?? {}) as Record<string, unknown>;

  const hasTls = Array.isArray(spec['tls']) && (spec['tls'] as unknown[]).length > 0;
  if (!hasTls) {
    issues.push(`Ingress "${name}" has no TLS configuration — HTTP only; traffic is unencrypted in transit`);
  }

  return {
    file: filePath,
    resourceType: 'Ingress',
    name,
    hasReadinessProbe: true,
    hasLivenessProbe: true,
    hasResourceLimits: true,
    hasLatestTag: false,
    issues,
  };
}

function parseConfigMap(filePath: string, raw: Record<string, unknown>): KubernetesConfigInfo | null {
  const metadata = (raw['metadata'] ?? {}) as Record<string, unknown>;
  const name = String(metadata['name'] ?? path.basename(filePath));
  const issues: string[] = [];
  const data = (raw['data'] ?? {}) as Record<string, unknown>;

  if (containsPasswordInData(data)) {
    issues.push(`ConfigMap "${name}" contains sensitive data (password/secret/token) — use a Kubernetes Secret instead of ConfigMap for sensitive values`);
  }

  if (issues.length === 0) return null;

  return {
    file: filePath,
    resourceType: 'ConfigMap',
    name,
    hasReadinessProbe: true,
    hasLivenessProbe: true,
    hasResourceLimits: true,
    hasLatestTag: false,
    issues,
  };
}

function buildKubernetesConfigInfos(appPath: string): KubernetesConfigInfo[] {
  const files = collectK8sFiles(appPath);
  const results: KubernetesConfigInfo[] = [];

  for (const filePath of files) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    } catch { continue; }

    if (!raw) continue;

    const kind = String(raw['kind'] ?? '');

    if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
      results.push(parseDeployment(filePath, raw));
    } else if (kind === 'Ingress') {
      results.push(parseIngress(filePath, raw));
    } else if (kind === 'ConfigMap') {
      const info = parseConfigMap(filePath, raw);
      if (info) results.push(info);
    }
  }

  return results;
}

export function listKubernetesConfig(appPath: string): McpToolResult {
  try {
    const infos = buildKubernetesConfigInfos(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Kubernetes manifests found in deploy/, k8s/, kubernetes/, helm/, or root-level k8s yaml files.',
        }],
      };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Kubernetes Configuration Analysis\n${'='.repeat(55)}\n\n`;
    text += `Resources: ${infos.length}  Issues: ${totalIssues}\n`;

    for (const info of infos.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${info.name}  [${info.resourceType}]\n`;
      text += `    file:            ${info.file}\n`;
      if (info.resourceType === 'Deployment') {
        text += `    readinessProbe:  ${info.hasReadinessProbe ? 'yes' : 'no'}\n`;
        text += `    livenessProbe:   ${info.hasLivenessProbe ? 'yes' : 'no'}\n`;
        text += `    resourceLimits:  ${info.hasResourceLimits ? 'yes' : 'no'}\n`;
        text += `    latestTag:       ${info.hasLatestTag ? 'yes' : 'no'}\n`;
      }
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getKubernetesConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildKubernetesConfigInfos(appPath);
    const deployments = infos.filter((i) => i.resourceType === 'Deployment');

    let text = `Kubernetes Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total resources:             ${infos.length}\n`;
    text += `  Deployments:               ${deployments.length}\n`;
    text += `  Ingresses:                 ${infos.filter((i) => i.resourceType === 'Ingress').length}\n`;
    text += `  ConfigMaps (with issues):  ${infos.filter((i) => i.resourceType === 'ConfigMap').length}\n`;
    text += `  With readinessProbe:       ${deployments.filter((i) => i.hasReadinessProbe).length}\n`;
    text += `  With livenessProbe:        ${deployments.filter((i) => i.hasLivenessProbe).length}\n`;
    text += `  With resource limits:      ${deployments.filter((i) => i.hasResourceLimits).length}\n`;
    text += `  With :latest tag:          ${deployments.filter((i) => i.hasLatestTag).length}\n`;
    text += `Total issues:                ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getKubernetesConfigTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_kubernetes_config',
      description: 'Inspect Kubernetes manifests in deploy/, k8s/, helm/ directories: Deployment probes, resource limits, image tags, Ingress TLS, ConfigMap sensitive data, plaintext secrets in env vars; warns on missing probes, :latest tags, no resource limits, HTTP-only ingress',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_kubernetes_config_stats',
      description: 'Statistics for Kubernetes manifests: resource type counts, readiness/liveness probe coverage, resource limit coverage, latest tag count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
