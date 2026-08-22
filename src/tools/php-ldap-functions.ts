import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpLdapInfo {
  file: string;
  type: 'bind' | 'injection' | 'tls' | 'version';
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

function buildPhpLdapInfos(appPath: string): PhpLdapInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpFiles = getAllPhpFiles(srcDir);
  const results: PhpLdapInfo[] = [];

  for (const filePath of phpFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch { continue; }

    if (!content.includes('ldap_')) continue;

    const relFile = path.relative(appPath, filePath);

    if (/ldap_bind\s*\(/.test(content) && /\$_(GET|POST|REQUEST)/.test(content)) {
      results.push({
        file: relFile,
        type: 'bind',
        pattern: 'ldap_bind with user-controlled password',
        issues: ['ldap_bind with user-controlled password — never use request data directly as LDAP bind password; authenticate through a service account first'],
      });
    }

    if (/ldap_search\s*\(/.test(content) && content.includes('.') && !content.includes('ldap_escape')) {
      results.push({
        file: relFile,
        type: 'injection',
        pattern: 'ldap_search without ldap_escape',
        issues: ['ldap_search filter without ldap_escape() — LDAP injection possible if filter contains user input; use ldap_escape($input, \'\', LDAP_ESCAPE_FILTER)'],
      });
    }

    if (/ldap_connect\s*\(/.test(content) && !content.includes('ldap_start_tls')) {
      results.push({
        file: relFile,
        type: 'tls',
        pattern: 'ldap_connect without ldap_start_tls',
        issues: ['ldap_connect without ldap_start_tls() — LDAP credentials transmitted in plaintext; call ldap_start_tls($ldap) before ldap_bind()'],
      });
    }

    if (content.includes('ldap_set_option') && !content.includes('LDAP_OPT_PROTOCOL_VERSION')) {
      results.push({
        file: relFile,
        type: 'version',
        pattern: 'ldap_set_option without LDAP_OPT_PROTOCOL_VERSION=3',
        issues: ['LDAP client without LDAP_OPT_PROTOCOL_VERSION=3 — LDAPv2 is deprecated and has security weaknesses; set ldap_set_option($ldap, LDAP_OPT_PROTOCOL_VERSION, 3)'],
      });
    }
  }

  return results;
}

export function listPhpLdapFunctions(appPath: string): McpToolResult {
  try {
    const infos = buildPhpLdapInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No LDAP security issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PHP LDAP Functions Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpLdapFunctionStats(appPath: string): McpToolResult {
  try {
    const infos = buildPhpLdapInfos(appPath);
    let text = `PHP LDAP Function Statistics\n${'='.repeat(40)}\n\n`;
    text += `Bind:      ${infos.filter((i) => i.type === 'bind').length}\n`;
    text += `Injection: ${infos.filter((i) => i.type === 'injection').length}\n`;
    text += `TLS:       ${infos.filter((i) => i.type === 'tls').length}\n`;
    text += `Version:   ${infos.filter((i) => i.type === 'version').length}\n`;
    text += `Issues:    ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpLdapFunctionTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_ldap_functions', description: 'Analyze PHP LDAP functions for bind, injection, TLS, and version security issues', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_ldap_function_stats', description: 'Statistics for PHP LDAP functions: counts by type and issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
