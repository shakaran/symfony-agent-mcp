/**
 * Symfony Service Decorator Inspector
 *
 * Scans config/services.yaml (and config/services_*.yaml) for DI decoration:
 *   - Services with `decorates:` key
 *   - Decoration chain reconstruction (A decorates B decorates C)
 *   - Inner service aliases (.inner)
 *   - Decoration priority
 *   - PHP #[AsDecorator] attribute in src/
 *
 * Also detects classes implementing known interfaces that suggest decoration:
 *   (e.g. implementing the same interface as the service they inject)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ServiceDecorator {
  decoratorId: string;
  decoratesId: string;
  innerAlias?: string;
  priority?: number;
  source: 'yaml' | 'attribute';
  file?: string;
}

interface DecorationChain {
  root: string;
  chain: string[];
}

// ─── YAML scanning ──────────────────────────────────────────────────────────

function extractDecoratorsFromYaml(
  filePath: string,
  sourceLabel: string
): ServiceDecorator[] {
  const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
  if (!raw) return [];

  const services = (raw['services'] ?? {}) as Record<string, unknown>;
  const decorators: ServiceDecorator[] = [];

  for (const [id, def] of Object.entries(services)) {
    if (!def || typeof def !== 'object') continue;
    const svc = def as Record<string, unknown>;

    if (!svc['decorates']) continue;

    decorators.push({
      decoratorId: id,
      decoratesId: String(svc['decorates']),
      innerAlias: svc['decoration_inner_name'] ? String(svc['decoration_inner_name']) : undefined,
      priority: svc['decoration_priority'] ? Number(svc['decoration_priority']) : undefined,
      source: 'yaml',
      file: sourceLabel,
    });
  }

  return decorators;
}

function loadYamlDecorators(appPath: string): ServiceDecorator[] {
  const decorators: ServiceDecorator[] = [];
  const configDir = path.join(appPath, 'config');

  const filesToScan: string[] = [];

  try {
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        filesToScan.push(path.join(configDir, entry.name));
      }
    }
  } catch { /* skip */ }

  try {
    const pkgDir = path.join(configDir, 'packages');
    for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        filesToScan.push(path.join(pkgDir, entry.name));
      }
    }
  } catch { /* skip */ }

  for (const file of filesToScan) {
    decorators.push(...extractDecoratorsFromYaml(file, path.relative(appPath, file)));
  }

  return decorators;
}

// ─── PHP attribute scanning ────────────────────────────────────────────────

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

function loadAttributeDecorators(appPath: string): ServiceDecorator[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const decorators: ServiceDecorator[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('AsDecorator')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // #[AsDecorator(decorates: SomeInterface::class, priority: 10)]
    for (const m of content.matchAll(/#\[AsDecorator\s*\(([^)]+)\)/g)) {
      const args = m[1];
      const decoratesM = /decorates\s*:\s*([\w\\]+)(?:::class)?/.exec(args);
      const priorityM = /priority\s*:\s*(-?\d+)/.exec(args);
      const innerM = /inner_id\s*:\s*['"]([^'"]+)['"]/.exec(args);

      if (decoratesM) {
        decorators.push({
          decoratorId: classM[1],
          decoratesId: decoratesM[1].split('\\').pop() ?? decoratesM[1],
          innerAlias: innerM?.[1],
          priority: priorityM ? parseInt(priorityM[1], 10) : undefined,
          source: 'attribute',
          file: path.basename(file),
        });
      }
    }
  }

  return decorators;
}

// ─── Chain reconstruction ──────────────────────────────────────────────────

function buildChains(decorators: ServiceDecorator[]): DecorationChain[] {
  const decoratesMap = new Map<string, string[]>();

  for (const d of decorators) {
    const list = decoratesMap.get(d.decoratesId) ?? [];
    list.push(d.decoratorId);
    decoratesMap.set(d.decoratesId, list);
  }

  const allDecorators = new Set(decorators.map((d) => d.decoratorId));
  const roots = decorators
    .map((d) => d.decoratesId)
    .filter((id) => !allDecorators.has(id));

  const chains: DecorationChain[] = [];
  const visited = new Set<string>();

  for (const root of [...new Set(roots)]) {
    if (visited.has(root)) continue;
    const chain: string[] = [root];

    let current = root;
    while (decoratesMap.has(current)) {
      const next = decoratesMap.get(current)![0];
      if (chain.includes(next)) break;
      chain.push(next);
      visited.add(next);
      current = next;
    }

    visited.add(root);
    chains.push({ root, chain });
  }

  return chains;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listServiceDecorators(appPath: string): McpToolResult {
  try {
    const yamlDecorators = loadYamlDecorators(appPath);
    const attrDecorators = loadAttributeDecorators(appPath);
    const all = [...yamlDecorators, ...attrDecorators];

    if (all.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No service decorators found.\n\nDeclare in services.yaml:\n  App\\Service\\CachingUserRepo:\n    decorates: App\\Repository\\UserRepository\n\nOr with PHP attribute:\n  #[AsDecorator(decorates: UserRepositoryInterface::class)]\n  class CachingUserRepository implements UserRepositoryInterface { ... }',
        }],
      };
    }

    const chains = buildChains(all);

    let text = `Service Decorators (${all.length})\n${'='.repeat(55)}\n`;

    if (chains.length > 0) {
      text += `\nDecoration chains:\n`;
      for (const { chain } of chains) {
        text += `  ${chain.join(' → ')}\n`;
      }
    }

    text += `\nAll decorators:\n`;
    for (const d of all.sort((a, b) => a.decoratorId.localeCompare(b.decoratorId))) {
      const shortDecorator = d.decoratorId.split('\\').pop() ?? d.decoratorId;
      const shortDecorates = d.decoratesId.split('\\').pop() ?? d.decoratesId;
      const priority = d.priority !== undefined ? `  [priority: ${d.priority}]` : '';
      const src = d.source === 'attribute' ? '  [#[AsDecorator]]' : `  [${d.file}]`;
      text += `  ${shortDecorator.padEnd(35)} decorates ${shortDecorates}${priority}${src}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDecoratorStats(appPath: string): McpToolResult {
  try {
    const yamlDecorators = loadYamlDecorators(appPath);
    const attrDecorators = loadAttributeDecorators(appPath);
    const all = [...yamlDecorators, ...attrDecorators];

    let text = `Service Decorator Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total decorators:    ${all.length}\n`;
    text += `Via YAML:            ${yamlDecorators.length}\n`;
    text += `Via #[AsDecorator]:  ${attrDecorators.length}\n`;
    text += `With priority:       ${all.filter((d) => d.priority !== undefined).length}\n`;
    text += `With inner alias:    ${all.filter((d) => d.innerAlias).length}\n`;

    const chains = buildChains(all);
    text += `Decoration chains:   ${chains.length}\n`;

    const longest = chains.reduce((max, c) => Math.max(max, c.chain.length), 0);
    if (longest > 2) {
      text += `Longest chain:       ${longest} services\n`;
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

export function getServiceDecoratorTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_service_decorators',
      description: 'List Symfony DI service decorators (decorates: in YAML or #[AsDecorator]) with full decoration chains and priority',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_decorator_stats',
      description: 'Show service decorator statistics: total count, YAML vs attribute, decoration chains, longest chain',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
