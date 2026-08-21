/**
 * Controller Security Audit
 *
 * Scans controllers for:
 *   - #[IsGranted('ROLE_X')] / #[IsGranted('attribute')]
 *   - #[Security("is_granted('ROLE_X')")]
 *   - Class-level vs method-level protection
 *   - Actions with no security attribute (potentially open)
 *
 * Cross-references with security.yaml access_control rules
 * to show which routes are covered by firewall rules vs attributes.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ActionSecurity {
  action: string;
  grants: string[];
  securityExpr?: string;
  isOpen: boolean;
}

interface ControllerSecurity {
  class: string;
  file: string;
  classGrants: string[];
  actions: ActionSecurity[];
  hasOpenActions: boolean;
}

interface AccessControlRule {
  path: string;
  roles: string[];
  ip?: string;
  methods?: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Controller parsing ────────────────────────────────────────────────────

function extractGrants(block: string): string[] {
  const grants: string[] = [];
  for (const m of block.matchAll(/#\[IsGranted\s*\(\s*['"]([^'"]+)['"]/g)) {
    grants.push(m[1]);
  }
  for (const m of block.matchAll(/#\[Security\s*\(\s*['"]([^'"]+)['"]/g)) {
    grants.push(`expr: ${m[1]}`);
  }
  return grants;
}

function parseController(filePath: string): ControllerSecurity | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isController =
    content.includes('AbstractController') ||
    content.includes('ControllerInterface') ||
    (content.includes('#[Route(') && content.includes('function '));

  if (!isController) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Class-level grants (before the class keyword)
  const classStart = content.indexOf(`class ${classM[1]}`);
  const classPrefix = content.slice(Math.max(0, classStart - 400), classStart);
  const classGrants = extractGrants(classPrefix);

  // Split into methods
  const methodRe = /(?:public|protected)\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  const actions: ActionSecurity[] = [];
  let methodMatch: RegExpExecArray | null;

  while ((methodMatch = methodRe.exec(content)) !== null) {
    const methodName = methodMatch[1];
    if (['__construct', 'setUp', 'tearDown'].includes(methodName)) continue;

    // Look for attributes in the ~300 chars before this method
    const beforeMethod = content.slice(Math.max(0, methodMatch.index - 300), methodMatch.index);
    const grants = extractGrants(beforeMethod);

    // Check if this action has a Route attribute
    const hasRoute = beforeMethod.includes('#[Route(') || beforeMethod.includes('#[Route ');
    if (!hasRoute && classGrants.length === 0) continue;

    actions.push({
      action: methodName,
      grants,
      isOpen: grants.length === 0 && classGrants.length === 0,
    });
  }

  if (actions.length === 0) return null;

  return {
    class: classM[1],
    file: path.basename(filePath),
    classGrants,
    actions,
    hasOpenActions: actions.some((a) => a.isOpen),
  };
}

// ─── Access control loading ────────────────────────────────────────────────

function loadAccessControl(appPath: string): AccessControlRule[] {
  const secFile = path.join(appPath, 'config', 'packages', 'security.yaml');
  const raw = parseYamlFile(secFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const security = (raw['security'] ?? raw) as Record<string, unknown>;
  const acl = security['access_control'] as unknown[] | undefined;
  if (!acl) return [];

  const rules: AccessControlRule[] = [];
  for (const item of acl) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Record<string, unknown>;
    const rolesRaw = rule['roles'];
    const roles = Array.isArray(rolesRaw)
      ? rolesRaw.map(String)
      : rolesRaw ? [String(rolesRaw)] : [];

    rules.push({
      path: String(rule['path'] ?? '^/'),
      roles,
      ip: rule['ips'] ? String(rule['ips']) : undefined,
      methods: rule['methods']
        ? (Array.isArray(rule['methods']) ? rule['methods'].map(String) : [String(rule['methods'])])
        : undefined,
    });
  }
  return rules;
}

function loadControllers(appPath: string): ControllerSecurity[] {
  const dirs = [
    path.join(appPath, 'src', 'Controller'),
    path.join(appPath, 'src', 'Controllers'),
    path.join(appPath, 'src'),
  ];
  const seen = new Set<string>();
  const controllers: ControllerSecurity[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of getAllPhpFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const c = parseController(file);
      if (c) controllers.push(c);
    }
  }
  return controllers.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function auditControllerSecurity(appPath: string): McpToolResult {
  try {
    const controllers = loadControllers(appPath);
    const acl = loadAccessControl(appPath);

    if (controllers.length === 0) {
      return {
        content: [{ type: 'text', text: 'No controllers found in src/Controller/.' }],
      };
    }

    const openControllers = controllers.filter((c) => c.hasOpenActions);
    const fullySecured = controllers.filter((c) => !c.hasOpenActions && c.classGrants.length > 0);
    const totalActions = controllers.reduce((s, c) => s + c.actions.length, 0);
    const openActions = controllers.reduce((s, c) => s + c.actions.filter((a) => a.isOpen).length, 0);

    let text = `Controller Security Audit  (${controllers.length} controllers, ${totalActions} actions)\n${'='.repeat(65)}\n`;

    text += `\nSummary:\n`;
    text += `  Fully secured (class-level):  ${fullySecured.length}\n`;
    text += `  Controllers with open actions: ${openControllers.length}\n`;
    text += `  Open actions (no attribute):   ${openActions}\n`;

    if (acl.length > 0) {
      text += `\naccess_control rules (${acl.length}) — may cover open actions:\n`;
      for (const rule of acl) {
        const methods = rule.methods ? `  [${rule.methods.join('|')}]` : '';
        const roles = rule.roles.length > 0 ? rule.roles.join(', ') : 'IS_AUTHENTICATED_ANONYMOUSLY';
        text += `  ${rule.path.padEnd(35)} ${roles}${methods}\n`;
      }
    }

    if (openControllers.length > 0) {
      text += `\nControllers with unprotected actions:\n`;
      for (const c of openControllers) {
        const open = c.actions.filter((a) => a.isOpen);
        text += `\n  ${c.class}  (${c.file})\n`;
        if (c.classGrants.length > 0) {
          text += `    class-level: ${c.classGrants.join(', ')}\n`;
        }
        for (const a of open) {
          text += `    ⚠ ${a.action}()  [no #[IsGranted]]\n`;
        }
      }
    }

    text += `\nSecured controllers:\n`;
    for (const c of controllers.filter((c) => !c.hasOpenActions)) {
      const grants = c.classGrants.length > 0
        ? c.classGrants.join(', ')
        : c.actions.flatMap((a) => a.grants).slice(0, 3).join(', ');
      text += `  ${c.class.padEnd(40)} ${grants}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getControllerSecurityStats(appPath: string): McpToolResult {
  try {
    const controllers = loadControllers(appPath);
    const acl = loadAccessControl(appPath);

    const totalActions = controllers.reduce((s, c) => s + c.actions.length, 0);
    const openActions = controllers.reduce((s, c) => s + c.actions.filter((a) => a.isOpen).length, 0);
    const classLevel = controllers.filter((c) => c.classGrants.length > 0).length;

    let text = `Controller Security Statistics\n${'='.repeat(40)}\n\n`;
    text += `Controllers:           ${controllers.length}\n`;
    text += `Total actions:         ${totalActions}\n`;
    text += `Class-level protected: ${classLevel}\n`;
    text += `Open actions:          ${openActions}\n`;
    text += `access_control rules:  ${acl.length}\n`;

    const coverage = totalActions > 0
      ? Math.round(((totalActions - openActions) / totalActions) * 100)
      : 100;
    text += `\nAttribute coverage: ${coverage}% of actions have security attributes\n`;

    if (openActions > 0) {
      text += `\n⚠ ${openActions} action(s) have no #[IsGranted] — verify access_control covers them.\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getControllerSecurityTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'audit_controller_security',
      description: 'Audit controller security: #[IsGranted]/#[Security] coverage per action, open (unprotected) actions, access_control rule cross-reference',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_controller_security_stats',
      description: 'Show controller security statistics: total actions, class-level vs method-level protection, open action count, attribute coverage percentage',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
