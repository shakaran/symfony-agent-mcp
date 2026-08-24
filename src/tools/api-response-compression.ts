// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ResponseCompressionInfo {
  source: string;
  type: 'gzip' | 'brotli' | 'headers' | 'exclusion' | 'security';
  pattern: string;
  issues: string[];
}

function buildApiResponseCompressionInfos(appPath: string): ResponseCompressionInfo[] {
  const results: ResponseCompressionInfo[] = [];

  const nginxPaths = [
    path.join(appPath, 'nginx.conf'),
    path.join(appPath, 'docker', 'nginx.conf'),
    path.join(appPath, 'docker', 'nginx', 'nginx.conf'),
    path.join(appPath, '.docker', 'nginx', 'nginx.conf'),
  ];

  const sitesEnabled = path.join(appPath, 'sites-enabled');
  if (fs.existsSync(sitesEnabled)) {
    try {
      for (const f of fs.readdirSync(sitesEnabled)) {
        nginxPaths.push(path.join(sitesEnabled, f));
      }
    } catch { /* skip */ }
  }

  let nginxFound = false;
  for (const nginxPath of nginxPaths) {
    if (!fs.existsSync(nginxPath)) continue;
    let content = '';
    try { content = fs.readFileSync(nginxPath, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, nginxPath);
    nginxFound = true;

    const hasGzip = content.includes('gzip on;') || /gzip\s+on;/.test(content);
    const hasBrotli = content.includes('brotli on;') || /brotli\s+on;/.test(content);
    const hasGzipMinLength = content.includes('gzip_min_length');
    const hasGzipTypes = content.includes('gzip_types');
    const hasVary = content.includes('Vary') || content.includes('vary');

    if (hasBrotli) {
      results.push({
        source: relFile,
        type: 'brotli',
        pattern: 'brotli compression enabled',
        issues: [],
      });
    }

    if (hasGzip) {
      const gzipIssues: string[] = [];

      if (!hasGzipMinLength) {
        gzipIssues.push('gzip without gzip_min_length — compressing tiny responses wastes CPU; add gzip_min_length 860;');
      }

      if (hasGzipTypes && (content.includes('image/jpeg') || content.includes('image/png') || content.includes('image/gif'))) {
        gzipIssues.push('gzip enabled for binary image formats — images are already compressed; exclude image/jpeg image/png image/gif from gzip_types');
      }

      if (!hasVary) {
        gzipIssues.push('Response compression without Vary: Accept-Encoding header — proxies may cache wrong version; ensure Vary: Accept-Encoding is sent with compressed responses');
      }

      results.push({
        source: relFile,
        type: 'gzip',
        pattern: 'gzip compression configured',
        issues: gzipIssues,
      });
    } else {
      results.push({
        source: relFile,
        type: 'gzip',
        pattern: 'nginx without gzip compression',
        issues: [
          'Nginx configuration without gzip compression — enable with gzip on; gzip_min_length 860; gzip_types text/plain application/json application/javascript text/css',
        ],
      });
    }
  }

  const htaccessPath = path.join(appPath, 'public', '.htaccess');
  const apacheConfigPath = path.join(appPath, 'apache.conf');
  const apachePaths = [htaccessPath, apacheConfigPath];

  for (const apachePath of apachePaths) {
    if (!fs.existsSync(apachePath)) continue;
    let content = '';
    try { content = fs.readFileSync(apachePath, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, apachePath);
    const hasDeflate = content.includes('mod_deflate') || content.includes('AddOutputFilterByType DEFLATE');
    const hasBrotli = content.includes('mod_brotli') || content.includes('AddOutputFilterByType BROTLI');

    if (hasDeflate) {
      results.push({
        source: relFile,
        type: 'gzip',
        pattern: 'Apache mod_deflate compression',
        issues: [],
      });
    }
    if (hasBrotli) {
      results.push({
        source: relFile,
        type: 'brotli',
        pattern: 'Apache mod_brotli compression',
        issues: [],
      });
    }
  }

  if (!nginxFound) {
    const frameworkYaml = path.join(appPath, 'config', 'packages', 'framework.yaml');
    if (fs.existsSync(frameworkYaml)) {
      results.push({
        source: 'config/packages/framework.yaml',
        type: 'headers',
        pattern: 'no web server compression config detected',
        issues: [
          'No response compression configuration found — for high-traffic applications, enable gzip on your web server (nginx: gzip on; gzip_types ...) or Apache (mod_deflate)',
        ],
      });
    }
  }

  return results;
}

export function listApiResponseCompression(appPath: string): McpToolResult {
  try {
    const infos = buildApiResponseCompressionInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No response compression patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `API Response Compression Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiResponseCompressionStats(appPath: string): McpToolResult {
  try {
    const infos = buildApiResponseCompressionInfos(appPath);
    let text = `API Response Compression Statistics\n${'='.repeat(40)}\n\n`;
    text += `Gzip:      ${infos.filter((i) => i.type === 'gzip').length}\n`;
    text += `Brotli:    ${infos.filter((i) => i.type === 'brotli').length}\n`;
    text += `Headers:   ${infos.filter((i) => i.type === 'headers').length}\n`;
    text += `Exclusion: ${infos.filter((i) => i.type === 'exclusion').length}\n`;
    text += `Security:  ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getApiResponseCompressionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_api_response_compression', description: 'Analyze response compression configuration; warns on missing nginx gzip, gzip without gzip_min_length, gzip on binary images, missing Vary header', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_api_response_compression_stats', description: 'Statistics for response compression: counts by type, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
