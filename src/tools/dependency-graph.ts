// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony DI Dependency Graph Analyzer
 *
 * Builds a static dependency graph from constructor injection:
 *   - Which services each class depends on
 *   - Fan-in: most injected services (potential "god" services)
 *   - Fan-out: services with the most dependencies
 *   - Circular dependency detection (via DFS)
 *   - Layer violations (e.g., Repository injected into Entity)
 *
 * Pure static analysis — parses constructor type hints from PHP files.
 * Does NOT execute Symfony's DI container.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ServiceNode {
  class: string;
  file: string;
  layer: string;
  dependencies: string[];
}

type LayerName = 'Controller' | 'Command' | 'Service' | 'Repository' | 'Entity' | 'Form' | 'EventListener' | 'MessageHandler' | 'Other';

// ─── Layer detection ────────────────────────────────────────────────────────

function detectLayer(filePath: string, content: string): LayerName {
  const rel = filePath.toLowerCase();
  if (rel.includes('/controller/') || /extends\s+AbstractController/.test(content)) return 'Controller';
  if (rel.includes('/command/') || content.includes('extends Command') || content.includes('#[AsCommand]')) return 'Command';
  if (rel.includes('/repository/') || content.includes('extends ServiceEntityRepository')) return 'Repository';
  if (rel.includes('/entity/') || content.includes('#[ORM\\Entity') || content.includes('#[Entity')) return 'Entity';
  if (rel.includes('/form/') || content.includes('extends AbstractType')) return 'Form';
  if (rel.includes('/eventlistener/') || rel.includes('/eventsubscriber/') || content.includes('#[AsEventListener]')) return 'EventListener';
  if (rel.includes('/messagehandler/') || content.includes('implements MessageHandlerInterface') || content.includes('#[AsMessageHandler]')) return 'MessageHandler';
  return 'Service';
}

// ─── File scanning ──────────────────────────────────────────────────────────

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function extractConstructorDeps(content: string): string[] {
  // Match constructor signature — grab all type-hinted parameters
  const ctorM = /public\s+function\s+__construct\s*\(([^)]*)\)/s.exec(content);
  if (!ctorM) return [];

  const deps: string[] = [];
  // Each param: TypeHint $varName — extract the TypeHint
  const paramPattern = /(?:readonly\s+)?(?:private|protected|public)?\s*([\w\\]+)\s+\$\w+/g;
  let m: RegExpExecArray | null;
  while ((m = paramPattern.exec(ctorM[1])) !== null) {
    const type = m[1];
    // Skip primitive types and nullable scalars
    if (/^(string|int|float|bool|array|callable|iterable|object|void|mixed|never|null)$/.test(type)) continue;
    // Short name (strip namespace)
    const shortName = type.split('\\').pop() ?? type;
    if (shortName.length > 2) deps.push(shortName);
  }
  return [...new Set(deps)];
}

function buildGraph(appPath: string): ServiceNode[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const nodes: ServiceNode[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    // Skip interfaces and traits
    if (/^\s*interface\s+/m.test(content) || /^\s*trait\s+/m.test(content)) continue;

    const classM = /(?:abstract\s+)?class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const deps = extractConstructorDeps(content);

    nodes.push({
      class: classM[1],
      file: path.relative(appPath, file),
      layer: detectLayer(file, content),
      dependencies: deps,
    });
  }

  return nodes;
}

// ─── Graph analysis ─────────────────────────────────────────────────────────

interface CircularDep {
  cycle: string[];
}

