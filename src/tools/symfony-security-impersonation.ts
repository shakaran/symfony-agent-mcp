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

interface ImpersonationInfo {
  firewall: string;
  hasImpersonation: boolean;
  role?: string;
  parameter?: string;
  hasAuditListener: boolean;
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

function scanSrcForImpersonation(appPath: string): { hasAuditListener: boolean; switchUserRoles: string[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { hasAuditListener: false, switchUserRoles: [] };

  let hasAuditListener = false;
  const switchUserRoles: string[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;

    if (content.includes('SwitchUserEvent')) hasAuditListener = true;

    if (content.includes('ROLE_ALLOWED_TO_SWITCH')) {
      const roleMatch = /ROLE_ALLOWED_TO_SWITCH/.exec(content);
      if (roleMatch) switchUserRoles.push(path.basename(file));
    }
  }

  return { hasAuditListener, switchUserRoles };
}

function loadImpersonationConfig(appPath: string): ImpersonationInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;
    const roleHierarchy = (security['role_hierarchy'] ?? {}) as Record<string, unknown>;

    const { hasAuditListener, switchUserRoles } = scanSrcForImpersonation(appPath);

    // Check if ROLE_ALLOWED_TO_SWITCH is assigned to broad roles in role_hierarchy
    const broadRolesWithSwitch: string[] = [];
    for (const [role, children] of Object.entries(roleHierarchy)) {
      const childRoles = Array.isArray(children) ? children.map(String) : [String(children)];
      if (childRoles.includes('ROLE_ALLOWED_TO_SWITCH')) {
        broadRolesWithSwitch.push(role);
      }
    }

    const results: ImpersonationInfo[] = [];
    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      const suRaw = fw['switch_user'] as Record<string, unknown> | undefined;

      if (!suRaw) {
        results.push({ firewall: name, hasImpersonation: false, hasAuditListener: false, issues: [] });
        continue;
      }

      const role = suRaw['role'] ? String(suRaw['role']) : undefined;
      const parameter = suRaw['parameter'] ? String(suRaw['parameter']) : undefined;

      const issues: string[] = [];
      if (!role) issues.push('switch_user without explicit role — defaults to ROLE_ALLOWED_TO_SWITCH; ensure this role is tightly controlled');
      if (!hasAuditListener) issues.push('No SwitchUserEvent subscriber detected — impersonation events not being audited');
      if (broadRolesWithSwitch.length > 0) {
        issues.push(`ROLE_ALLOWED_TO_SWITCH inherited by broad roles: ${broadRolesWithSwitch.join(', ')} — too many users can impersonate`);
      }
      if (switchUserRoles.length > 0 && !hasAuditListener) {
        issues.push(`ROLE_ALLOWED_TO_SWITCH referenced in ${switchUserRoles.length} file(s) but no audit listener found`);
      }

      results.push({ firewall: name, hasImpersonation: true, role, parameter, hasAuditListener, issues });
    }

    return results;
  }
  return [];
}

export function listImpersonationConfig(appPath: string): McpToolResult {
  try {
    const configs = loadImpersonationConfig(appPath);
    const withImpersonation = configs.filter((c) => c.hasImpersonation);

    if (configs.length === 0) {
      return { content: [{ type: 'text', text: 'No security.yaml found or no firewalls configured.' }] };
    }
    if (withImpersonation.length === 0) {
      return { content: [{ type: 'text', text: 'No firewalls with switch_user (impersonation) configured.' }] };
    }

    const totalIssues = withImpersonation.reduce((s, c) => s + c.issues.length, 0);
    let text = `Security Impersonation (switch_user)\n${'='.repeat(55)}\n\nFirewalls with switch_user: ${withImpersonation.length}  Issues: ${totalIssues}\n`;

    for (const c of withImpersonation.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${c.firewall}\n`;
      if (c.role) text += `    role: ${c.role}\n`;
      if (c.parameter) text += `    parameter: ${c.parameter}\n`;
      text += `    audit listener: ${c.hasAuditListener ? 'yes' : 'NOT FOUND'}\n`;
      for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImpersonationStats(appPath: string): McpToolResult {
  try {
    const configs = loadImpersonationConfig(appPath);
    const withImpersonation = configs.filter((c) => c.hasImpersonation);

    let text = `Impersonation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total firewalls:          ${configs.length}\n`;
    text += `With switch_user:         ${withImpersonation.length}\n`;
    text += `  With explicit role:     ${withImpersonation.filter((c) => c.role).length}\n`;
    text += `  With audit listener:    ${withImpersonation.filter((c) => c.hasAuditListener).length}\n`;
    text += `Issues:                   ${withImpersonation.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getImpersonationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_impersonation',
      description: 'Show switch_user impersonation config per firewall: role, parameter; warns on missing explicit role, no SwitchUserEvent audit listener, ROLE_ALLOWED_TO_SWITCH assigned to broad roles in role_hierarchy',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_impersonation_stats',
      description: 'Show impersonation statistics: firewall count, switch_user enabled count, explicit role count, audit listener presence, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
