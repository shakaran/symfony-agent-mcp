// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface LdapAuthInfo {
  source: string;
  type: 'server' | 'provider' | 'bind' | 'search' | 'security';
  directive: string;
  value: string;
  issues: string[];
}

function buildLdapInfos(appPath: string): LdapAuthInfo[] {
  const results: LdapAuthInfo[] = [];

  let hasLdapPackage = false;
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['symfony/ldap']) hasLdapPackage = true;
    } catch { /* ignore */ }
  }

  const securityYaml = path.join(appPath, 'config', 'packages', 'security.yaml');
  if (fs.existsSync(securityYaml)) {
    const cfg = parseYamlFile(securityYaml) as Record<string, unknown> | null;
    if (cfg) {
      const security = (cfg['security'] ?? {}) as Record<string, unknown>;
      const providers = (security['providers'] ?? {}) as Record<string, unknown>;

      for (const [name, providerCfg] of Object.entries(providers)) {
        const provider = providerCfg as Record<string, unknown>;
        if (!provider['ldap']) continue;

        const ldap = (provider['ldap'] ?? {}) as Record<string, unknown>;
        const issues: string[] = [];

        const baseDn = String(ldap['base_dn'] ?? '');
        if (!baseDn) issues.push(`LDAP provider "${name}" missing base_dn — required for user search`);

        const searchDn = String(ldap['search_dn'] ?? '');
        const searchPassword = String(ldap['search_password'] ?? '');
        if (searchDn && searchPassword && !searchPassword.startsWith('%env(')) {
          issues.push(`LDAP provider "${name}" has literal search_password — use %env(LDAP_BIND_PASSWORD)% to avoid credentials in YAML`);
        }

        if (!ldap['uid_key']) {
          issues.push(`LDAP provider "${name}" missing uid_key — defaults to "sAMAccountName" (Active Directory); use "uid" for OpenLDAP`);
        }

        const filter = String(ldap['filter'] ?? '');
        if (filter && filter.includes('{username}') && !filter.includes('(') ) {
          issues.push(`LDAP search filter "${filter}" may be injectable — sanitize {username} with LdapUser::getLdapValue() or ensure filter uses proper escaping`);
        }

        results.push({ source: 'security.yaml', type: 'provider', directive: `provider.${name}`, value: `base_dn: ${baseDn}`, issues });
      }

      const firewalls = (security['firewalls'] ?? {}) as Record<string, unknown>;
      for (const [fwName, fwCfg] of Object.entries(firewalls)) {
        const fw = fwCfg as Record<string, unknown>;
        if (!fw['ldap_login'] && !fw['form_login_ldap']) continue;

        const ldapLogin = (fw['ldap_login'] ?? fw['form_login_ldap'] ?? {}) as Record<string, unknown>;
        const issues: string[] = [];

        if (!ldapLogin['service']) {
          issues.push(`Firewall "${fwName}" ldap_login missing service — must reference a configured ldap service (e.g., ldap.ldap)`);
        }
        if (!ldapLogin['dn_string'] && !ldapLogin['query_string']) {
          issues.push(`Firewall "${fwName}" ldap_login missing dn_string — without it, all credentials bind to the root DN (security risk)`);
        }

        results.push({ source: 'security.yaml', type: 'security', directive: `firewall.${fwName}`, value: 'ldap_login', issues });
      }
    }
  }

  const ldapYaml = path.join(appPath, 'config', 'packages', 'ldap.yaml');
  if (fs.existsSync(ldapYaml)) {
    const cfg = parseYamlFile(ldapYaml) as Record<string, unknown> | null;
    if (cfg) {
      const ldapCfg = (cfg['ldap'] ?? {}) as Record<string, unknown>;
      const clients = Object.entries(ldapCfg);
      for (const [name, clientCfg] of clients) {
        const client = (clientCfg ?? {}) as Record<string, unknown>;
        const issues: string[] = [];

        const host = String(client['host'] ?? '');
        const encryption = String(client['encryption'] ?? 'none');

        if (encryption === 'none') {
          issues.push(`LDAP client "${name}" uses no encryption — credentials transmitted in plaintext; use encryption: tls or ssl`);
        }
        if (host && host !== 'localhost' && encryption === 'none') {
          issues.push(`LDAP client "${name}" connects to remote host "${host}" without TLS — network sniffing exposes all LDAP passwords`);
        }
        if (!client['version'] || String(client['version']) === '2') {
          issues.push(`LDAP client "${name}" using LDAPv2 — upgrade to version: 3 (LDAPv2 deprecated, has security weaknesses)`);
        }

        results.push({ source: 'ldap.yaml', type: 'server', directive: `client.${name}`, value: `host: ${host}, encryption: ${encryption}`, issues });
      }
    }
  }

  if (!hasLdapPackage && results.length === 0) {
    results.push({ source: 'composer.json', type: 'server', directive: 'symfony/ldap', value: 'not installed', issues: ['symfony/ldap package not found — install with: composer require symfony/ldap'] });
  }

  return results;
}

export function listSymfonyLdapAuth(appPath: string): McpToolResult {
  try {
    const infos = buildLdapInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Symfony LDAP authentication configuration found (no ldap.yaml, no LDAP provider in security.yaml).' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony LDAP Authentication Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.source})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLdapAuthStats(appPath: string): McpToolResult {
  try {
    const infos = buildLdapInfos(appPath);
    let text = `LDAP Auth Statistics\n${'='.repeat(40)}\n\n`;
    text += `Servers:    ${infos.filter((i) => i.type === 'server').length}\n`;
    text += `Providers:  ${infos.filter((i) => i.type === 'provider').length}\n`;
    text += `Firewalls:  ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyLdapAuthTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_ldap_auth', description: 'Analyze Symfony LDAP authentication configuration; warns on plain-text LDAP encryption, LDAPv2, literal bind password in YAML, missing base_dn/uid_key, missing dn_string in firewall, injectable search filter', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_ldap_auth_stats', description: 'Statistics for LDAP auth: server/provider/firewall count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
