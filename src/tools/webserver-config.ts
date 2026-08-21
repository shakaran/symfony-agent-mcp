import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface WebserverVhostInfo {
  file: string;
  type: 'nginx' | 'apache';
  serverName?: string;
  docRoot?: string;
  hasHttps: boolean;
  hasPHPFpm: boolean;
  hasGzip: boolean;
  hasHSTS: boolean;
  hasXFrameOptions: boolean;
  issues: string[];
}

function findVhostFiles(appPath: string): string[] {
  const files: string[] = [];
  const searchDirs = [
    path.join(appPath, 'docker'),
    path.join(appPath, '.docker'),
    path.join(appPath, 'config', 'nginx'),
    path.join(appPath, 'config', 'apache'),
    path.join(appPath, 'deploy'),
    appPath,
  ];
  const vhostNames = ['vhost.conf', 'nginx.conf', 'site.conf', 'app.conf', 'default.conf', 'httpd.conf', '.htaccess', 'apache.conf', 'nginx-vhost.conf'];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const lower = entry.toLowerCase();
        if (vhostNames.some((n) => lower === n || lower.endsWith('.conf') || lower === '.htaccess')) {
          files.push(path.join(dir, entry));
        }
      }
    } catch { /* skip */ }
  }
  return [...new Set(files)];
}

function parseVhostFile(filePath: string, appPath: string): WebserverVhostInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isNginx = content.includes('server {') || content.includes('server_name') || content.includes('fastcgi_pass');
  const isApache = content.includes('<VirtualHost') || content.includes('ServerName') || content.includes('DocumentRoot') || content.includes('RewriteRule');
  if (!isNginx && !isApache) return null;
  const type: 'nginx' | 'apache' = isNginx ? 'nginx' : 'apache';
  const serverNameM = /(?:server_name|ServerName)\s+([^\s;]+)/.exec(content);
  const docRootM = /(?:root|DocumentRoot)\s+([^\s;]+)/.exec(content);
  const hasHttps = content.includes('443') || content.includes('ssl') || content.includes('SSL') || content.includes('https');
  const hasPHPFpm = content.includes('fastcgi_pass') || content.includes('php-fpm') || content.includes('ProxyPassMatch');
  const hasGzip = content.includes('gzip on') || content.includes('AddOutputFilterByType DEFLATE');
  const hasHSTS = content.includes('Strict-Transport-Security') || content.includes('HSTS');
  const hasXFrameOptions = content.includes('X-Frame-Options');
  const issues: string[] = [];
  if (!hasHttps) issues.push('No HTTPS configuration found — add SSL/TLS termination or redirect HTTP to HTTPS');
  if (!hasHSTS && hasHttps) issues.push('HTTPS without Strict-Transport-Security header — add HSTS for security');
  if (!hasXFrameOptions) issues.push('Missing X-Frame-Options header — add "X-Frame-Options SAMEORIGIN" to prevent clickjacking');
  if (type === 'nginx' && !content.includes('index.php')) issues.push('Nginx config without index.php as index — Symfony requires try_files $uri /index.php$is_args$args');
  return { file: path.relative(appPath, filePath), type, serverName: serverNameM?.[1], docRoot: docRootM?.[1], hasHttps, hasPHPFpm, hasGzip, hasHSTS, hasXFrameOptions, issues };
}

export function listWebserverConfig(appPath: string): McpToolResult {
  try {
    const vhostFiles = findVhostFiles(appPath);
    const configs: WebserverVhostInfo[] = [];
    for (const file of vhostFiles) {
      const c = parseVhostFile(file, appPath);
      if (c) configs.push(c);
    }
    if (configs.length === 0) return { content: [{ type: 'text', text: 'No nginx/apache vhost configuration files found.\n\nSearched: docker/, .docker/, config/nginx/, config/apache/, deploy/, and root' }] };
    const totalIssues = configs.reduce((s, c) => s + c.issues.length, 0);
    let text = `Webserver Configuration\n${'='.repeat(55)}\n\nFiles: ${configs.length}  Issues: ${totalIssues}\n`;
    for (const c of configs.sort((a, b) => b.issues.length - a.issues.length)) {
      const features = [c.hasHttps ? '✓ HTTPS' : '⚠ no HTTPS', c.hasHSTS ? '✓ HSTS' : '', c.hasGzip ? '✓ gzip' : '', c.hasPHPFpm ? '✓ PHP-FPM' : ''].filter(Boolean).join('  ');
      text += `\n  ${c.type.toUpperCase()}  ${c.serverName ?? 'no serverName'}  ${features}  (${c.file})\n`;
      for (const i of c.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebserverConfigStats(appPath: string): McpToolResult {
  try {
    const vhostFiles = findVhostFiles(appPath);
    const configs: WebserverVhostInfo[] = [];
    for (const file of vhostFiles) {
      const c = parseVhostFile(file, appPath);
      if (c) configs.push(c);
    }
    let text = `Webserver Config Statistics\n${'='.repeat(40)}\n\n`;
    text += `Files: ${configs.length}\n  Nginx: ${configs.filter((c) => c.type === 'nginx').length}\n  Apache: ${configs.filter((c) => c.type === 'apache').length}\n  With HTTPS: ${configs.filter((c) => c.hasHttps).length}\n  With HSTS: ${configs.filter((c) => c.hasHSTS).length}\n  With gzip: ${configs.filter((c) => c.hasGzip).length}\nIssues: ${configs.reduce((s, c) => s + c.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getWebserverConfigTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_webserver_config', description: 'Show nginx/apache vhost configuration: serverName, document root, HTTPS, PHP-FPM, gzip, HSTS, X-Frame-Options, missing HTTPS/HSTS/clickjacking warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_webserver_config_stats', description: 'Show webserver config statistics: file count by type, HTTPS/HSTS/gzip adoption, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
