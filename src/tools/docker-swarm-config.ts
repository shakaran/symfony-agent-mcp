import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DockerSwarmInfo {
  service: string;
  replicas: number | null;
  hasResources: boolean;
  hasHealthCheck: boolean;
  issues: string[];
}

function extractYamlValue(block: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*:\\s*([^\\n]{1,200})`);
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

function extractYamlBool(block: string, key: string): boolean | null {
  const val = extractYamlValue(block, key);
  if (val === null) return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  return null;
}

function extractServiceBlock(content: string, serviceName: string): string {
  const serviceRe = new RegExp(`^(  ${serviceName}\\s*:)`, 'm');
  const sm = serviceRe.exec(content);
  if (!sm) return '';
  const start = sm.index;
  const rest = content.substring(start);
  const nextServiceMatch = /^ {2}[a-zA-Z_][a-zA-Z0-9_-]{0,100}\s*:/m.exec(rest.substring(sm[0].length));
  const end = nextServiceMatch ? start + sm[0].length + nextServiceMatch.index : content.length;
  return content.substring(start, end);
}

function parseSwarmServices(content: string): DockerSwarmInfo[] {
  const results: DockerSwarmInfo[] = [];

  const servicesSectionMatch = /^services\s*:/m.exec(content);
  if (!servicesSectionMatch) return results;

  const serviceNamesRe = /^ {2}([a-zA-Z_][a-zA-Z0-9_-]{0,100})\s*:/gm;
  const serviceNames: string[] = [];
  let snm: RegExpExecArray | null;
  while ((snm = serviceNamesRe.exec(content)) !== null) {
    if (!serviceNames.includes(snm[1])) serviceNames.push(snm[1]);
  }

  for (const serviceName of serviceNames) {
    const block = extractServiceBlock(content, serviceName);
    if (!block.includes('deploy:')) continue;

    const deployBlock = block.substring(block.indexOf('deploy:'));
    const issues: string[] = [];

    const replicasVal = extractYamlValue(deployBlock, 'replicas');
    const replicas = replicasVal ? parseInt(replicasVal, 10) : null;

    const hasResources = deployBlock.includes('resources:') &&
      (deployBlock.includes('limits:') || deployBlock.includes('reservations:'));

    if (!hasResources) {
      issues.push(`Service "${serviceName}" has no resource limits — without memory/CPU limits containers can be OOM-killed or starve other services; add resources.limits.memory and resources.limits.cpus`);
    } else {
      const memoryVal = extractYamlValue(deployBlock, 'memory');
      const cpusVal = extractYamlValue(deployBlock, 'cpus');
      if (!memoryVal) {
        issues.push(`Service "${serviceName}" has resources block but no memory limit — add resources.limits.memory to prevent OOM kills`);
      }
      if (!cpusVal) {
        issues.push(`Service "${serviceName}" has resources block but no cpus limit — add resources.limits.cpus to prevent CPU starvation`);
      }
    }

    const hasHealthCheck = block.includes('healthcheck:');
    if (!hasHealthCheck && replicas !== null && replicas > 1) {
      issues.push(`Service "${serviceName}" has ${replicas} replicas but no healthcheck — Swarm cannot verify container readiness before routing traffic; add a healthcheck`);
    }

    if (!deployBlock.includes('update_config:')) {
      issues.push(`Service "${serviceName}" missing update_config — no rolling update strategy defined; add update_config with failure_action: rollback for safe deploys`);
    } else {
      const failureAction = extractYamlValue(deployBlock, 'failure_action');
      if (failureAction !== 'rollback') {
        issues.push(`Service "${serviceName}" update_config.failure_action is "${failureAction ?? 'not set'}" — set failure_action: rollback for automatic rollback on deploy failure`);
      }
      const order = extractYamlValue(deployBlock, 'order');
      if (order === 'stop-first') {
        issues.push(`Service "${serviceName}" update_config.order: stop-first — causes brief downtime during updates; consider order: start-first for zero-downtime rolling updates`);
      }
    }

    if (!deployBlock.includes('restart_policy:')) {
      issues.push(`Service "${serviceName}" missing restart_policy — containers won't restart on failure; add restart_policy: { condition: on-failure }`);
    } else {
      const condition = extractYamlValue(deployBlock, 'condition');
      if (condition === 'none') {
        issues.push(`Service "${serviceName}" restart_policy.condition: none — failed containers will not restart; change to on-failure or any`);
      }
    }

    if (deployBlock.includes('rollback_config:')) {
      const rollbackParallelism = extractYamlValue(deployBlock, 'parallelism');
      if (!rollbackParallelism) {
        issues.push(`Service "${serviceName}" has rollback_config but no parallelism set — defaults to all replicas at once; set parallelism: 1 for incremental rollback`);
      }
    }

    if (deployBlock.includes('placement:') && deployBlock.includes('constraints:')) {
      const constraintVal = extractYamlValue(deployBlock, 'node.role');
      if (!constraintVal) {
        issues.push(`Service "${serviceName}" has placement constraints but no node.role constraint — verify placement constraints are correctly targeting manager or worker nodes`);
      }
    }

    const hasEqualSign = extractYamlBool(block, 'ports');
    if (hasEqualSign !== null && block.includes('ports:') && deployBlock.includes('replicas') && replicas !== null && replicas > 1) {
      const portMode = extractYamlValue(block, 'mode');
      if (portMode !== 'host' && !block.includes('ingress')) {
        issues.push(`Service "${serviceName}" with ${replicas} replicas publishes ports — consider using ingress load balancing mode explicitly`);
      }
    }

    results.push({ service: serviceName, replicas: replicas ?? null, hasResources, hasHealthCheck, issues });
  }

  return results;
}

