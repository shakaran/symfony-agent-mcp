// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DockerHealthInfo {
  service: string;
  file: string;
  type: 'healthcheck' | 'dependency' | 'restart' | 'resource';
  pattern: string;
  issues: string[];
}

/**
 * The indentation this document uses for one nesting level.
 *
 * Two spaces is the common style and four is equally valid YAML; assuming two
 * meant a four-space file parsed as having nothing in it. Taken from the first
 * child of the given key rather than guessed.
 */
function indentUnder(content: string, key: string): number {
  const m = new RegExp(`^${key}\\s*:\\s*\\n( +)\\S`, 'm').exec(content);
  return m ? m[1].length : 2;
}

function parseDockerCompose(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const services: Record<string, unknown> = {};
    let currentService = '';
    const lines = content.split('\n');
    const svcIndent = indentUnder(content, 'services');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const serviceMatch = new RegExp(`^ {${svcIndent}}(?! )([a-zA-Z0-9_-]+):\\s*$`).exec(line);
      if (serviceMatch && i > 0) {
        const prevLine = lines[i - 1] ?? '';
        if (prevLine.includes('services:')) {
          currentService = serviceMatch[1];
          services[currentService] = {};
          continue;
        }
      }

      if (/^ {4}(?:image|build):/.test(line) && currentService) {
        const svc = services[currentService] as Record<string, string>;
        if (line.includes('image:')) svc['image'] = line.split(':')[1]?.trim() ?? '';
      }
      if (/^ {4}healthcheck:/.test(line) && currentService) {
        (services[currentService] as Record<string, boolean>)['healthcheck'] = true;
      }
      if (/^ {4}restart:/.test(line) && currentService) {
        (services[currentService] as Record<string, string>)['restart'] = line.split(':')[1]?.trim() ?? '';
      }
      if (/^ {4}depends_on:/.test(line) && currentService) {
        (services[currentService] as Record<string, boolean>)['depends_on'] = true;
      }
      if (/^ {4}deploy:/.test(line) && currentService) {
        (services[currentService] as Record<string, boolean>)['deploy'] = true;
      }
    }
    return services;
  } catch { return null; }
}

function buildDockerComposeHealthInfos(appPath: string): DockerHealthInfo[] {
  const results: DockerHealthInfo[] = [];

  const composePaths = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
    path.join(appPath, 'docker-compose.prod.yml'),
    path.join(appPath, 'docker-compose.production.yml'),
  ];

  for (const composePath of composePaths) {
    if (!fs.existsSync(composePath)) continue;
    const relFile = path.relative(appPath, composePath);

    let content = '';
    try { content = fs.readFileSync(composePath, 'utf-8'); } catch { continue; }

    const services = parseDockerCompose(composePath) ?? {};
    const serviceNames = Object.keys(services);

    for (const svcName of serviceNames) {
      const svc = services[svcName] as Record<string, unknown>;
      const issues: string[] = [];

      if (!svc['healthcheck']) {
        const isDbOrCache = svcName.includes('db') || svcName.includes('mysql') || svcName.includes('postgres') || svcName.includes('redis') || svcName.includes('rabbit') || svcName.includes('mongo');
        if (isDbOrCache) {
          issues.push(`Service "${svcName}" in ${relFile} has no healthcheck — dependent services may start before db/cache is ready; add healthcheck with appropriate test command`);
        }
      }

      const restartPolicy = String(svc['restart'] ?? '');
      if (!restartPolicy || restartPolicy === 'no') {
        issues.push(`Service "${svcName}" in ${relFile} has no restart policy (or "no") — containers that crash will not restart; set restart: unless-stopped or on-failure:5 for production resilience`);
      }

      if (!svc['deploy']) {
        const isWebOrApp = svcName.includes('app') || svcName.includes('web') || svcName.includes('php') || svcName.includes('nginx');
        if (isWebOrApp && content.includes('deploy:')) {
          issues.push(`Service "${svcName}" in ${relFile} without resource limits — add deploy.resources.limits (memory, cpus) to prevent one service from consuming all host resources`);
        }
      }

      const hasDepsOnWithCondition = content.includes('condition: service_healthy') || content.includes('service_healthy');
      if (svc['depends_on'] && !hasDepsOnWithCondition) {
        issues.push(`Service "${svcName}" in ${relFile} uses depends_on without condition: service_healthy — depends_on only waits for container start, not readiness; use condition: service_healthy to wait for healthcheck`);
      }

      if (issues.length > 0) {
        results.push({ service: svcName, file: relFile, type: 'healthcheck', pattern: `service: ${svcName}`, issues });
      }
    }
  }

  return results;
}

export function listDockerComposeHealth(appPath: string): McpToolResult {
  try {
    const infos = buildDockerComposeHealthInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Docker Compose health issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Docker Compose Health Analysis\n${'='.repeat(55)}\n\nServices: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerComposeHealthStats(appPath: string): McpToolResult {
  try {
    const infos = buildDockerComposeHealthInfos(appPath);
    let text = `Docker Compose Health Statistics\n${'='.repeat(40)}\n\n`;
    text += `Services checked:  ${infos.length}\n`;
    text += `Issues:            ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerComposeHealthTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_docker_compose_health', description: 'Analyze Docker Compose service health configuration; warns on db/cache services without healthcheck, no restart policy, depends_on without condition: service_healthy, missing resource limits on web/app containers', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_docker_compose_health_stats', description: 'Statistics for Docker Compose health: service count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
