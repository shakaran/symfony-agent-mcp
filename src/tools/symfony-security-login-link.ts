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

interface LoginLinkInfo {
  firewall: string;
  hasLoginLink: boolean;
  lifetime?: number;
  maxUses?: number;
  signatureProperties: string[];
  hasHandlerUsage: boolean;
  hasEmailSending: boolean;
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

function scanSrcForLoginLink(appPath: string): { hasHandlerUsage: boolean; hasEmailSending: boolean } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { hasHandlerUsage: false, hasEmailSending: false };

  let hasHandlerUsage = false;
  let hasEmailSending = false;

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (
      content.includes('LoginLinkHandlerInterface') ||
      content.includes('createLoginLink(') ||
      content.includes('LoginLinkNotification')
    ) {
      hasHandlerUsage = true;
    }

    if (
      hasHandlerUsage &&
      (content.includes('MailerInterface') ||
        content.includes('mailer->send(') ||
        content.includes('->send(') ||
        content.includes('LoginLinkNotification'))
    ) {
      hasEmailSending = true;
    }
  }

  return { hasHandlerUsage, hasEmailSending };
}

function loadLoginLinkConfig(appPath: string): LoginLinkInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;
    const { hasHandlerUsage, hasEmailSending } = scanSrcForLoginLink(appPath);

    const results: LoginLinkInfo[] = [];
    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      const llRaw = fw['login_link'] as Record<string, unknown> | undefined;

      if (!llRaw) {
        results.push({ firewall: name, hasLoginLink: false, signatureProperties: [], hasHandlerUsage: false, hasEmailSending: false, issues: [] });
        continue;
      }

      const lifetime = llRaw['lifetime'] !== undefined ? parseInt(String(llRaw['lifetime']), 10) : undefined;
      const maxUses = llRaw['max_uses'] !== undefined ? parseInt(String(llRaw['max_uses']), 10) : undefined;
      const sigPropsRaw = llRaw['signature_properties'];
      const signatureProperties: string[] = Array.isArray(sigPropsRaw) ? sigPropsRaw.map(String) : [];

      const issues: string[] = [];
      if (lifetime !== undefined && lifetime > 3600) {
        issues.push(`lifetime=${lifetime}s (${Math.round(lifetime / 60)}min) exceeds 1 hour — login link valid too long`);
      }
      if (maxUses === undefined) {
        issues.push('max_uses not set — login link can be used unlimited times');
      }
      if (signatureProperties.length === 0) {
        issues.push('signature_properties not set — weak link signature (all fields used); set explicit properties');
      }
      if (hasHandlerUsage && !hasEmailSending) {
        issues.push('createLoginLink() detected but no email sending found — link may be created but not delivered');
      }

      results.push({ firewall: name, hasLoginLink: true, lifetime, maxUses, signatureProperties, hasHandlerUsage, hasEmailSending, issues });
    }

    return results;
  }
  return [];
}

export function listLoginLinkConfig(appPath: string): McpToolResult {
  try {
    const configs = loadLoginLinkConfig(appPath);
    const withLoginLink = configs.filter((c) => c.hasLoginLink);

    if (configs.length === 0) {
      return { content: [{ type: 'text', text: 'No security.yaml found or no firewalls configured.' }] };
    }
    if (withLoginLink.length === 0) {
      return { content: [{ type: 'text', text: 'No firewalls with login_link configured.\n\nExample:\n  security:\n    firewalls:\n      main:\n        login_link:\n          check_route: login_link_check\n          signature_properties: [id, email]\n          max_uses: 1\n          lifetime: 600' }] };
    }

    const totalIssues = withLoginLink.reduce((s, c) => s + c.issues.length, 0);
    let text = `Login Link Configuration\n${'='.repeat(55)}\n\nFirewalls with login_link: ${withLoginLink.length}  Issues: ${totalIssues}\n`;

    for (const c of withLoginLink.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.firewall}\n`;
      if (c.lifetime !== undefined) text += `    lifetime: ${c.lifetime}s\n`;
      if (c.maxUses !== undefined) text += `    max_uses: ${c.maxUses}\n`;
      else text += `    max_uses: unlimited\n`;
      if (c.signatureProperties.length > 0) text += `    signature_properties: ${c.signatureProperties.join(', ')}\n`;
      text += `    handler usage: ${c.hasHandlerUsage ? 'yes' : 'not detected'}  email sending: ${c.hasEmailSending ? 'yes' : 'not detected'}\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLoginLinkStats(appPath: string): McpToolResult {
  try {
    const configs = loadLoginLinkConfig(appPath);
    const withLoginLink = configs.filter((c) => c.hasLoginLink);

    let text = `Login Link Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total firewalls:        ${configs.length}\n`;
    text += `With login_link:        ${withLoginLink.length}\n`;
    text += `  With max_uses set:    ${withLoginLink.filter((c) => c.maxUses !== undefined).length}\n`;
    text += `  With sig properties:  ${withLoginLink.filter((c) => c.signatureProperties.length > 0).length}\n`;
    text += `  Handler usage found:  ${withLoginLink.filter((c) => c.hasHandlerUsage).length}\n`;
    text += `  Email sending found:  ${withLoginLink.filter((c) => c.hasEmailSending).length}\n`;
    text += `Issues:                 ${withLoginLink.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getLoginLinkTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_login_link',
      description: 'Show login_link config per firewall: check_route, signature_properties, max_uses, lifetime; warns on lifetime>1h, unlimited uses, missing signature_properties, createLoginLink() without detected email delivery',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_login_link_stats',
      description: 'Show login link statistics: firewall count, login_link enabled count, max_uses/signature properties coverage, handler and email sending detection, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
