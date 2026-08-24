// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface BundleConfigInfo {
  file: string;
  class: string;
  hasLoad: boolean;
  hasTreeBuilder: boolean;
  configNodes: string[];
  rootNode?: string;
  isExtension: boolean;
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

function parseBundleConfig(filePath: string, appPath: string): BundleConfigInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  const isConfig = content.includes('ConfigurationInterface') || content.includes('TreeBuilder') || (content.includes('Extension') && content.includes('load('));
  if (!isConfig) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;
  const classM = /class\s+(\w{1,120})/.exec(content);
  if (!classM) return null;
  const isExtension = content.includes('Extension') || content.includes('prepareContainer') || content.includes('ContainerBuilder');
  const hasLoad = content.includes('function load(');
  const hasTreeBuilder = content.includes('TreeBuilder') || content.includes('getConfigTreeBuilder');
  const rootNodeM = /new TreeBuilder\s*\(\s*['"]([^'"]{1,80})['"]\)/.exec(content);
  const rootNode = rootNodeM?.[1];
  const configNodes: string[] = [];
  const nodeRe = /->children\(\)\s*(?:\n[^;]{0,500}?)?->(?:scalar|boolean|integer|float|array|enum|node|variableNode|arrayNode|scalarNode|booleanNode|integerNode)Node\s*\(\s*['"](\w{1,60})['"]\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(content)) !== null) {
    if (!configNodes.includes(m[1])) configNodes.push(m[1]);
  }
  const issues: string[] = [];
  if (hasTreeBuilder && !rootNode) issues.push('TreeBuilder without root node alias — configuration key may be auto-detected incorrectly');
  if (isExtension && hasLoad && !content.includes('processConfiguration')) issues.push('Extension::load() without processConfiguration() — configuration is not validated against tree builder');
  if (hasTreeBuilder && configNodes.length === 0) issues.push('TreeBuilder defined but no configuration nodes detected — bundle has no configurable options');
  return { file: path.relative(appPath, filePath), class: classM[1], hasLoad, hasTreeBuilder, configNodes, rootNode, isExtension, issues };
}

export function listBundleConfigTree(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    const results: BundleConfigInfo[] = [];
    for (const f of getAllPhpFiles(srcDir)) {
      const r = parseBundleConfig(f, appPath);
      if (r) results.push(r);
    }
    if (results.length === 0) return { content: [{ type: 'text', text: 'No bundle Configuration/Extension classes found.\n\nExample:\n  class Configuration implements ConfigurationInterface {\n    public function getConfigTreeBuilder(): TreeBuilder {\n      $treeBuilder = new TreeBuilder(\'my_bundle\');\n      $treeBuilder->getRootNode()->children()->scalarNode(\'api_key\')->end()->end();\n      return $treeBuilder;\n    }\n  }' }] };
    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
    let text = `Bundle Configuration Tree\n${'='.repeat(55)}\n\nClasses: ${results.length}  Issues: ${totalIssues}\n`;
    for (const r of results.sort((a, b) => b.issues.length - a.issues.length)) {
      const role = r.isExtension ? 'Extension' : 'Configuration';
      text += `\n  ${r.class}  [${role}]  root: ${r.rootNode ?? '?'}  nodes: ${r.configNodes.length}  (${r.file})\n`;
      if (r.configNodes.length > 0) text += `    nodes: ${r.configNodes.slice(0, 8).join(', ')}${r.configNodes.length > 8 ? ` +${r.configNodes.length - 8} more` : ''}\n`;
      for (const i of r.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBundleConfigTreeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const results: BundleConfigInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const f of getAllPhpFiles(srcDir)) {
        const r = parseBundleConfig(f, appPath);
        if (r) results.push(r);
      }
    }
    let text = `Bundle Config Tree Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes found: ${results.length}\n  Extensions: ${results.filter(r => r.isExtension).length}\n  Configurations: ${results.filter(r => !r.isExtension).length}\nTotal config nodes: ${results.reduce((s, r) => s + r.configNodes.length, 0)}\nIssues: ${results.reduce((s, r) => s + r.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getBundleConfigTreeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_symfony_bundle_config_tree', description: 'Detect bundle Configuration/TreeBuilder classes and Extension::load(): root node alias, configuration nodes (scalarNode/arrayNode/booleanNode), processConfiguration() check, missing root node warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_symfony_bundle_config_tree_stats', description: 'Bundle config tree statistics: Extension/Configuration class counts, total config nodes, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
