import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CdnConfigInfo {
  source: string;
  type: 'asset' | 'cors' | 'csp' | 'caching' | 'integrity';
  directive: string;
  value: string;
  issues: string[];
}

function buildCdnConfigInfos(appPath: string): CdnConfigInfo[] {
  const results: CdnConfigInfo[] = [];

  const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
  if (fs.existsSync(frameworkYaml)) {
    let content = '';
    try { content = fs.readFileSync(frameworkYaml, 'utf-8'); } catch { /* skip */ }

    const cdnMatch = /base_url\s*:\s*([^\n]+)/.exec(content);
    if (cdnMatch) {
      const cdnUrl = cdnMatch[1].trim();
      const issues: string[] = [];
      const isHttp = cdnUrl.startsWith('http://');
      if (isHttp) {
        issues.push(`CDN base_url "${cdnUrl}" uses HTTP — use HTTPS to prevent mixed content warnings and man-in-the-middle attacks on static assets`);
      }
      const hasIntegrity = content.includes('integrity') || content.includes('crossorigin');
      if (!hasIntegrity && (cdnUrl.includes('cdn') || cdnUrl.includes('cloudfront') || cdnUrl.includes('fastly'))) {
        issues.push(`CDN asset URL configured without subresource integrity (SRI) — add integrity= and crossorigin= attributes to script/style tags to detect CDN tampering`);
      }
      results.push({ source: 'framework.yaml', type: 'asset', directive: 'assets.base_url', value: cdnUrl.substring(0, 40), issues });
    }

    const hasTrustedHosts = content.includes('trusted_hosts:');
    if (!hasTrustedHosts && content.includes('base_url')) {
      results.push({ source: 'framework.yaml', type: 'asset', directive: 'trusted_hosts', value: '(not set)', issues: ['assets.base_url configured but trusted_hosts not set — add CDN hostname to trusted_hosts to prevent host injection attacks via Host header'] });
    }
  }

  const securityYaml = path.join(appPath, 'config', 'packages', 'security.yaml');
  if (fs.existsSync(securityYaml)) {
    let content = '';
    try { content = fs.readFileSync(securityYaml, 'utf-8'); } catch { /* skip */ }
    if (content.includes('Content-Security-Policy') || content.includes('csp')) {
      const hasCdnInCsp = content.includes('cdn') || content.includes('cloudfront') || content.includes('fastly') || content.includes('amazonaws');
      if (!hasCdnInCsp) {
        results.push({ source: 'security.yaml', type: 'csp', directive: 'Content-Security-Policy', value: 'CDN domains missing', issues: ['CSP defined but CDN domains not whitelisted — browsers will block CDN resources; add CDN hostname to script-src, style-src, img-src directives'] });
      }
    }
  }

  const nelmioYaml = path.join(appPath, 'config', 'packages', 'nelmio_cors.yaml');
  if (fs.existsSync(nelmioYaml)) {
    let content = '';
    try { content = fs.readFileSync(nelmioYaml, 'utf-8'); } catch { /* skip */ }
    const hasWildcard = content.includes('allow_origin: [\'*\']') || content.includes('allow_origin: ["*"]') || content.includes("allow_origin:\n    - '*'");
    if (hasWildcard) {
      results.push({ source: 'nelmio_cors.yaml', type: 'cors', directive: 'allow_origin', value: '*', issues: ['CORS allow_origin wildcard "*" — with credentials (cookies, auth headers) this is blocked by browsers; specify exact CDN/frontend origin domains instead'] });
    }
  }

  const assetMapperYaml = path.join(appPath, 'config', 'packages', 'asset_mapper.yaml');
  if (fs.existsSync(assetMapperYaml)) {
    let content = '';
    try { content = fs.readFileSync(assetMapperYaml, 'utf-8'); } catch { /* skip */ }
    const hasPublicUrl = content.includes('server:') || content.includes('public_url:');
    if (!hasPublicUrl) {
      results.push({ source: 'asset_mapper.yaml', type: 'asset', directive: 'AssetMapper public_url', value: '(default)', issues: ['AssetMapper server/public_url not set for CDN — assets will be served from app origin instead of CDN; configure server: https://cdn.example.com for CDN delivery'] });
    }
  }

  return results;
}

export function listCdnConfig(appPath: string): McpToolResult {
  try {
    const infos = buildCdnConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No CDN configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `CDN Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCdnConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildCdnConfigInfos(appPath);
    let text = `CDN Configuration Statistics\n${'='.repeat(40)}\n\n`;
    text += `Asset config:  ${infos.filter((i) => i.type === 'asset').length}\n`;
    text += `CORS config:   ${infos.filter((i) => i.type === 'cors').length}\n`;
    text += `CSP config:    ${infos.filter((i) => i.type === 'csp').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getCdnConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_cdn_config', description: 'Analyze CDN configuration in Symfony; warns on HTTP CDN base_url, missing SRI integrity attributes, CDN domains not in CSP, CORS wildcard origin, AssetMapper server not configured for CDN delivery', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_cdn_config_stats', description: 'Statistics for CDN config: asset/CORS/CSP entry count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
