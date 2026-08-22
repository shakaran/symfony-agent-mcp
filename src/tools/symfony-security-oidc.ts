/**
 * Symfony OIDC / OpenID Connect Authentication Inspector
 *
 * Detects OpenID Connect (OIDC) authentication configuration.
 * Scans security.yaml for: oidc, openid_connect, oauth2, connect sections.
 * Scans src/ PHP for: OidcTokenHandlerInterface, OidcUserInfoTokenHandler,
 *   openid scope, id_token processing.
 * Scans composer.json for: knpuniversity/oauth2-client-bundle, league/oauth2-client,
 *   hwi/oauth-bundle, symfony/security-bundle OIDC native.
 *
 * Warns on:
 *   - OIDC without nonce validation (replay attack)
 *   - id_token used without signature verification
 *   - PKCE not enabled for authorization code flow
 *   - OIDC scope without 'openid' (not actually OIDC)
 *   - state parameter not validated
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';
import { parseYamlFile } from '../utils/symfony-parser.js';


interface OidcInfo {
  file: string;
  hasNonce: boolean;
  hasPkce: boolean;
  hasStateValidation: boolean;
  provider: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function detectOidcProvider(appPath: string): string {
  const composerPath = path.join(appPath, 'composer.json');
  try {
    const raw = fs.readFileSync(composerPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const req = (json['require'] ?? {}) as Record<string, string>;
    if ('knpuniversity/oauth2-client-bundle' in req) return 'knpuniversity/oauth2-client-bundle';
    if ('hwi/oauth-bundle' in req) return 'hwi/oauth-bundle';
    if ('league/oauth2-client' in req) return 'league/oauth2-client';
  } catch { /* skip */ }

  const securityPath = path.join(appPath, 'config', 'packages', 'security.yaml');
  try {
    const raw = fs.readFileSync(securityPath, 'utf-8');
    if (raw.includes('oidc') || raw.includes('openid_connect')) return 'symfony-native-oidc';
  } catch { /* skip */ }

  return 'unknown';
}

function parseOidcPhpFile(filePath: string): OidcInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isOidc =
    content.includes('OidcTokenHandlerInterface') ||
    content.includes('OidcUserInfoTokenHandler') ||
    content.includes('id_token') ||
    content.includes('openid') ||
    content.includes('OidcClient') ||
    content.includes('OpenIdConnect') ||
    content.includes('OAuth2Client');

  if (!isOidc) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;

  const issues: string[] = [];
  const provider = detectOidcProvider(path.dirname(path.dirname(filePath)));

  // Nonce validation
  const hasNonce =
    content.includes('nonce') ||
    content.includes('getNonce()') ||
    content.includes('setNonce(') ||
    content.includes('verifyNonce');

  if (!hasNonce) {
    issues.push('OIDC implementation does not validate nonce — replay attacks are possible; always verify nonce matches session value');
  }

  // PKCE
  const hasPkce =
    content.includes('PKCE') ||
    content.includes('pkce') ||
    content.includes('code_verifier') ||
    content.includes('code_challenge') ||
    content.includes('codeVerifier') ||
    content.includes('codeChallenge');

  if (!hasPkce) {
    issues.push('OIDC/OAuth2 flow does not use PKCE (code_verifier/code_challenge) — authorization code interception attacks are possible for public clients');
  }

  // State parameter validation
  const hasStateValidation =
    content.includes('state') &&
    (content.includes('getState()') ||
      content.includes('setState(') ||
      content.includes('verifyState') ||
      content.includes('$state') ||
      content.includes("'state'"));

  if (!hasStateValidation) {
    issues.push('OIDC implementation does not validate the state parameter — CSRF attacks on the authorization callback are possible');
  }

  // id_token signature verification
  if (content.includes('id_token') && !content.includes('verify') && !content.includes('JWT') && !content.includes('signature')) {
    issues.push('id_token is processed without signature verification — forged tokens can be accepted; verify with provider public key');
  }

  // openid scope check
  if ((content.includes("'openid'") || content.includes('"openid"')) === false &&
    (content.includes('scope') || content.includes('scopes'))) {
    issues.push("OIDC scope list does not include 'openid' — without the openid scope this is OAuth2, not OIDC; id_token will not be returned");
  }

  return {
    file: filePath,
    hasNonce,
    hasPkce,
    hasStateValidation,
    provider,
    issues,
  };
}

