import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ResettableServiceInfo {
  file: string;
  class: string;
  hasResettableInterface: boolean;
  hasResetMethod: boolean;
  isRegisteredForReset: boolean;
  statefulProperties: string[];
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

function extractStatefulProperties(content: string): string[] {
  const props: string[] = [];
  // Array properties: private/protected array $name = []
  const arrayPropRegex = /(?:private|protected)\s+(?:array\s+)?\$(\w{1,80})\s*=\s*\[\]/g;
  for (const m of content.matchAll(arrayPropRegex)) {
    props.push(m[1]);
  }
  // Object properties typed as collection-like
  const objectPropRegex = /(?:private|protected)\s+(?:\??\w+\s+)?\$(\w{1,80})\s*=\s*null/g;
  for (const m of content.matchAll(objectPropRegex)) {
    if (!props.includes(m[1])) props.push(m[1]);
  }
  return props;
}

function loadRegisteredResets(appPath: string): Set<string> {
  const registered = new Set<string>();
  const servicesYaml = path.join(appPath, 'config', 'services.yaml');
  const raw = parseYamlFile(servicesYaml) as Record<string, unknown> | null;
  if (!raw) return registered;

  const services = (raw['services'] ?? {}) as Record<string, unknown>;
  for (const [id, def] of Object.entries(services)) {
    const d = (def ?? {}) as Record<string, unknown>;
    if (d['calls'] || d['reset'] || JSON.stringify(d).includes('kernel.reset')) {
      registered.add(id);
    }
    const tags = (d['tags'] ?? []) as unknown[];
    for (const tag of tags) {
      if (typeof tag === 'object' && tag !== null) {
        const t = tag as Record<string, unknown>;
        if (t['name'] === 'kernel.reset') registered.add(id);
      }
      if (typeof tag === 'string' && tag === 'kernel.reset') registered.add(id);
    }
  }
  return registered;
}

function parseResettableService(filePath: string, appPath: string, registeredResets: Set<string>): ResettableServiceInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasResettableInterface = content.includes('ResettableInterface') && content.includes('implements');
  const hasResetMethod = /function\s+reset\s*\(/.test(content);

  // Skip classes that have no stateful props and no reset-related interface
  const statefulProperties = extractStatefulProperties(content);

  if (!hasResettableInterface && !hasResetMethod && statefulProperties.length === 0) return null;
  // Skip entities
  if (content.includes('@ORM\\Entity') || content.includes('#[ORM\\Entity') || content.includes('#[Entity]')) return null;

  // Determine if namespace matches a registered service
  const namespaceM = /namespace\s+([\w\\]{1,200});/.exec(content);
  const fqcn = namespaceM ? `${namespaceM[1]}\\${className}` : className;
  const isRegisteredForReset = registeredResets.has(fqcn) || registeredResets.has(className);

  const issues: string[] = [];

  if (statefulProperties.length > 0 && !hasResettableInterface) {
    issues.push(`Service with stateful properties [${statefulProperties.slice(0, 3).join(', ')}] without ResettableInterface — state leaks in long-running workers`);
  }

  if (hasResettableInterface && hasResetMethod) {
    // Check if reset() clears all stateful properties
    const resetBodyM = /function\s+reset\s*\([^)]{0,50}\)[^{]{0,20}\{([\s\S]{0,500})\}/s.exec(content);
    if (resetBodyM) {
      const body = resetBodyM[1];
      const uncleared = statefulProperties.filter((p) => !body.includes(`$this->${p}`));
      if (uncleared.length > 0) {
        issues.push(`reset() does not clear all stateful properties: ${uncleared.slice(0, 3).join(', ')}`);
      }
    }
  }

  if (hasResettableInterface && !isRegisteredForReset) {
    issues.push('ResettableInterface implemented but service not registered for reset — services.yaml missing kernel.reset tag');
  }

  if (!hasResettableInterface && statefulProperties.length > 0) {
    // Check for RoadRunner/FrankenPHP context signals
    const composerPath = path.join(appPath, 'composer.json');
    let hasPersistentRuntime = false;
    try {
      const composerRaw = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = JSON.stringify(composerRaw['require'] ?? {});
      hasPersistentRuntime = req.includes('roadrunner') || req.includes('frankenphp') || req.includes('swoole');
    } catch { /* skip */ }
    if (hasPersistentRuntime) {
      issues.push('Stateful singleton without reset() in RoadRunner/FrankenPHP context — request state bleeds across requests');
    }
  }

  if (!hasResettableInterface && !hasResetMethod && statefulProperties.length === 0) return null;

  return {
    file: path.relative(appPath, filePath),
    class: className,
    hasResettableInterface,
    hasResetMethod,
    isRegisteredForReset,
    statefulProperties,
    issues,
  };
}

function loadResettableServices(appPath: string): ResettableServiceInfo[] {
  const registeredResets = loadRegisteredResets(appPath);
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: ResettableServiceInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parseResettableService(file, appPath, registeredResets);
    if (info) results.push(info);
  }
  return results;
}

export function listResettableServices(appPath: string): McpToolResult {
  try {
    const services = loadResettableServices(appPath);
    if (services.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No ResettableInterface implementations or stateful services found.\n\nExample:\n  class CacheCollector implements ResettableInterface {\n    private array $cache = [];\n    public function reset(): void { $this->cache = []; }\n  }',
        }],
      };
    }

    const totalIssues = services.reduce((s, svc) => s + svc.issues.length, 0);
    let text = `Resettable Services\n${'='.repeat(55)}\n\nServices: ${services.length}  Issues: ${totalIssues}\n`;

    for (const svc of services.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${svc.class}  (${svc.file})\n`;
      text += `    ResettableInterface: ${svc.hasResettableInterface ? 'yes' : 'no'}\n`;
      text += `    reset() method:      ${svc.hasResetMethod ? 'yes' : 'no'}\n`;
      text += `    registered:          ${svc.isRegisteredForReset ? 'yes' : 'no'}\n`;
      if (svc.statefulProperties.length > 0) {
        text += `    stateful props:      ${svc.statefulProperties.slice(0, 5).join(', ')}\n`;
      }
      for (const issue of svc.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getResettableServiceStats(appPath: string): McpToolResult {
  try {
    const services = loadResettableServices(appPath);
    const withInterface = services.filter((s) => s.hasResettableInterface);
    const withReset = services.filter((s) => s.hasResetMethod);

    let text = `Resettable Service Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total services analyzed:    ${services.length}\n`;
    text += `  With ResettableInterface: ${withInterface.length}\n`;
    text += `  With reset() method:      ${withReset.length}\n`;
    text += `  Registered for reset:     ${services.filter((s) => s.isRegisteredForReset).length}\n`;
    text += `  With stateful properties: ${services.filter((s) => s.statefulProperties.length > 0).length}\n`;
    text += `Issues:                     ${services.reduce((s, svc) => s + svc.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getResettableServiceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_resettable_services',
      description: 'Show ResettableInterface implementations and stateful services: reset() coverage, kernel.reset registration; warns on stateful service without ResettableInterface, incomplete reset(), unregistered ResettableInterface, RoadRunner/FrankenPHP state bleed',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_resettable_service_stats',
      description: 'Show resettable service statistics: total analyzed, ResettableInterface count, reset() count, registered count, stateful property count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
