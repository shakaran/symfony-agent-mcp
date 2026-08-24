// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

interface TwigNamespace {
  namespace: string;
  paths: string[];
  issues: string[];
}

function loadTwigNamespaces(appPath: string): TwigNamespace[] {
  const namespaces: TwigNamespace[] = [];
  const candidates = [
    path.join(appPath, 'config', 'packages', 'twig.yaml'),
    path.join(appPath, 'config', 'twig.yaml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const twig = (raw['twig'] ?? raw) as Record<string, unknown>;
    const pathsConfig = twig['paths'];
    if (!pathsConfig || typeof pathsConfig !== 'object') continue;
    if (Array.isArray(pathsConfig)) {
      for (const p of pathsConfig) {
        namespaces.push({ namespace: '__main__', paths: [String(p)], issues: [] });
      }
    } else {
      for (const [p, ns] of Object.entries(pathsConfig as Record<string, unknown>)) {
        const nsName = ns ? String(ns) : '__main__';
        const existing = namespaces.find(n => n.namespace === nsName);
        if (existing) { existing.paths.push(p); }
        else { namespaces.push({ namespace: nsName, paths: [p], issues: [] }); }
      }
    }
  }
  for (const ns of namespaces) {
    if (ns.paths.length > 3) ns.issues.push(`${ns.paths.length} paths for namespace @${ns.namespace} — multiple fallback paths can cause ambiguous template resolution`);
    if (ns.namespace === '__main__' && namespaces.length > 1) ns.issues.push('Mixing unnamed and named namespaces — prefer explicit @Namespace references');
  }
  return namespaces;
}

export function listTwigNamespacePaths(appPath: string): McpToolResult {
  try {
    const namespaces = loadTwigNamespaces(appPath);
    if (namespaces.length === 0) return { content: [{ type: 'text', text: 'No custom Twig namespace paths configured.\n\nExample:\n  twig:\n    paths:\n      \'%kernel.project_dir%/templates/admin\': Admin\n      \'%kernel.project_dir%/templates/frontend\': Frontend' }] };
    const totalIssues = namespaces.reduce((s, n) => s + n.issues.length, 0);
    let text = `Twig Namespace Paths\n${'='.repeat(55)}\n\nNamespaces: ${namespaces.length}  Issues: ${totalIssues}\n`;
    for (const ns of namespaces) {
      text += `\n  @${ns.namespace}\n`;
      for (const p of ns.paths) text += `    path: ${p}\n`;
      for (const i of ns.issues) text += `    ⚠ ${i}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigNamespaceStats(appPath: string): McpToolResult {
  try {
    const namespaces = loadTwigNamespaces(appPath);
    let text = `Twig Namespace Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom namespaces: ${namespaces.length}\nTotal paths: ${namespaces.reduce((s, n) => s + n.paths.length, 0)}\nIssues: ${namespaces.reduce((s, n) => s + n.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getTwigNamespaceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_twig_namespace_paths', description: 'Show Twig custom namespace paths from twig.yaml: @Namespace → directory mappings, multiple fallback path warning, mixed named/unnamed namespace warning', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_twig_namespace_stats', description: 'Twig namespace statistics: custom namespace count, total paths, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
