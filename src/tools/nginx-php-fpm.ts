import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NginxPhpFpmInfo {
  source: string;
  section: string;
  directive: string;
  value: string;
  issues: string[];
}

function findNginxConfFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'docker', 'nginx', 'nginx.conf'),
    path.join(appPath, 'docker', 'nginx', 'default.conf'),
    path.join(appPath, '.docker', 'nginx.conf'),
    path.join(appPath, 'nginx.conf'),
    path.join(appPath, 'config', 'nginx.conf'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

function findFpmConfFiles(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'docker', 'php', 'php-fpm.conf'),
    path.join(appPath, 'docker', 'php', 'www.conf'),
    path.join(appPath, '.docker', 'php-fpm.conf'),
    path.join(appPath, 'php-fpm.conf'),
    path.join(appPath, 'config', 'php-fpm.conf'),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

function parseDirectiveValue(line: string): string {
  const m = /\s+(\S+)\s*;/.exec(line);
  return m ? m[1] : '';
}

function buildNginxPhpFpmInfos(appPath: string): NginxPhpFpmInfo[] {
  const results: NginxPhpFpmInfo[] = [];

  const nginxFiles = findNginxConfFiles(appPath);
  for (const nginxFile of nginxFiles) {
    let content = '';
    try { content = fs.readFileSync(nginxFile, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, nginxFile);
    const lines = content.split('\n');

    for (const line of lines) {
      const t = line.trim();

      if (t.startsWith('client_max_body_size')) {
        const val = parseDirectiveValue(t);
        const issues: string[] = [];
        const num = parseInt(val, 10);
        if (val.endsWith('m') || val.endsWith('M')) {
          if (num > 100) issues.push(`client_max_body_size ${val} is very large — limit file upload size to prevent DoS; use 10m–20m for most applications`);
        }
        results.push({ source: relFile, section: 'nginx', directive: 'client_max_body_size', value: val, issues });
      }

      if (t.startsWith('server_tokens')) {
        const val = parseDirectiveValue(t);
        if (val !== 'off') {
          results.push({ source: relFile, section: 'nginx', directive: 'server_tokens', value: val, issues: ['server_tokens should be "off" — disabling version disclosure reduces information leakage'] });
        }
      }

      if (t.startsWith('add_header X-Frame-Options') || t.startsWith('add_header x-frame-options')) {
        results.push({ source: relFile, section: 'security_headers', directive: 'X-Frame-Options', value: 'set', issues: [] });
      }
      if (t.startsWith('add_header Content-Security-Policy') || t.startsWith('add_header content-security-policy')) {
        results.push({ source: relFile, section: 'security_headers', directive: 'Content-Security-Policy', value: 'set', issues: [] });
      }

      if (t.startsWith('try_files') && !t.includes('$uri/') && t.includes('php')) {
        results.push({ source: relFile, section: 'nginx', directive: 'try_files', value: t, issues: ['try_files pattern does not include $uri/ directory check — symlink traversal may bypass intended routing'] });
      }

      if (t.includes('fastcgi_param SCRIPT_FILENAME') && !t.includes('$document_root') && !t.includes('$realpath_root')) {
        results.push({ source: relFile, section: 'fastcgi', directive: 'SCRIPT_FILENAME', value: t, issues: ['SCRIPT_FILENAME uses a hardcoded path instead of $document_root$fastcgi_script_name — breaks when document root changes'] });
      }

      if (t.startsWith('access_log') && t.includes('off')) {
        results.push({ source: relFile, section: 'nginx', directive: 'access_log', value: 'off', issues: ['access_log is disabled — consider enabling for security audit trails and incident investigation'] });
      }
    }

    const hasXFrame = content.includes('X-Frame-Options') || content.includes('x-frame-options');
    const hasCSP = content.includes('Content-Security-Policy') || content.includes('content-security-policy');
    const hasHSTS = content.includes('Strict-Transport-Security') || content.includes('strict-transport-security');
    if (!hasXFrame) results.push({ source: relFile, section: 'security_headers', directive: 'X-Frame-Options', value: 'missing', issues: ['Missing X-Frame-Options header — add "add_header X-Frame-Options SAMEORIGIN;" to prevent clickjacking'] });
    if (!hasCSP) results.push({ source: relFile, section: 'security_headers', directive: 'Content-Security-Policy', value: 'missing', issues: ['Missing Content-Security-Policy header — CSP is the primary XSS mitigation for modern browsers'] });
    if (!hasHSTS && content.includes('ssl') && content.includes('443')) {
      results.push({ source: relFile, section: 'security_headers', directive: 'Strict-Transport-Security', value: 'missing', issues: ['HTTPS server has no Strict-Transport-Security header — add HSTS with max-age >= 31536000'] });
    }
  }

  const fpmFiles = findFpmConfFiles(appPath);
  for (const fpmFile of fpmFiles) {
    let content = '';
    try { content = fs.readFileSync(fpmFile, 'utf-8'); } catch { continue; }

    const relFile = path.relative(appPath, fpmFile);
    const lines = content.split('\n');

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#') || !t.includes('=')) continue;

      const [rawKey, rawVal] = t.split('=');
      const k = (rawKey ?? '').trim();
      const v = (rawVal ?? '').trim();

      if (k === 'pm') {
        if (v === 'static') {
          results.push({ source: relFile, section: 'fpm', directive: 'pm', value: v, issues: ['pm=static always runs max_children processes — use pm=dynamic or pm=ondemand to save memory when traffic is low'] });
        }
      }
      if (k === 'pm.max_children') {
        const num = parseInt(v, 10);
        if (!isNaN(num) && num > 200) {
          results.push({ source: relFile, section: 'fpm', directive: 'pm.max_children', value: v, issues: [`pm.max_children=${v} is very high — each worker can use 30–60MB; verify you have enough RAM (${v} × 50MB = ${num * 50}MB)`] });
        }
      }
      if (k === 'request_terminate_timeout' && v === '0') {
        results.push({ source: relFile, section: 'fpm', directive: 'request_terminate_timeout', value: v, issues: ['request_terminate_timeout=0 means slow requests run forever — set to 60s or 300s to prevent worker starvation from runaway requests'] });
      }
      if (k === 'catch_workers_output' && v === 'yes') {
        results.push({ source: relFile, section: 'fpm', directive: 'catch_workers_output', value: v, issues: [] });
      }
    }
  }

  if (nginxFiles.length === 0 && fpmFiles.length === 0) {
    results.push({ source: 'docker/', section: 'config', directive: 'nginx+fpm', value: 'not found', issues: ['No nginx.conf or php-fpm.conf found in docker/ — if using Docker, add these files for server configuration analysis'] });
  }

  return results;
}

export function listNginxPhpFpmConfig(appPath: string): McpToolResult {
  try {
    const infos = buildNginxPhpFpmInfos(appPath);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Nginx + PHP-FPM Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.section}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNginxPhpFpmStats(appPath: string): McpToolResult {
  try {
    const infos = buildNginxPhpFpmInfos(appPath);
    let text = `Nginx + PHP-FPM Statistics\n${'='.repeat(40)}\n\n`;
    text += `Nginx directives: ${infos.filter((i) => i.section === 'nginx').length}\n`;
    text += `Security headers: ${infos.filter((i) => i.section === 'security_headers').length}\n`;
    text += `FPM directives:   ${infos.filter((i) => i.section === 'fpm').length}\n`;
    text += `Issues:           ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getNginxPhpFpmTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_nginx_php_fpm_config', description: 'Analyze nginx.conf and php-fpm.conf; warns on large client_max_body_size, server_tokens on, missing security headers (CSP/HSTS/X-Frame-Options), bad try_files, pm=static, excessive max_children, request_terminate_timeout=0', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_nginx_php_fpm_stats', description: 'Statistics for nginx+fpm: nginx/security-headers/fpm directive count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
