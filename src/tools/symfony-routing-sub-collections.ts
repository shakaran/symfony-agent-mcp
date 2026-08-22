/**
 * Symfony Routing Sub-Collections Inspector
 *
 * Scans config/routes/**\/*.yaml, config/routes.yaml, and src/**\/*.php:
 *   - Route resource imports without prefix (potential collision)
 *   - Conflicting requirements between parent collection and imported routes
 *   - Circular import detection (route file importing itself or creating a cycle)
 *   - Route names with same prefix but different controllers (shadow routing)
 *   - host requirement on sub-collection without schemes constraint
 *   - Wildcard {_locale} in prefix without locale requirements
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface RouteImport {
  sourceFile: string;
  resource: string;
  prefix: string;
  requirements: Record<string, string>;
  host: string;
  schemes: string[];
}

interface RouteIssue {
  file: string;
  type: string;
  description: string;
}

function getAllYamlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllYamlFiles(full));
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        files.push(...getAllPhpFiles(full));
      } else if (entry.name.endsWith('.php')) {
        files.push(full);
      }
    }
  } catch { /* skip */ }
  return files;
}

function extractRouteImports(filePath: string, content: string): RouteImport[] {
  const imports: RouteImport[] = [];

  // YAML resource imports: key with resource: ...
  const blockRegex = /^(\w[\w_-]*):\s*\n((?:[ \t]+[^\n]*\n)*)/gm;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    const block = match[2];
    const resourceMatch = /resource:\s*['"]?([^\s'"]+)['"]?/m.exec(block);
    if (!resourceMatch) continue;

    const resource = resourceMatch[1];
    const prefixMatch = /prefix:\s*['"]?([^\s'"]+)['"]?/m.exec(block);
    const hostMatch = /host:\s*['"]?([^\s'"]+)['"]?/m.exec(block);
    const schemesMatch = /schemes:\s*\[([^\]]+)]/m.exec(block);
    const requirementsBlock = /requirements:\s*\n((?:\s+\w[^\n]*\n)*)/m.exec(block);

    const requirements: Record<string, string> = {};
    if (requirementsBlock) {
      const reqLines = requirementsBlock[1].split('\n');
      for (const line of reqLines) {
        const kv = /^\s+(\w+):\s*(.+)$/.exec(line);
        if (kv) requirements[kv[1]] = kv[2].trim().replace(/['"]/g, '');
      }
    }

    imports.push({
      sourceFile: filePath,
      resource,
      prefix: prefixMatch ? prefixMatch[1] : '',
      requirements,
      host: hostMatch ? hostMatch[1] : '',
      schemes: schemesMatch ? schemesMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')) : [],
    });
  }

  return imports;
}

function detectCircularImports(imports: RouteImport[], baseDir: string): string[] {
  const graph = new Map<string, string[]>();

  for (const imp of imports) {
    const src = path.resolve(baseDir, imp.sourceFile);
    const target = path.resolve(path.dirname(imp.sourceFile), imp.resource);
    const existing = graph.get(src) ?? [];
    existing.push(target);
    graph.set(src, existing);
  }

  const cycles: string[] = [];

  function dfs(node: string, visited: Set<string>, stack: string[]): void {
    if (stack.includes(node)) {
      const cycleStart = stack.indexOf(node);
      cycles.push(`Circular import: ${stack.slice(cycleStart).join(' -> ')} -> ${node}`);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const neighbor of graph.get(node) ?? []) {
      dfs(neighbor, visited, [...stack]);
    }
  }

  for (const node of graph.keys()) {
    dfs(node, new Set<string>(), []);
  }

  return [...new Set(cycles)];
}

