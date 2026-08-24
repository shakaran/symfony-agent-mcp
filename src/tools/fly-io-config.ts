// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FlyIoConfigInfo {
  file: string;
  setting: string;
  value: string;
  issues: string[];
}

function safeReadFile(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function maskSecretValue(_value: string): string {
  return '***';
}

const SECRET_KEY_PATTERN = /password|secret|key|token|api_key|private|credential|auth|\bpass\b|\bcert\b|\bdsn\b/i;

function parseFlyToml(content: string, relPath: string): FlyIoConfigInfo[] {
  const results: FlyIoConfigInfo[] = [];

  // app name
  const appMatch = content.match(/^app\s*=\s*["']?([^"'\n]{1,100})["']?/m);
  if (appMatch) {
    results.push({ file: relPath, setting: 'app', value: appMatch[1].trim(), issues: [] });
  }

  // primary_region
  const regionMatch = content.match(/^primary_region\s*=\s*["']?([^"'\n]{1,20})["']?/m);
  if (regionMatch) {
    results.push({ file: relPath, setting: 'primary_region', value: regionMatch[1].trim(), issues: [] });
  } else {
    results.push({
      file: relPath,
      setting: 'primary_region',
      value: 'missing',
      issues: ['primary_region not set in fly.toml — specify a primary_region for deterministic placement'],
    });
  }

  // [build]
  if (/^\[build\]/m.test(content)) {
    const buildMatch = content.match(/\[build\][^[]{0,500}/s);
    const buildBlock = buildMatch ? buildMatch[0] : '';
    const imageMatch = buildBlock.match(/image\s*=\s*["']?([^"'\n]{1,100})["']?/);
    results.push({ file: relPath, setting: 'build', value: imageMatch ? imageMatch[1].trim() : 'dockerfile', issues: [] });
  }

  // [http_service] or [[services]]
  const hasHttpService = /^\[http_service\]/m.test(content);
  const hasServices = /^\[\[services\]\]/m.test(content);

  if (hasHttpService) {
    const info: FlyIoConfigInfo = { file: relPath, setting: 'http_service', value: 'configured', issues: [] };
    // health checks
    if (!/health_check|checks/.test(content)) {
      info.issues.push('No health checks configured under [http_service] — add [[http_service.checks]] with interval and timeout');
    }
    // auto_stop_machines
    if (!/auto_stop_machines/.test(content)) {
      info.issues.push('auto_stop_machines not set — consider setting auto_stop_machines = true to reduce costs when idle');
    }
    results.push(info);
  } else if (hasServices) {
    const info: FlyIoConfigInfo = { file: relPath, setting: 'services', value: 'configured', issues: [] };
    if (!/tcp_checks|http_checks/.test(content)) {
      info.issues.push('No health checks configured under [[services]] — add [[services.http_checks]] or [[services.tcp_checks]]');
    }
    results.push(info);
  } else {
    results.push({
      file: relPath,
      setting: 'http_service',
      value: 'missing',
      issues: ['No [http_service] or [[services]] block found — define service ports and health checks'],
    });
  }

  // [env] — flag hardcoded secrets
  const envMatch = content.match(/^\[env\][^[]{0,2000}/ms);
  if (envMatch) {
    const envBlock = envMatch[0];
    const lines = envBlock.split('\n').slice(1); // skip [env] line
    for (const line of lines) {
      if (line.startsWith('[')) break;
      const kvMatch = line.match(/^\s*([A-Z0-9_]{1,80})\s*=\s*["']?([^"'\n]{0,200})["']?/);
      if (!kvMatch) continue;
      const [, envKey, envVal] = kvMatch;
      if (SECRET_KEY_PATTERN.test(envKey)) {
        results.push({
          file: relPath,
          setting: `env.${envKey}`,
          value: maskSecretValue(envVal.trim()),
          issues: [`Secret-like env var "${envKey}" hardcoded in [env] block — use "fly secrets set ${envKey}=..." instead`],
        });
      }
    }
    if (!results.some((r) => r.setting === 'env')) {
      results.push({ file: relPath, setting: 'env', value: 'configured', issues: [] });
    }
  }

  // [[vm]]
  const vmMatch = content.match(/^\[\[vm\]\][^[]{0,500}/ms);
  if (vmMatch) {
    const vmBlock = vmMatch[0];
    const cpuMatch = vmBlock.match(/cpu_kind\s*=\s*["']?([^"'\n]{1,20})["']?/);
    const memMatch = vmBlock.match(/memory\s*=\s*["']?([^"'\n]{1,20})["']?/);
    results.push({
      file: relPath,
      setting: 'vm',
      value: `cpu_kind=${cpuMatch ? cpuMatch[1].trim() : 'default'} memory=${memMatch ? memMatch[1].trim() : 'default'}`,
      issues: [],
    });
  }

  return results;
}

function buildFlyIoConfigInfos(appPath: string): FlyIoConfigInfo[] {
  const results: FlyIoConfigInfo[] = [];
  const flyTomlPath = path.join(appPath, 'fly.toml');
  const content = safeReadFile(flyTomlPath, appPath);
  if (content !== null) {
    results.push(...parseFlyToml(content, 'fly.toml'));
  }
  return results;
}

export function listFlyIoConfig(appPath: string): McpToolResult {
  try {
    const infos = buildFlyIoConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No fly.toml configuration file found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Fly.io Configuration Analysis\n${'='.repeat(55)}\n\nSettings: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.setting.toUpperCase()}] ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFlyIoConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildFlyIoConfigInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Fly.io Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `fly.toml found:     ${infos.length > 0 ? 'yes' : 'no'}\n`;
    text += `Settings analyzed:  ${infos.length}\n`;
    text += `Secret issues:      ${infos.filter((i) => i.setting.startsWith('env.') && i.issues.length > 0).length}\n`;
    text += `Health check issues:${infos.filter((i) => i.issues.some((x) => x.includes('health check'))).length}\n`;
    text += `Total issues:       ${totalIssues}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getFlyIoConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_fly_io_config',
      description: 'Analyse fly.toml for app name, primary_region, build, http_service/services health checks, hardcoded secrets in [env] (values masked), and [[vm]] configuration',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_fly_io_config_stats',
      description: 'Statistics for fly.toml: settings analyzed, secret-like env vars found, health check issues, and total issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
