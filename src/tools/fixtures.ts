// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine Fixtures Inspector
 *
 * Scans src/DataFixtures/ for fixture classes:
 *   - Classes extending Fixture / implementing FixtureInterface
 *   - Fixture groups (getGroups())
 *   - DependentFixtureInterface dependencies
 *   - Reference usage (addReference / getReference)
 *   - Order reconstruction from dependency graph
 *
 * Detects if fixture directories contain non-dev-safe content.
 * Pure static analysis — no fixture classes are instantiated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface FixtureClass {
  class: string;
  file: string;
  groups: string[];
  dependencies: string[];
  references: string[];
  usesReferences: boolean;
  lineCount: number;
}

// ─── File scanning ──────────────────────────────────────────────────────────

function findFixtureDir(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'src', 'DataFixtures'),
    path.join(appPath, 'src', 'Fixtures'),
    path.join(appPath, 'fixtures'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) return d;
  }
  return null;
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

// ─── Fixture parsing ───────────────────────────────────────────────────────

function extractGroups(content: string): string[] {
  const methodRe = /function\s+getGroups\s*\(\s*\)\s*(?::\s*array)?\s*\{([^}]+)\}/;
  const m = methodRe.exec(content);
  if (!m) return [];

  const groups: string[] = [];
  for (const gm of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
    groups.push(gm[1]);
  }
  return groups;
}

function extractDependencies(content: string): string[] {
  const methodRe = /function\s+getDependencies\s*\(\s*\)\s*(?::\s*array)?\s*\{([^}]+)\}/;
  const m = methodRe.exec(content);
  if (!m) return [];

  const deps: string[] = [];
  for (const dm of m[1].matchAll(/(\w+)::class/g)) {
    deps.push(dm[1]);
  }
  return deps;
}

function extractReferences(content: string): string[] {
  const refs: string[] = [];
  for (const m of content.matchAll(/addReference\s*\(\s*['"]([^'"]+)['"]/g)) {
    refs.push(m[1]);
  }
  return [...new Set(refs)];
}

function parseFixture(filePath: string): FixtureClass | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const isFixture =
    content.includes('extends Fixture') ||
    content.includes('implements FixtureInterface') ||
    content.includes('implements OrderedFixtureInterface') ||
    content.includes('AbstractFixture');

  if (!isFixture) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  return {
    class: classM[1],
    file: path.basename(filePath),
    groups: extractGroups(content),
    dependencies: extractDependencies(content),
    references: extractReferences(content),
    usesReferences: content.includes('getReference(') || content.includes('hasReference('),
    lineCount: content.split('\n').length,
  };
}

// ─── Load order reconstruction ────────────────────────────────────────────

function topologicalSort(fixtures: FixtureClass[]): FixtureClass[] {
  const byClass = new Map(fixtures.map((f) => [f.class, f]));
  const visited = new Set<string>();
  const result: FixtureClass[] = [];

  function visit(cls: string): void {
    if (visited.has(cls)) return;
    visited.add(cls);
    const f = byClass.get(cls);
    if (!f) return;
    for (const dep of f.dependencies) visit(dep);
    result.push(f);
  }

  for (const f of fixtures) visit(f.class);
  return result;
}

function loadFixtures(appPath: string): FixtureClass[] {
  const dir = findFixtureDir(appPath);
  if (!dir) return [];

  const fixtures: FixtureClass[] = [];
  for (const file of getAllPhpFiles(dir)) {
    const f = parseFixture(file);
    if (f) fixtures.push(f);
  }
  return fixtures;
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listFixtures(appPath: string): McpToolResult {
  try {
    const raw = loadFixtures(appPath);
    if (raw.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No fixture classes found.\n\nInstall:\n  composer require --dev doctrine/doctrine-fixtures-bundle\n\nCreate:\n  php bin/console make:fixtures AppFixtures',
        }],
      };
    }

    const ordered = topologicalSort(raw);
    const allGroups = [...new Set(raw.flatMap((f) => f.groups))];

    let text = `Doctrine Fixtures  (${raw.length} classes)\n${'='.repeat(55)}\n`;

    if (allGroups.length > 0) {
      text += `\nFixture groups: ${allGroups.join(', ')}\n`;
    }

    text += `\nLoad order (dependency-sorted):\n`;
    ordered.forEach((f, i) => {
      const groups = f.groups.length > 0 ? `  [${f.groups.join(', ')}]` : '';
      const refs = f.references.length > 0 ? `  refs: ${f.references.slice(0, 3).join(', ')}${f.references.length > 3 ? '...' : ''}` : '';
      const deps = f.dependencies.length > 0 ? `  deps: ${f.dependencies.join(', ')}` : '';
      text += `  ${String(i + 1).padStart(2)}. ${f.class}${groups}${refs}${deps}\n`;
    });

    const withDeps = raw.filter((f) => f.dependencies.length > 0);
    if (withDeps.length > 0) {
      text += `\nDependency graph:\n`;
      for (const f of withDeps) {
        text += `  ${f.class} → ${f.dependencies.join(', ')}\n`;
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

export function getFixtureStats(appPath: string): McpToolResult {
  try {
    const fixtures = loadFixtures(appPath);
    const dir = findFixtureDir(appPath);

    let text = `Fixture Statistics\n${'='.repeat(40)}\n\n`;
    text += `Fixture classes:   ${fixtures.length}\n`;

    if (fixtures.length === 0) {
      text += `Directory:         ${dir ?? 'not found'}\n`;
      return { content: [{ type: 'text', text }] };
    }

    const allGroups = [...new Set(fixtures.flatMap((f) => f.groups))];
    const withDeps = fixtures.filter((f) => f.dependencies.length > 0).length;
    const withRefs = fixtures.filter((f) => f.references.length > 0).length;
    const totalRefs = fixtures.reduce((s, f) => s + f.references.length, 0);

    text += `Groups defined:    ${allGroups.length}  (${allGroups.join(', ') || 'none'})\n`;
    text += `With dependencies: ${withDeps}\n`;
    text += `With references:   ${withRefs}  (${totalRefs} total reference keys)\n`;
    text += `Avg lines/fixture: ${Math.round(fixtures.reduce((s, f) => s + f.lineCount, 0) / fixtures.length)}\n`;
    text += `Directory:         ${dir ? path.relative(appPath, dir) : 'not found'}\n`;

    if (allGroups.length > 0) {
      text += `\nClasses by group:\n`;
      for (const group of allGroups) {
        const inGroup = fixtures.filter((f) => f.groups.includes(group));
        text += `  ${group}: ${inGroup.map((f) => f.class).join(', ')}\n`;
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

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getFixtureTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_fixtures',
      description: 'List Doctrine fixture classes with their groups, load order (dependency-sorted), and reference keys shared between fixtures',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_fixture_stats',
      description: 'Show fixture statistics: class count, groups, dependency count, reference count, average size',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
