import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CloudRunConfigInfo {
  file: string;
  service: string;
  setting: string;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectYamlFiles(dir: string, base: string): string[] {
  const files: string[] = [];
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return files;
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const full = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...collectYamlFiles(full, base));
      else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function parseMemoryMi(memStr: string): number {
  const mMatch = /^(\d+)Mi$/.exec(memStr);
  if (mMatch) return parseInt(mMatch[1], 10);
  const giMatch = /^(\d+)Gi$/.exec(memStr);
  if (giMatch) return parseInt(giMatch[1], 10) * 1024;
  return 0;
}

function looksLikeRawSecret(value: string): boolean {
  if (!value || value.startsWith('$(') || value.includes('secretKeyRef') || value.length < 8) return false;
  return /[A-Za-z0-9+/]{20,}/.test(value) || /[A-Z0-9_-]{24,}/.test(value);
}

function analyzeCloudRunYaml(content: string, relFile: string): CloudRunConfigInfo[] {
  const results: CloudRunConfigInfo[] = [];

  if (!content.includes('serving.knative.dev') && !content.includes('run.googleapis.com') && !content.includes('containerConcurrency')) {
    return results;
  }

  const nameMatch = /metadata\s*:\s*[\s\S]{0,200}name\s*:\s*(\S+)/.exec(content);
  const serviceName = nameMatch ? nameMatch[1] : path.basename(relFile, '.yaml');

  // Check containerConcurrency
  const concurrencyMatch = /containerConcurrency\s*:\s*(\d+)/.exec(content);
  if (concurrencyMatch && concurrencyMatch[1] === '1') {
    results.push({
      file: relFile, service: serviceName, setting: 'containerConcurrency',
      issues: ['containerConcurrency: 1 — severe bottleneck; PHP-FPM handles concurrent requests; set to 80 or higher'],
    });
  }

  // Check timeoutSeconds
  if (!content.includes('timeoutSeconds')) {
    results.push({
      file: relFile, service: serviceName, setting: 'timeoutSeconds',
      issues: ['Missing timeoutSeconds — Cloud Run defaults to 300s; set explicitly to avoid unexpected request termination'],
    });
  }

  // Check memory limits
  const memMatch = /memory\s*:\s*(\S+)/.exec(content);
  if (memMatch) {
    const memMi = parseMemoryMi(memMatch[1]);
    if (memMi > 0 && memMi < 512) {
      results.push({
        file: relFile, service: serviceName, setting: 'resources.limits.memory',
        issues: [`Memory limit ${memMatch[1]} is below 512Mi — PHP/Symfony requires at least 512Mi; low memory causes OOM kills`],
      });
    }
  }

  // Check env vars for plain-text secrets
  const envPattern = /- name\s*:\s*(\S+)\s*\n\s*value\s*:\s*([^\n]+)/g;
  let ev: RegExpExecArray | null;
  while ((ev = envPattern.exec(content)) !== null) {
    const varName = ev[1];
    const val = ev[2].trim().replace(/^['"]|['"]$/g, '');
    if (looksLikeRawSecret(val)) {
      results.push({
        file: relFile, service: serviceName, setting: `env.${varName}`,
        issues: [`Env var "${varName}" has plain-text value "***" — use secretKeyRef pointing to Secret Manager instead`],
      });
    }
  }

  return results;
}

function buildCloudRunConfigInfos(appPath: string): CloudRunConfigInfo[] {
  const results: CloudRunConfigInfo[] = [];

  const candidateFiles = [
    'service.yaml',
    'cloudrun.yaml',
    'cloudbuild.yaml',
    '.cloudbuild/service.yaml',
    '.cloudbuild/cloudbuild.yaml',
  ];

  for (const relPath of candidateFiles) {
    const fullPath = path.join(appPath, relPath);
    const content = safeRead(fullPath, appPath);
    if (!content) continue;
    results.push(...analyzeCloudRunYaml(content, relPath));
  }

  // Scan deploy/cloudrun/ directory
  const deployCloudrunDir = path.join(appPath, 'deploy', 'cloudrun');
  if (fs.existsSync(deployCloudrunDir)) {
    for (const filePath of collectYamlFiles(deployCloudrunDir, appPath)) {
      const content = safeRead(filePath, appPath);
      if (!content) continue;
      const relFile = path.relative(appPath, filePath);
      results.push(...analyzeCloudRunYaml(content, relFile));
    }
  }

  return results;
}

export function listGoogleCloudRunConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCloudRunConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Google Cloud Run configuration found (service.yaml, cloudrun.yaml, cloudbuild.yaml, .cloudbuild/, deploy/cloudrun/).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Google Cloud Run Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  service:"${info.service}"  setting:${info.setting}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGoogleCloudRunConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCloudRunConfigInfos(appPath);
    const memIssues = infos.filter((i) => i.setting.includes('memory')).length;
    const secretIssues = infos.filter((i) => i.setting.startsWith('env.')).length;
    const concurrencyIssues = infos.filter((i) => i.setting === 'containerConcurrency').length;
    const timeoutIssues = infos.filter((i) => i.setting === 'timeoutSeconds').length;

    let text = `Google Cloud Run Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total entries:         ${infos.length}\n`;
    text += `  Memory issues:       ${memIssues}\n`;
    text += `  Plain-text secrets:  ${secretIssues}\n`;
    text += `  Concurrency issues:  ${concurrencyIssues}\n`;
    text += `  Timeout issues:      ${timeoutIssues}\n`;
    text += `Total issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getGoogleCloudRunConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_google_cloud_run_config',
      description: 'Analyze Google Cloud Run config (service.yaml, cloudrun.yaml, .cloudbuild/, deploy/cloudrun/): parse Knative service spec, env vars, resource limits, containerConcurrency; flag plain-text secrets (vs secretKeyRef), memory <512Mi, containerConcurrency:1, missing timeoutSeconds',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_google_cloud_run_config_stats',
      description: 'Statistics for Google Cloud Run configuration: entry counts, memory/secret/concurrency/timeout issue breakdown and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
