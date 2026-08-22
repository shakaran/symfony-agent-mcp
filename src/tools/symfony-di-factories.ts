import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface DiFactory {
  service: string;
  factoryClass: string;
  factoryMethod: string;
  source: 'yaml' | 'attribute';
  isStatic: boolean;
  issues: string[];
}

function loadYamlFactories(appPath: string): DiFactory[] {
  const factories: DiFactory[] = [];
  const servicesPath = path.join(appPath, 'config', 'services.yaml');
  const raw = parseYamlFile(servicesPath) as Record<string, unknown> | null;
  if (!raw) return factories;
  const services = ((raw['services'] ?? {}) as Record<string, unknown>);
  for (const [id, def] of Object.entries(services)) {
    const d = (def ?? {}) as Record<string, unknown>;
    if (!d['factory']) continue;
    const factory = d['factory'];
    let factoryClass = '';
    let factoryMethod = '';
    if (Array.isArray(factory) && factory.length >= 2) {
      factoryClass = String(factory[0]);
      factoryMethod = String(factory[1]);
    } else if (typeof factory === 'string') {
      const parts = factory.split('::');
      factoryClass = parts[0] ?? '';
      factoryMethod = parts[1] ?? '__invoke';
    }
    const issues: string[] = [];
    if (!factoryMethod) issues.push('Factory without method — defaults to __invoke; verify class is invokable');
    factories.push({ service: id, factoryClass, factoryMethod, source: 'yaml', isStatic: !factoryClass.startsWith('@'), issues });
  }
  return factories;
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

function scanAttributeFactories(appPath: string): DiFactory[] {
  const factories: DiFactory[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return factories;
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[AsTaggedItem')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;
    for (const m of content.matchAll(/#\[AsTaggedItem\s*\([^)]{0,200}\)/g)) {
      const priorityM = /priority\s*:\s*(-?\d+)/.exec(m[0]);
      factories.push({ service: classM[1], factoryClass: classM[1], factoryMethod: '(tagged)', source: 'attribute', isStatic: false, issues: priorityM ? [] : [] });
    }
  }
  return factories;
}

export function listDiFactories(appPath: string): McpToolResult {
  try {
    const yamlFactories = loadYamlFactories(appPath);
    const attrFactories = scanAttributeFactories(appPath);
    const all = [...yamlFactories, ...attrFactories];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No DI factory definitions found.\n\nExample (services.yaml):\n  App\\Service\\MyService:\n    factory: [App\\Factory\\MyFactory, create]\n\nOr static:\n  App\\Service\\MyService:\n    factory: [\'App\\\\Service\\\\MyService\', \'createDefault\']' }] };
    const totalIssues = all.reduce((s, f) => s + f.issues.length, 0);
    let text = `DI Factory Definitions\n${'='.repeat(55)}\n\nFactories: ${all.length}  (yaml: ${yamlFactories.length}  attribute: ${attrFactories.length})  Issues: ${totalIssues}\n`;
    for (const f of all.sort((a, b) => b.issues.length - a.issues.length)) {
      const staticStr = f.isStatic ? '  static' : '';
      text += `\n  ${f.service}\n    factory: ${f.factoryClass}::${f.factoryMethod}${staticStr}  [${f.source}]\n`;
      for (const i of f.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDiFactoryStats(appPath: string): McpToolResult {
  try {
    const all = [...loadYamlFactories(appPath), ...scanAttributeFactories(appPath)];
    let text = `DI Factory Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total factories: ${all.length}\n  From YAML: ${all.filter((f) => f.source === 'yaml').length}\n  Static: ${all.filter((f) => f.isStatic).length}\nIssues: ${all.reduce((s, f) => s + f.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDiFactoryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_di_factories', description: 'Show DI factory definitions: factory: in services.yaml (static/instance), #[AsTaggedItem] attribute, factory class+method, missing method warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_di_factory_stats', description: 'Show DI factory statistics: total factory count, YAML vs attribute source, static count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