function parseOidcYaml(appPath: string): OidcInfo | null {
  const configPath = path.join(appPath, 'config', 'packages', 'security.yaml');
  let raw = '';
  try { raw = fs.readFileSync(configPath, 'utf-8'); } catch { return null; }

  const hasOidc = raw.includes('oidc') || raw.includes('openid_connect') ||
    raw.includes('oauth2') || raw.includes('connect:');

  if (!hasOidc) return null;

  try { parseYamlFile(configPath); } catch { /* skip */ }

  const issues: string[] = [];
  const provider = detectOidcProvider(appPath);

  const hasNonce = raw.includes('nonce');
  const hasPkce = raw.includes('pkce') || raw.includes('code_challenge');
  const hasStateValidation = raw.includes('state');

  if (!hasNonce) {
    issues.push('security.yaml OIDC configuration does not reference nonce — verify nonce is enforced in token handler');
  }
  if (!hasPkce) {
    issues.push('security.yaml OIDC configuration does not enable PKCE — enable code_challenge for authorization code flows');
  }
  if (!hasStateValidation) {
    issues.push('security.yaml OIDC configuration does not reference state parameter — CSRF protection on callback not confirmed');
  }
  if (raw.includes('scope') && !raw.includes('openid')) {
    issues.push("OIDC scope in security.yaml does not include 'openid' — this is not OIDC without the openid scope");
  }

  return {
    file: configPath,
    hasNonce,
    hasPkce,
    hasStateValidation,
    provider,
    issues,
  };
}

function loadOidcInfos(appPath: string): OidcInfo[] {
  const results: OidcInfo[] = [];

  const yamlInfo = parseOidcYaml(appPath);
  if (yamlInfo) {
    yamlInfo.file = path.relative(appPath, yamlInfo.file);
    results.push(yamlInfo);
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseOidcPhpFile(f);
      if (r) {
        r.file = path.relative(appPath, r.file);
        results.push(r);
      }
    }
  }

  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listSymfonySecurityOidc(appPath: string): McpToolResult {
  try {
    const infos = loadOidcInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No OIDC/OpenID Connect configuration or implementation found.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony OIDC Inspector (${infos.length} files)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}  [provider: ${info.provider}]\n`;
      const flags = [
        info.hasNonce ? 'nonce-ok' : 'NO-NONCE',
        info.hasPkce ? 'pkce-ok' : 'NO-PKCE',
        info.hasStateValidation ? 'state-ok' : 'NO-STATE',
      ].join(', ');
      text += `    flags: [${flags}]\n`;
      for (const issue of info.issues) text += `    WARN: ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonySecurityOidcStats(appPath: string): McpToolResult {
  try {
    const infos = loadOidcInfos(appPath);

    let text = `OIDC Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `OIDC files found:             ${infos.length}\n`;
    text += `  With nonce validation:      ${infos.filter((i) => i.hasNonce).length}\n`;
    text += `  With PKCE:                  ${infos.filter((i) => i.hasPkce).length}\n`;
    text += `  With state validation:      ${infos.filter((i) => i.hasStateValidation).length}\n`;
    text += `Issues:                       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityOidcTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_security_oidc',
      description: 'List Symfony OIDC/OpenID Connect configurations and implementations: detects nonce validation, PKCE, state parameter, id_token signature verification, openid scope presence; warns on replay attack risk, CSRF risk, forged token risk, OAuth2 masquerading as OIDC',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_security_oidc_stats',
      description: 'Show OIDC security statistics: total files, nonce/PKCE/state coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
