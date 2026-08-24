// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VarnishConfigInfo {
  file: string;
  type: 'vcl' | 'symfony' | 'purge' | 'header';
  directive: string;
  value: string;
  issues: string[];
}

function buildVarnishConfigInfos(appPath: string): VarnishConfigInfo[] {
  const results: VarnishConfigInfo[] = [];

  const vclPaths = [
    path.join(appPath, 'config', 'varnish', 'default.vcl'),
    path.join(appPath, 'varnish', 'default.vcl'),
    path.join(appPath, 'docker', 'varnish', 'default.vcl'),
    path.join(appPath, 'infrastructure', 'varnish', 'default.vcl'),
  ];

  for (const vclPath of vclPaths) {
    if (!fs.existsSync(vclPath)) continue;
    let content = '';
    try { content = fs.readFileSync(vclPath, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, vclPath);
    const issues: string[] = [];

    const hasGrace = content.includes('grace') || content.includes('beresp.grace');
    if (!hasGrace) {
      issues.push(`VCL "${relFile}" without grace period — add "set beresp.grace = 1h" to serve stale content while refetching, preventing traffic spikes from emptying cache simultaneously`);
    }

    const hasHealthcheck = content.includes('.probe') || content.includes('probe {');
    if (!hasHealthcheck) {
      issues.push(`VCL "${relFile}" without backend health probe — add .probe definition to detect unhealthy backends and avoid routing requests to down servers`);
    }

    const hasPurge = content.includes('acl purge') || content.includes('BAN') || content.includes('PURGE');
    if (!hasPurge) {
      issues.push(`VCL "${relFile}" without purge/BAN configuration — cache cannot be invalidated on content updates; add ACL-protected PURGE/BAN handler for Symfony FosHttpCache or SensioFrameworkExtraBundle`);
    }

    const hasSetCookiePassthrough = content.includes('Cookie') && !content.includes('unset req.http.Cookie');
    if (hasSetCookiePassthrough) {
      issues.push(`VCL "${relFile}" does not strip cookies before caching — requests with cookies bypass cache; unset req.http.Cookie for static assets and non-session routes`);
    }

    const hasXForwardedFor = content.includes('X-Forwarded-For') || content.includes('X-Real-IP');
    if (!hasXForwardedFor) {
      issues.push(`VCL "${relFile}" missing X-Forwarded-For forwarding — Symfony will see Varnish's IP instead of the client IP; add X-Forwarded-For and configure trusted_proxies in framework.yaml`);
    }

    results.push({ file: relFile, type: 'vcl', directive: 'VCL file', value: path.basename(vclPath), issues });
  }

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    let content = '';
    try { content = fs.readFileSync(frameworkYaml, 'utf-8'); } catch { /* skip */ }

    const hasTrustedProxies = content.includes('trusted_proxies:');
    if (!hasTrustedProxies && results.some((r) => r.type === 'vcl')) {
      results.push({ file: 'config/packages/framework.yaml', type: 'symfony', directive: 'trusted_proxies', value: '(not set)', issues: ['trusted_proxies not configured — with Varnish in front, $request->getClientIp() returns Varnish IP; set trusted_proxies: "127.0.0.1,REMOTE_ADDR"'] });
    }

    const hasHttpCache = content.includes('http_cache') || content.includes('http_method_override');
    if (!hasHttpCache && results.some((r) => r.type === 'vcl')) {
      results.push({ file: 'config/packages/framework.yaml', type: 'symfony', directive: 'http_cache', value: '(not set)', issues: ['Varnish detected but Symfony http_cache not configured — add cache control headers (max_age, s_maxage, public) to responses for Varnish to cache them'] });
    }
  }

  return results;
}

export function listVarnishConfig(appPath: string): McpToolResult {
  try {
    const infos = buildVarnishConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Varnish VCL configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Varnish Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVarnishConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildVarnishConfigInfos(appPath);
    let text = `Varnish Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `VCL files:  ${infos.filter((i) => i.type === 'vcl').length}\n`;
    text += `Symfony:    ${infos.filter((i) => i.type === 'symfony').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getVarnishConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_varnish_config', description: 'Analyze Varnish VCL configuration; warns on missing grace period, no backend health probe, no PURGE/BAN handler, cookie passthrough bypassing cache, missing X-Forwarded-For, Symfony trusted_proxies not configured', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_varnish_config_stats', description: 'Statistics for Varnish config: VCL/Symfony entry count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
