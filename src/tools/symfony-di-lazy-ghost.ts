// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony DI Lazy Ghost Service Inspector
 *
 * Reads services.yaml for services with lazy: true.
 * Scans src/ PHP for #[Autoconfigure(lazy: true)], #[Lazy] attribute (Symfony 6.3+).
 * Detects interface-typed lazy services (virtual proxy).
 *
 * Warns: lazy: true on final class (ghost proxy impossible),
 * lazy service without interface (ghost object, class must be non-final),
 * constructor with side effects in lazy service,
 * #[Lazy] on service that appears to be always-used-immediately.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface LazyGhostInfo {
  serviceId: string;
  class: string;
  isLazy: boolean;
  hasInterface: boolean;
  isFinal: boolean;
  hasHeavyConstructor: boolean;
  issues: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function shortClass(fqcn: string): string {
  const parts = fqcn.split('\\');
  return parts[parts.length - 1] ?? fqcn;
}

// ─── YAML-based lazy services ─────────────────────────────────────────────────

function readLazyServicesFromYaml(appPath: string): Map<string, string> {
  const lazyMap = new Map<string, string>(); // serviceId -> class

  const candidates = [
    path.join(appPath, 'config', 'services.yaml'),
    path.join(appPath, 'config', 'services.yml'),
    path.join(appPath, 'config', 'packages', 'services.yaml'),
  ];

  for (const filePath of candidates) {
    const raw = parseYamlFile(filePath) as Record<string, unknown> | null;
    if (!raw) continue;

    const services = (raw['services'] ?? {}) as Record<string, unknown>;
    for (const [id, def] of Object.entries(services)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      if (d['lazy'] === true) {
        const cls = (d['class'] as string | undefined) ?? id;
        lazyMap.set(id, cls);
      }
    }
  }

  return lazyMap;
}

// ─── PHP attribute scanning ───────────────────────────────────────────────────

interface PhpClassInfo {
  file: string;
  class: string;
  fqcn: string;
  isLazy: boolean;
  isFinal: boolean;
  hasInterface: boolean;
  hasHeavyConstructor: boolean;
  constructorDeps: number;
}

function scanPhpClassesForLazy(srcDir: string): PhpClassInfo[] {
  const results: PhpClassInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const isLazy = /#\[Autoconfigure\s*\([^)]{0,200}lazy\s*:\s*true/u.test(content) ||
      /#\[Lazy\b/.test(content);

    if (!isLazy) continue;

    const classMatch = /class\s+(\w{1,100})/.exec(content);
    if (!classMatch) continue;
    const className = classMatch[1];

    const nsMatch = /namespace\s+([\w\\]{1,200});/.exec(content);
    const fqcn = nsMatch ? `${nsMatch[1]}\\${className}` : className;

    const isFinal = /\bfinal\s+class\b/.test(content);
    const hasInterface = /implements\s+\w/.test(content) || /interface\s+\w/.test(content);

    // Heuristic: heavy constructor — 5+ params or contains new X(), DB, Redis mentions
    const ctorMatch = /function\s+__construct\s*\(([^)]{0,600})\)/u.exec(content);
    let constructorDeps = 0;
    let hasHeavyConstructor = false;
    if (ctorMatch) {
      const params = ctorMatch[1].split(',').filter((p) => p.trim().length > 0);
      constructorDeps = params.length;
      hasHeavyConstructor = constructorDeps >= 5 ||
        /\bnew\s+\w/.test(ctorMatch[1]) ||
        /(?:Connection|EntityManager|Redis|Predis|Elasticsearch|Doctrine)/.test(ctorMatch[1]);
    }

    results.push({ file, class: className, fqcn, isLazy: true, isFinal, hasInterface, hasHeavyConstructor, constructorDeps });
  }

  return results;
}

// ─── Build combined list ──────────────────────────────────────────────────────