function loadComposeFiles(appPath: string): Array<{ file: string; content: string }> {
  const candidates = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'docker-compose.prod.yml',
    'docker-compose.prod.yaml',
    'docker-compose.swarm.yml',
    'docker-compose.swarm.yaml',
  ];
  const loaded: Array<{ file: string; content: string }> = [];
  for (const name of candidates) {
    const fullPath = path.join(appPath, name);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes('deploy:')) loaded.push({ file: name, content });
    } catch { /* skip */ }
  }
  return loaded;
}

function buildDockerSwarmInfos(appPath: string): DockerSwarmInfo[] {
  const results: DockerSwarmInfo[] = [];
  const files = loadComposeFiles(appPath);
  for (const { content } of files) {
    results.push(...parseSwarmServices(content));
  }
  return results;
}

export function listDockerSwarmConfig(appPath: string): McpToolResult {
  try {
    const infos = buildDockerSwarmInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Docker Swarm deploy configuration found in docker-compose files.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Docker Swarm Configuration Analysis\n${'='.repeat(55)}\n\nServices: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  ${info.service}`;
      if (info.replicas !== null) text += `  replicas: ${info.replicas}`;
      text += `  resources: ${info.hasResources ? 'yes' : 'NO'}  healthcheck: ${info.hasHealthCheck ? 'yes' : 'NO'}\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerSwarmConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildDockerSwarmInfos(appPath);
    let text = `Docker Swarm Statistics\n${'='.repeat(40)}\n\n`;
    text += `Services:        ${infos.length}\n`;
    text += `With resources:  ${infos.filter((i) => i.hasResources).length}\n`;
    text += `With healthcheck: ${infos.filter((i) => i.hasHealthCheck).length}\n`;
    text += `Replicated (>1): ${infos.filter((i) => i.replicas !== null && i.replicas > 1).length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerSwarmConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_docker_swarm_config',
      description: 'Scan docker-compose.yml/prod/swarm files for Swarm deploy sections; detects missing resource limits (OOM kill risk), missing healthcheck with multiple replicas, missing update_config.failure_action: rollback, stop-first update order (downtime), missing restart_policy, rollback_config without parallelism',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_docker_swarm_config_stats',
      description: 'Statistics for Docker Swarm config: service count, resource coverage, healthcheck coverage, replicated service count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
