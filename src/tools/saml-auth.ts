// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface SamlAuthInfo {
  file: string;
  type: 'sp' | 'idp' | 'certificate' | 'binding' | 'security';
  directive: string;
  value: string;
  issues: string[];
}

function safeKeyPath(p: string): string {
  // Anchored: an unanchored `\S+` before the extension backtracks across the
  // whole path on every near-miss.
  return p.replace(/^\S+\.(key|p12|pfx|der|crt|pem)$/i, '[KEY-PATH]');
}

function buildSamlAuthInfos(appPath: string): SamlAuthInfo[] {
  const results: SamlAuthInfo[] = [];

  const samlConfigPaths = [
    path.join(appPath, 'config', 'packages', 'hslavich_onelogin_saml.yaml'),
    path.join(appPath, 'config', 'packages', 'hslavich_onelogin_saml.yml'),
    path.join(appPath, 'config', 'packages', 'nbgrp_onelogin_saml.yaml'),
    path.join(appPath, 'config', 'packages', 'nbgrp_onelogin_saml.yml'),
    path.join(appPath, 'config', 'packages', 'saml.yaml'),
    path.join(appPath, 'config', 'packages', 'saml.yml'),
    path.join(appPath, 'app', 'config', 'saml.yaml'),
    path.join(appPath, 'app', 'config', 'saml.yml'),
  ];

  for (const cfgPath of samlConfigPaths) {
    if (!fs.existsSync(cfgPath)) continue;
    let content = '';
    try { content = fs.readFileSync(cfgPath, 'utf-8'); } catch { continue; }
    const relFile = path.relative(appPath, cfgPath);

    const hasSpCert = content.includes('sp_certificate') || content.includes('sp:') && content.includes('cert');
    const hasIdpCert = content.includes('idp:') && content.includes('cert') || content.includes('x509cert');
    const issues: string[] = [];

    if (!hasSpCert) {
      issues.push(`SAML SP in "${relFile}" without SP certificate — SP certificate is required for signed AuthnRequests and encrypted assertions; generate and configure sp.privateKey and sp.x509cert`);
    }

    if (!hasIdpCert) {
      issues.push(`SAML config in "${relFile}" without IdP certificate — without IdP public cert, SAML responses cannot be verified for authenticity; configure idp.x509cert to validate IdP signatures`);
    }

    const hasNameIdPolicy = content.includes('name_id_format') || content.includes('NameIDFormat');
    if (!hasNameIdPolicy) {
      issues.push(`SAML config in "${relFile}" without NameID format — defaults to unspecified; set NameIDFormat to persistent or emailAddress to ensure consistent user identification across sessions`);
    }

    const hasWantAssertionsSigned = content.includes('wantAssertionsSigned') || content.includes('want_assertions_signed');
    if (!hasWantAssertionsSigned) {
      issues.push(`SAML config in "${relFile}" without wantAssertionsSigned — without this flag, unsigned assertions are accepted; set security.wantAssertionsSigned: true to enforce cryptographic signature on assertions`);
    }

    const hasStrictMode = content.includes('strict: true') || content.includes("strict:true");
    if (!hasStrictMode) {
      issues.push(`SAML config in "${relFile}" without strict: true — non-strict mode skips validation of timestamp, audience, and signature requirements; enable strict mode for production SAML`);
    }

    const hasHttpRedirect = content.includes('binding: urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    if (!hasHttpRedirect) {
      issues.push(`SAML binding in "${relFile}" may not use HTTP-POST — HTTP-Redirect binding sends assertions in URL query string, limiting size and exposing data in server logs; prefer HTTP-POST binding for assertions`);
    }

    results.push({ file: relFile, type: 'sp', directive: 'SAML config', value: path.basename(cfgPath), issues });
  }

  const certPaths = [
    path.join(appPath, 'config', 'saml', 'certs', 'sp.crt'),
    path.join(appPath, 'config', 'certs', 'saml.crt'),
  ];
  for (const certPath of certPaths) {
    if (!fs.existsSync(certPath)) continue;
    try {
      const stat = fs.statSync(certPath);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== '600' && mode !== '400') {
        const relCertPath = safeKeyPath(path.relative(appPath, certPath));
        results.push({ file: relCertPath, type: 'certificate', directive: 'cert file permissions', value: mode, issues: [`SAML certificate "${relCertPath}" has permissions ${mode} — certificate files should be chmod 600 (owner read/write only) to prevent unauthorized access`] });
      }
    } catch { /* skip */ }
  }

  return results;
}

export function listSamlAuth(appPath: string): McpToolResult {
  try {
    const infos = buildSamlAuthInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No SAML authentication configuration found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `SAML Authentication Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.directive}: ${info.value}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSamlAuthStats(appPath: string): McpToolResult {
  try {
    const infos = buildSamlAuthInfos(appPath);
    let text = `SAML Authentication Statistics\n${'='.repeat(40)}\n\n`;
    text += `SP config:     ${infos.filter((i) => i.type === 'sp').length}\n`;
    text += `Certificates:  ${infos.filter((i) => i.type === 'certificate').length}\n`;
    text += `Issues:        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSamlAuthTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_saml_auth', description: 'Analyze SAML SSO authentication configuration; warns on missing SP certificate, no IdP cert for response verification, no NameID format, wantAssertionsSigned not set, strict mode disabled, HTTP-Redirect binding for assertions, certificate file permissions', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_saml_auth_stats', description: 'Statistics for SAML auth: SP config/certificate count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
