/**
 * Symfony Security Inspector — Voters, Role Hierarchy & Access Control
 *
 * Extends config.ts security analysis with deeper static introspection:
 *
 *   1. Role hierarchy tree — visual tree from security.yaml role_hierarchy
 *   2. Custom voters — scan src/Security/ for Voter subclasses, extract
 *      supported attributes and subject classes from supports()
 *   3. Access control matrix — path patterns → roles from access_control
 *   4. Firewalls — pattern, stateless, authenticators, lazy settings
 *   5. User providers — entity/memory/ldap/chain configurations
 *
 * Pure static analysis — no PHP execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface RoleNode {
  role: string;
  inherits: string[];
  inheritedBy: string[];
}

interface CustomVoter {
  class: string;
  file: string;
  attributes: string[];
  subjects: string[];
}

interface AccessControlRule {
  path?: string;
  host?: string;
  methods?: string[];
  roles: string[];
  ips?: string[];
  allow_if?: string;
}

interface Firewall {
  name: string;
  pattern?: string;
  stateless?: boolean;
  lazy?: boolean;
  security?: boolean;
  authenticators: string[];
  provider?: string;
  entryPoint?: string;
}

// ─── YAML parsing ──────────────────────────────────────────────────────────

function loadSecurityYaml(appPath: string): Record<string, unknown> | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'security.yaml'),
  ];
  for (const f of candidates) {
    const raw = parseYamlFile(f) as Record<string, unknown> | null;
    if (raw) {
      const sec = raw['security'] as Record<string, unknown> | undefined;
      return sec ?? raw;
    }
  }
  return null;
}

// ─── Role hierarchy ────────────────────────────────────────────────────────

function buildRoleHierarchy(security: Record<string, unknown>): Map<string, RoleNode> {
  const map = new Map<string, RoleNode>();
  const raw = security['role_hierarchy'] as Record<string, unknown> | undefined;
  if (!raw) return map;

  const ensure = (role: string): RoleNode => {
    if (!map.has(role)) map.set(role, { role, inherits: [], inheritedBy: [] });
    return map.get(role)!;
  };

  for (const [parent, children] of Object.entries(raw)) {
    const parentNode = ensure(parent);
    const childList = Array.isArray(children) ? children : [children];
    for (const child of childList) {
      const childStr = String(child);
      parentNode.inherits.push(childStr);
      ensure(childStr).inheritedBy.push(parent);
    }
  }

  return map;
}

function renderRoleTree(map: Map<string, RoleNode>): string {
  const roots = Array.from(map.values()).filter((n) => n.inheritedBy.length === 0);
  if (roots.length === 0) return Array.from(map.keys()).join('\n  ');

  function renderNode(role: string, prefix: string, isLast: boolean): string {
    const node = map.get(role);
    const connector = isLast ? '└── ' : '├── ';
    let text = `${prefix}${connector}${role}\n`;
    if (node?.inherits.length) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      node.inherits.forEach((child, i) => {
        text += renderNode(child, childPrefix, i === node.inherits.length - 1);
      });
    }
    return text;
  }

  let text = '';
  roots.forEach((root, i) => {
    text += renderNode(root.role, '', i === roots.length - 1);
  });
  return text;
}

// ─── Custom voters ─────────────────────────────────────────────────────────

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

function parseVoterFile(filePath: string): CustomVoter | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('extends Voter') && !content.includes('extends CacheableSupportsMethodInterface') &&
      !content.includes('VoterInterface')) return null;
  if (!/extends\s+Voter/.test(content) && !/implements\s+VoterInterface/.test(content)) return null;

  const classMatch = /class\s+(\w+)/.exec(content);
  if (!classMatch) return null;

  const attributes: string[] = [];
  const subjects: string[] = [];

  // Look for constants like const VIEW = 'view'; const EDIT = 'edit';
  for (const m of content.matchAll(/const\s+([A-Z_]+)\s*=\s*['"]([^'"]+)['"]/g)) {
    attributes.push(m[2]);
  }

  // Extract from supports() return: $attribute === self::VIEW || ...
  const supportsMatch = /function\s+supports\s*\([^)]+\)[^{]*\{([\s\S]*?)(?=\n\s{4}(?:protected|public|private|function))/m.exec(content);
  if (supportsMatch) {
    for (const m of supportsMatch[1].matchAll(/['"]([A-Z_]+)['"]/g)) {
      if (!attributes.includes(m[1])) attributes.push(m[1]);
    }
    // Subject type hints: instanceof Product, $subject instanceof Order
    for (const m of supportsMatch[1].matchAll(/instanceof\s+([\w\\]+)/g)) {
      const cls = m[1].split('\\').pop() ?? m[1];
      if (!subjects.includes(cls)) subjects.push(cls);
    }
    // is_a($subject, Product::class)
    for (const m of supportsMatch[1].matchAll(/is_a\s*\(\s*\$\w+\s*,\s*([\w\\]+)::class/g)) {
      const cls = m[1].split('\\').pop() ?? m[1];
      if (!subjects.includes(cls)) subjects.push(cls);
    }
  }

  return {
    class: classMatch[1],
    file: path.basename(filePath),
    attributes,
    subjects,
  };
}

function loadVoters(appPath: string): CustomVoter[] {
  const scanDirs = [
    path.join(appPath, 'src', 'Security'),
    path.join(appPath, 'src', 'Voter'),
    path.join(appPath, 'src'),
  ];

  const seen = new Set<string>();
  const voters: CustomVoter[] = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const v = parseVoterFile(file);
      if (v) voters.push(v);
    }
  }

  return voters;
}

// ─── Access control parsing ────────────────────────────────────────────────

function parseAccessControl(security: Record<string, unknown>): AccessControlRule[] {
  const raw = security['access_control'] as Array<unknown> | undefined;
  if (!Array.isArray(raw)) return [];

  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    const roles = Array.isArray(e['roles'])
      ? e['roles'].map(String)
      : e['roles'] ? [String(e['roles'])] : [];
    const methods = Array.isArray(e['methods'])
      ? e['methods'].map(String)
      : e['methods'] ? [String(e['methods'])] : undefined;
    const ips = Array.isArray(e['ips'])
      ? e['ips'].map(String)
      : e['ips'] ? [String(e['ips'])] : undefined;

    return {
      path: e['path'] ? String(e['path']) : undefined,
      host: e['host'] ? String(e['host']) : undefined,
      methods,
      roles,
      ips,
      allow_if: e['allow_if'] ? String(e['allow_if']) : undefined,
    };
  });
}

// ─── Firewall parsing ──────────────────────────────────────────────────────

function parseFirewalls(security: Record<string, unknown>): Firewall[] {
  const raw = security['firewalls'] as Record<string, unknown> | undefined;
  if (!raw) return [];

  const firewalls: Firewall[] = [];

  for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object') continue;
    const fw = def as Record<string, unknown>;

    const authenticators: string[] = [];
    if (fw['custom_authenticators']) {
      const auths = Array.isArray(fw['custom_authenticators'])
        ? fw['custom_authenticators']
        : [fw['custom_authenticators']];
      authenticators.push(...auths.map(String).map((a) => a.split('\\').pop() ?? a));
    }
    if (fw['form_login']) authenticators.push('FormLogin');
    if (fw['http_basic']) authenticators.push('HttpBasic');
    if (fw['jwt']) authenticators.push('JWT');
    if (fw['json_login']) authenticators.push('JsonLogin');
    if (fw['remember_me']) authenticators.push('RememberMe');
    if (fw['oauth2']) authenticators.push('OAuth2');

    firewalls.push({
      name,
      pattern: fw['pattern'] ? String(fw['pattern']) : undefined,
      stateless: fw['stateless'] === true,
      lazy: fw['lazy'] === true,
      security: fw['security'] !== false,
      authenticators,
      provider: fw['provider'] ? String(fw['provider']) : undefined,
      entryPoint: fw['entry_point'] ? String(fw['entry_point']) : undefined,
    });
  }

  return firewalls;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function getRoleHierarchy(appPath: string): McpToolResult {
  try {
    const security = loadSecurityYaml(appPath);
    if (!security) {
      return { content: [{ type: 'text', text: 'security.yaml not found.' }], isError: true };
    }

    const hierarchy = buildRoleHierarchy(security);

    if (hierarchy.size === 0) {
      return {
        content: [{ type: 'text', text: 'No role_hierarchy defined in security.yaml.\n\nAdd:\n  security:\n    role_hierarchy:\n      ROLE_ADMIN: ROLE_USER' }],
      };
    }

    let text = `Role Hierarchy\n${'='.repeat(40)}\n\n`;
    text += renderRoleTree(hierarchy);

    text += `\nAll roles (${hierarchy.size}):\n`;
    for (const [role, node] of Array.from(hierarchy.entries()).sort()) {
      if (node.inherits.length > 0) {
        text += `  ${role} → inherits: ${node.inherits.join(', ')}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listSecurityVoters(appPath: string): McpToolResult {
  try {
    const voters = loadVoters(appPath);

    if (voters.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom security voters found in src/Security/ or src/Voter/.\n\nCreate with: php bin/console make:voter',
        }],
      };
    }

    let text = `Security Voters (${voters.length})\n${'='.repeat(50)}\n`;

    for (const v of voters) {
      text += `\n  ${v.class}  (${v.file})\n`;
      if (v.attributes.length > 0) text += `    Attributes: ${v.attributes.join(', ')}\n`;
      if (v.subjects.length > 0) text += `    Subjects:   ${v.subjects.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getAccessControlMatrix(appPath: string): McpToolResult {
  try {
    const security = loadSecurityYaml(appPath);
    if (!security) {
      return { content: [{ type: 'text', text: 'security.yaml not found.' }], isError: true };
    }

    const rules = parseAccessControl(security);

    if (rules.length === 0) {
      return { content: [{ type: 'text', text: 'No access_control rules defined in security.yaml.' }] };
    }

    let text = `Access Control Matrix (${rules.length} rules)\n${'='.repeat(50)}\n\n`;
    text += `Rules are evaluated top-to-bottom — first match wins.\n\n`;

    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      text += `  ${String(i + 1).padStart(2)}. `;
      if (r.path) text += `path: ${r.path}  `;
      if (r.host) text += `host: ${r.host}  `;
      if (r.methods?.length) text += `methods: [${r.methods.join(',')}]  `;
      if (r.ips?.length) text += `ips: [${r.ips.join(',')}]  `;
      text += '\n';
      if (r.roles.length > 0) text += `      Roles: ${r.roles.join(', ')}\n`;
      if (r.allow_if) text += `      Allow if: ${r.allow_if}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function listFirewalls(appPath: string): McpToolResult {
  try {
    const security = loadSecurityYaml(appPath);
    if (!security) {
      return { content: [{ type: 'text', text: 'security.yaml not found.' }], isError: true };
    }

    const firewalls = parseFirewalls(security);

    if (firewalls.length === 0) {
      return { content: [{ type: 'text', text: 'No firewalls defined in security.yaml.' }] };
    }

    let text = `Firewalls (${firewalls.length})\n${'='.repeat(50)}\n`;

    for (const fw of firewalls) {
      text += `\n  ${fw.name}\n`;
      if (fw.pattern) text += `    Pattern:        ${fw.pattern}\n`;
      if (fw.security === false) {
        text += `    Security:       DISABLED\n`;
      } else {
        if (fw.stateless) text += `    Stateless:      yes\n`;
        if (fw.lazy) text += `    Lazy:           yes\n`;
        if (fw.provider) text += `    Provider:       ${fw.provider}\n`;
        if (fw.authenticators.length > 0) text += `    Authenticators: ${fw.authenticators.join(', ')}\n`;
        if (fw.entryPoint) text += `    Entry point:    ${fw.entryPoint}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getSecurityVoterTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'get_role_hierarchy',
      description: 'Show Symfony role hierarchy tree from security.yaml: which roles inherit which, with visual ASCII tree',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_security_voters',
      description: 'List custom security voters from src/Security/ with their supported attributes and subject classes',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_access_control_matrix',
      description: 'Show the access_control rules matrix from security.yaml: path patterns, required roles, method/IP restrictions, evaluated top-to-bottom',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'list_firewalls',
      description: 'List security firewalls from security.yaml: patterns, authenticators, stateless mode, providers, and entry points',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
