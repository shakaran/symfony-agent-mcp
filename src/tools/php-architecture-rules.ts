// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ArchitectureRulesInfo {
  tool: string;
  configFile: string;
  version?: string;
  ruleCount: number;
  layers: string[];
  issues: string[];
}

function findDeptracConfig(appPath: string): string | null {
  const candidates = ['deptrac.yml', 'deptrac.yaml', '.deptrac.yaml', 'depfile.yml', 'depfile.yaml'];
  for (const name of candidates) {
    const f = path.join(appPath, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function findArkitectConfig(appPath: string): string | null {
  const candidates = ['arkitect.php', '.arkitect.php'];
  for (const name of candidates) {
    const f = path.join(appPath, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function parseDeptrac(filePath: string, appPath: string): ArchitectureRulesInfo {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
  const layerPattern = /name:\s*([^\s\n]+)/g;
  const layers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = layerPattern.exec(content)) !== null) {
    const name = m[1].replace(/^['"]|['"]$/g, '');
    if (!layers.includes(name)) layers.push(name);
  }
  const ruleCount = [...content.matchAll(/must_not_depend_on|may_not_depend|cannot_depend/g)].length;
  const issues: string[] = [];
  if (layers.length < 2) issues.push('Only 1 layer defined — deptrac requires at least 2 layers to enforce architecture boundaries');
  return { tool: 'deptrac', configFile: path.relative(appPath, filePath), ruleCount, layers: layers.slice(0, 20), issues };
}

function parseArkitect(filePath: string, appPath: string): ArchitectureRulesInfo {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
  const ruleCount = [...content.matchAll(/Rule::(?:allClasses|classesInNamespace|classes)\b/g)].length;
  const layerPattern = /namespace\s+['"]([^'"]+)['"]/g;
  const layers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = layerPattern.exec(content)) !== null) {
    const ns = m[1].split('\\').slice(0, 3).join('\\');
    if (!layers.includes(ns)) layers.push(ns);
  }
  const issues: string[] = [];
  if (ruleCount === 0) issues.push('No Arkitect rules found — define rules with Rule::allClasses()->that->...');
  return { tool: 'arkitect', configFile: path.relative(appPath, filePath), ruleCount, layers: layers.slice(0, 20), issues };
}

export function listPhpArchitectureRules(appPath: string): McpToolResult {
  try {
    const tools: ArchitectureRulesInfo[] = [];
    const deptracPath = findDeptracConfig(appPath);
    if (deptracPath) tools.push(parseDeptrac(deptracPath, appPath));
    const arkitectPath = findArkitectConfig(appPath);
    if (arkitectPath) tools.push(parseArkitect(arkitectPath, appPath));
    if (tools.length === 0) {
      return { content: [{ type: 'text', text: 'No architecture enforcement tool configured.\n\nOptions:\n  deptrac: composer require --dev qossmic/deptrac-shim\n    Config: deptrac.yaml with layers and ruleset\n  Arkitect: composer require --dev phparkitect/phparkitect\n    Config: arkitect.php with Rule definitions' }] };
    }
    const totalIssues = tools.reduce((s, t) => s + t.issues.length, 0);
    let text = `PHP Architecture Rules\n${'='.repeat(55)}\n\nTools: ${tools.length}  Issues: ${totalIssues}\n`;
    for (const t of tools.sort((a, b) => b.issues.length - a.issues.length)) {
      text += `\n  ${t.tool}  rules: ${t.ruleCount}  layers: ${t.layers.length}  (${t.configFile})\n`;
      if (t.layers.length > 0) text += `    Layers: ${t.layers.join(', ')}\n`;
      for (const i of t.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArchitectureRulesStats(appPath: string): McpToolResult {
  try {
    const tools: ArchitectureRulesInfo[] = [];
    const deptracPath = findDeptracConfig(appPath);
    if (deptracPath) tools.push(parseDeptrac(deptracPath, appPath));
    const arkitectPath = findArkitectConfig(appPath);
    if (arkitectPath) tools.push(parseArkitect(arkitectPath, appPath));
    let text = `PHP Architecture Rules Statistics\n${'='.repeat(40)}\n\n`;
    text += `Tools configured: ${tools.length}\n`;
    for (const t of tools) text += `  ${t.tool}: ${t.ruleCount} rules  ${t.layers.length} layers\n`;
    text += `Issues: ${tools.reduce((s, t) => s + t.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPhpArchitectureRulesTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_php_architecture_rules', description: 'Show deptrac/Arkitect configuration: layers, rule count, config file presence, missing-rules warning; detect architecture enforcement tooling', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_php_architecture_rules_stats', description: 'Show architecture rules statistics: tools configured, rule count per tool, layer count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
