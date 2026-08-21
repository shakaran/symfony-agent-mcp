/**
 * Symfony Routing Loader Inspector
 *
 * Scans src/ PHP for:
 *   - Classes implementing LoaderInterface with routing.loader tag
 *   - load() method that returns RouteCollection
 *   - supports() method
 *
 * Also detects:
 *   - Custom route loaders in services.yaml with routing.loader tag
 *
 * Warns about:
 *   - routing.loader without supports() (may conflict)
 *   - load() method with file I/O not in try/catch (unhandled loader exception)
 *   - Loader not returning RouteCollection (returns null — routing breaks)
 *   - supports() always returning true (intercepts all routing files)
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

interface RoutingLoaderInfo {
  file: string;
  class?: string;
  hasLoad: boolean;
  hasSupports: boolean;
  supportsFormat?: string;
  isRegistered: boolean;
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

function loadRegisteredLoaderClasses(appPath: string): Set<string> {
  const registered = new Set<string>();
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services.yml'),
  ];
  for (const fp of candidates) {
    const raw = parseYamlFile(fp) as Record<string, unknown> | null;
    if (!raw) continue;
    const services = (raw['services'] ?? {}) as Record<string, unknown>;
    for (const [svcId, svcData] of Object.entries(services)) {
      const svc = (svcData ?? {}) as Record<string, unknown>;
      const tagsRaw = svc['tags'];
      if (!Array.isArray(tagsRaw)) continue;
      for (const tag of tagsRaw) {
        const tagStr = typeof tag === 'string' ? tag : (tag as Record<string, unknown>)['name'];
        if (tagStr === 'routing.loader') {
          registered.add(svcId);
        }
      }
    }
  }
  return registered;
}

function parseRoutingLoaderFile(filePath: string, appPath: string, registeredClasses: Set<string>): RoutingLoaderInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isLoader = (content.includes('LoaderInterface') && content.includes('implements') &&
    /implements[^{]{0,300}LoaderInterface/.test(content)) ||
    content.includes('routing.loader') ||
    (content.includes('extends Loader') && content.includes('RouteCollection'));

  if (!isLoader) return null;
  if (content.includes('namespace Symfony\\Component\\Config\\Loader')) return null;
  if (content.includes('namespace Symfony\\Component\\Routing\\Loader')) return null;

  const classM = /class\s+(\w{1,120})/.exec(content);
  const className = classM?.[1];
  const issues: string[] = [];

  const hasLoad = content.includes('function load(') || content.includes('public function load(');
  const hasSupports = content.includes('function supports(') || content.includes('public function supports(');

  // Extract supported format from supports()
  let supportsFormat: string | undefined;
  const supportsM = /function\s+supports\s*\([^)]{0,100}\)[^{]{0,20}\{[^}]{0,300}\}/.exec(content);
  if (supportsM) {
    const supportsBody = supportsM[0];
    const fmtM = /['"]([a-z]{1,20})['"]/.exec(supportsBody);
    if (fmtM) supportsFormat = fmtM[1];
    // Check if supports() always returns true
    if (/return\s+true\s*;/.test(supportsBody) && !supportsBody.includes('===') && !supportsBody.includes('instanceof')) {
      issues.push('supports() always returns true — this loader intercepts ALL routing file loads (conflict risk)');
    }
  }

  if (!hasSupports) {
    issues.push('Routing loader without supports() method — may conflict with other loaders (Symfony calls supports() to select the right loader)');
  }

  // Check load() for file I/O without try/catch
  if (hasLoad) {
    const loadM = /function\s+load\s*\([^)]{0,200}\)[^{]{0,20}\{([\s\S]{0,1500}?)\n {2}\}/.exec(content);
    const loadBody = loadM ? loadM[1] : content;
    const hasFileIo = loadBody.includes('file_get_contents(') || loadBody.includes('fopen(') ||
      loadBody.includes('readFileSync') || loadBody.includes('Yaml::parseFile') ||
      loadBody.includes('parse_ini_file(');
    if (hasFileIo) {
      const hasTryCatch = loadBody.includes('try') && loadBody.includes('catch');
      if (!hasTryCatch) {
        issues.push('load() performs file I/O without try/catch — unhandled exceptions break routing entirely');
      }
    }

    // Check return type — should return RouteCollection
    const returnsNull = /return\s+null\s*;/.test(loadBody) && !loadBody.includes('RouteCollection');
    if (returnsNull) {
      issues.push('load() may return null — routing loader must return a RouteCollection instance or routing breaks');
    }

    const returnsRouteCollection = loadBody.includes('RouteCollection') || loadBody.includes('new RouteCollection');
    if (!returnsRouteCollection) {
      issues.push('load() does not appear to return a RouteCollection — verify return type to avoid routing failures');
    }
  }

  // Check if registered
  const fqcn = ((): string => {
    const nsM = /namespace\s+([\w\\]{1,200});/.exec(content);
    return nsM && className ? `${nsM[1]}\\${className}` : (className ?? '');
  })();
  const isRegistered = registeredClasses.has(fqcn) || content.includes('routing.loader') ||
    content.includes('#[AsTaggedItem') || content.includes('autoconfigure');

  return {
    file: path.relative(appPath, filePath),
    class: className,
    hasLoad,
    hasSupports,
    supportsFormat,
    isRegistered,
    issues,
  };
}

function loadRoutingLoaderInfos(appPath: string): RoutingLoaderInfo[] {
  const registeredClasses = loadRegisteredLoaderClasses(appPath);
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: RoutingLoaderInfo[] = [];
  for (const f of getAllPhpFiles(srcDir)) {
    const r = parseRoutingLoaderFile(f, appPath, registeredClasses);
    if (r) results.push(r);
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

export function listRoutingLoaders(appPath: string): McpToolResult {
  try {
    const infos = loadRoutingLoaderInfos(appPath);

    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No custom routing loaders found in src/.' }] };
    }

    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Symfony Routing Loaders (${infos.length} found)\n${'='.repeat(55)}\n`;
    text += `Issues: ${totalIssues}\n`;

    for (const info of infos) {
      text += `\n  ${info.file}`;
      if (info.class) text += `  [${info.class}]`;
      text += '\n';
      const flags = [
        info.hasLoad ? 'has-load' : 'missing-load',
        info.hasSupports ? 'has-supports' : 'missing-supports',
        info.isRegistered ? 'registered' : 'not-registered',
      ].filter(Boolean).join(', ');
      text += `    flags: [${flags}]\n`;
      if (info.supportsFormat) text += `    supports format: ${info.supportsFormat}\n`;
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

export function getRoutingLoaderStats(appPath: string): McpToolResult {
  try {
    const infos = loadRoutingLoaderInfos(appPath);

    let text = `Routing Loader Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total routing loaders:        ${infos.length}\n`;
    text += `  With load() method:         ${infos.filter((i) => i.hasLoad).length}\n`;
    text += `  With supports() method:     ${infos.filter((i) => i.hasSupports).length}\n`;
    text += `  Registered:                 ${infos.filter((i) => i.isRegistered).length}\n`;
    text += `  With format detection:      ${infos.filter((i) => !!i.supportsFormat).length}\n`;
    text += `Issues:                       ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getRoutingLoaderTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_routing_loaders',
      description: 'List Symfony custom routing loaders: LoaderInterface implementations, load()/supports() methods, routing.loader tag registration; warns about missing supports(), file I/O without try/catch, missing RouteCollection return, always-true supports()',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_routing_loader_stats',
      description: 'Show routing loader statistics: total loaders, load/supports method coverage, registration status, issues count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
