// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface ConnectionFactoryInfo {
  hasCustomFactory: boolean;
  factories: Array<{ class: string; file: string; hasCreate: boolean; issues: string[] }>;
  wrapperClass?: string;
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

function loadConnectionFactoryInfo(appPath: string): ConnectionFactoryInfo {
  let wrapperClass: string | undefined;
  const issues: string[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'doctrine.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const dbal = (doctrine['dbal'] ?? {}) as Record<string, unknown>;
    const wc = dbal['wrapper_class'] ?? dbal['wrapperClass'];
    if (wc) wrapperClass = String(wc);
  }
  const srcDir = path.join(appPath, 'src');
  const factories: ConnectionFactoryInfo['factories'] = [];
  if (fs.existsSync(srcDir)) {
    for (const filePath of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const isFactory = content.includes('ConnectionFactory') || content.includes('DriverManagerInterface');
      if (!isFactory) continue;
      if (content.includes('namespace Doctrine\\') || content.includes('namespace Symfony\\')) continue;
      const classM = /class\s+(\w{1,120})/.exec(content);
      if (!classM) continue;
      const hasCreate = content.includes('function createConnection') || content.includes('->createConnection(') || content.includes('ConnectionFactory::createConnection');
      const factoryIssues: string[] = [];
      if (!hasCreate) factoryIssues.push('ConnectionFactory subclass without createConnection() override — custom connection behavior not implemented');
      if (wrapperClass && !content.includes(wrapperClass.split('\\').pop() ?? wrapperClass)) {
        factoryIssues.push(`wrapper_class "${wrapperClass}" configured but not referenced in custom factory`);
      }
      factories.push({ class: classM[1], file: path.relative(appPath, filePath), hasCreate, issues: factoryIssues });
    }
  }
  if (wrapperClass) issues.push(`wrapper_class configured: ${wrapperClass} — custom connection class; ensure it extends Doctrine\\DBAL\\Connection`);
  return { hasCustomFactory: factories.length > 0 || !!wrapperClass, factories, wrapperClass, issues };
}

export function listDbalConnectionFactory(appPath: string): McpToolResult {
  try {
    const info = loadConnectionFactoryInfo(appPath);
    if (!info.hasCustomFactory) return { content: [{ type: 'text', text: 'No custom DBAL ConnectionFactory or wrapper_class found (using Doctrine defaults).' }] };
    let text = `DBAL Connection Factory\n${'='.repeat(55)}\n\nCustom factories: ${info.factories.length}  Issues: ${info.issues.length + info.factories.reduce((s, f) => s + f.issues.length, 0)}\n`;
    if (info.wrapperClass) text += `\nwrapper_class: ${info.wrapperClass}\n`;
    for (const f of info.factories.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${f.class}  createConnection: ${f.hasCreate ? '✓' : '✗'}  (${f.file})\n`;
      for (const i of f.issues) text += `    ⚠ ${i}\n`;
    }
    for (const i of info.issues) text += `\n⚠ ${i}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalConnectionFactoryStats(appPath: string): McpToolResult {
  try {
    const info = loadConnectionFactoryInfo(appPath);
    let text = `DBAL Connection Factory Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom factory: ${info.hasCustomFactory ? 'yes' : 'no'}\nFactory classes: ${info.factories.length}\nwrapper_class: ${info.wrapperClass ?? 'none'}\nIssues: ${info.issues.length}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDbalConnectionFactoryTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_dbal_connection_factory', description: 'Detect custom Doctrine DBAL ConnectionFactory classes and wrapper_class config: createConnection() override, wrapper_class inheritance check', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_dbal_connection_factory_stats', description: 'DBAL connection factory statistics: custom factory count, wrapper_class presence, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
