// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony Validator Auto-Mapping Inspector
 *
 * Scans config/packages/validator.yaml:
 *   - Detects auto_mapping: section — lists namespaces with auto_mapping enabled
 *   - Detects enable_annotations / enable_attributes: true
 *   - Detects not_compromised_password: enabled (requires network — HaveIBeenPwned)
 *   - Scans src/ PHP for classes in auto-mapped namespaces that also use explicit
 *     #[Assert\*] attributes — flags as "auto_mapping + explicit constraints"
 *   - If validator.yaml not found, does PHP-only scan for Assert\ usage
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ValidatorAutoMappingEntry {
  class: string;
  type: 'auto_mapped' | 'explicit_constraint' | 'mixed';
  namespace: string;
  issue: string | null;
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function loadValidatorYaml(appPath: string): string | null {
  const candidates = [
    path.join(appPath, 'config', 'packages', 'validator.yaml'),
    path.join(appPath, 'config', 'packages', 'dev', 'validator.yaml'),
    path.join(appPath, 'config', 'packages', 'prod', 'validator.yaml'),
  ];
  for (const c of candidates) {
    const content = safeRead(c, appPath);
    if (content) return content;
  }
  return null;
}

function extractAutoMappedNamespaces(content: string): string[] {
  const namespaces: string[] = [];
  const blockRe = /auto_mapping:\s*\n([\s\S]*?)(?=^[ \t]{0,8}\S[^:\n]{0,100}:[ \t]*$|(?![\s\S]))/m;
  const blockM = blockRe.exec(content);
  if (!blockM) return namespaces;

  const block = blockM[1];
  // Each entry: "    App\Entity\: []" or "    App\: ~"
  const nsRe = /^[ \t]+([A-Z][\w\\]{1,120}[\\]?):/gm;
  let m: RegExpExecArray | null;
  while ((m = nsRe.exec(block)) !== null) {
    namespaces.push(m[1].trim());
  }
  return namespaces;
}

function hasAnnotationsEnabled(content: string): boolean {
  return /enable_annotations:\s*true/.test(content) ||
    /enable_attributes:\s*true/.test(content);
}

function hasNotCompromisedPassword(content: string): boolean {
  return /not_compromised_password:\s*\n?[\s\S]{0,60}enabled:\s*true/.test(content) ||
    /not_compromised_password:\s*true/.test(content);
}

function classMatchesNamespace(fqn: string, namespace: string): boolean {
  const ns = namespace.endsWith('\\') ? namespace : namespace + '\\';
  return fqn.startsWith(ns) || fqn === namespace.replace(/\\$/, '');
}

function countAssertAttributes(content: string): number {
  const assertRe = /#\[Assert\\[A-Z][A-Za-z]{0,60}/g;
  return (content.match(assertRe) ?? []).length;
}

function buildAutoMappingEntries(appPath: string): {
  entries: ValidatorAutoMappingEntry[];
  autoMappedNamespaces: string[];
  annotationsEnabled: boolean;
  notCompromisedEnabled: boolean;
  yamlFound: boolean;
} {
  const yamlContent = loadValidatorYaml(appPath);
  const autoMappedNamespaces = yamlContent ? extractAutoMappedNamespaces(yamlContent) : [];
  const annotationsEnabled = yamlContent ? hasAnnotationsEnabled(yamlContent) : false;
  const notCompromisedEnabled = yamlContent ? hasNotCompromisedPassword(yamlContent) : false;

  const srcDir = path.join(appPath, 'src');
  const entries: ValidatorAutoMappingEntry[] = [];

  if (!fs.existsSync(srcDir)) {
    return { entries, autoMappedNamespaces, annotationsEnabled, notCompromisedEnabled, yamlFound: yamlContent !== null };
  }

  for (const filePath of getAllPhpFiles(srcDir)) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    const nsM = /namespace\s+([\w\\]{1,200});/.exec(content);
    const classM = /class\s+(\w{1,120})/.exec(content);
    if (!classM) continue;

    const ns = nsM ? nsM[1] : '';
    const className = classM[1];
    const fqn = ns ? `${ns}\\${className}` : className;

    const assertCount = countAssertAttributes(content);
    const inAutoMappedNs = autoMappedNamespaces.some((n) => classMatchesNamespace(fqn, n));

    if (!inAutoMappedNs && assertCount === 0) continue;

    let type: 'auto_mapped' | 'explicit_constraint' | 'mixed';
    let issue: string | null = null;

    if (inAutoMappedNs && assertCount > 0) {
      type = 'mixed';
      issue = `auto_mapping enabled for namespace AND ${assertCount} explicit #[Assert\\*] attribute(s) found — verify no conflicting constraint definitions`;
    } else if (inAutoMappedNs) {
      type = 'auto_mapped';
    } else {
      type = 'explicit_constraint';
    }

    entries.push({ class: fqn, type, namespace: ns, issue });
  }

  return { entries, autoMappedNamespaces, annotationsEnabled, notCompromisedEnabled, yamlFound: yamlContent !== null };
}

