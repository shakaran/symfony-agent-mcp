import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ServiceAlias {
  alias: string;
  target: string;
  source: 'yaml' | 'attribute';
  isDeprecated: boolean;
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

function loadYamlAliases(appPath: string): ServiceAlias[] {
  const aliases: ServiceAlias[] = [];
  const servicesFiles = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services_test.yaml'),
  ];
  for (const filePath of servicesFiles) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const services = ((raw['services'] ?? {}) as Record<string, unknown>);
    for (const [id, def] of Object.entries(services)) {
      const d = (def ?? {}) as Record<string, unknown>;
      if (typeof d['alias'] === 'string') {
        const isDeprecated = !!d['deprecated'];
        aliases.push({ alias: id, target: d['alias'], source: 'yaml', isDeprecated, issues: isDeprecated ? ['Deprecated alias — schedule removal'] : [] });
      }
    }
  }
  return aliases;
}

function loadAttributeAliases(appPath: string): ServiceAlias[] {
  const aliases: ServiceAlias[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return aliases;
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[AsAlias')) continue;
    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;
    for (const m of content.matchAll(/#\[AsAlias\s*\(\s*(?:id\s*:\s*)?['"]([^'"]+)['"]/g)) {
      aliases.push({ alias: m[1], target: classM[1], source: 'attribute', isDeprecated: false, issues: [] });
    }
    if (content.includes('#[AsAlias]') || content.includes('#[AsAlias(')) {
      if (!content.match(/#\[AsAlias\s*\(\s*(?:id\s*:\s*)?['"][^'"]+['"]/)) {
        aliases.push({ alias: `(auto: ${classM[1]})`, target: classM[1], source: 'attribute', isDeprecated: false, issues: [] });
      }
    }
  }
  return aliases;
}

export function listServiceAliases(appPath: string): McpToolResult {
  try {
    const yamlAliases = loadYamlAliases(appPath);
    const attrAliases = loadAttributeAliases(appPath);
    const all = [...yamlAliases, ...attrAliases];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No service aliases found.\n\nExample (services.yaml):\n  App\\Repository\\PostRepositoryInterface:\n    alias: App\\Repository\\PostRepository\n\nOr with #[AsAlias] attribute (Symfony 6.3+):\n  #[AsAlias(id: PostRepositoryInterface::class)]' }] };
    const totalIssues = all.reduce((s, a) => s + a.issues.length, 0);
    let text = `Service Aliases\n${'='.repeat(55)}\n\nAliases: ${all.length}  (yaml: ${yamlAliases.length}  attribute: ${attrAliases.length})  Issues: ${totalIssues}\n`;
    for (const a of all.sort((x, y) => y.issues.length - x.issues.length)) {
      const dep = a.isDeprecated ? '  [DEPRECATED]' : '';
      text += `\n  ${a.alias}${dep}\n    → ${a.target}  [${a.source}]\n`;
      for (const i of a.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getServiceAliasStats(appPath: string): McpToolResult {
  try {
    const all = [...loadYamlAliases(appPath), ...loadAttributeAliases(appPath)];
    let text = `Service Alias Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total aliases: ${all.length}\n  From YAML: ${all.filter((a) => a.source === 'yaml').length}\n  From #[AsAlias]: ${all.filter((a) => a.source === 'attribute').length}\n  Deprecated: ${all.filter((a) => a.isDeprecated).length}\nIssues: ${all.reduce((s, a) => s + a.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getServiceAliasTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_service_aliases', description: 'Show service aliases: YAML alias: definitions, #[AsAlias] attribute (Symfony 6.3+), deprecated alias warnings, interface→implementation mapping', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_service_alias_stats', description: 'Show service alias statistics: total count, YAML vs attribute source, deprecated count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
