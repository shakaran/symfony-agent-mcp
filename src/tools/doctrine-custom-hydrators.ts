// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface HydratorInfo {
  class: string;
  file: string;
  name?: string;
  hasGetHydratorClass: boolean;
  hasHydrateAll: boolean;
  configRegistered: boolean;
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

function loadRegisteredHydrators(appPath: string): string[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const orm = (doctrine['orm'] ?? {}) as Record<string, unknown>;
    const hydrators = (orm['hydrators'] ?? {}) as Record<string, unknown>;
    return Object.values(hydrators).map(String);
  }
  return [];
}

export function listDoctrineCustomHydrators(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const registeredClasses = loadRegisteredHydrators(appPath);
    const hydrators: HydratorInfo[] = [];
    for (const filePath of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!content.includes('AbstractHydrator') && !content.includes('ObjectHydrator')) continue;
      if (content.includes('namespace Doctrine\\')) continue;
      const classM = /class\s+(\w{1,120})\s+extends\s+\w*Hydrator/.exec(content);
      if (!classM) continue;
      const className = classM[1];
      const nsM = /namespace\s+([\w\\]{1,200});/.exec(content);
      const fqn = nsM ? `${nsM[1]}\\${className}` : className;
      const hasGetHydratorClass = content.includes('getHydratorClass');
      const hasHydrateAll = content.includes('hydrateAll') || content.includes('hydrateRow');
      const configRegistered = registeredClasses.some(c => c.includes(className) || c === fqn);
      const issues: string[] = [];
      if (!configRegistered) issues.push('Hydrator not registered in doctrine.yaml orm.hydrators — it cannot be used by name');
      if (!hasHydrateAll) issues.push('Missing hydrateAll() or hydrateRow() — hydrator may be incomplete');
      hydrators.push({ class: className, file: path.relative(appPath, filePath), hasGetHydratorClass, hasHydrateAll, configRegistered, issues });
    }
    if (hydrators.length === 0) return { content: [{ type: 'text', text: 'No custom Doctrine hydrators found.\n\nExample:\n  class UserHydrator extends AbstractHydrator {\n    protected function hydrateAllData(): array { ... }\n  }\n  # doctrine.yaml: orm.hydrators: { user: App\\Hydrator\\UserHydrator }' }] };
    const totalIssues = hydrators.reduce((s, h) => s + h.issues.length, 0);
    let text = `Doctrine Custom Hydrators\n${'='.repeat(55)}\n\nHydrators: ${hydrators.length}  Issues: ${totalIssues}\n`;
    for (const h of hydrators.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${h.class}  registered: ${h.configRegistered ? 'yes' : 'NO'}\n    ${h.file}\n`;
      for (const i of h.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineHydratorStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const registered = loadRegisteredHydrators(appPath);
    let count = 0;
    let unregistered = 0;
    if (fs.existsSync(srcDir)) {
      for (const filePath of getAllPhpFiles(srcDir)) {
        let content = '';
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
        if (!content.includes('AbstractHydrator') && !content.includes('ObjectHydrator')) continue;
        if (/class\s+\w{1,120}\s+extends\s+\w*Hydrator/.test(content)) {
          count++;
          const classM = /class\s+(\w{1,120})/.exec(content);
          if (classM && !registered.some(c => c.includes(classM[1]))) unregistered++;
        }
      }
    }
    let text = `Doctrine Hydrator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom hydrators: ${count}\nRegistered in config: ${count - unregistered}\nNot registered: ${unregistered}\nConfig entries: ${registered.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineHydratorTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_custom_hydrators', description: 'Detect AbstractHydrator subclasses: hydrateAll/hydrateRow presence, registration in doctrine.yaml orm.hydrators, unregistered hydrator warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_hydrator_stats', description: 'Doctrine hydrator statistics: custom count, registered vs unregistered, config entries', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
