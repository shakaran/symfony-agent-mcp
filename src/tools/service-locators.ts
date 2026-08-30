// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ServiceLocatorInfo {
  name: string;
  type: 'tagged_locator' | 'ServiceLocatorInterface' | 'ServiceSubscriberInterface';
  file?: string;
  class?: string;
  services?: string[];
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

function loadTaggedLocators(appPath: string): ServiceLocatorInfo[] {
  const results: ServiceLocatorInfo[] = [];
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services.yml'),
    path.join(appPath, 'config', 'services_test.yaml'),
    path.join(appPath, 'config', 'services_test.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const services = (raw['services'] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(services)) {
      const d = (def ?? {}) as Record<string, unknown>;
      const args = Array.isArray(d['arguments']) ? d['arguments'] : [];
      for (const arg of args) {
        const a = (arg ?? {}) as Record<string, unknown>;
        if (typeof a === 'object' && a['!tagged_locator']) {
          results.push({ name, type: 'tagged_locator', services: [String(a['!tagged_locator'])], issues: [] });
        }
      }
    }
  }
  return results;
}

function loadPhpLocators(appPath: string): ServiceLocatorInfo[] {
  const results: ServiceLocatorInfo[] = [];
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;
  for (const filePath of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const isLocator = content.includes('ServiceLocatorInterface') || content.includes('ServiceSubscriberInterface');
    if (!isLocator) continue;
    if (content.includes('namespace Symfony\\')) continue;
    const classM = /class\s+(\w{1,120})/.exec(content);
    if (!classM) continue;
    const type = content.includes('ServiceSubscriberInterface') ? 'ServiceSubscriberInterface' : 'ServiceLocatorInterface';
    const issues: string[] = [];
    if (type === 'ServiceSubscriberInterface' && !content.includes('getSubscribedServices')) {
      issues.push('ServiceSubscriberInterface without getSubscribedServices() — all services will be eagerly loaded');
    }
    if (type === 'ServiceLocatorInterface' && !content.includes('has(') && !content.includes('get(')) {
      issues.push('ServiceLocatorInterface injected but has()/get() not used — consider injecting specific services directly');
    }
    results.push({ name: classM[1], type, file: path.relative(appPath, filePath), class: classM[1], issues });
  }
  return results;
}

export function listServiceLocators(appPath: string): McpToolResult {
  try {
    const tagged = loadTaggedLocators(appPath);
    const php = loadPhpLocators(appPath);
    const all = [...tagged, ...php];
    if (all.length === 0) return { content: [{ type: 'text', text: 'No service locators found.\n\nExample:\n  # services.yaml\n  App\\Handler\\HandlerLocator:\n    arguments:\n      - !tagged_locator { tag: app.handler, index_by: alias }' }] };
    const totalIssues = all.reduce((s, s2) => s + s2.issues.length, 0);
    let text = `Service Locators\n${'='.repeat(55)}\n\nLocators: ${all.length}  Issues: ${totalIssues}\n`;
    for (const s of all.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${s.name}  type: ${s.type}${s.file ? `  (${s.file})` : ''}\n`;
      if (s.services && s.services.length > 0) text += `    tags: ${s.services.join(', ')}\n`;
      for (const i of s.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getServiceLocatorStats(appPath: string): McpToolResult {
  try {
    const tagged = loadTaggedLocators(appPath);
    const php = loadPhpLocators(appPath);
    const all = [...tagged, ...php];
    let text = `Service Locator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total locators: ${all.length}\n  !tagged_locator: ${tagged.length}\n  ServiceLocatorInterface: ${php.filter(p => p.type === 'ServiceLocatorInterface').length}\n  ServiceSubscriberInterface: ${php.filter(p => p.type === 'ServiceSubscriberInterface').length}\nIssues: ${all.reduce((s, s2) => s + s2.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getServiceLocatorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_service_locators', description: 'Detect service locators: !tagged_locator in services.yaml, ServiceLocatorInterface and ServiceSubscriberInterface in PHP — missing getSubscribedServices() warning, unused locator warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_service_locator_stats', description: 'Service locator statistics: total count, !tagged_locator/ServiceLocatorInterface/ServiceSubscriberInterface breakdown, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
