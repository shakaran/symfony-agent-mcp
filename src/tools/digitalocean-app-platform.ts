import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DigitalOceanAppInfo {
  file: string;
  service: string;
  type: 'web' | 'worker' | 'job' | 'static';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function looksLikeSecret(value: string): boolean {
  if (!value || value.startsWith('${') || value.startsWith('%') || value.length < 8) return false;
  // Looks like a raw secret if it has mixed chars and is not a plain word
  return /[A-Za-z0-9]{16,}/.test(value) || /[A-Z0-9_-]{20,}/.test(value);
}

function maskValue(value: string): string {
  return looksLikeSecret(value) ? '***' : value;
}

function parseServiceType(serviceBlock: string): DigitalOceanAppInfo['type'] {
  if (/\bkind\s*:\s*WORKER/.test(serviceBlock) || /\bworkers\s*:/.test(serviceBlock)) return 'worker';
  if (/\bkind\s*:\s*JOB/.test(serviceBlock) || /\bjobs\s*:/.test(serviceBlock)) return 'job';
  if (/\bstatic_sites\s*:/.test(serviceBlock) || /\bkind\s*:\s*STATIC/.test(serviceBlock)) return 'static';
  return 'web';
}

function buildDigitalOceanAppInfos(appPath: string): DigitalOceanAppInfo[] {
  const results: DigitalOceanAppInfo[] = [];
  const candidates = [
    '.do/app.yaml',
    'app.yaml',
    '.do/deploy.template.yaml',
  ];

  for (const relPath of candidates) {
    const fullPath = path.join(appPath, relPath);
    const content = safeRead(fullPath, appPath);
    if (!content) continue;

    const serviceNamePattern = /(?:^|\n)\s*- name\s*:\s*(\S+)/g;
    let m: RegExpExecArray | null;
    const serviceNames: string[] = [];

    while ((m = serviceNamePattern.exec(content)) !== null) {
      serviceNames.push(m[1]);
    }

    if (serviceNames.length === 0) {
      // Fallback: treat whole file as a single unnamed service
      serviceNames.push('app');
    }

    const serviceType = parseServiceType(content);

    // Check for missing health_check
    const hasHealthCheck = content.includes('health_check');
    const hasAlertPolicies = content.includes('alert_policies') || content.includes('alerts');

    for (const svcName of serviceNames) {
      const issues: string[] = [];

      if (!hasHealthCheck && serviceType === 'web') {
        issues.push(`Service "${svcName}": no health_check configured — add http_path health check for zero-downtime deploys`);
      }

      // Check for basic-xxs in prod context
      if (/instance_size_slug\s*:\s*basic-xxs/.test(content)) {
        issues.push(`Service "${svcName}": instance_size_slug basic-xxs — too small for production PHP/Symfony (min 512MB RAM); upgrade to basic-xs or higher`);
      }

      // Check for hardcoded secrets in envs
      const envValuePattern = /value\s*:\s*([^\n]+)/g;
      let ev: RegExpExecArray | null;
      while ((ev = envValuePattern.exec(content)) !== null) {
        const val = ev[1].trim().replace(/^['"]|['"]$/g, '');
        if (looksLikeSecret(val)) {
          issues.push(`Service "${svcName}": env var with plain-text value "${maskValue(val)}" — use DigitalOcean App secrets (type: SECRET) instead of inline values`);
          break;
        }
      }

      if (!hasAlertPolicies) {
        issues.push(`Service "${svcName}": no alert_policies defined — add CPU/memory/restart alerts for production observability`);
      }

      results.push({ file: relPath, service: svcName, type: serviceType, issues });
    }
  }

  return results;
}

export function listDigitalOceanAppPlatform(appPath: string): McpToolResult {
  try {
    const infos = buildDigitalOceanAppInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No DigitalOcean App Platform configuration found (.do/app.yaml, app.yaml, .do/deploy.template.yaml).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `DigitalOcean App Platform Analysis\n${'='.repeat(55)}\n\nServices: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  service:"${info.service}"  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDigitalOceanAppPlatformStats(appPath: string): McpToolResult {
  try {
    const infos = buildDigitalOceanAppInfos(appPath);
    let text = `DigitalOcean App Platform Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total services: ${infos.length}\n`;
    text += `  web:          ${infos.filter((i) => i.type === 'web').length}\n`;
    text += `  worker:       ${infos.filter((i) => i.type === 'worker').length}\n`;
    text += `  job:          ${infos.filter((i) => i.type === 'job').length}\n`;
    text += `  static:       ${infos.filter((i) => i.type === 'static').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDigitalOceanAppPlatformTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_digitalocean_app_platform',
      description: 'Analyze DigitalOcean App Platform config (.do/app.yaml, app.yaml, .do/deploy.template.yaml): parse services/workers/jobs/databases, flag hardcoded secrets in envs, missing health_check, basic-xxs instance for prod, missing alert_policies; masks secret values',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_digitalocean_app_platform_stats',
      description: 'Statistics for DigitalOcean App Platform: service counts by type (web/worker/job/static) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
