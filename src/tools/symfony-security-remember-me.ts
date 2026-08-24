// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface RememberMeInfo {
  firewall: string;
  hasRememberMe: boolean;
  lifetime?: number;
  secure?: boolean;
  httponly?: boolean;
  hasCustomHandler: boolean;
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

function loadRememberMeConfig(appPath: string): RememberMeInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;

    const results: RememberMeInfo[] = [];
    const srcDir = path.join(appPath, 'src');
    let hasCustomHandler = false;

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const content = safeRead(file, appPath);
        if (content === null) continue;
        if (content.includes('RememberMeHandlerInterface')) {
          hasCustomHandler = true;
          break;
        }
      }
    }

    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      const rmRaw = fw['remember_me'] as Record<string, unknown> | undefined;
      if (!rmRaw) {
        results.push({ firewall: name, hasRememberMe: false, hasCustomHandler: false, issues: [] });
        continue;
      }

      const lifetime = rmRaw['lifetime'] !== undefined ? parseInt(String(rmRaw['lifetime']), 10) : undefined;
      const secure = rmRaw['secure'] !== undefined ? rmRaw['secure'] === true || rmRaw['secure'] === 'true' : undefined;
      const httponly = rmRaw['httponly'] !== undefined ? rmRaw['httponly'] === true || rmRaw['httponly'] === 'true' : undefined;
      const hasSecret = rmRaw['secret'] !== undefined && String(rmRaw['secret']).trim().length > 0;
      const signatureProperties = rmRaw['signature_properties'];
      const hasSignatureProperties = Array.isArray(signatureProperties) && signatureProperties.length > 0;

      const issues: string[] = [];
      if (!hasSecret) issues.push('remember_me without explicit secret — uses APP_SECRET; rotating app secret invalidates all remember-me tokens');
      if (lifetime !== undefined && lifetime > 2592000) issues.push(`lifetime=${lifetime}s (${Math.round(lifetime / 86400)}d) exceeds 30 days — increases hijack window`);
      if (secure === false || secure === undefined) issues.push('secure not set to true — cookie sent over HTTP; set secure: true for HTTPS-only apps');
      if (httponly === false || httponly === undefined) issues.push('httponly not set to true — cookie accessible via JavaScript; set httponly: true');
      if (!hasSignatureProperties) issues.push('signature_properties not set — all user fields used as signature; changes to any field invalidate tokens');

      results.push({ firewall: name, hasRememberMe: true, lifetime, secure, httponly, hasCustomHandler, issues });
    }

    return results;
  }
  return [];
}

export function listRememberMeConfig(appPath: string): McpToolResult {
  try {
    const configs = loadRememberMeConfig(appPath);
    const withRememberMe = configs.filter((c) => c.hasRememberMe);

    if (configs.length === 0) {
      return { content: [{ type: 'text', text: 'No security.yaml found or no firewalls configured.' }] };
    }
    if (withRememberMe.length === 0) {
      return { content: [{ type: 'text', text: 'No firewalls with remember_me configured.\n\nExample:\n  security:\n    firewalls:\n      main:\n        remember_me:\n          secret: \'%kernel.secret%\'\n          lifetime: 604800\n          secure: true\n          httponly: true\n          signature_properties: [id, password]' }] };
    }

    const totalIssues = withRememberMe.reduce((s, c) => s + c.issues.length, 0);
    let text = `Remember-Me Configuration\n${'='.repeat(55)}\n\nFirewalls with remember_me: ${withRememberMe.length}  Issues: ${totalIssues}\n`;

    for (const c of withRememberMe.sort((a, b) => b.issues.length - a.issues.length)) {
      const lifetimeStr = c.lifetime !== undefined ? `${c.lifetime}s (${Math.round(c.lifetime / 86400)}d)` : 'default';
      text += `\n  ${c.firewall}\n`;
      text += `    lifetime: ${lifetimeStr}\n`;
      text += `    secure: ${c.secure ?? 'not set'}  httponly: ${c.httponly ?? 'not set'}\n`;
      if (c.hasCustomHandler) text += `    custom handler: yes\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRememberMeStats(appPath: string): McpToolResult {
  try {
    const configs = loadRememberMeConfig(appPath);
    const withRememberMe = configs.filter((c) => c.hasRememberMe);

    let text = `Remember-Me Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total firewalls:        ${configs.length}\n`;
    text += `With remember_me:       ${withRememberMe.length}\n`;
    text += `  With custom handler:  ${withRememberMe.filter((c) => c.hasCustomHandler).length}\n`;
    text += `  lifetime > 30 days:   ${withRememberMe.filter((c) => c.lifetime !== undefined && c.lifetime > 2592000).length}\n`;
    text += `  secure: true:         ${withRememberMe.filter((c) => c.secure === true).length}\n`;
    text += `  httponly: true:       ${withRememberMe.filter((c) => c.httponly === true).length}\n`;
    text += `Issues:                 ${withRememberMe.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRememberMeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_remember_me',
      description: 'Show remember_me config per firewall: secret, lifetime, secure, httponly, samesite, token_provider, signature_properties; warns on missing explicit secret, lifetime >30 days, missing secure/httponly, no signature_properties',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_remember_me_stats',
      description: 'Show remember-me statistics: firewall count, firewalls with remember_me, custom handler usage, lifetime/secure/httponly/signature_properties coverage, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
