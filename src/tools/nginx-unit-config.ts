import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface NginxUnitConfigInfo {
  section: string;
  key: string;
  value: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function findUnitConfigFiles(appPath: string): string[] {
  const candidates = ['unit.json', 'config.json', 'nginx-unit.json'];
  const searchDirs = [appPath, path.join(appPath, 'docker'), path.join(appPath, 'config')];
  const found: string[] = [];
  for (const dir of searchDirs) {
    for (const name of candidates) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) found.push(full);
    }
  }
  return found;
}

type UnitConfig = Record<string, unknown>;

function buildNginxUnitConfigInfos(appPath: string): NginxUnitConfigInfo[] {
  const results: NginxUnitConfigInfo[] = [];

  const configFiles = findUnitConfigFiles(appPath);

  for (const filePath of configFiles) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, filePath);

    let config: UnitConfig;
    try {
      config = JSON.parse(content) as UnitConfig;
    } catch {
      results.push({ section: relFile, key: 'parse', value: 'invalid JSON', issue: `NGINX Unit config "${relFile}" is not valid JSON` });
      continue;
    }

    // listeners section
    const listeners = (config['listeners'] ?? {}) as Record<string, unknown>;
    for (const [addr, listenerVal] of Object.entries(listeners)) {
      const listener = listenerVal as Record<string, unknown>;
      results.push({ section: `${relFile} > listeners`, key: addr, value: JSON.stringify(listener).slice(0, 200), issue: null });

      const hasTls = listener['tls'] !== undefined;
      if (!hasTls && (addr.includes(':80') || addr.includes(':8080') || addr === '*:80' || addr === '0.0.0.0:80')) {
        results.push({
          section: `${relFile} > listeners`,
          key: addr,
          value: 'HTTP only',
          issue: `Listener "${addr}" has no TLS configuration — HTTP-only listener exposes traffic in plaintext; add "tls": { "certificate": "..." } to terminate HTTPS at NGINX Unit`,
        });
      }
    }

    // applications section
    const applications = (config['applications'] ?? {}) as Record<string, unknown>;
    for (const [appName, appVal] of Object.entries(applications)) {
      const app = appVal as Record<string, unknown>;

      const appType = typeof app['type'] === 'string' ? app['type'] : 'unknown';
      results.push({ section: `${relFile} > applications`, key: `${appName}.type`, value: appType, issue: null });

      // processes
      const processes = app['processes'];
      if (processes === undefined || processes === null) {
        results.push({
          section: `${relFile} > applications`,
          key: `${appName}.processes`,
          value: 'not set',
          issue: `Application "${appName}" has no process limits — without limits NGINX Unit spawns unlimited workers; set "processes": { "max": N, "spare": M } to bound resource usage`,
        });
      } else {
        results.push({ section: `${relFile} > applications`, key: `${appName}.processes`, value: JSON.stringify(processes).slice(0, 100), issue: null });
      }

      // threads
      const threads = app['threads'];
      if (threads !== undefined) {
        results.push({ section: `${relFile} > applications`, key: `${appName}.threads`, value: String(threads), issue: null });
      }

      // root (document root path)
      const root = typeof app['root'] === 'string' ? app['root'] : null;
      if (root) {
        results.push({ section: `${relFile} > applications`, key: `${appName}.root`, value: root, issue: null });
      }

      // user/group — running as root
      const user = typeof app['user'] === 'string' ? app['user'] : null;
      const group = typeof app['group'] === 'string' ? app['group'] : null;

      if (user) {
        results.push({
          section: `${relFile} > applications`,
          key: `${appName}.user`,
          value: user,
          issue: user === 'root'
            ? `Application "${appName}" runs as root — this is a critical security risk; create a dedicated low-privilege user (e.g., www-data) and set "user": "www-data"`
            : null,
        });
      }

      if (group) {
        results.push({
          section: `${relFile} > applications`,
          key: `${appName}.group`,
          value: group,
          issue: group === 'root'
            ? `Application "${appName}" runs with group root — change to a low-privilege group`
            : null,
        });
      }

      // PHP-specific: options.admin.disable_functions
      if (appType === 'php') {
        const options = (app['options'] ?? {}) as Record<string, unknown>;
        const admin = (options['admin'] ?? {}) as Record<string, unknown>;
        const disableFunctions = admin['disable_functions'];
        if (!disableFunctions) {
          results.push({
            section: `${relFile} > applications`,
            key: `${appName}.options.admin.disable_functions`,
            value: 'not set',
            issue: `PHP application "${appName}" without disable_functions — dangerous PHP functions (exec, shell_exec, system, passthru, popen) are available; set options.admin.disable_functions to restrict them`,
          });
        } else {
          results.push({ section: `${relFile} > applications`, key: `${appName}.options.admin.disable_functions`, value: String(disableFunctions).slice(0, 100), issue: null });
        }
      }
    }

    // routes section
    const routes = config['routes'];
    if (Array.isArray(routes)) {
      for (const route of routes as unknown[]) {
        const r = route as Record<string, unknown>;
        const match = (r['match'] ?? {}) as Record<string, unknown>;
        const uri = match['uri'];
        if (uri) {
          results.push({ section: `${relFile} > routes`, key: 'match.uri', value: String(uri).slice(0, 200), issue: null });
        }
      }
    } else if (typeof routes === 'object' && routes !== null) {
      for (const [routeName, routeVal] of Object.entries(routes as Record<string, unknown>)) {
        if (Array.isArray(routeVal)) {
          for (const route of routeVal as unknown[]) {
            const r = route as Record<string, unknown>;
            const match = (r['match'] ?? {}) as Record<string, unknown>;
            const uri = match['uri'];
            if (uri) {
              results.push({ section: `${relFile} > routes[${routeName}]`, key: 'match.uri', value: String(uri).slice(0, 200), issue: null });
            }
          }
        }
      }
    }

    // settings section
    const settings = (config['settings'] ?? {}) as Record<string, unknown>;
    const httpSettings = (settings['http'] ?? {}) as Record<string, unknown>;
    if (Object.keys(httpSettings).length > 0) {
      results.push({ section: `${relFile} > settings.http`, key: 'settings', value: JSON.stringify(httpSettings).slice(0, 200), issue: null });
    }
  }

  // Check docker-compose for nginx unit image
  const dcFiles = [
    path.join(appPath, 'docker-compose.yml'),
    path.join(appPath, 'docker-compose.yaml'),
  ];
  for (const dcFile of dcFiles) {
    const content = safeRead(dcFile, appPath);
    if (!content) continue;
    const relFile = path.relative(appPath, dcFile);
    if (content.includes('nginx/unit')) {
      const imageMatch = /nginx\/unit:[^\s\n]{1,50}/.exec(content);
      results.push({
        section: relFile,
        key: 'service image',
        value: imageMatch ? imageMatch[0] : 'nginx/unit',
        issue: null,
      });
    }
  }

  return results;
}

