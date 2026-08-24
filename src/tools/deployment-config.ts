// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Deployment Configuration Inspector
 *
 * Complements docker-inspector.ts (local Docker) with production infrastructure:
 *
 * Kubernetes / Helm:
 *   - k8s/*.yaml: Deployments (replicas, image, resources.limits/requests), Services,
 *     Ingress (host, TLS), HPA (minReplicas, maxReplicas, targetCPUUtilizationPercentage),
 *     ConfigMaps with Symfony env vars
 *   - helm/values.yaml: replicaCount, image.tag, resources, ingress
 *
 * Fly.io:
 *   - fly.toml: app name, primary_region, [vm] size, [http_service] min/max machines,
 *     [processes], [env] APP_ENV
 *
 * Heroku:
 *   - Procfile: web/worker/release entries
 *   - app.json: addons, env, formation
 *
 * Google Cloud / Cloud Run:
 *   - app.yaml: runtime, instance_class, automatic_scaling, env_variables
 *   - cloudrun.yaml: containerPort, resources, env
 *
 * Render.com:
 *   - render.yaml: services, envVars, plan
 *
 * Analysis:
 *   - Replicas < 2 in production (single point of failure)
 *   - No resource limits on Kubernetes pods
 *   - HPA without resource limits (HPA won't work without requests defined)
 *   - No health check / readiness probe on Kubernetes deployment
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DeploymentTarget {
  platform: string;
  details: string[];
  issues: string[];
}

function fileExists(appPath: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(appPath, ...parts));
}

function readFile(appPath: string, ...parts: string[]): string {
  try { return fs.readFileSync(path.join(appPath, ...parts), 'utf-8'); } catch { return ''; }
}

// ─── Kubernetes ────────────────────────────────────────────────────────────────

function analyzeKubernetes(appPath: string): DeploymentTarget | null {
  const dirs = ['k8s', 'kubernetes', 'deploy', '.k8s', 'kube'];
  let found = false;
  const details: string[] = [];
  const issues: string[] = [];

  for (const dir of dirs) {
    const dirPath = path.join(appPath, dir);
    try {
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      if (files.length === 0) continue;
      found = true;

      for (const fname of files) {
        const content = readFile(appPath, dir, fname);
        if (!content) continue;

        if (content.includes('kind: Deployment')) {
          const replicaM = /replicas:\s*(\d+)/.exec(content);
          const replicas  = replicaM ? parseInt(replicaM[1], 10) : 1;
          details.push(`Deployment: ${fname} (replicas: ${replicas})`);
          if (replicas < 2) issues.push(`${fname}: replicas < 2 — single point of failure`);
          if (!content.includes('resources:')) issues.push(`${fname}: no resource limits/requests — HPA will not work`);
          if (!content.includes('readinessProbe:') && !content.includes('livenessProbe:')) {
            issues.push(`${fname}: no readiness/liveness probe`);
          }
        }
        if (content.includes('kind: HorizontalPodAutoscaler')) {
          const minM = /minReplicas:\s*(\d+)/.exec(content);
          const maxM = /maxReplicas:\s*(\d+)/.exec(content);
          details.push(`HPA: ${fname} (min: ${minM?.[1] ?? '?'}, max: ${maxM?.[1] ?? '?'})`);
        }
        if (content.includes('kind: Ingress')) {
          const hostM = /host:\s*([^\n]+)/.exec(content);
          details.push(`Ingress: ${fname}${hostM ? ` (${hostM[1].trim()})` : ''}`);
        }
      }
    } catch { /* skip */ }
  }

  // Helm
  if (fileExists(appPath, 'helm', 'values.yaml') || fileExists(appPath, 'chart', 'values.yaml')) {
    found = true;
    const values = readFile(appPath, 'helm', 'values.yaml') || readFile(appPath, 'chart', 'values.yaml');
    const replicaM = /replicaCount:\s*(\d+)/.exec(values);
    details.push(`Helm chart (replicas: ${replicaM?.[1] ?? '?'})`);
  }

  return found ? { platform: 'Kubernetes / Helm', details, issues } : null;
}

// ─── Fly.io ───────────────────────────────────────────────────────────────────

