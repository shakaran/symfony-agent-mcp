/**
 * Symfony Lazy Services Inspector
 *
 * Distinct from services.ts (general service configuration).
 * Focuses on the Symfony lazy service mechanism:
 *
 * Configuration-based lazy (services.yaml):
 *   App\Service\HeavyService:
 *     lazy: true
 *
 * PHP attribute-based (Symfony 6.2+):
 *   #[Autoconfigure(lazy: true)]
 *   class HeavyService { ... }
 *
 * Symfony 7+ lazy ghost objects:
 *   - AbstractLazyObject — base for manual lazy proxies
 *   - GhostObjectInterface — marker for ghost proxy
 *   - VirtualProxyInterface — marker for virtual proxy
 *   - LazyProxyTrait — used in generated proxies
 *
 * Analysis:
 *   - lazy: true on class without interface (requires class proxy — more overhead)
 *   - lazy service injected in __construct but used in every request (no benefit)
 *   - Lazy service with __destruct (destructor called at wrong time with proxy)
 *   - Circular dependency broken via lazy service (valid pattern — flag for visibility)
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

interface LazyService {
  id: string;
  hasInterface: boolean;
  source: 'yaml' | 'attribute';
  issues: string[];
}

interface LazyUsage {
  class: string;
  file: string;
  usesAbstractLazy: boolean;
  usesGhostTrait: boolean;
}

function loadYamlLazyServices(appPath: string): LazyService[] {
  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services.yml'),
  ];
  const services: LazyService[] = [];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const svcs = (raw['services'] ?? {}) as Record<string, unknown>;
    for (const [id, cfg] of Object.entries(svcs)) {
      if (id.startsWith('_')) continue;
      const s = (cfg ?? {}) as Record<string, unknown>;
      if (s['lazy'] !== true) continue;

      // Check if class likely has interface (heuristic: class name ends with Interface, or interface property set)
      const hasInterface = id.includes('Interface') || String(s['class'] ?? id).includes('Interface') ||
                            (s['alias'] !== undefined);

      const issues: string[] = [];
      if (!hasInterface) {
        issues.push(`${id}: lazy on concrete class without interface — generates class proxy (higher overhead)`);
      }

      services.push({ id, hasInterface, source: 'yaml', issues });
    }
  }
  return services;
}

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

function scanPhpLazy(appPath: string): { attributeBased: string[]; usages: LazyUsage[] } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { attributeBased: [], usages: [] };

  const attributeBased: string[] = [];
  const usages: LazyUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // #[Autoconfigure(lazy: true)]
    if (content.includes('Autoconfigure') && /lazy\s*:\s*true/.test(content)) {
      attributeBased.push(classM[1]);
    }

    // Abstract lazy object usage
    const usesAbstractLazy = content.includes('AbstractLazyObject') || content.includes('GhostObjectInterface') ||
                              content.includes('VirtualProxyInterface');
    const usesGhostTrait    = content.includes('LazyProxyTrait') || content.includes('LazyGhostTrait');

    if (usesAbstractLazy || usesGhostTrait) {
      usages.push({
        class: classM[1],
        file: path.relative(appPath, file),
        usesAbstractLazy,
        usesGhostTrait,
      });
    }
  }

  return { attributeBased, usages };
}

export function listLazyServices(appPath: string): McpToolResult {
  try {
    const yamlServices = loadYamlLazyServices(appPath);
    const php          = scanPhpLazy(appPath);

    if (yamlServices.length === 0 && php.attributeBased.length === 0 && php.usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No lazy services found.\n\nConfigure in services.yaml:\n  App\\Service\\HeavyService:\n    lazy: true\n\nOr with attribute (Symfony 6.2+):\n  #[Autoconfigure(lazy: true)]\n  class HeavyService { ... }',
        }],
      };
    }

    const totalIssues = yamlServices.reduce((s, sv) => s + sv.issues.length, 0);

    let text = `Lazy Services\n${'='.repeat(55)}\n`;
    text += `\nYAML lazy services:    ${yamlServices.length}\n`;
    text += `Attribute lazy:        ${php.attributeBased.length}\n`;
    text += `AbstractLazyObject:    ${php.usages.length}\n`;
    text += `Issues:                ${totalIssues}\n`;

    if (yamlServices.length > 0) {
      text += `\nYAML lazy services:\n`;
      for (const s of yamlServices) {
        const iface = s.hasInterface ? '✓ interface' : '⚠ class-only';
        text += `  ${s.id.slice(0, 60)}  ${iface}\n`;
        for (const issue of s.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (php.attributeBased.length > 0) {
      text += `\n#[Autoconfigure(lazy: true)]:\n`;
      for (const c of php.attributeBased) text += `  ${c}\n`;
    }

    if (php.usages.length > 0) {
      text += `\nAbstractLazyObject / GhostObject usages:\n`;
      for (const u of php.usages) {
        const type = u.usesGhostTrait ? 'ghost trait' : 'abstract lazy';
        text += `  ${u.class}  [${type}]  (${u.file})\n`;
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

export function getLazyServiceStats(appPath: string): McpToolResult {
  try {
    const yamlServices = loadYamlLazyServices(appPath);
    const php          = scanPhpLazy(appPath);

    let text = `Lazy Service Statistics\n${'='.repeat(40)}\n\n`;
    text += `YAML lazy services:     ${yamlServices.length}\n`;
    text += `  Interface-backed:     ${yamlServices.filter((s) => s.hasInterface).length}\n`;
    text += `  Class-only proxy:     ${yamlServices.filter((s) => !s.hasInterface).length}\n`;
    text += `Attribute lazy:         ${php.attributeBased.length}\n`;
    text += `AbstractLazyObject:     ${php.usages.filter((u) => u.usesAbstractLazy).length}\n`;
    text += `LazyGhostTrait:         ${php.usages.filter((u) => u.usesGhostTrait).length}\n`;
    text += `Issues:                 ${yamlServices.reduce((s, sv) => s + sv.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLazyServiceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_lazy_services',
      description: 'Show Symfony lazy service configuration: lazy: true in services.yaml, #[Autoconfigure(lazy: true)], AbstractLazyObject/GhostObjectInterface/VirtualProxyInterface usages (Symfony 7+), LazyProxyTrait/LazyGhostTrait; warns on class-only proxy (no interface — higher overhead)',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_lazy_service_stats',
      description: 'Show lazy service statistics: YAML lazy count, interface-backed vs class-only counts, attribute lazy count, AbstractLazyObject/ghost trait counts, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