export function listNginxUnitConfig(appPath: string): McpToolResult {
  try {
    const infos = buildNginxUnitConfigInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No NGINX Unit configuration found.' }] };
    }
    const issues = infos.filter((i) => i.issue !== null);
    let text = `NGINX Unit Configuration Analysis\n${'='.repeat(55)}\n\nEntries: ${infos.length}  Issues: ${issues.length}\n\n`;
    for (const info of infos) {
      text += `[${info.section}]\n`;
      text += `  Key:   ${info.key}\n`;
      text += `  Value: ${info.value}\n`;
      if (info.issue) text += `  ISSUE: ${info.issue}\n`;
      text += '\n';
    }
    if (issues.length > 0) {
      text += `Issues Summary (${issues.length}):\n`;
      for (const info of issues) {
        text += `  - [${info.section}] ${info.key}: ${info.issue}\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error scanning NGINX Unit config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getNginxUnitConfigStats(appPath: string): McpToolResult {
  try {
    const infos = buildNginxUnitConfigInfos(appPath);
    const issues = infos.filter((i) => i.issue !== null);
    const sections = new Set(infos.map((i) => i.section.split(' > ')[0]));
    const text = [
      `NGINX Unit Config Stats`,
      `=======================`,
      `Config files found : ${sections.size}`,
      `Total entries      : ${infos.length}`,
      `Issues             : ${issues.length}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export function getNginxUnitConfigTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: 'list_nginx_unit_config',
      description: 'Scan for NGINX Unit application server configuration (unit.json, nginx-unit.json). Parses listeners, routes, applications, and settings. Flags HTTP-only listeners, applications running as root, missing process limits, and PHP apps without disable_functions.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
    {
      name: 'get_nginx_unit_config_stats',
      description: 'Return summary statistics for NGINX Unit configuration: number of config files, entries, and issues.',
      inputSchema: {
        type: 'object',
        properties: { appPath: { type: 'string', description: 'Absolute path to the Symfony project root' } },
        required: ['appPath'],
      },
    },
  ];
}