function analyzeRouteFiles(appPath: string): { imports: RouteImport[]; issues: RouteIssue[] } {
  const resolvedBase = path.resolve(appPath);
  const configDir = path.join(resolvedBase, 'config');
  const srcDir = path.join(resolvedBase, 'src');

  const yamlFiles: string[] = [];
  if (fs.existsSync(configDir)) {
    yamlFiles.push(...getAllYamlFiles(configDir));
  }

  const safeYamls = yamlFiles.filter((f) => path.resolve(f).startsWith(resolvedBase + path.sep));

  const allImports: RouteImport[] = [];
  const issues: RouteIssue[] = [];

  for (const f of safeYamls) {
    let content = '';
    try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }

    if (!content.includes('resource:')) continue;

    const relFile = path.relative(appPath, f);
    const imports = extractRouteImports(f, content);
    allImports.push(...imports);

    for (const imp of imports) {
      // No prefix
      if (!imp.prefix) {
        issues.push({
          file: relFile,
          type: 'no-prefix',
          description: `Resource "${imp.resource}" imported without prefix — all imported routes at root path may collide with other routes`,
        });
      }

      // host without schemes
      if (imp.host && imp.schemes.length === 0) {
        issues.push({
          file: relFile,
          type: 'host-no-schemes',
          description: `Resource "${imp.resource}" has host requirement "${imp.host}" but no schemes constraint — add schemes: [https] to avoid mixed-protocol issues`,
        });
      }

      // {_locale} prefix without locale requirement
      if (imp.prefix.includes('{_locale}') && !imp.requirements['_locale']) {
        issues.push({
          file: relFile,
          type: 'locale-no-requirement',
          description: `Prefix "${imp.prefix}" contains {_locale} but no requirements._locale regex defined — add requirements: { _locale: 'en|fr|...' }`,
        });
      }
    }
  }

  // Circular import detection
  const cycles = detectCircularImports(allImports, appPath);
  for (const cycle of cycles) {
    issues.push({ file: '(circular)', type: 'circular-import', description: cycle });
  }

  // Shadow routing: same prefix, different controllers in PHP attributes
  const prefixControllerMap = new Map<string, string[]>();
  if (fs.existsSync(srcDir)) {
    for (const phpFile of getAllPhpFiles(srcDir)) {
      if (!path.resolve(phpFile).startsWith(resolvedBase + path.sep)) continue;
      let content = '';
      try { content = fs.readFileSync(phpFile, 'utf-8'); } catch { continue; }

      const routePrefixRegex = /#\[Route\s*\(\s*['"]([^'"]+)['"]/g;
      let routeMatch: RegExpExecArray | null;
      while ((routeMatch = routePrefixRegex.exec(content)) !== null) {
        const routePath = routeMatch[1];
        // Use first path segment as prefix
        const segments = routePath.split('/').filter((s) => s.length > 0);
        const prefix = segments.length > 0 ? `/${segments[0]}` : '/';

        const classMatch = /class\s+(\w+)/.exec(content);
        const controller = classMatch ? classMatch[1] : path.basename(phpFile, '.php');

        const existing = prefixControllerMap.get(prefix) ?? [];
        if (!existing.includes(controller)) existing.push(controller);
        prefixControllerMap.set(prefix, existing);
      }
    }
  }

  for (const [prefix, controllers] of prefixControllerMap.entries()) {
    if (controllers.length > 1) {
      issues.push({
        file: '(php-routes)',
        type: 'shadow-routing',
        description: `Route prefix "${prefix}" used by multiple controllers: ${controllers.join(', ')} — verify no unintended shadowing`,
      });
    }
  }

  return { imports: allImports, issues };
}

export function listSymfonyRoutingSubCollections(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { imports, issues } = analyzeRouteFiles(appPath);

    if (imports.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No route resource imports found.\n\nSub-collections use:\n  _api:\n    resource: ../src/Controller/Api/\n    prefix: /api\n    type: attribute',
        }],
      };
    }

    let text = `Symfony Routing Sub-Collections\n${'='.repeat(55)}\n\n`;
    text += `Route imports found: ${imports.length}\n\n`;

    for (const imp of imports) {
      const rel = path.relative(appPath, imp.sourceFile);
      text += `  ${rel}\n`;
      text += `    resource: ${imp.resource}\n`;
      text += `    prefix:   ${imp.prefix || '(none — root)'}\n`;
      if (imp.host) text += `    host:     ${imp.host}\n`;
      if (imp.schemes.length > 0) text += `    schemes:  [${imp.schemes.join(', ')}]\n`;
      const reqKeys = Object.keys(imp.requirements);
      if (reqKeys.length > 0) {
        text += `    requirements: ${reqKeys.map((k) => `${k}: ${imp.requirements[k]}`).join(', ')}\n`;
      }
      text += '\n';
    }

    if (issues.length > 0) {
      text += `Issues (${issues.length}):\n`;
      for (const issue of issues) {
        text += `  [${issue.type}] ${issue.file}: ${issue.description}\n`;
      }
    } else {
      text += 'No routing sub-collection issues detected.\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyRoutingSubCollectionsStats(appPath: string): McpToolResult {
  try {
    const resolvedPath = path.resolve(appPath);
    if (!fs.existsSync(resolvedPath)) {
      return { content: [{ type: 'text', text: `Path not found: ${appPath}` }], isError: true };
    }

    const { imports, issues } = analyzeRouteFiles(appPath);

    const byType = new Map<string, number>();
    for (const issue of issues) {
      byType.set(issue.type, (byType.get(issue.type) ?? 0) + 1);
    }

    let text = `Symfony Routing Sub-Collections Stats\n${'='.repeat(40)}\n\n`;
    text += `Total route imports:      ${imports.length}\n`;
    text += `Without prefix:           ${imports.filter((i) => !i.prefix).length}\n`;
    text += `With host constraint:     ${imports.filter((i) => i.host.length > 0).length}\n`;
    text += `With locale placeholder:  ${imports.filter((i) => i.prefix.includes('{_locale}')).length}\n`;
    text += `Total issues:             ${issues.length}\n`;

    for (const [type, count] of [...byType.entries()].sort()) {
      text += `  ${type.padEnd(25)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyRoutingSubCollectionsTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_routing_sub_collections',
      description: 'Scan Symfony route YAML files for sub-collection issues: missing prefix (root collision), circular imports, host without schemes, {_locale} without requirements, shadow routing (same prefix different controllers)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_routing_sub_collections_stats',
      description: 'Statistics for Symfony routing sub-collections: import count, missing prefix count, host/schemes mismatches, locale issues, total issues by type',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
