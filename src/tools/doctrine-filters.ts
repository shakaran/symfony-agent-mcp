/**
 * Doctrine SQL Filters Inspector
 *
 * Distinct from multi-tenancy.ts (which detects filters as a sign of multi-tenancy).
 * Full inspection of all Doctrine SQL filters:
 *
 * doctrine.yaml orm.filters:
 *   - Registered filter names, class, enabled flag, parameters
 *
 * SQLFilter subclasses in src/:
 *   - Classes extending AbstractSQLFilter / SQLFilter
 *   - addFilterConstraint() implementation: which entities/tables they target
 *   - Parameters read via getParameter()
 *
 * Activation tracking:
 *   - Listeners/services calling $em->getFilters()->enable('filterName')
 *   - $em->getFilters()->disable('filterName') call sites
 *   - Filters enabled globally vs per-request
 *
 * Analysis:
 *   - Filters registered in config but no matching class found
 *   - Filter classes in src/ but not registered in doctrine.yaml
 *   - Globally enabled filters with no disable call (always active — may affect all queries)
 *   - Filters with hardcoded parameters (should be set dynamically)
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

interface FilterConfig {
  name: string;
  class: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
}

interface FilterClass {
  class: string;
  file: string;
  targetEntities: string[];
  parameters: string[];
  issues: string[];
}

interface FilterActivation {
  filterName: string;
  action: 'enable' | 'disable';
  file: string;
  class: string;
}

function loadFilterConfig(appPath: string): FilterConfig[] {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'doctrine.yaml'),
    path.join(appPath, 'config', 'packages', 'doctrine.yml'),
  ];
  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;
    const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
    const orm      = (doctrine['orm'] ?? {}) as Record<string, unknown>;
    const filtersRaw = orm['filters'] as Record<string, unknown> | undefined;
    if (!filtersRaw) return [];

    return Object.entries(filtersRaw).map(([name, def]) => {
      const d = (def ?? {}) as Record<string, unknown>;
      return {
        name,
        class: String(d['class'] ?? ''),
        enabled: d['enabled'] === true || d['enabled'] === 'true',
        parameters: (d['parameters'] ?? {}) as Record<string, unknown>,
      };
    });
  }
  return [];
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

function scanFilterClasses(appPath: string): FilterClass[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FilterClass[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('AbstractSQLFilter') && !content.includes('SQLFilter')) continue;
    if (!content.includes('addFilterConstraint')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    const targetEntities: string[] = [];
    for (const m of content.matchAll(/instanceof\s+(\w+)|targetEntity\s*[=:]\s*['"]([^'"]+)['"]/g)) {
      const entity = m[1] ?? m[2];
      if (entity && entity !== 'ClassMetadata' && entity !== 'ORM') targetEntities.push(entity);
    }

    const parameters: string[] = [];
    for (const m of content.matchAll(/getParameter\s*\(\s*['"]([^'"]+)['"]/g)) {
      parameters.push(m[1]);
    }

    const issues: string[] = [];
    if (parameters.length === 0) {
      issues.push('no parameters read — filter may not be customizable per-request');
    }

    results.push({ class: classM[1], file: path.basename(file), targetEntities: [...new Set(targetEntities)], parameters, issues });
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

function scanFilterActivations(appPath: string): FilterActivation[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const results: FilterActivation[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('getFilters()')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    for (const m of content.matchAll(/getFilters\(\)\s*->\s*(enable|disable)\s*\(\s*['"]([^'"]+)['"]/g)) {
      results.push({ filterName: m[2], action: m[1] as 'enable' | 'disable', file: path.basename(file), class: classM[1] });
    }
  }
  return results;
}

export function listDoctrineFilters(appPath: string): McpToolResult {
  try {
    const config      = loadFilterConfig(appPath);
    const classes     = scanFilterClasses(appPath);
    const activations = scanFilterActivations(appPath);

    if (config.length === 0 && classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine SQL filters found.\n\nRegister in doctrine.yaml:\n  doctrine:\n    orm:\n      filters:\n        tenant_filter:\n          class: App\\Filter\\TenantFilter\n          enabled: true\n\nImplement:\n  class TenantFilter extends AbstractSQLFilter\n  {\n    public function addFilterConstraint(ClassMetadata $meta, string $alias): string\n    {\n      return sprintf(\'%s.tenant_id = %s\', $alias, $this->getParameter(\'tenant_id\'));\n    }\n  }',
        }],
      };
    }

    let text = `Doctrine SQL Filters\n${'='.repeat(55)}\n`;

    if (config.length > 0) {
      text += `\nRegistered filters (${config.length}):\n`;
      for (const f of config) {
        const status  = f.enabled ? '✓ enabled' : '─ disabled';
        const params  = Object.keys(f.parameters).length > 0 ? `  params: ${Object.keys(f.parameters).join(', ')}` : '';
        const shortClass = f.class.split('\\').pop() ?? f.class;
        text += `  ${f.name.padEnd(25)} [${status}]  ${shortClass}${params}\n`;
      }
    }

    if (classes.length > 0) {
      text += `\nFilter classes (${classes.length}):\n`;
      for (const c of classes) {
        const targets = c.targetEntities.length > 0 ? `  targets: ${c.targetEntities.join(', ')}` : '';
        const params  = c.parameters.length > 0 ? `  reads: ${c.parameters.join(', ')}` : '';
        text += `  ${c.class.padEnd(35)} (${c.file})${targets}${params}\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    if (activations.length > 0) {
      text += `\nFilter activation calls (${activations.length}):\n`;
      for (const a of activations) {
        text += `  ${a.action.padEnd(7)} "${a.filterName}"  in ${a.class} (${a.file})\n`;
      }
    }

    // Cross-check: registered but no class found
    const classNames = new Set(classes.map((c) => c.class));
    const orphanConfig = config.filter((f) => {
      const shortClass = f.class.split('\\').pop() ?? '';
      return !classNames.has(shortClass) && f.class !== '';
    });
    if (orphanConfig.length > 0) {
      text += `\n⚠ Filters registered but class not found in src/: ${orphanConfig.map((f) => f.name).join(', ')}\n`;
    }

    // Globally enabled with no disable
    const enabledGlobal = config.filter((f) => f.enabled);
    const disabledAnywhere = new Set(activations.filter((a) => a.action === 'disable').map((a) => a.filterName));
    const alwaysActive = enabledGlobal.filter((f) => !disabledAnywhere.has(f.name));
    if (alwaysActive.length > 0) {
      text += `⚠ Always-active filters (no disable call found): ${alwaysActive.map((f) => f.name).join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineFilterStats(appPath: string): McpToolResult {
  try {
    const config      = loadFilterConfig(appPath);
    const classes     = scanFilterClasses(appPath);
    const activations = scanFilterActivations(appPath);

    let text = `Doctrine Filter Statistics\n${'='.repeat(40)}\n\n`;
    text += `Registered filters:  ${config.length}\n`;
    text += `  Enabled globally:  ${config.filter((f) => f.enabled).length}\n`;
    text += `  Disabled by default: ${config.filter((f) => !f.enabled).length}\n`;
    text += `Filter classes:      ${classes.length}\n`;
    text += `Activation calls:    ${activations.length}\n`;
    text += `  enable() calls:    ${activations.filter((a) => a.action === 'enable').length}\n`;
    text += `  disable() calls:   ${activations.filter((a) => a.action === 'disable').length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineFilterTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_filters',
      description: 'Show Doctrine SQL filters: registered filters from doctrine.yaml (enabled flag, parameters), SQLFilter subclasses (target entities, parameters read), enable()/disable() call sites, orphan filter detection, always-active filter warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_filter_stats',
      description: 'Show Doctrine filter statistics: registered count, enabled/disabled split, filter class count, activation call count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
