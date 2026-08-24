// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface IpAccessInfo {
  path: string;
  ips: string[];
  roles: string[];
  hasPrivateRange: boolean;
  hasPublicIp: boolean;
  issues: string[];
}

function isPrivateIp(ip: string): boolean {
  const privatePatterns = [
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/,
    /^192\.168\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/,
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/,
    /^::1(\/\d{1,3})?$/,
    /^fc00:[\da-fA-F:]{1,39}(\/\d{1,3})?$/,
  ];
  return privatePatterns.some((p) => p.test(ip.trim()));
}

function isPublicIp(ip: string): boolean {
  if (isPrivateIp(ip)) return false;
  // IPv4 — simple check for a dot-notation address (no private range)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(ip.trim())) return true;
  // IPv6 with colons but not private fc00:: or loopback ::1
  if (ip.includes(':') && !isPrivateIp(ip)) return true;
  return false;
}

function loadIpAccessRules(appPath: string): IpAccessInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const accessControl = security['access_control'];
    if (!Array.isArray(accessControl)) return [];

    const ipRules: IpAccessInfo[] = [];
    let hasCatchAll = false;

    for (const rule of accessControl) {
      const r = (rule ?? {}) as Record<string, unknown>;
      const ipsRaw = r['ips'];
      const ruleIps: string[] = Array.isArray(ipsRaw)
        ? ipsRaw.map(String)
        : ipsRaw !== undefined
          ? [String(ipsRaw)]
          : [];

      const routePath = r['path'] ? String(r['path']) : '';
      const rolesRaw = r['roles'];
      const roles: string[] = Array.isArray(rolesRaw)
        ? rolesRaw.map(String)
        : rolesRaw !== undefined
          ? [String(rolesRaw)]
          : [];

      // Check for catch-all rule (no path and no ips restriction)
      if (!routePath && ruleIps.length === 0) hasCatchAll = true;

      if (ruleIps.length === 0) continue;

      const hasPrivateRange = ruleIps.some(isPrivateIp);
      const hasPublicIp = ruleIps.some(isPublicIp);

      const issues: string[] = [];
      if (!routePath) issues.push('IP rule without path restriction — applies to all routes; may block or allow too broadly');
      if (hasPublicIp) issues.push(`Public IP hardcoded: ${ruleIps.filter(isPublicIp).join(', ')} — use env var or CIDR for flexibility`);

      ipRules.push({ path: routePath, ips: ruleIps, roles, hasPrivateRange, hasPublicIp, issues });
    }

    // Warn if there are IP rules but no catch-all after them
    if (ipRules.length > 0 && !hasCatchAll) {
      const last = ipRules[ipRules.length - 1];
      last.issues.push('No catch-all rule after IP-specific rules — unmatched requests may fall through with unexpected behavior');
    }

    return ipRules;
  }
  return [];
}

export function listSecurityIpAccess(appPath: string): McpToolResult {
  try {
    const rules = loadIpAccessRules(appPath);
    if (rules.length === 0) {
      return { content: [{ type: 'text', text: 'No IP-based access_control rules found in security.yaml.' }] };
    }

    const totalIssues = rules.reduce((s, r) => s + r.issues.length, 0);
    let text = `IP Access Control Rules\n${'='.repeat(55)}\n\nIP rules: ${rules.length}  Issues: ${totalIssues}\n`;

    for (const r of rules.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  path: ${r.path || '(any)'}\n`;
      text += `    ips:   ${r.ips.join(', ')}\n`;
      if (r.roles.length > 0) text += `    roles: ${r.roles.join(', ')}\n`;
      const tags = [r.hasPrivateRange ? 'private' : '', r.hasPublicIp ? 'public' : ''].filter(Boolean);
      if (tags.length > 0) text += `    range: ${tags.join(', ')}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSecurityIpAccessStats(appPath: string): McpToolResult {
  try {
    const rules = loadIpAccessRules(appPath);

    let text = `IP Access Control Statistics\n${'='.repeat(40)}\n\n`;
    text += `IP access rules:     ${rules.length}\n`;
    text += `  With private IPs:  ${rules.filter((r) => r.hasPrivateRange).length}\n`;
    text += `  With public IPs:   ${rules.filter((r) => r.hasPublicIp).length}\n`;
    text += `  Without path:      ${rules.filter((r) => !r.path).length}\n`;
    text += `Issues:              ${rules.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSecurityIpAccessTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_ip_access',
      description: 'Show access_control rules with ips: field: path, IPs (private/public/CIDR), roles; warns on rules without path, hardcoded public IPs, missing catch-all after IP rules, IPv4-only without IPv6 equivalent',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_ip_access_stats',
      description: 'Show IP access control statistics: total IP rules, private range count, public IP count, rules without path restriction, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
