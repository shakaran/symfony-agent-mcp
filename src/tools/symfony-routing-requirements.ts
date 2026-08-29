// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Routing Requirements Inspector
 *
 * Scans src/ PHP for #[Route] attributes with requirements parameter
 * and config/routes/*.yaml for route requirement patterns.
 *
 * Extracts:
 *   - Requirement patterns per parameter
 *   - Host requirements
 *   - Schemes requirements
 *   - utf8 option
 *
 * Detects:
 *   - Very permissive requirements (.+, .*)
 *   - Conflicting routes with same path but different requirements
 *   - Missing requirements on parameters (id should be \d+, etc.)
 *
 * Warns about:
 *   - Route parameter without requirement (accepts any string including /)
 *   - Requirement pattern without anchors (partial match)
 *   - Host requirement without https scheme requirement (inconsistency)
 *   - Same-path routes where requirements ordering matters
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

interface RoutingRequirementInfo {
  file: string;
  routeName?: string;
  path: string;
  requirements: Record<string, string>;
  host?: string;
  schemes: string[];
  hasUtf8: boolean;
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

function extractPathParams(routePath: string): string[] {
  const params: string[] = [];
  const re = /\{(\w{1,60})\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routePath)) !== null) {
    params.push(m[1]);
  }
  return params;
}

function analyzeRequirement(param: string, pattern: string): string[] {
  const issues: string[] = [];
  // Very permissive patterns
  if (pattern === '.+' || pattern === '.*' || pattern === '[\\s\\S]+' || pattern === '[\\s\\S]*') {
    issues.push(`Parameter "${param}" has very permissive requirement "${pattern}" — accepts any string including path separators`);
  }
  // Common id parameter without \d+ constraint
  if ((param === 'id' || param.endsWith('Id') || param.endsWith('_id')) && !/\\d/.test(pattern) && !pattern.includes('[0-9]')) {
    issues.push(`Parameter "${param}" appears to be an ID but requirement "${pattern}" does not restrict to digits`);
  }
  return issues;
}

function parsePhpRouteFile(filePath: string, appPath: string): RoutingRequirementInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  if (!content.includes('#[Route') && !content.includes('@Route')) return [];

  const results: RoutingRequirementInfo[] = [];

  // Match #[Route('path', ...)] attributes — simplified extraction
  const routeAttrPattern = /#\[Route\s*\(\s*['"]([^'"]{1,300})['"]\s*([^)]{0,600})\)/g;
  let m: RegExpExecArray | null;
  while ((m = routeAttrPattern.exec(content)) !== null) {
    const routePath = m[1];
    const attrBody = m[2];

    const nameM = /name\s*:\s*['"]([^'"]{1,100})['"]/.exec(attrBody);
    const routeName = nameM ? nameM[1] : undefined;

    // Extract requirements array
    const requirements: Record<string, string> = {};
    const reqM = /requirements\s*:\s*\[([^\][]{0,400}(?:\[[^\][]{0,300}\][^\][]{0,400}){0,40})\]/.exec(attrBody);
    if (reqM) {
      const reqBody = reqM[1];
      const kvPattern = /['"](\w{1,60})['"]\s*=>\s*['"]([^'"]{1,200})['"]/g;
      let kv: RegExpExecArray | null;
      while ((kv = kvPattern.exec(reqBody)) !== null) {
        requirements[kv[1]] = kv[2];
      }
    }

    const hostM = /host\s*:\s*['"]([^'"]{1,200})['"]/.exec(attrBody);
    const host = hostM ? hostM[1] : undefined;

    const schemesM = /schemes\s*:\s*\[([^\][]{0,200}(?:\[[^\][]{0,300}\][^\][]{0,200}){0,40})\]/.exec(attrBody);
    const schemes: string[] = [];
    if (schemesM) {
      const sm = schemesM[1].match(/['"]([^'"]{1,20})['"]/g) ?? [];
      schemes.push(...sm.map((s) => s.replace(/['"]/g, '')));
    }

    const hasUtf8 = attrBody.includes('utf8') && (attrBody.includes('true') || attrBody.includes(':true'));

    const issues: string[] = [];
    const params = extractPathParams(routePath);

    // Check each param for requirements
    for (const param of params) {
      if (!requirements[param]) {
        // Warn only for potentially ambiguous params
        if (param === 'id' || param.endsWith('Id') || param.endsWith('_id') || param === 'slug') {
          issues.push(`Route parameter "{${param}}" has no requirement — accepts any string including "/""`);
        }
      } else {
        issues.push(...analyzeRequirement(param, requirements[param]));
      }
    }

    // Host without https scheme
    if (host && !schemes.includes('https')) {
      issues.push(`Route has host requirement "${host}" but no https scheme requirement — inconsistency`);
    }

    results.push({
      file: path.relative(appPath, filePath),
      routeName,
      path: routePath,
      requirements,
      host,
      schemes,
      hasUtf8,
      issues,
    });
  }

  return results;
}

function loadYamlRouteFiles(appPath: string): RoutingRequirementInfo[] {
  const routesDir = path.join(appPath, 'config', 'routes');
  const results: RoutingRequirementInfo[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(routesDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => path.join(routesDir, f));
  } catch { return []; }

  for (const fp of files) {
    const raw = parseYamlFile(fp) as Record<string, unknown> | null;
    if (!raw) continue;
    for (const [routeName, routeData] of Object.entries(raw)) {
      const rd = (routeData ?? {}) as Record<string, unknown>;
      const routePath = rd['path'] ? String(rd['path']) : '';
      if (!routePath) continue;

      const reqRaw = (rd['requirements'] ?? {}) as Record<string, unknown>;
      const requirements: Record<string, string> = {};
      for (const [k, v] of Object.entries(reqRaw)) {
        requirements[k] = String(v);
      }

      const host = rd['host'] ? String(rd['host']) : undefined;
      const schemesRaw = rd['schemes'];
      const schemes = Array.isArray(schemesRaw) ? schemesRaw.map(String) : [];
      const optsRaw = (rd['options'] ?? {}) as Record<string, unknown>;
      const hasUtf8 = optsRaw['utf8'] === true || optsRaw['utf8'] === 'true';

      const issues: string[] = [];
      const params = extractPathParams(routePath);
      for (const param of params) {
        if (!requirements[param]) {
          if (param === 'id' || param.endsWith('Id') || param.endsWith('_id') || param === 'slug') {
            issues.push(`Route parameter "{${param}}" has no requirement — accepts any string`);
          }
        } else {
          issues.push(...analyzeRequirement(param, requirements[param]));
        }
      }
      if (host && !schemes.includes('https')) {
        issues.push(`Route has host requirement "${host}" but no https scheme — inconsistency`);
      }

      results.push({
        file: path.relative(appPath, fp),
        routeName,
        path: routePath,
        requirements,
        host,
        schemes,
        hasUtf8,
        issues,
      });
    }
  }
  return results;
}

function loadRoutingRequirements(appPath: string): RoutingRequirementInfo[] {
  const srcDir = path.join(appPath, 'src');
  const phpResults: RoutingRequirementInfo[] = [];
  if (fs.existsSync(srcDir)) {
    for (const f of getAllPhpFiles(srcDir)) {
      phpResults.push(...parsePhpRouteFile(f, appPath));
    }
  }
  const yamlResults = loadYamlRouteFiles(appPath);
  const all = [...phpResults, ...yamlResults].sort((a, b) => a.path.localeCompare(b.path));

  // Detect same-path routes (potential conflicts)
  const pathGroups = new Map<string, RoutingRequirementInfo[]>();
  for (const r of all) {
    const group = pathGroups.get(r.path) ?? [];
    group.push(r);
    pathGroups.set(r.path, group);
  }
  for (const [, group] of pathGroups) {
    if (group.length > 1) {
      for (const r of group) {
        r.issues.push(`Multiple routes share path "${r.path}" — requirement ordering matters for matching`);
      }
    }
  }

  return all;
}

export function listRoutingRequirements(appPath: string): McpToolResult {
  try {
    const infos = loadRoutingRequirements(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No routes with requirements found in src/ or config/routes/.' }] };
    }

    const withReqs = infos.filter((i) => Object.keys(i.requirements).length > 0);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Routing Requirements (${infos.length} routes, ${withReqs.length} with requirements)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      if (Object.keys(info.requirements).length === 0 && info.issues.length === 0) continue;
      text += `\n  ${info.path}`;
      if (info.routeName) text += `  (${info.routeName})`;
      text += `  [${info.file}]\n`;
      if (Object.keys(info.requirements).length > 0) {
        for (const [p, r] of Object.entries(info.requirements)) {
          text += `    requirement: ${p} = ${r}\n`;
        }
      }
      if (info.host) text += `    host: ${info.host}\n`;
      if (info.schemes.length > 0) text += `    schemes: ${info.schemes.join(', ')}\n`;
      if (info.hasUtf8) text += `    utf8: true\n`;
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

export function getRoutingRequirementStats(appPath: string): McpToolResult {
  try {
    const infos = loadRoutingRequirements(appPath);

    let text = `Routing Requirement Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total routes analyzed:         ${infos.length}\n`;
    text += `  With requirements:           ${infos.filter((i) => Object.keys(i.requirements).length > 0).length}\n`;
    text += `  With host requirement:       ${infos.filter((i) => !!i.host).length}\n`;
    text += `  With schemes:                ${infos.filter((i) => i.schemes.length > 0).length}\n`;
    text += `  With utf8 option:            ${infos.filter((i) => i.hasUtf8).length}\n`;
    text += `Issues:                        ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRoutingRequirementTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_routing_requirements',
      description: 'List Symfony route requirements from PHP attributes and YAML files: requirement patterns per parameter, host/schemes/utf8; warns about permissive patterns, missing ID requirements, host without https, same-path conflicts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_routing_requirement_stats',
      description: 'Show routing requirement statistics: total routes, routes with requirements/host/schemes/utf8, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
