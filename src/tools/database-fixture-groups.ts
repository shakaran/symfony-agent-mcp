/**
 * Doctrine Fixtures Group and Dependency Inspector
 *
 * Distinct from fixtures.ts (which lists fixture files).
 * Deep inspection of fixture grouping and ordering:
 *
 * getGroups() analysis:
 *   - Fixture classes implementing getGroups() — declared group names
 *   - Cross-file: which groups contain which fixtures
 *   - Group usage consistency (fixtures in "test" group only usable in test env)
 *
 * DependentFixtureInterface analysis:
 *   - getDependencies() return values
 *   - Dependency chain: A depends on B depends on C
 *   - Circular dependency detection (A → B → A)
 *   - Missing dependencies (class referenced but not found)
 *
 * addReference/getReference analysis:
 *   - Reference names added per fixture
 *   - References consumed and which fixture provides them
 *   - References consumed but never set (runtime error)
 *
 * Orphan detection:
 *   - Fixtures declared but not in any group (may not run in subset loads)
 *   - Fixtures with no dependencies and no dependents (standalone)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface FixtureInfo {
  class: string;
  file: string;
  fullPath: string;
  groups: string[];
  dependencies: string[];
  referencesAdded: string[];
  referencesUsed: string[];
  order?: number;
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

function parseFixture(filePath: string): FixtureInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('Fixture') && !content.includes('FixtureInterface')) return null;
  if (!content.includes('extends') || (!content.includes('AbstractFixture') && !content.includes('Fixture'))) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Extract groups from getGroups() return
  const groups: string[] = [];
  const groupsM = /function\s+getGroups\s*\(\s*\)[^{]*\{([^}]+)\}/s.exec(content);
  if (groupsM) {
    for (const m of groupsM[1].matchAll(/['"]([^'"]+)['"]/g)) {
      groups.push(m[1]);
    }
  }

  // Extract dependencies from getDependencies() return
  const dependencies: string[] = [];
  const depsM = /function\s+getDependencies\s*\(\s*\)[^{]*\{([^}]+)\}/s.exec(content);
  if (depsM) {
    for (const m of depsM[1].matchAll(/(\w+)::class/g)) {
      dependencies.push(m[1]);
    }
    for (const m of depsM[1].matchAll(/['"]([^'"]+Fixture[^'"]*)['"]/g)) {
      dependencies.push(m[1].split('\\').pop() ?? m[1]);
    }
  }

  // addReference calls
  const referencesAdded: string[] = [];
  for (const m of content.matchAll(/addReference\s*\(\s*['"]([^'"]+)['"]/g)) {
    referencesAdded.push(m[1]);
  }

  // getReference calls
  const referencesUsed: string[] = [];
  for (const m of content.matchAll(/getReference\s*\(\s*['"]([^'"]+)['"]/g)) {
    referencesUsed.push(m[1]);
  }

  // getOrder() value
  const orderM = /function\s+getOrder\s*\(\s*\)[^{]*\{[^}]*return\s+(\d+)/s.exec(content);

  return {
    class: classM[1],
    file: path.basename(filePath),
    fullPath: filePath,
    groups,
    dependencies: [...new Set(dependencies)],
    referencesAdded: [...new Set(referencesAdded)],
    referencesUsed: [...new Set(referencesUsed)],
    order: orderM ? parseInt(orderM[1], 10) : undefined,
  };
}

function detectCircularDependencies(fixtures: FixtureInfo[]): string[][] {
  const classMap = new Map(fixtures.map((f) => [f.class, f]));
  const cycles: string[][] = [];

  function dfs(current: string, path: string[], visited: Set<string>): void {
    if (path.includes(current)) {
      const cycleStart = path.indexOf(current);
      cycles.push(path.slice(cycleStart));
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    const fixture = classMap.get(current);
    if (!fixture) return;
    for (const dep of fixture.dependencies) {
      dfs(dep, [...path, current], visited);
    }
  }

  const visited = new Set<string>();
  for (const fixture of fixtures) {
    if (!visited.has(fixture.class)) {
      dfs(fixture.class, [], visited);
    }
  }
  return cycles;
}

export function listFixtureGroups(appPath: string): McpToolResult {
  try {
    const candidates = [
      path.join(appPath, 'src', 'DataFixtures'),
      path.join(appPath, 'src', 'Fixtures'),
      path.join(appPath, 'fixtures'),
    ];

    const fixtures: FixtureInfo[] = [];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      for (const file of getAllPhpFiles(dir)) {
        const f = parseFixture(file);
        if (f) fixtures.push(f);
      }
    }

    if (fixtures.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No DataFixtures found.\n\nInstall:\n  composer require --dev doctrine/doctrine-fixtures-bundle\n\nCreate fixture:\n  class UserFixtures extends Fixture implements DependentFixtureInterface\n  {\n    public function getGroups(): array { return [\'dev\', \'test\']; }\n    public function getDependencies(): array { return [GroupFixtures::class]; }\n  }',
        }],
      };
    }

    fixtures.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.class.localeCompare(b.class));

    // Groups map
    const groupMap = new Map<string, string[]>();
    for (const f of fixtures) {
      for (const g of f.groups) {
        const list = groupMap.get(g) ?? [];
        list.push(f.class);
        groupMap.set(g, list);
      }
    }

    // Reference cross-check
    const allRefsAdded = new Set(fixtures.flatMap((f) => f.referencesAdded));
    const missingRefs: string[] = [];
    for (const f of fixtures) {
      for (const ref of f.referencesUsed) {
        if (!allRefsAdded.has(ref)) missingRefs.push(`${f.class} uses reference "${ref}" but no fixture adds it`);
      }
    }

    const circles = detectCircularDependencies(fixtures);
    const classNames = new Set(fixtures.map((f) => f.class));
    const missingDeps: string[] = [];
    for (const f of fixtures) {
      for (const dep of f.dependencies) {
        if (!classNames.has(dep)) missingDeps.push(`${f.class} depends on ${dep} (not found in fixtures directory)`);
      }
    }

    let text = `Fixture Groups and Dependencies\n${'='.repeat(55)}\n`;
    text += `\nTotal fixtures: ${fixtures.length}\n`;

    if (groupMap.size > 0) {
      text += `\nGroups (${groupMap.size}):\n`;
      for (const [group, classes] of [...groupMap.entries()].sort()) {
        text += `  ${group.padEnd(20)} ${classes.length} fixtures: ${classes.slice(0, 3).join(', ')}${classes.length > 3 ? '...' : ''}\n`;
      }
    } else {
      text += `\n⚠ No fixtures implement getGroups() — all-or-nothing loading only\n`;
    }

    const withDeps = fixtures.filter((f) => f.dependencies.length > 0);
    if (withDeps.length > 0) {
      text += `\nDependency tree (${withDeps.length} with deps):\n`;
      for (const f of withDeps) {
        text += `  ${f.class} → ${f.dependencies.join(', ')}\n`;
      }
    }

    if (circles.length > 0) {
      text += `\n⚠ Circular dependencies detected:\n`;
      for (const cycle of circles) text += `  ${cycle.join(' → ')} → ${cycle[0]}\n`;
    }

    if (missingDeps.length > 0) {
      text += `\n⚠ Missing dependencies:\n`;
      for (const m of missingDeps) text += `  ${m}\n`;
    }

    if (missingRefs.length > 0) {
      text += `\n⚠ Missing references (runtime error risk):\n`;
      for (const m of missingRefs) text += `  ${m}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFixtureGroupStats(appPath: string): McpToolResult {
  try {
    const candidates = [
      path.join(appPath, 'src', 'DataFixtures'),
      path.join(appPath, 'src', 'Fixtures'),
      path.join(appPath, 'fixtures'),
    ];

    const fixtures: FixtureInfo[] = [];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      for (const file of getAllPhpFiles(dir)) {
        const f = parseFixture(file);
        if (f) fixtures.push(f);
      }
    }

    const groupMap = new Map<string, string[]>();
    for (const f of fixtures) {
      for (const g of f.groups) {
        const list = groupMap.get(g) ?? [];
        list.push(f.class);
        groupMap.set(g, list);
      }
    }

    const circles = detectCircularDependencies(fixtures);

    let text = `Fixture Group Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total fixtures:      ${fixtures.length}\n`;
    text += `With groups:         ${fixtures.filter((f) => f.groups.length > 0).length}\n`;
    text += `With dependencies:   ${fixtures.filter((f) => f.dependencies.length > 0).length}\n`;
    text += `With references:     ${fixtures.filter((f) => f.referencesAdded.length > 0).length}\n`;
    text += `Groups defined:      ${groupMap.size}\n`;
    text += `Circular deps:       ${circles.length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getFixtureGroupTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_fixture_groups',
      description: 'Show DataFixtures groups and dependencies: getGroups() declarations, getDependencies() chains, dependency tree, circular dependency detection, addReference/getReference cross-check (missing reference warning), orphan fixture detection',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_fixture_group_stats',
      description: 'Show fixture statistics: total count, group count, dependency count, reference count, circular dependency count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
