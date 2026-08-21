import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface RenderDeployInfo {
  file: string;
  service: string;
  type: 'web' | 'worker' | 'cron' | 'static';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function mapRenderType(rawType: string): RenderDeployInfo['type'] {
  if (rawType === 'worker' || rawType === 'pserv') return 'worker';
  if (rawType === 'cron') return 'cron';
  if (rawType === 'static') return 'static';
  return 'web';
}

function looksLikeHardcodedSecret(value: string, key = ''): boolean {
  if (!value || value.startsWith('${') || value.startsWith('%')) return false;
  if (key && /password|secret|token|key|api_key|private|credential|auth|\bpass\b|\bcert\b|\bdsn\b/i.test(key)) return true;
  return value.length >= 4 && (/[A-Za-z0-9+/]{4,}={0,2}$/.test(value) || /[A-Z0-9_-]{4,}/.test(value));
}

function buildRenderDeployInfos(appPath: string): RenderDeployInfo[] {
  const results: RenderDeployInfo[] = [];
  const candidates = ['render.yaml', '.render/render.yaml'];

  for (const relPath of candidates) {
    const fullPath = path.join(appPath, relPath);
    const content = safeRead(fullPath, appPath);
    if (!content) continue;
    if (content.length > 500_000) continue;

    // Parse service blocks by splitting on "- name:"
    const serviceBlockPattern = /- name\s*:\s*(\S+)([\s\S]*?)(?=\n\s*- name\s*:|\n\s*databases\s*:|\s*$)/g;
    let m: RegExpExecArray | null;

    while ((m = serviceBlockPattern.exec(content)) !== null) {
      const svcName = m[1];
      const block = m[2];
      const issues: string[] = [];

      const typeMatch = /\btype\s*:\s*(\S+)/.exec(block);
      const rawType = typeMatch ? typeMatch[1] : 'web';
      const svcType = mapRenderType(rawType);

      // Check plan for web services
      const planMatch = /\bplan\s*:\s*(\S+)/.exec(block);
      if (planMatch && planMatch[1] === 'free' && svcType === 'web') {
        issues.push(`Service "${svcName}": free plan for web service — Render free services have ephemeral disks and spin down after inactivity; upgrade for persistent state`);
      }

      // Check health check path for web services
      const hasHealthCheck = /healthCheckPath\s*:/.test(block) || /health_check_path\s*:/.test(block);
      if (!hasHealthCheck && svcType === 'web') {
        issues.push(`Service "${svcName}": missing healthCheckPath — add healthCheckPath for zero-downtime deploys and service health monitoring`);
      }

      // Check for autoDeploy
      const hasAutoDeploy = /autoDeploy\s*:/.test(block);
      if (!hasAutoDeploy) {
        issues.push(`Service "${svcName}": no autoDeploy setting — set autoDeploy: false for production services requiring manual deploy approval`);
      }

      // Check envVars for hardcoded secrets
      const envVarValuePattern = /value\s*:\s*([^\n]+)/g;
      let ev: RegExpExecArray | null;
      while ((ev = envVarValuePattern.exec(block)) !== null) {
        const val = ev[1].trim().replace(/^['"]|['"]$/g, '');
        if (looksLikeHardcodedSecret(val)) {
          issues.push(`Service "${svcName}": envVar with plain-text value "***" — use sync: true with Render environment group secrets instead`);
          break;
        }
      }

      results.push({ file: relPath, service: svcName, type: svcType, issues });
    }

    // If no service blocks parsed, report the file with global info
    if (results.length === 0) {
      results.push({ file: relPath, service: 'global', type: 'web', issues: ['Could not parse service blocks from render.yaml — verify YAML structure'] });
    }
  }

  return results;
}

export function listRenderDeployConfig(appPath: string): McpToolResult {
  try {
    const infos = buildRenderDeployInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Render deploy configuration found (render.yaml, .render/render.yaml).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Render Deploy Configuration Analysis\n${'='.repeat(55)}\n\nServices: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}]  service:"${info.service}"  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRenderDeployConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildRenderDeployInfos(appPath);
    let text = `Render Deploy Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total services: ${infos.length}\n`;
    text += `  web:          ${infos.filter((i) => i.type === 'web').length}\n`;
    text += `  worker:       ${infos.filter((i) => i.type === 'worker').length}\n`;
    text += `  cron:         ${infos.filter((i) => i.type === 'cron').length}\n`;
    text += `  static:       ${infos.filter((i) => i.type === 'static').length}\n`;
    text += `Issues:         ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRenderDeployConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_render_deploy_config',
      description: 'Analyze Render deploy config (render.yaml, .render/render.yaml): parse services/databases by type (web/worker/cron/static/pserv), flag free plan for web with persistent state, missing healthCheckPath, secrets in envVars value, no autoDeploy setting',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_render_deploy_config_stats',
      description: 'Statistics for Render deploy configuration: service counts by type (web/worker/cron/static) and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