function analyzeFly(appPath: string): DeploymentTarget | null {
  const content = readFile(appPath, 'fly.toml');
  if (!content) return null;

  const details: string[] = [];
  const issues: string[] = [];

  const appM     = /app\s*=\s*['"]([^'"]+)['"]/.exec(content);
  const regionM  = /primary_region\s*=\s*['"]([^'"]+)['"]/.exec(content);
  const vmM      = /\[vm\][^[]*size\s*=\s*['"]([^'"]+)['"]/.exec(content);
  const minM     = /min_machines_running\s*=\s*(\d+)/.exec(content);
  const maxM     = /max_machines\s*=\s*(\d+)/.exec(content);

  if (appM)    details.push(`App: ${appM[1]}`);
  if (regionM) details.push(`Region: ${regionM[1]}`);
  if (vmM)     details.push(`VM size: ${vmM[1]}`);
  if (minM)    details.push(`Min machines: ${minM[1]}`);
  if (maxM)    details.push(`Max machines: ${maxM[1]}`);

  if (minM && parseInt(minM[1], 10) < 1) {
    issues.push('min_machines_running < 1 — app may have cold starts');
  }

  return { platform: 'Fly.io', details, issues };
}

// ─── Heroku ───────────────────────────────────────────────────────────────────

function analyzeHeroku(appPath: string): DeploymentTarget | null {
  const procfile = readFile(appPath, 'Procfile');
  if (!procfile) return null;

  const details: string[] = [];
  const issues: string[] = [];

  for (const line of procfile.split('\n')) {
    const m = /^(\w+):\s*(.+)/.exec(line.trim());
    if (m) details.push(`${m[1]}: ${m[2].substring(0, 80)}`);
  }

  if (!procfile.includes('web:')) {
    issues.push('No web: process in Procfile — HTTP traffic may not be routed');
  }
  if (!procfile.includes('release:')) {
    issues.push('No release: process — migrations may not run on deploy');
  }

  return { platform: 'Heroku', details, issues };
}

// ─── Render.com ───────────────────────────────────────────────────────────────

function analyzeRender(appPath: string): DeploymentTarget | null {
  const content = readFile(appPath, 'render.yaml');
  if (!content) return null;

  const details: string[] = [];
  const issues: string[] = [];

  for (const m of content.matchAll(/name:\s*([^\n]+)/g)) {
    details.push(`Service: ${m[1].trim()}`);
  }
  for (const m of content.matchAll(/plan:\s*([^\n]+)/g)) {
    details.push(`Plan: ${m[1].trim()}`);
  }
  if (content.includes('plan: free')) {
    issues.push('Free plan — instances spin down when inactive (cold starts)');
  }

  return { platform: 'Render.com', details, issues };
}

// ─── Google Cloud App Engine ──────────────────────────────────────────────────

function analyzeGCloud(appPath: string): DeploymentTarget | null {
  const content = readFile(appPath, 'app.yaml');
  if (!content || !content.includes('runtime:')) return null;

  const details: string[] = [];
  const runtimeM = /runtime:\s*(\S+)/.exec(content);
  const instanceM = /instance_class:\s*(\S+)/.exec(content);
  if (runtimeM) details.push(`Runtime: ${runtimeM[1]}`);
  if (instanceM) details.push(`Instance: ${instanceM[1]}`);

  return { platform: 'Google Cloud App Engine', details, issues: [] };
}

export function listDeploymentConfig(appPath: string): McpToolResult {
  try {
    const targets: DeploymentTarget[] = [
      analyzeKubernetes(appPath),
      analyzeFly(appPath),
      analyzeHeroku(appPath),
      analyzeRender(appPath),
      analyzeGCloud(appPath),
    ].filter(Boolean) as DeploymentTarget[];

    if (targets.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No deployment configuration found.\n\nChecked: k8s/, helm/, fly.toml, Procfile, render.yaml, app.yaml\n\nNote: Docker-specific config is in list_docker_config.',
        }],
      };
    }

    let text = `Deployment Configuration\n${'='.repeat(55)}\n`;

    for (const target of targets) {
      text += `\n${target.platform}:\n`;
      for (const d of target.details) text += `  ${d}\n`;
      for (const issue of target.issues) text += `  ⚠ ${issue}\n`;
    }

    const allIssues = targets.flatMap((t) => t.issues);
    if (allIssues.length === 0) text += `\n✓ No deployment configuration issues detected.\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDeploymentStats(appPath: string): McpToolResult {
  try {
    const targets: DeploymentTarget[] = [
      analyzeKubernetes(appPath),
      analyzeFly(appPath),
      analyzeHeroku(appPath),
      analyzeRender(appPath),
      analyzeGCloud(appPath),
    ].filter(Boolean) as DeploymentTarget[];

    let text = `Deployment Statistics\n${'='.repeat(40)}\n\n`;
    text += `Platforms detected:  ${targets.length}\n`;
    if (targets.length > 0) {
      text += `Platforms:           ${targets.map((t) => t.platform).join(', ')}\n`;
    }
    text += `Total issues:        ${targets.reduce((s, t) => s + t.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDeploymentConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_deployment_config',
      description: 'Show deployment configuration: Kubernetes Deployments/HPA/Ingress (replicas, resource limits, probes), Helm values, Fly.io (vm size, min/max machines), Heroku Procfile, Render.com, Google Cloud App Engine — with availability and configuration issue detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_deployment_stats',
      description: 'Show deployment statistics: platforms detected and their names, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
