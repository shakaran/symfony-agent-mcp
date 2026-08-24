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

interface RoleNode {
  role: string;
  inherits: string[];
}

function loadRoleHierarchy(appPath: string): Map<string, string[]> {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'security.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const hierarchy = (security['role_hierarchy'] ?? {}) as Record<string, unknown>;
    const result = new Map<string, string[]>();
    for (const [role, parents] of Object.entries(hierarchy)) {
      const list = Array.isArray(parents) ? (parents as string[]) : [String(parents)];
      result.set(role, list);
    }
    if (result.size > 0) return result;
  }
  return new Map();
}

function detectCycles(hierarchy: Map<string, string[]>): string[] {
  const cycles: string[] = [];
  function visit(role: string, path: string[], visited: Set<string>): void {
    if (visited.has(role)) {
      const start = path.indexOf(role);
      if (start !== -1) cycles.push(path.slice(start).concat(role).join(' → '));
      return;
    }
    visited.add(role);
    path.push(role);
    for (const parent of hierarchy.get(role) ?? []) visit(parent, [...path], new Set(visited));
  }
  for (const role of hierarchy.keys()) visit(role, [], new Set());
  return [...new Set(cycles)];
}

function buildChain(role: string, hierarchy: Map<string, string[]>, depth = 0): string[] {
  if (depth > 10) return [];
  const parents = hierarchy.get(role) ?? [];
  return parents.flatMap((p) => [p, ...buildChain(p, hierarchy, depth + 1)]);
}

function scanUsedRoles(appPath: string): Set<string> {
  const used = new Set<string>();
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'security.yaml'),
  ];
  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const m of content.matchAll(/ROLE_[A-Z_]+/g)) used.add(m[0]);
    } catch { /* skip */ }
  }
  const srcDir = path.join(appPath, 'src');
  function scan(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { scan(full); continue; }
        if (!entry.name.endsWith('.php') && !entry.name.endsWith('.yaml')) continue;
        const content = safeRead(full, appPath);
        if (content === null) continue;
        for (const m of content.matchAll(/ROLE_[A-Z_]+/g)) used.add(m[0]);
      }
    } catch { /* skip */ }
  }
  if (fs.existsSync(srcDir)) scan(srcDir);
  return used;
}

export function listRoleHierarchy(appPath: string): McpToolResult {
  try {
    const hierarchy = loadRoleHierarchy(appPath);
    if (hierarchy.size === 0) {
      return { content: [{ type: 'text', text: 'No role_hierarchy found in security.yaml.\n\nExample:\n  security:\n    role_hierarchy:\n      ROLE_ADMIN: ROLE_USER\n      ROLE_SUPER_ADMIN: [ROLE_ADMIN, ROLE_ALLOWED_TO_SWITCH]' }] };
    }
    const usedRoles = scanUsedRoles(appPath);
    const cycles = detectCycles(hierarchy);
    const nodes: RoleNode[] = [];
    for (const [role, inherits] of hierarchy.entries()) nodes.push({ role, inherits });

    let text = `Security Role Hierarchy\n${'='.repeat(55)}\n\nRoles defined: ${hierarchy.size}  Issues: ${cycles.length}\n`;
    for (const node of nodes) {
      const chain = buildChain(node.role, hierarchy);
      const inherited = chain.length > 0 ? `  inherits all: ${[...new Set(chain)].join(', ')}` : '';
      const usedMark = usedRoles.has(node.role) ? '' : '  ⚠ never referenced';
      text += `\n  ${node.role} → ${node.inherits.join(', ')}${inherited}${usedMark}\n`;
    }
    if (cycles.length > 0) {
      text += `\nCycles detected:\n`;
      for (const c of cycles) text += `  ⚠ ${c}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRoleHierarchyStats(appPath: string): McpToolResult {
  try {
    const hierarchy = loadRoleHierarchy(appPath);
    const cycles = detectCycles(hierarchy);
    const usedRoles = scanUsedRoles(appPath);
    const unused = [...hierarchy.keys()].filter((r) => !usedRoles.has(r));
    let text = `Role Hierarchy Statistics\n${'='.repeat(40)}\n\n`;
    text += `Roles in hierarchy: ${hierarchy.size}\nCycles: ${cycles.length}\nUnreferenced roles: ${unused.length}\n`;
    if (unused.length > 0) text += `  Unreferenced: ${unused.join(', ')}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getRoleHierarchyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_role_hierarchy', description: 'Show security role_hierarchy: inheritance chains, full transitive roles per role, cycle detection, unreferenced role warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_role_hierarchy_stats', description: 'Show role hierarchy statistics: role count, cycle count, unreferenced role count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
