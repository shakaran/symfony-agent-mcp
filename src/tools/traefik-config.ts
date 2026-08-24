// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface TraefikConfigInfo {
  source: string;
  type: 'config' | 'compose';
  detail: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzeTraefikContent(content: string, source: string, type: TraefikConfigInfo['type']): TraefikConfigInfo[] {
  const results: TraefikConfigInfo[] = [];

  // Missing HTTPS redirect middleware (redirectScheme with scheme: https)
  const hasRedirectScheme = content.includes('redirectScheme') || content.includes('redirect-scheme');
  const hasHttpsScheme = /scheme\s*:\s*https/.test(content);
  if (!hasRedirectScheme || !hasHttpsScheme) {
    results.push({
      source,
      type,
      detail: 'HTTPS redirect middleware check',
      issue: 'Missing redirectScheme middleware with scheme: https — all HTTP traffic should be redirected to HTTPS via a Traefik middleware',
    });
  } else {
    results.push({ source, type, detail: 'redirectScheme with scheme: https found', issue: null });
  }

  // insecureSkipVerify: true in backend TLS (MITM risk)
  if (/insecureSkipVerify\s*:\s*true/.test(content)) {
    results.push({
      source,
      type,
      detail: 'insecureSkipVerify: true detected',
      issue: 'insecureSkipVerify: true in backend TLS config — this disables certificate verification and exposes the backend to MITM attacks; use proper CA certificates instead',
    });
  }

  // Missing rate-limit middleware on public entrypoints
  const hasRateLimit = content.includes('rateLimit') || content.includes('rate-limit');
  if (!hasRateLimit) {
    results.push({
      source,
      type,
      detail: 'Rate-limit middleware check',
      issue: 'No rate-limit middleware detected — public entrypoints should have rateLimit middleware to prevent abuse and DoS attacks',
    });
  } else {
    results.push({ source, type, detail: 'Rate-limit middleware found', issue: null });
  }

  // api.insecure: true enabled (Traefik dashboard exposed without auth)
  if (/api\s*:[\s\S]{0,50}insecure\s*:\s*true/.test(content) || /insecure\s*:\s*true/.test(content)) {
    results.push({
      source,
      type,
      detail: 'api.insecure: true detected',
      issue: 'api.insecure: true exposes the Traefik dashboard without authentication — disable insecure API mode and protect the dashboard with basicAuth or forward-auth middleware',
    });
  }

  // Missing access logs configuration
  const hasAccessLogs = content.includes('accessLog') || content.includes('access-log') || content.includes('accesslog');
  if (!hasAccessLogs) {
    results.push({
      source,
      type,
      detail: 'Access logs configuration check',
      issue: 'No accessLog configuration detected — enable access logging to capture request details for security auditing and debugging',
    });
  } else {
    results.push({ source, type, detail: 'Access logs configuration found', issue: null });
  }

  // Entrypoint without TLS termination in production config
  const entrypointPattern = /entryPoint[s]?\s*:/i;
  const hasTls = content.includes('tls:') || content.includes('certResolver') || content.includes('certificates:');
  if (entrypointPattern.test(content) && !hasTls) {
    results.push({
      source,
      type,
      detail: 'Entrypoint TLS termination check',
      issue: 'Entrypoint(s) defined without TLS termination — production entrypoints should use TLS with certResolver (Let\'s Encrypt) or manual certificates',
    });
  }

  // exposedByDefault: true in Docker provider
  if (/exposedByDefault\s*:\s*true/.test(content)) {
    results.push({
      source,
      type,
      detail: 'exposedByDefault: true in Docker provider',
      issue: 'exposedByDefault: true causes all Docker containers to be routed by default — set exposedByDefault: false and explicitly opt-in containers with traefik.enable=true label',
    });
  }

  return results;
}

function buildTraefikConfigInfos(appPath: string): TraefikConfigInfo[] {
  const results: TraefikConfigInfo[] = [];

  // Scan root-level Traefik config files
  const rootConfigs = ['traefik.yml', 'traefik.yaml'];
  for (const fname of rootConfigs) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    results.push(...analyzeTraefikContent(content, fname, 'config'));
  }

  // Scan docker-compose files
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'docker-compose.prod.yaml'];
  for (const fname of composeFiles) {
    const fpath = path.join(appPath, fname);
    const content = safeRead(fpath, appPath);
    if (!content) continue;
    if (!content.includes('traefik')) continue;
    results.push(...analyzeTraefikContent(content, fname, 'compose'));
  }

  // Scan .traefik/ directory
  const traefikDir = path.join(appPath, '.traefik');
  if (fs.existsSync(traefikDir)) {
    const yamlFiles = [
      ...scanDirRecursive(traefikDir, '.yml'),
      ...scanDirRecursive(traefikDir, '.yaml'),
    ];
    for (const fpath of yamlFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      const relFile = path.relative(appPath, fpath);
      results.push(...analyzeTraefikContent(content, relFile, 'config'));
    }
  }

  // Also check docker/ and infra/ subdirectories
  for (const subdir of ['docker', 'infra', 'deploy']) {
    const dir = path.join(appPath, subdir);
    if (!fs.existsSync(dir)) continue;
    const yamlFiles = [
      ...scanDirRecursive(dir, '.yml'),
      ...scanDirRecursive(dir, '.yaml'),
    ];
    for (const fpath of yamlFiles) {
      const content = safeRead(fpath, appPath);
      if (!content) continue;
      if (!content.includes('traefik') && !content.includes('Traefik')) continue;
      const relFile = path.relative(appPath, fpath);
      results.push(...analyzeTraefikContent(content, relFile, 'config'));
    }
  }

  return results;
}

export function listTraefikConfig(appPath: string): McpToolResult {
  try {
    const infos = buildTraefikConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Traefik configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Traefik Configuration Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${issues.length}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  ${info.source}\n`;
      text += `    ${info.detail}\n`;
      if (info.issue) text += `    WARNING: ${info.issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTraefikConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildTraefikConfigInfos(appPath);
    const configEntries = infos.filter((i) => i.type === 'config');
    const composeEntries = infos.filter((i) => i.type === 'compose');
    const issues = infos.filter((i) => i.issue !== null);
    let text = `Traefik Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Config entries:   ${configEntries.length}\n`;
    text += `Compose entries:  ${composeEntries.length}\n`;
    text += `Issues:           ${issues.length}\n`;
    if (issues.length > 0) {
      text += `\nIssue breakdown:\n`;
      for (const info of issues) {
        text += `  - [${info.source}] ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTraefikConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_traefik_config',
      description: 'Scan traefik.yml/yaml, docker-compose.yml/yaml, .traefik/ for Traefik config issues: missing HTTPS redirectScheme middleware, insecureSkipVerify: true (MITM risk), missing rate-limit middleware, api.insecure: true (dashboard exposed), missing access logs, entrypoint without TLS termination, exposedByDefault: true in Docker provider.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_traefik_config_stats',
      description: 'Statistics for Traefik configuration: config/compose entry counts and issue breakdown.',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