export function listSymfonyValidatorAutoMapping(appPath: string): McpToolResult {
  try {
    const { entries, autoMappedNamespaces, annotationsEnabled, notCompromisedEnabled, yamlFound } = buildAutoMappingEntries(appPath);

    let text = `Symfony Validator Auto-Mapping Inspector\n${'='.repeat(55)}\n\n`;

    if (!yamlFound) {
      text += 'validator.yaml not found — showing PHP constraint scan only.\n\n';
    } else {
      text += `Auto-mapped namespaces: ${autoMappedNamespaces.length > 0 ? autoMappedNamespaces.join(', ') : '(none)'}\n`;
      text += `Annotations/Attributes enabled: ${annotationsEnabled ? 'yes' : 'no'}\n`;
      if (notCompromisedEnabled) {
        text += `WARNING: not_compromised_password enabled — requires outbound HTTPS to api.pwnedpasswords.com\n`;
      }
      text += '\n';
    }

    const mixed = entries.filter((e) => e.type === 'mixed');
    const autoMapped = entries.filter((e) => e.type === 'auto_mapped');
    const explicit = entries.filter((e) => e.type === 'explicit_constraint');

    text += `Classes found: ${entries.length}  (mixed: ${mixed.length}, auto_mapped: ${autoMapped.length}, explicit: ${explicit.length})\n\n`;

    if (mixed.length > 0) {
      text += `Mixed (auto_mapping + explicit constraints) — review for conflicts (${mixed.length}):\n`;
      for (const e of mixed) {
        text += `  ${e.class}\n`;
        if (e.issue) text += `    Issue: ${e.issue}\n`;
      }
      text += '\n';
    }

    if (autoMapped.length > 0) {
      text += `Auto-mapped only (${autoMapped.length}):\n`;
      for (const e of autoMapped.slice(0, 20)) {
        text += `  ${e.class}\n`;
      }
      if (autoMapped.length > 20) text += `  ... and ${autoMapped.length - 20} more\n`;
      text += '\n';
    }

    if (explicit.length > 0) {
      text += `Explicit #[Assert\\*] constraints only (${explicit.length}):\n`;
      for (const e of explicit.slice(0, 20)) {
        text += `  ${e.class}\n`;
      }
      if (explicit.length > 20) text += `  ... and ${explicit.length - 20} more\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorAutoMappingStats(appPath: string): McpToolResult {
  try {
    const { entries, autoMappedNamespaces, annotationsEnabled, notCompromisedEnabled, yamlFound } = buildAutoMappingEntries(appPath);

    let text = `Symfony Validator Auto-Mapping Statistics\n${'='.repeat(50)}\n\n`;

    text += `validator.yaml found: ${yamlFound ? 'yes' : 'no'}\n`;
    text += `Auto-mapped namespaces: ${autoMappedNamespaces.length}\n`;
    text += `Annotations/Attributes enabled: ${annotationsEnabled ? 'yes' : 'no'}\n`;
    text += `not_compromised_password: ${notCompromisedEnabled ? 'ENABLED (network required)' : 'no'}\n`;

    const mixed = entries.filter((e) => e.type === 'mixed').length;
    const autoMapped = entries.filter((e) => e.type === 'auto_mapped').length;
    const explicit = entries.filter((e) => e.type === 'explicit_constraint').length;
    const withIssues = entries.filter((e) => e.issue !== null).length;

    text += `\nClasses scanned with constraints: ${entries.length}\n`;
    text += `  Auto-mapped only:   ${autoMapped}\n`;
    text += `  Explicit only:      ${explicit}\n`;
    text += `  Mixed (conflict?):  ${mixed}\n`;
    text += `  Classes with issues: ${withIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getSymfonyValidatorAutoMappingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_validator_auto_mapping',
      description: 'List Symfony validator auto-mapping: namespaces with auto_mapping, annotations/attributes enabled, not_compromised_password detection, classes with both auto_mapping and explicit Assert attributes flagged as potential conflicts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_validator_auto_mapping_stats',
      description: 'Show Symfony validator auto-mapping statistics: namespace count, annotations enabled, not_compromised_password status, class counts by type (auto_mapped/explicit/mixed), issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
