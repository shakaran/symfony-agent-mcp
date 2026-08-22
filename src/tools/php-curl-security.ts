import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CurlSecurityInfo {
  file: string;
  type: 'tls' | 'timeout' | 'redirect' | 'ssrf';
  pattern: string;
  issues: string[];
}


function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function buildPhpCurlSecurityInfos(appPath: string): CurlSecurityInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: CurlSecurityInfo[] = [];

  for (const filePath of phpFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch { continue; }

    if (!content.includes('curl_') && !content.includes('CURLOPT_')) continue;

    const relFile = path.relative(appPath, filePath);

    if (/CURLOPT_SSL_VERIFYPEER.*false/i.test(content)) {
      results.push({
        file: relFile,
        type: 'tls',
        pattern: 'CURLOPT_SSL_VERIFYPEER=false',
        issues: ['CURLOPT_SSL_VERIFYPEER=false disables TLS certificate verification — vulnerable to MITM attacks; always keep true in production'],
      });
    }

    if (/CURLOPT_SSL_VERIFYHOST.*[,=] {0,}0/.test(content)) {
      results.push({
        file: relFile,
        type: 'tls',
        pattern: 'CURLOPT_SSL_VERIFYHOST=0',
        issues: ['CURLOPT_SSL_VERIFYHOST=0 disables hostname verification — even if VERIFYPEER is on, host mismatch is ignored; use 2 (default)'],
      });
    }

    if (content.includes('curl_exec') && !content.includes('CURLOPT_TIMEOUT') && !content.includes('CURLOPT_CONNECTTIMEOUT')) {
      results.push({
        file: relFile,
        type: 'timeout',
        pattern: 'curl_exec without timeouts',
        issues: ['cURL call without CURLOPT_TIMEOUT and CURLOPT_CONNECTTIMEOUT — slow/unresponsive servers can hang PHP-FPM workers; add both timeouts'],
      });
    }

    if (/CURLOPT_FOLLOWLOCATION.*true/i.test(content) && !content.includes('CURLOPT_MAXREDIRS')) {
      results.push({
        file: relFile,
        type: 'redirect',
        pattern: 'CURLOPT_FOLLOWLOCATION without CURLOPT_MAXREDIRS',
        issues: ['CURLOPT_FOLLOWLOCATION=true without CURLOPT_MAXREDIRS — infinite redirect chains possible; add CURLOPT_MAXREDIRS with a small value like 5'],
      });
    }

    if (/\$_(GET|POST|REQUEST)/.test(content) && (content.includes('CURLOPT_URL') || content.includes('curl_init'))) {
      results.push({
        file: relFile,
        type: 'ssrf',
        pattern: 'User-controlled URL in cURL call',
        issues: ['User-controlled URL in cURL call detected — validate against an allowlist before passing to curl_init() or CURLOPT_URL to prevent SSRF'],
      });
    }
  }

  return results;
}

export function listPhpCurlSecurity(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCurlSecurityInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No cURL security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP cURL Security Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCurlSecurityStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpCurlSecurityInfos(appPath);
    let text = `PHP cURL Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `TLS:      ${infos.filter((i) => i.type === 'tls').length}\n`;
    text += `Timeout:  ${infos.filter((i) => i.type === 'timeout').length}\n`;
    text += `Redirect: ${infos.filter((i) => i.type === 'redirect').length}\n`;
    text += `SSRF:     ${infos.filter((i) => i.type === 'ssrf').length}\n`;
    text += `Issues:   ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpCurlSecurityTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_curl_security', description: 'Analyze PHP cURL calls for TLS, timeout, redirect, and SSRF security issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_curl_security_stats', description: 'Statistics for PHP cURL security: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
