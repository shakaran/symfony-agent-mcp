import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface K8sManifestInfo {
  file: string;
  kind: string;
  name: string;
  issues: string[];
}

const MANIFEST_DIRS = ['k8s', 'kubernetes', 'deploy', '.k8s', 'infra'];
const SUPPORTED_KINDS = ['Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'HorizontalPodAutoscaler', 'PodDisruptionBudget'];

function getAllYamlFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return files;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const resolvedFull = path.resolve(full);
      if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllYamlFiles(full, base));
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractYamlField(content: string, field: string): string | null {
  const re = new RegExp(`^${field}\\s*:\\s*([^\\n]{1,200})`, 'm');
  const m = re.exec(content);
  return m ? m[1].trim() : null;
}

function analyzeDeployment(content: string, relFile: string, name: string): string[] {
  const issues: string[] = [];

  const hasResourceLimits = content.includes('limits:') && (content.includes('memory:') || content.includes('cpu:'));
  if (!hasResourceLimits) {
    issues.push(`Deployment "${name}" containers missing resource limits — without limits, pods can consume all node memory/CPU and trigger OOM kills; add resources.limits.memory and resources.limits.cpu`);
  }

  if (!content.includes('livenessProbe:')) {
    issues.push(`Deployment "${name}" missing livenessProbe — Kubernetes cannot detect stuck containers; add livenessProbe to enable automatic container restart`);
  }
  if (!content.includes('readinessProbe:')) {
    issues.push(`Deployment "${name}" missing readinessProbe — Kubernetes will route traffic to pods that are not yet ready; add readinessProbe to gate traffic until app is up`);
  }

  const imageRe = /image:\s*([^\n]{1,200})/g;
  let im: RegExpExecArray | null;
  while ((im = imageRe.exec(content)) !== null) {
    const imageRef = im[1].trim();
    if (imageRef.endsWith(':latest') || (!imageRef.includes(':') && !imageRef.includes('@sha256'))) {
      issues.push(`Deployment "${name}" uses image "${imageRef.substring(0, 80)}" with latest or no tag — non-reproducible deployments; pin to a specific tag or digest`);
    }
  }

  const replicasVal = extractYamlField(content, 'replicas');
  const replicas = replicasVal ? parseInt(replicasVal, 10) : 1;
  if (replicas < 2) {
    issues.push(`Deployment "${name}" has replicas: ${replicas} — single replica has no high availability; consider replicas: 2+ for production`);
  }

  return issues;
}

function analyzeService(content: string, name: string, relFile: string): string[] {
  const issues: string[] = [];
  const serviceType = extractYamlField(content, 'type');
  if (serviceType === 'LoadBalancer') {
    const isDevFile = relFile.includes('dev') || relFile.includes('local') || relFile.includes('test');
    if (isDevFile) {
      issues.push(`Service "${name}" type: LoadBalancer in dev/test config (${relFile}) — LoadBalancer provisions a cloud load balancer (expensive); use NodePort or ClusterIP for non-prod`);
    }
  }
  if (serviceType === 'NodePort') {
    issues.push(`Service "${name}" type: NodePort — exposes a port on every node IP; security risk as the port is accessible on all nodes; prefer ClusterIP with Ingress`);
  }
  return issues;
}

function analyzeIngress(content: string, name: string): string[] {
  const issues: string[] = [];
  if (!content.includes('tls:')) {
    issues.push(`Ingress "${name}" has no tls section — traffic is served over HTTP only; add tls with cert-manager annotation for HTTPS`);
  }
  const hasRateLimit = content.includes('rate-limit') || content.includes('nginx.ingress.kubernetes.io/limit') || content.includes('rateLimit');
  if (!hasRateLimit) {
    issues.push(`Ingress "${name}" missing rate limiting annotations — no protection against traffic floods; add nginx.ingress.kubernetes.io/limit-rps or similar`);
  }
  return issues;
}

function analyzeSecret(content: string, name: string): string[] {
  const issues: string[] = [];

  const hasHardcodedData = content.includes('\ndata:') || content.includes('\nstringData:');
  if (hasHardcodedData) {
    const isSealed = content.includes('SealedSecret') || content.includes('ExternalSecret');
    if (!isSealed) {
      const dataBlockMatch = /^data\s*:\s*\n((?:\s+[^\n]{1,200}\n){1,20})/m.exec(content);
      if (dataBlockMatch) {
        issues.push(`Secret "${name}" contains hardcoded data values — base64 is not encryption; use sealed-secrets (SealedSecret kind) or external-secrets to store secrets safely`);
      }
    }
  }

  const typeVal = extractYamlField(content, 'type');
  if (typeVal === 'Opaque' && content.includes('password') && !content.includes('%env(')) {
    issues.push(`Secret "${name}" of type Opaque appears to contain password data — ensure this secret is managed via sealed-secrets or an external vault, not committed to git`);
  }

  return issues;
}