function detectCircular(nodes: ServiceNode[]): CircularDep[] {
  const classMap = new Map<string, ServiceNode>();
  for (const n of nodes) classMap.set(n.class, n);

  const cycles: CircularDep[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(cls: string, stack: string[]): void {
    if (inStack.has(cls)) {
      const cycleStart = stack.indexOf(cls);
      if (cycleStart >= 0) {
        const cycle = stack.slice(cycleStart);
        // Deduplicate: normalize cycle by rotating to smallest element
        const min = cycle.reduce((a, b) => (a < b ? a : b));
        const idx = cycle.indexOf(min);
        const normalized = [...cycle.slice(idx), ...cycle.slice(0, idx)];
        const key = normalized.join('→');
        if (!cycles.some((c) => c.cycle.join('→') === key)) {
          cycles.push({ cycle: normalized });
        }
      }
      return;
    }
    if (visited.has(cls)) return;

    visited.add(cls);
    inStack.add(cls);

    const node = classMap.get(cls);
    if (node) {
      for (const dep of node.dependencies) {
        if (classMap.has(dep)) {
          dfs(dep, [...stack, cls]);
        }
      }
    }

    inStack.delete(cls);
  }

  for (const node of nodes) {
    if (!visited.has(node.class)) {
      dfs(node.class, []);
    }
  }

  return cycles;
}

function computeFanIn(nodes: ServiceNode[]): Array<{ class: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      counts.set(dep, (counts.get(dep) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Layer violation detection ──────────────────────────────────────────────

const LAYER_ORDER: LayerName[] = ['Controller', 'Command', 'MessageHandler', 'Service', 'Form', 'EventListener', 'Repository', 'Entity'];

interface LayerViolation {
  from: string;
  fromLayer: string;
  to: string;
  toLayer: string;
  reason: string;
}

function detectLayerViolations(nodes: ServiceNode[]): LayerViolation[] {
  const classLayerMap = new Map<string, string>();
  for (const n of nodes) classLayerMap.set(n.class, n.layer);

  const violations: LayerViolation[] = [];
  const RULES: Array<[LayerName, LayerName, string]> = [
    ['Entity', 'Repository', 'Entity should not depend on Repository (circular concern)'],
    ['Entity', 'Service', 'Entity should not depend on Service (anemic domain violation)'],
    ['Repository', 'Controller', 'Repository should not depend on Controller'],
    ['Form', 'Service', 'Form depending on Service is acceptable but watch for complexity'],
  ];

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const depLayer = classLayerMap.get(dep) as LayerName | undefined;
      if (!depLayer) continue;

      for (const [fromLayer, toLayer, reason] of RULES) {
        if (node.layer === fromLayer && depLayer === toLayer) {
          violations.push({
            from: node.class,
            fromLayer: node.layer,
            to: dep,
            toLayer: depLayer,
            reason,
          });
        }
      }
    }
  }

  void LAYER_ORDER;
  return violations;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function analyzeDependencyGraph(appPath: string): McpToolResult {
  try {
    const nodes = buildGraph(appPath);

    if (nodes.length === 0) {
      return {
        content: [{ type: 'text', text: 'No PHP classes found in src/.' }],
      };
    }

    const fanIn = computeFanFanIn(nodes).slice(0, 15);
    const fanOut = nodes
      .map((n) => ({ class: n.class, layer: n.layer, count: n.dependencies.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const circles = detectCircular(nodes);
    const violations = detectLayerViolations(nodes);

    let text = `Dependency Graph Analysis  (${nodes.length} classes)\n${'='.repeat(60)}\n`;

    // Most-injected (fan-in) — potential "god services"
    text += `\nMost Injected Services (fan-in top 15):\n`;
    for (const { class: cls, count } of fanIn) {
      text += `  ${String(count).padStart(3)}x  ${cls}\n`;
    }

    // Most dependencies (fan-out)
    text += `\nMost Dependencies (fan-out top 10):\n`;
    for (const { class: cls, layer, count } of fanOut) {
      if (count === 0) continue;
      text += `  ${String(count).padStart(3)} deps  ${cls}  [${layer}]\n`;
    }

    // Circular dependencies
    if (circles.length > 0) {
      text += `\n⚠ Circular Dependencies (${circles.length}):\n`;
      for (const c of circles.slice(0, 10)) {
        text += `  ${c.cycle.join(' → ')} → ${c.cycle[0]}\n`;
      }
    } else {
      text += `\n✓ No circular dependencies detected.\n`;
    }

    // Layer violations
    if (violations.length > 0) {
      text += `\n⚠ Potential Layer Violations (${violations.length}):\n`;
      for (const v of violations.slice(0, 10)) {
        text += `  ${v.from} [${v.fromLayer}] → ${v.to} [${v.toLayer}]\n`;
        text += `    ${v.reason}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function computeFanFanIn(nodes: ServiceNode[]): Array<{ class: string; count: number }> {
  return computeFanIn(nodes);
}

export function detectCircularDependencies(appPath: string): McpToolResult {
  try {
    const nodes = buildGraph(appPath);
    const circles = detectCircular(nodes);

    if (circles.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No circular dependencies found in ${nodes.length} classes.\n\nAll constructor-injection chains are acyclic.`,
        }],
      };
    }

    let text = `Circular Dependencies (${circles.length} cycles)\n${'='.repeat(50)}\n\n`;
    for (const c of circles) {
      text += `  ${c.cycle.join(' → ')} → ${c.cycle[0]}\n`;
    }

    text += `\nFix: introduce an interface or event to break the cycle.\n`;
    text += `Symfony will throw at container compile time if true service cycles exist.`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDependencyGraphStats(appPath: string): McpToolResult {
  try {
    const nodes = buildGraph(appPath);

    const totalDeps = nodes.reduce((s, n) => s + n.dependencies.length, 0);
    const avgDeps = nodes.length > 0 ? (totalDeps / nodes.length).toFixed(1) : '0';
    const circles = detectCircular(nodes);
    const violations = detectLayerViolations(nodes);

    const byLayer: Record<string, number> = {};
    for (const n of nodes) {
      byLayer[n.layer] = (byLayer[n.layer] ?? 0) + 1;
    }

    let text = `Dependency Graph Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes:         ${nodes.length}\n`;
    text += `Total dependencies:    ${totalDeps}\n`;
    text += `Avg deps per class:    ${avgDeps}\n`;
    text += `Circular dependencies: ${circles.length}\n`;
    text += `Layer violations:      ${violations.length}\n`;

    text += `\nBy layer:\n`;
    for (const [layer, count] of Object.entries(byLayer).sort((a, b) => b[1] - a[1])) {
      text += `  ${layer.padEnd(20)} ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getDependencyGraphTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'analyze_dependency_graph',
      description: 'Analyze the DI dependency graph: most-injected services (fan-in), services with most dependencies (fan-out), circular dependencies, and layer violations',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'detect_circular_dependencies',
      description: 'Detect circular constructor-injection chains in src/ (A depends on B depends on A)',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_dependency_graph_stats',
      description: 'Show dependency graph statistics: total classes, average dependencies per class, circular count, layer breakdown',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
