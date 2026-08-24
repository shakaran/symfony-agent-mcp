// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Security Entry Point Inspector
 *
 * Reads security.yaml firewalls for entry_point: config.
 * Scans src/ PHP for AuthenticationEntryPointInterface implementations:
 *   - start() method
 *   - returning RedirectResponse vs JsonResponse vs Response(401)
 *
 * Warns about:
 *   - API firewall (stateless: true) without JSON entry_point (returns HTML redirect — breaks SPA)
 *   - entry_point not configured when multiple authenticators exist (Symfony throws)
 *   - entry_point returning redirect for stateless firewall
 *   - form_login without configured entry_point (auto-configured but may conflict)
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

interface SecurityEntryPointInfo {
  file?: string;
  class?: string;
  firewall: string;
  hasEntryPoint: boolean;
  entryPointClass?: string;
  returnsJson: boolean;
  returnsRedirect: boolean;
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

interface FirewallEntryPointConfig {
  name: string;
  entryPointClass?: string;
  isStateless: boolean;
  hasFormLogin: boolean;
  authenticatorCount: number;
}

function loadFirewallEntryPoints(appPath: string): FirewallEntryPointConfig[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'security.yaml'),
    path.join(appPath, 'config', 'packages', 'security.yml'),
  ];
  for (const fp of candidates) {
    const raw = parseYamlFile(fp) as Record<string, unknown> | null;
    if (!raw) continue;
    const security = (raw['security'] ?? raw) as Record<string, unknown>;
    const fwsRaw = (security['firewalls'] ?? {}) as Record<string, unknown>;

    const configs: FirewallEntryPointConfig[] = [];
    for (const [name, fwData] of Object.entries(fwsRaw)) {
      const fw = (fwData ?? {}) as Record<string, unknown>;
      const entryPointClass = fw['entry_point'] ? String(fw['entry_point']) : undefined;
      const isStateless = fw['stateless'] === true || fw['stateless'] === 'true';
      const hasFormLogin = !!fw['form_login'];
      const authRaw = fw['custom_authenticators'];
      const authenticatorCount = Array.isArray(authRaw) ? authRaw.length : 0;
      configs.push({ name, entryPointClass, isStateless, hasFormLogin, authenticatorCount });
    }
    return configs;
  }
  return [];
}

interface EntryPointClassInfo {
  file: string;
  class?: string;
  returnsJson: boolean;
  returnsRedirect: boolean;
  issues: string[];
}