function analyzeHpa(content: string, name: string): string[] {
  const issues: string[] = [];
  const minReplicas = extractYamlField(content, 'minReplicas');
  const maxReplicas = extractYamlField(content, 'maxReplicas');
  if (!minReplicas) {
    issues.push(`HPA "${name}" missing minReplicas — defaults to 1 which may cause downtime during scale-down; set minReplicas: 2 for HA`);
  }
  if (!maxReplicas) {
    issues.push(`HPA "${name}" missing maxReplicas — unbounded scale-up can exhaust cluster resources`);
  }
  const hasCpuTarget = content.includes('cpu') && (content.includes('targetAverageUtilization') || content.includes('averageUtilization'));
  if (!hasCpuTarget) {
    issues.push(`HPA "${name}" has no CPU utilization target — HPA needs a metric to scale on; add averageUtilization: 70 under resource cpu`);
  }
  return issues;
}

function buildK8sManifestInfos(appPath: string): K8sManifestInfo[] {
  const results: K8sManifestInfo[] = [];

  for (const dir of MANIFEST_DIRS) {
    const fullDir = path.join(appPath, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of getAllYamlFiles(fullDir, fullDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const kindVal = extractYamlField(content, 'kind');
      if (!kindVal || !SUPPORTED_KINDS.includes(kindVal)) continue;

      const nameVal = extractYamlField(content, 'name') ?? path.basename(file, '.yaml');
      const relFile = path.relative(appPath, file);
      let issues: string[] = [];

      if (kindVal === 'Deployment') issues = analyzeDeployment(content, relFile, nameVal);
      else if (kindVal === 'Service') issues = analyzeService(content, nameVal, relFile);
      else if (kindVal === 'Ingress') issues = analyzeIngress(content, nameVal);
      else if (kindVal === 'Secret') issues = analyzeSecret(content, nameVal);
      else if (kindVal === 'HorizontalPodAutoscaler') issues = analyzeHpa(content, nameVal);
      else if (kindVal === 'PodDisruptionBudget') {
        const minAvailable = extractYamlField(content, 'minAvailable');
        const maxUnavailable = extractYamlField(content, 'maxUnavailable');
        if (!minAvailable && !maxUnavailable) {
          issues.push(`PodDisruptionBudget "${nameVal}" has neither minAvailable nor maxUnavailable — PDB has no effect`);
        }
      }

      results.push({ file: relFile, kind: kindVal, name: nameVal, issues });
    }
  }

  return results;
}

export function listKubernetesManifests(appPath: string): McpToolResult {
  try {
    const infos = buildK8sManifestInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Kubernetes manifests found in k8s/, kubernetes/, deploy/, .k8s/, or infra/ directories.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Kubernetes Manifests Analysis\n${'='.repeat(55)}\n\nManifests: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.kind}] ${info.name}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getKubernetesManifestsStats(appPath: string): McpToolResult {
  try {
    const infos = buildK8sManifestInfos(appPath);
    let text = `Kubernetes Manifests Statistics\n${'='.repeat(40)}\n\n`;
    for (const kind of SUPPORTED_KINDS) {
      const count = infos.filter((i) => i.kind === kind).length;
      if (count > 0) text += `${kind}: ${count}\n`;
    }
    text += `Issues: ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getKubernetesManifestsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_kubernetes_manifests',
      description: 'Scan k8s/, kubernetes/, deploy/, .k8s/, infra/ for Kubernetes YAML manifests; analyzes Deployment (resource limits, liveness/readinessProbe, latest image tag, low replicas), Service (LoadBalancer in dev, NodePort risk), Ingress (missing TLS, rate limiting), Secret (hardcoded base64 data), HPA (missing CPU target), PodDisruptionBudget',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_kubernetes_manifests_stats',
      description: 'Statistics for Kubernetes manifests: count per kind (Deployment/Service/Ingress/ConfigMap/Secret/HPA/PDB), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
