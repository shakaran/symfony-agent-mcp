import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface EcsConfigInfo {
  file: string;
  family: string;
  container: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function safeReadDir(dir: string, base: string): string[] {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return [];
  try { return fs.readdirSync(resolved); } catch { return []; }
}

const SECRET_NAME_PATTERN = /password|secret|token|api_key|private|credential|auth/i;

function isTaskDefinitionFilename(name: string): boolean {
  if (name === 'taskdef.json') return true;
  if (name.startsWith('task-definition') && name.endsWith('.json')) return true;
  if (name.startsWith('ecs-task') && name.endsWith('.json')) return true;
  return false;
}

function parseTaskDefinition(content: string, relPath: string): EcsConfigInfo[] {
  const results: EcsConfigInfo[] = [];
  let json: Record<string, unknown>;
  try { json = JSON.parse(content) as Record<string, unknown>; } catch {
    return [{ file: relPath, family: 'parse-error', container: 'n/a', issues: ['File is not valid JSON'] }];
  }

  const family = json['family'] as string ?? 'unknown';
  const cpu = json['cpu'] as string | undefined;
  const memory = json['memory'] as string | undefined;

  // Top-level resource summary
  results.push({
    file: relPath,
    family,
    container: 'task-level',
    issues: [
      ...(!cpu ? ['No cpu defined at task level — specify cpu to enable Fargate or set proper resource allocation'] : []),
      ...(!memory ? ['No memory defined at task level — specify memory for proper resource constraints'] : []),
    ],
  });

  const containerDefs = json['containerDefinitions'] as Array<Record<string, unknown>> | undefined;
  if (!containerDefs || containerDefs.length === 0) {
    results.push({ file: relPath, family, container: 'containerDefinitions', issues: ['No containerDefinitions found in task definition'] });
    return results;
  }

  for (const containerDef of containerDefs) {
    const containerName = containerDef['name'] as string ?? 'unknown';
    const image = containerDef['image'] as string ?? 'unknown';
    const info: EcsConfigInfo = { file: relPath, family, container: containerName, issues: [] };

    // image info
    if (image.endsWith(':latest')) {
      info.issues.push(`Container "${containerName}" uses image tag :latest — pin to a specific tag for reproducible deployments`);
    }

    // environment[] — check for secrets
    const environment = containerDef['environment'] as Array<Record<string, string>> | undefined;
    if (environment) {
      for (const envVar of environment) {
        const envName = envVar['name'] ?? '';
        const envValue = envVar['value'] ?? '';
        if (SECRET_NAME_PATTERN.test(envName) && envValue.length > 0) {
          info.issues.push(`Container "${containerName}" has secret-like env var "${envName}" in environment[] — use secrets[] with SSM Parameter Store or Secrets Manager ARN instead`);
        }
      }
    }

    // healthCheck
    const healthCheck = containerDef['healthCheck'] as Record<string, unknown> | undefined;
    if (!healthCheck) {
      info.issues.push(`Container "${containerName}" has no healthCheck configured — add healthCheck.command to allow ECS to replace unhealthy tasks`);
    }

    // privileged
    if (containerDef['privileged'] === true) {
      info.issues.push(`Container "${containerName}" runs with privileged: true — remove privileged mode unless strictly required; it grants host-level access`);
    }

    // secrets[] presence is good — note it
    const secrets = containerDef['secrets'] as Array<unknown> | undefined;
    if (secrets && secrets.length > 0) {
      results.push({ file: relPath, family, container: `${containerName} (secrets)`, issues: [] });
    }

    results.push(info);
  }

  return results;
}

function findTaskDefinitionFiles(appPath: string): string[] {
  const found: string[] = [];

  function scanDir(dir: string, depth: number): void {
    if (depth > 4) return;
    const entries = safeReadDir(dir, appPath);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(fullPath); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === '.terraform') continue;
        scanDir(fullPath, depth + 1);
      } else if (isTaskDefinitionFilename(entry)) {
        found.push(fullPath);
      }
    }
  }

  scanDir(appPath, 0);
  return found;
}

function buildAwsEcsConfigInfos(appPath: string): EcsConfigInfo[] {
  const results: EcsConfigInfo[] = [];
  const taskFiles = findTaskDefinitionFiles(appPath);

  for (const taskFile of taskFiles) {
    const content = safeReadFile(taskFile, appPath);
    if (content === null) continue;
    const relPath = path.relative(appPath, taskFile);
    results.push(...parseTaskDefinition(content, relPath));
  }

  return results;
}

export function listAwsEcsConfig(appPath: string): McpToolResult {
  try {
    const infos = buildAwsEcsConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No ECS task definition files found (*task-definition*.json, ecs-task*.json, taskdef.json).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `AWS ECS Configuration Analysis\n${'='.repeat(55)}\n\nContainers: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.family}] ${info.container}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsEcsConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildAwsEcsConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    const families = [...new Set(infos.map((i) => i.family).filter((f) => f !== 'parse-error'))];
    const files = [...new Set(infos.map((i) => i.file))];
    let text = `AWS ECS Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Task def files:      ${files.length}\n`;
    text += `Task families:       ${families.length}\n`;
    text += `Container entries:   ${infos.length}\n`;
    text += `Secret issues:       ${infos.filter((i) => i.issues.some((x) => x.includes('secret') || x.includes('env var'))).length}\n`;
    text += `Health check issues: ${infos.filter((i) => i.issues.some((x) => x.includes('healthCheck'))).length}\n`;
    text += `Privileged issues:   ${infos.filter((i) => i.issues.some((x) => x.includes('privileged'))).length}\n`;
    text += `Total issues:        ${totalIssues}\n`;
    if (families.length > 0) text += `\nFamilies:\n${families.map((f) => `  ${f}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAwsEcsConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_aws_ecs_config',
      description: 'Analyse ECS task definition JSON files (*task-definition*.json, ecs-task*.json, taskdef.json) for hardcoded secrets in environment[], missing healthCheck, privileged:true containers, and missing cpu/memory',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_aws_ecs_config_stats',
      description: 'Statistics for AWS ECS task definitions: file/family/container counts, secret/health-check/privileged issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
