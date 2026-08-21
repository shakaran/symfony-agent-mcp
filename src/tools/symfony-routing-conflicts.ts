import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface RoutingConflictInfo {
  file: string;
  type: 'duplicate-name' | 'duplicate-path' | 'no-name' | 'no-method' | 'priority';
  pattern: string;
  issues: string[];
}

function buildSymfonyRoutingConflictInfos(appPath: string): RoutingConflictInfo[] {
  const results: RoutingConflictInfo[] = [];

  const routeNames = new Map<string, string>();
  const routePaths = new Map<string, string>();

  const extractRouteAttributes = (content: string, relFile: string): void => {
    const routeRegex = /#\[Route\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(content)) !== null) {
      const attrs = match[1];

      const pathMatch = /^['"]([^'"]+)['"]/.exec(attrs.trim()) ||
        /path:\s*['"]([^'"]+)['"]/.exec(attrs);
      const nameMatch = /name:\s*['"]([^'"]+)['"]/.exec(attrs);
      const methodsMatch = /methods:\s*[[{]/.exec(attrs);

      const routePath = pathMatch ? pathMatch[1] : null;
      const routeName = nameMatch ? nameMatch[1] : null;

      if (routeName) {
        if (routeNames.has(routeName)) {
          results.push({
            file: relFile,
            type: 'duplicate-name',
            pattern: `duplicate route name: ${routeName}`,
            issues: [`Route name '${routeName}' is duplicated — also defined in ${routeNames.get(routeName)}; duplicate route names cause silent overwrites and unpredictable URL generation`],
          });
        } else {
          routeNames.set(routeName, relFile);
        }
      } else {
        results.push({
          file: relFile,
          type: 'no-name',
          pattern: `route without name in ${relFile}`,
          issues: ["Route without explicit name — Symfony auto-generates names like 'app_controller_method' which can break if renamed; add name: 'my_route_name'"],
        });
      }

      if (routePath) {
        if (routePaths.has(routePath)) {
          results.push({
            file: relFile,
            type: 'duplicate-path',
            pattern: `duplicate route path: ${routePath}`,
            issues: [`Route path '${routePath}' is duplicated — also defined in ${routePaths.get(routePath)}; first matching route wins which may cause unexpected handler dispatch`],
          });
        } else {
          routePaths.set(routePath, relFile);
        }
      }

      if (!methodsMatch) {
        results.push({
          file: relFile,
          type: 'no-method',
          pattern: `route without methods restriction in ${relFile}`,
          issues: ["Route without methods restriction — accepts all HTTP methods including DELETE and PUT; add methods: ['GET'] or methods: ['POST'] for explicit control"],
        });
      }
    }
  };

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php') && (full.includes('Controller') || full.includes('controller'))) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('#[Route(')) return;
            const relFile = path.relative(appPath, full);
            extractRouteAttributes(content, relFile);
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  const routesYaml = path.join(appPath, 'config', 'routes.yaml');
  if (fs.existsSync(routesYaml)) {
    let content = '';
    try { content = fs.readFileSync(routesYaml, 'utf-8'); } catch { /* skip */ }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\w[\w_]+:/.test(line) && !line.startsWith(' ') && !line.startsWith('#')) {
        const yamlRouteName = line.replace(':', '').trim();
        if (routeNames.has(yamlRouteName)) {
          results.push({
            file: 'config/routes.yaml',
            type: 'duplicate-name',
            pattern: `duplicate route name: ${yamlRouteName}`,
            issues: [`Route name '${yamlRouteName}' defined in YAML is also defined in ${routeNames.get(yamlRouteName)}; duplicate route names cause silent overwrites`],
          });
        } else {
          routeNames.set(yamlRouteName, 'config/routes.yaml');
        }
      }
    }

    if (!content.includes('methods:')) {
      results.push({
        file: 'config/routes.yaml',
        type: 'no-method',
        pattern: 'YAML routes without methods restriction',
        issues: ["YAML routes without methods restriction — accepts all HTTP methods; add methods: [GET] or methods: [POST] for explicit control"],
      });
    }
  }

  return results;
}

export function listSymfonyRoutingConflicts(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyRoutingConflictInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No routing conflicts found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Routing Conflicts Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRoutingConflictStats(appPath: string): McpToolResult {
  try {
    const infos = buildSymfonyRoutingConflictInfos(appPath);
    let text = `Symfony Routing Conflict Statistics\n${'='.repeat(40)}\n\n`;
    text += `Duplicate-name:  ${infos.filter((i) => i.type === 'duplicate-name').length}\n`;
    text += `Duplicate-path:  ${infos.filter((i) => i.type === 'duplicate-path').length}\n`;
    text += `No-name:         ${infos.filter((i) => i.type === 'no-name').length}\n`;
    text += `No-method:       ${infos.filter((i) => i.type === 'no-method').length}\n`;
    text += `Priority:        ${infos.filter((i) => i.type === 'priority').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyRoutingConflictTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_routing_conflicts', description: 'Analyze Symfony routing for conflicts; warns on duplicate route names, duplicate paths, routes without explicit names, routes without HTTP method restrictions', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_routing_conflict_stats', description: 'Statistics for Symfony routing conflicts: counts by type (duplicate-name/duplicate-path/no-name/no-method/priority), issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
