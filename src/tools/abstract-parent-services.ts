import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface AbstractServiceInfo {
  name: string;
  isAbstract: boolean;
  parent?: string;
  children: string[];
  calls: string[];
  properties: string[];
  issues: string[];
}

function loadAbstractServices(appPath: string): AbstractServiceInfo[] {
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services_test.yaml'),
  ];
  const allServices: AbstractServiceInfo[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const services = (raw['services'] ?? {}) as Record<string, unknown>;
    const infos = new Map<string, AbstractServiceInfo>();
    for (const [name, def] of Object.entries(services)) {
      if (name === '_defaults' || name === '_instanceof') continue;
      const d = (def ?? {}) as Record<string, unknown>;
      const isAbstract = d['abstract'] === true;
      const parent = d['parent'] ? String(d['parent']) : undefined;
      const calls = Array.isArray(d['calls']) ? d['calls'].map(c => Array.isArray(c) ? String(c[0]) : String(c)) : [];
      const properties = d['properties'] ? Object.keys(d['properties'] as Record<string, unknown>) : [];
      if (isAbstract || parent) {
        infos.set(name, { name, isAbstract, parent, children: [], calls, properties, issues: [] });
        allServices.push(infos.get(name)!);
      }
    }
    for (const svc of allServices) {
      if (svc.parent) {
        const parentSvc = infos.get(svc.parent);
        if (parentSvc) parentSvc.children.push(svc.name);
        else svc.issues.push(`Parent service "${svc.parent}" not found — may be in another file or missing`);
      }
    }
    for (const svc of allServices) {
      if (svc.isAbstract && svc.children.length === 0) svc.issues.push(`Abstract service "${svc.name}" has no child services — may be unused`);
      if (svc.parent && svc.calls.length === 0 && svc.properties.length === 0 && !svc.isAbstract) {
        svc.issues.push('Child service adds no calls or properties — parent: may be unnecessary overhead');
      }
    }
  }
  return allServices;
}

export function listAbstractServices(appPath: string): McpToolResult {
  try {
    const services = loadAbstractServices(appPath);
    if (services.length === 0) return { content: [{ type: 'text', text: 'No abstract or parent service definitions found.\n\nExample:\n  services:\n    App\\Handler\\AbstractHandler:\n      abstract: true\n      calls: [[ setLogger, [\'@logger\'] ]]\n    App\\Handler\\ConcreteHandler:\n      parent: App\\Handler\\AbstractHandler' }] };
    const abstracts = services.filter(s => s.isAbstract);
    const children = services.filter(s => s.parent);
    const totalIssues = services.reduce((s, svc) => s + svc.issues.length, 0);
    let text = `Abstract / Parent Services\n${'='.repeat(55)}\n\nAbstract: ${abstracts.length}  Children: ${children.length}  Issues: ${totalIssues}\n`;
    for (const s of services.sort((a, b) => b.issues.length - a.issues.length)) {
      const role = s.isAbstract ? `abstract  children: ${s.children.length}` : `parent: ${s.parent}`;
      text += `\n  ${s.name}  [${role}]\n`;
      if (s.calls.length > 0) text += `    calls: ${s.calls.join(', ')}\n`;
      for (const i of s.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAbstractServiceStats(appPath: string): McpToolResult {
  try {
    const services = loadAbstractServices(appPath);
    let text = `Abstract Service Statistics\n${'='.repeat(40)}\n\n`;
    text += `Abstract services: ${services.filter(s => s.isAbstract).length}\nChild services: ${services.filter(s => s.parent).length}\nMax children per abstract: ${Math.max(0, ...services.map(s => s.children.length))}\nIssues: ${services.reduce((s, svc) => s + svc.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getAbstractServiceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_abstract_services', description: 'Show abstract: true and parent: service definitions from services.yaml: child count per abstract, inherited calls/properties, unused abstract warning, missing parent warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_abstract_service_stats', description: 'Abstract service statistics: abstract count, child count, max children per abstract, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