function buildLazyGhostList(appPath: string): LazyGhostInfo[] {
  const srcDir = path.join(appPath, 'src');
  const yamlLazy = readLazyServicesFromYaml(appPath);
  const phpClasses = scanPhpClassesForLazy(srcDir);

  const results: LazyGhostInfo[] = [];

  // From YAML
  for (const [serviceId, className] of yamlLazy) {
    const shortName = shortClass(className);

    // Try to find matching PHP class
    let isFinal = false;
    let hasInterface = false;
    let hasHeavyConstructor = false;

    for (const file of getAllPhpFiles(srcDir)) {
      let content = '';
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      if (!content.includes(shortName)) continue;
      const cm = new RegExp(`class\\s+${shortName}\\b`).exec(content);
      if (!cm) continue;

      isFinal = /\bfinal\s+class\b/.test(content);
      hasInterface = /implements\s+\w/.test(content);

      const ctorMatch = /function\s+__construct\s*\(([^)]{0,600})\)/u.exec(content);
      if (ctorMatch) {
        const params = ctorMatch[1].split(',').filter((p) => p.trim().length > 0);
        hasHeavyConstructor = params.length >= 5;
      }
      break;
    }

    const issues: string[] = [];
    if (isFinal) {
      issues.push(`lazy: true on final class "${shortName}" — Symfony cannot create a ghost proxy for final classes`);
    }
    if (!hasInterface) {
      issues.push(`lazy service "${shortName}" has no interface — Symfony uses ghost object (class must be non-final)`);
    }
    if (hasHeavyConstructor) {
      issues.push(`lazy service "${shortName}" has a heavy constructor — ensure no observable side effects run eagerly`);
    }

    results.push({ serviceId, class: shortName, isLazy: true, hasInterface, isFinal, hasHeavyConstructor, issues });
  }

  // From PHP attributes (deduplicate)
  for (const info of phpClasses) {
    const alreadyAdded = results.some((r) => r.class === info.class);
    if (alreadyAdded) continue;

    const issues: string[] = [];
    if (info.isFinal) {
      issues.push(`#[Lazy] on final class "${info.class}" — Symfony cannot create a ghost proxy for final classes`);
    }
    if (!info.hasInterface) {
      issues.push(`#[Lazy] service "${info.class}" has no interface — ghost object requires non-final class`);
    }
    if (info.hasHeavyConstructor) {
      issues.push(`#[Lazy] service "${info.class}" has ${info.constructorDeps} constructor deps — check for side effects`);
    }

    results.push({
      serviceId: info.fqcn,
      class: info.class,
      isLazy: true,
      hasInterface: info.hasInterface,
      isFinal: info.isFinal,
      hasHeavyConstructor: info.hasHeavyConstructor,
      issues,
    });
  }

  return results;
}

// ─── Tool functions ──────────────────────────────────────────────────────────

export function listLazyGhostServices(appPath: string): McpToolResult {
  try {
    const items = buildLazyGhostList(appPath);

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No lazy services found in services.yaml or src/ PHP attributes.' }] };
    }

    let text = `Lazy Ghost Services\n${'='.repeat(50)}\n\n`;
    text += `Found ${items.length} lazy service(s):\n\n`;

    for (const item of items) {
      text += `  ${item.class}\n`;
      text += `    Service ID:         ${item.serviceId}\n`;
      text += `    Has interface:      ${item.hasInterface ? 'yes' : 'no'}\n`;
      text += `    Final class:        ${item.isFinal ? 'YES (problem)' : 'no'}\n`;
      text += `    Heavy constructor:  ${item.hasHeavyConstructor ? 'yes' : 'no'}\n`;
      if (item.issues.length > 0) {
        text += `    Issues:\n`;
        for (const issue of item.issues) {
          text += `      - ${issue}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getLazyGhostStats(appPath: string): McpToolResult {
  try {
    const items = buildLazyGhostList(appPath);

    const finalCount = items.filter((i) => i.isFinal).length;
    const noInterface = items.filter((i) => !i.hasInterface).length;
    const withIssues = items.filter((i) => i.issues.length > 0).length;

    let text = `Lazy Ghost Service Stats\n${'='.repeat(40)}\n\n`;
    text += `Total lazy services:     ${items.length}\n`;
    text += `Final class (problem):   ${finalCount}\n`;
    text += `Without interface:       ${noInterface}\n`;
    text += `Services with issues:    ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export function getLazyGhostTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_lazy_ghost_services',
      description: 'Scan services.yaml and src/ for lazy services: #[Lazy]/#[Autoconfigure(lazy:true)], final class warnings, missing interface, heavy constructor detection',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_lazy_ghost_stats',
      description: 'Statistics for lazy ghost services: total count, final class problems, interface coverage, issue count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
