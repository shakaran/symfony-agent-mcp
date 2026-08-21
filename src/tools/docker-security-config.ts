import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface DockerSecurityConfigInfo {
  file: string;
  type: 'root-user' | 'privileged' | 'secret' | 'mutable-tag' | 'capability' | 'readonly';
  pattern: string;
  issues: string[];
}

function analyseDockerfile(filePath: string, relPath: string): DockerSecurityConfigInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const results: DockerSecurityConfigInfo[] = [];

  // No USER directive, or USER root
  if (!/^USER\s+(?!root)/m.test(content)) {
    const userMatch = content.match(/^USER\s+(\S+)/m);
    if (!userMatch || userMatch[1] === 'root') {
      results.push({
        file: relPath,
        type: 'root-user',
        pattern: 'Dockerfile runs as root',
        issues: ['Dockerfile without USER directive runs as root — add a non-root user: RUN useradd -r -u 1001 appuser && USER appuser to reduce attack surface'],
      });
    }
  }

  // ENV with secrets
  const envLines = content.match(/^ENV\s+.+/mg) ?? [];
  for (const line of envLines) {
    if (/password|secret|key|token|auth|passwd/i.test(line)) {
      results.push({
        file: relPath,
        type: 'secret',
        pattern: 'Secret in Dockerfile ENV',
        issues: ['Secret/credential in Dockerfile ENV — never put secrets in Dockerfile ENV; use Docker secrets or environment variables at runtime'],
      });
      break;
    }
  }

  // FROM image:latest
  if (/^FROM\s+\S+:latest/m.test(content)) {
    results.push({
      file: relPath,
      type: 'mutable-tag',
      pattern: 'FROM image:latest',
      issues: ['Dockerfile uses :latest tag — pin to a specific version (FROM php:8.3.12-fpm-alpine3.20) for reproducible and secure builds'],
    });
  }

  return results;
}

function analyseComposeFile(filePath: string, relPath: string): DockerSecurityConfigInfo[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  const results: DockerSecurityConfigInfo[] = [];

  // privileged: true
  if (/privileged:\s*true/.test(content)) {
    results.push({
      file: relPath,
      type: 'privileged',
      pattern: 'privileged: true',
      issues: ['Docker service running in privileged mode — privileged containers have full host access; remove privileged: true unless absolutely required'],
    });
  }

  // Sensitive host path mounts
  const volumeLines = content.match(/- [/'"](\/[^'"]*)['"]/g) ?? [];
  for (const vol of volumeLines) {
    if (/docker\.sock|^\/etc|^\/var\/run/.test(vol) || /- ["']?\/:/.test(vol)) {
      results.push({
        file: relPath,
        type: 'privileged',
        pattern: `Sensitive host path mount: ${vol.trim()}`,
        issues: ['Docker container mounting sensitive host path — avoid mounting / or /etc; docker.sock mount gives container control over host Docker daemon'],
      });
      break;
    }
  }

  // Good practices (no issues)
  if (/no-new-privileges:true/.test(content)) {
    results.push({
      file: relPath,
      type: 'capability',
      pattern: 'security_opt: no-new-privileges:true',
      issues: [],
    });
  }

  if (/cap_drop:/.test(content) && /ALL/.test(content)) {
    results.push({
      file: relPath,
      type: 'capability',
      pattern: 'cap_drop: ALL',
      issues: [],
    });
  }

  // Missing security_opt for app containers
  if (!/security_opt:/.test(content) && /image:/.test(content)) {
    results.push({
      file: relPath,
      type: 'capability',
      pattern: 'No security_opt configured',
      issues: ['Docker service without security options — add security_opt: [no-new-privileges:true] and cap_drop: [ALL] to restrict container capabilities'],
    });
  }

  // read_only: true (no issues)
  if (/read_only:\s*true/.test(content)) {
    results.push({
      file: relPath,
      type: 'readonly',
      pattern: 'read_only: true',
      issues: [],
    });
  }

  return results;
}

function buildDockerSecurityConfigInfos(appPath: string): DockerSecurityConfigInfo[] {
  const results: DockerSecurityConfigInfo[] = [];

  // Dockerfiles
  const dockerfilePaths = [
    path.join(appPath, 'Dockerfile'),
    path.join(appPath, 'Dockerfile.prod'),
    path.join(appPath, 'docker', 'Dockerfile'),
    path.join(appPath, 'docker', 'Dockerfile.prod'),
  ];
  for (const dfPath of dockerfilePaths) {
    if (!fs.existsSync(dfPath)) continue;
    results.push(...analyseDockerfile(dfPath, path.relative(appPath, dfPath)));
  }

  // docker-compose files
  const composePaths: string[] = [];
  try {
    for (const entry of fs.readdirSync(appPath, { withFileTypes: true })) {
      if (entry.isFile() && /^docker-compose/.test(entry.name) && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
        composePaths.push(path.join(appPath, entry.name));
      }
    }
  } catch { /* skip */ }

  for (const cPath of composePaths) {
    results.push(...analyseComposeFile(cPath, path.relative(appPath, cPath)));
  }

  return results;
}

export function listDockerSecurityConfig(appPath: string): McpToolResult {
  try {
    const infos = buildDockerSecurityConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Docker configuration files found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Docker Security Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerSecurityConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildDockerSecurityConfigInfos(appPath);
    let text = `Docker Security Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Root-user:   ${infos.filter((i) => i.type === 'root-user').length}\n`;
    text += `Privileged:  ${infos.filter((i) => i.type === 'privileged').length}\n`;
    text += `Secret:      ${infos.filter((i) => i.type === 'secret').length}\n`;
    text += `Mutable-tag: ${infos.filter((i) => i.type === 'mutable-tag').length}\n`;
    text += `Capability:  ${infos.filter((i) => i.type === 'capability').length}\n`;
    text += `Readonly:    ${infos.filter((i) => i.type === 'readonly').length}\n`;
    text += `Issues:      ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDockerSecurityConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_docker_security_config',
      description: 'Analyse Docker security: Dockerfile root-user, ENV secrets, :latest tags, privileged containers, sensitive host mounts, missing security_opt/cap_drop, and read_only settings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_docker_security_config_stats',
      description: 'Statistics for Docker security configuration: counts by type (root-user/privileged/secret/mutable-tag/capability/readonly) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
