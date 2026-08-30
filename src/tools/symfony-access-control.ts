// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface AccessControlRule {
  index: number;
  path?: string;
  roles: string[];
  methods?: string[];
  ips?: string[];
  issues: string[];
}

function loadAccessControl(appPath: string): AccessControlRule[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
    path.join(appPath, 'config', 'security.yaml'),
    path.join(appPath, 'config', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const acList = security['access_control'];
    if (!Array.isArray(acList)) continue;
    return acList.map((rule: unknown, idx) => {
      const r = (rule ?? {}) as Record<string, unknown>;
      const roles = Array.isArray(r['roles']) ? (r['roles'] as string[]) : (r['roles'] ? [String(r['roles'])] : []);
      const methods = Array.isArray(r['methods']) ? (r['methods'] as string[]) : undefined;
      const ips = Array.isArray(r['ips']) ? (r['ips'] as string[]) : undefined;
      const issues: string[] = [];
      const rulePath = r['path'] ? String(r['path']) : undefined;
      if (!rulePath) issues.push('Rule without path — matches all URLs (very broad)');
      if (roles.length === 0 && !r['allow_if']) issues.push('No roles or allow_if — rule has no access restriction');
      if (rulePath && rulePath === '^/' && roles.includes('PUBLIC_ACCESS')) issues.push('PUBLIC_ACCESS on root path makes all other rules below unreachable');
      return { index: idx + 1, path: rulePath, roles, methods, ips, issues };
    });
  }
  return [];
}

export function listAccessControl(appPath: string): McpToolResult {
  try {
    const rules = loadAccessControl(appPath);
    if (rules.length === 0) {
      return { content: [{ type: 'text', text: 'No access_control rules found in security.yaml.\n\nExample:\n  security:\n    access_control:\n      - { path: ^/admin, roles: ROLE_ADMIN }\n      - { path: ^/api, roles: IS_AUTHENTICATED_FULLY }' }] };
    }
    const totalIssues = rules.reduce((s, r) => s + r.issues.length, 0);
    let text = `Security Access Control Rules\n${'='.repeat(55)}\n\nRules: ${rules.length}  Issues: ${totalIssues}\n(First matching rule wins — order matters)\n`;
    for (const r of rules) {
      const methods = r.methods ? `  [${r.methods.join('|')}]` : '';
      const ips = r.ips ? `  ips: ${r.ips.join(',')}` : '';
      text += `\n  #${r.index}  path: ${r.path ?? '(none)'}${methods}${ips}\n       roles: ${r.roles.length > 0 ? r.roles.join(', ') : '(none)'}\n`;
      for (const issue of r.issues) text += `    ⚠ ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAccessControlStats(appPath: string): McpToolResult {
  try {
    const rules = loadAccessControl(appPath);
    let text = `Access Control Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total rules: ${rules.length}\n`;
    text += `  With roles: ${rules.filter((r) => r.roles.length > 0).length}\n`;
    text += `  With IP restriction: ${rules.filter((r) => r.ips && r.ips.length > 0).length}\n`;
    text += `  With method filter: ${rules.filter((r) => r.methods && r.methods.length > 0).length}\n`;
    text += `Issues: ${rules.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAccessControlTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_access_control', description: 'Show security access_control rules: path patterns, required roles, IP/method restrictions, ordering (first match wins), no-path warning, PUBLIC_ACCESS shadowing warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_access_control_stats', description: 'Show access_control statistics: rule count, with-roles count, IP-restricted count, method-filtered count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