function parseEntryPointFile(filePath: string, appPath: string): EntryPointClassInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const isEntryPoint = content.includes('AuthenticationEntryPointInterface') &&
    content.includes('implements') &&
    /implements[^{]{0,300}AuthenticationEntryPointInterface/.test(content);

  if (!isEntryPoint) return null;
  if (content.includes('namespace Symfony\\Component\\Security')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const issues: string[] = [];

  // Extract start() method body
  const startM = /function\s+start\s*\([^)]{0,200}\)[^{]{0,20}\{([\s\S]{0,1000}?)\n {2}\}/.exec(content);
  const startBody = startM ? startM[1] : content;

  const returnsJson = startBody.includes('JsonResponse') || startBody.includes('json(') ||
    startBody.includes('application/json');
  const returnsRedirect = startBody.includes('RedirectResponse') || startBody.includes('redirectToRoute') ||
    startBody.includes('->redirect(') || startBody.includes('301') || startBody.includes('302') ||
    startBody.includes('303');

  // Check for 401 response
  const returns401 = startBody.includes('401') || startBody.includes('Response::HTTP_UNAUTHORIZED');

  if (!returnsJson && !returns401 && returnsRedirect) {
    issues.push('Entry point start() returns redirect — will break API/SPA clients that cannot follow HTML redirects');
  }
  if (!returnsJson && !returns401 && !returnsRedirect) {
    issues.push('Entry point start() return type unclear — should return JsonResponse (for API) or 401 Response');
  }

  return {
    file: path.relative(appPath, filePath),
    class: classM?.[1],
    returnsJson,
    returnsRedirect,
    issues,
  };
}

function loadSecurityEntryPointData(appPath: string): SecurityEntryPointInfo[] {
  const firewalls = loadFirewallEntryPoints(appPath);
  const srcDir = path.join(appPath, 'src');

  const entryPointClasses: EntryPointClassInfo[] = [];
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseEntryPointFile(f, appPath);
      if (r) entryPointClasses.push(r);
    }
  }

  const results: SecurityEntryPointInfo[] = [];

  for (const fw of firewalls) {
    if (fw.name === 'dev') continue;

    const issues: string[] = [];

    // Find entry point class info
    let epClass: EntryPointClassInfo | undefined;
    if (fw.entryPointClass) {
      const shortName = fw.entryPointClass.split('\\').pop() ?? fw.entryPointClass;
      epClass = entryPointClasses.find((c) => c.class === shortName || c.class === fw.entryPointClass);
    }

    // Warn: stateless firewall without entry_point or with redirect entry_point
    if (fw.isStateless) {
      if (!fw.entryPointClass) {
        issues.push(`Stateless firewall "${fw.name}" without entry_point — unauthenticated requests may get unexpected responses`);
      } else if (epClass?.returnsRedirect && !epClass?.returnsJson) {
        issues.push(`Stateless firewall "${fw.name}" entry_point returns redirect — breaks API/SPA clients (should return 401 JSON)`);
      }
    }

    // Warn: multiple authenticators without entry_point
    if (fw.authenticatorCount > 1 && !fw.entryPointClass) {
      issues.push(`Firewall "${fw.name}" has ${fw.authenticatorCount} authenticators but no entry_point — Symfony requires explicit entry_point with multiple authenticators`);
    }

    // form_login note
    if (fw.hasFormLogin && !fw.entryPointClass) {
      issues.push(`Firewall "${fw.name}" uses form_login without explicit entry_point — entry_point is auto-configured but may conflict if other authenticators are added`);
    }

    const returnsJson = epClass?.returnsJson ?? false;
    const returnsRedirect = epClass?.returnsRedirect ?? false;

    results.push({
      file: epClass?.file,
      class: epClass?.class,
      firewall: fw.name,
      hasEntryPoint: !!fw.entryPointClass,
      entryPointClass: fw.entryPointClass,
      returnsJson,
      returnsRedirect,
      issues: [...issues, ...(epClass?.issues ?? [])],
    });
  }

  // Add standalone entry point implementations not linked to firewalls
  for (const ep of entryPointClasses) {
    const alreadyLinked = results.some((r) => r.class === ep.class);
    if (!alreadyLinked) {
      results.push({
        file: ep.file,
        class: ep.class,
        firewall: '(unlinked)',
        hasEntryPoint: false,
        returnsJson: ep.returnsJson,
        returnsRedirect: ep.returnsRedirect,
        issues: [
          ...ep.issues,
          'AuthenticationEntryPointInterface implementation not referenced in any firewall entry_point',
        ],
      });
    }
  }

  return results;
}

export function listSecurityEntryPoints(appPath: string): McpToolResult {
  try {
    const infos = loadSecurityEntryPointData(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No security entry points found (security.yaml or AuthenticationEntryPointInterface implementations).' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Security Entry Points (${infos.length} firewalls/implementations)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  firewall: ${info.firewall}\n`;
      if (info.class) text += `    class: ${info.class}  (${info.file})\n`;
      if (info.entryPointClass) text += `    entry_point: ${info.entryPointClass}\n`;
      const flags = [
        info.hasEntryPoint ? 'entry_point-configured' : 'no-entry_point',
        info.returnsJson ? 'returns-json' : '',
        info.returnsRedirect ? 'returns-redirect' : '',
      ].filter(Boolean).join(', ');
      if (flags) text += `    flags: [${flags}]\n`;
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

export function getSecurityEntryPointStats(appPath: string): McpToolResult {
  try {
    const infos = loadSecurityEntryPointData(appPath);

    const firewallCount = infos.filter((i) => i.firewall !== '(unlinked)').length;
    let text = `Security Entry Point Statistics\n${'='.repeat(40)}\n\n`;
    text += `Firewalls analyzed:            ${firewallCount}\n`;
    text += `  With entry_point:            ${infos.filter((i) => i.hasEntryPoint).length}\n`;
    text += `  Returning JSON:              ${infos.filter((i) => i.returnsJson).length}\n`;
    text += `  Returning redirect:          ${infos.filter((i) => i.returnsRedirect).length}\n`;
    text += `Unlinked implementations:      ${infos.filter((i) => i.firewall === '(unlinked)').length}\n`;
    text += `Issues:                        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSecurityEntryPointTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_security_entry_points',
      description: 'List Symfony security entry points: firewall entry_point config, AuthenticationEntryPointInterface implementations, JSON vs redirect responses; warns about stateless firewalls with redirect entry point, missing entry_point with multiple authenticators, unlinked implementations',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_security_entry_point_stats',
      description: 'Show security entry point statistics: firewall count, entry_point coverage, JSON/redirect breakdown, unlinked implementations, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
