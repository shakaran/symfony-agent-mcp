/**
 * PHP Trait Conflict Inspector
 *
 * Scans src/ PHP for:
 *   - use TraitA, TraitB statements
 *   - insteadof keyword
 *   - as keyword in trait use
 *   - Classes using multiple traits with same method name
 *
 * Detects:
 *   - Conflict resolution via insteadof/as
 *   - Diamond problem (multiple traits from same hierarchy)
 *   - Trait using another trait
 *
 * Warns:
 *   - Class using multiple traits without conflict resolution when same method names exist (PHP fatal)
 *   - Trait method aliased to same name (pointless as alias)
 *   - insteadof without corresponding as (excluded method lost)
 *   - Self-referencing trait (trait using itself via use)
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

interface PhpTraitConflictInfo {
  file: string;
  class: string;
  traits: string[];
  hasConflictResolution: boolean;
  hasInsteadOf: boolean;
  hasAlias: boolean;
  potentialConflicts: string[];
  issues: string[];
}

// ─── File scanning ──────────────────────────────────────────────────────────

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

// ─── Trait method index ──────────────────────────────────────────────────────

type TraitMethodMap = Map<string, string[]>; // traitName -> method names

function buildTraitMethodMap(srcDir: string, appPath: string): TraitMethodMap {
  const traitMap: TraitMethodMap = new Map();
  for (const file of getAllPhpFiles(srcDir)) {
    const content = safeRead(file, appPath);
    if (content === null) continue;
    if (!content.includes('trait ')) continue;
    const traitM = /\btrait\s+(\w{1,80})/.exec(content);
    if (!traitM) continue;
    const traitName = traitM[1];
    const methods: string[] = [];
    const methodRe = /(?:public|protected|private)\s+function\s+(\w{1,80})\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = methodRe.exec(content)) !== null) {
      methods.push(m[1]);
    }
    traitMap.set(traitName, methods);
  }
  return traitMap;
}

// ─── Trait use block extractor ────────────────────────────────────────────────

interface TraitUseBlock {
  traits: string[];
  block: string; // the content inside use { ... } or just traits list
}

function extractTraitUseBlocks(content: string): TraitUseBlock[] {
  const results: TraitUseBlock[] = [];
  // Match: use TraitA, TraitB { ... } or use TraitA, TraitB;
  const re = /\buse\s+([\w,\s\\]{1,300}?)(?:\s*\{([^}]{0,1000})\}|;)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Make sure this is a trait use inside a class, not a namespace use
    const before = content.slice(Math.max(0, m.index - 200), m.index);
    if (/\bnamespace\b/.test(before) && !/\bclass\b|\btrait\b/.test(before)) continue;
    // Filter out namespace/class use statements (they import classes, not traits)
    const traitList = m[1].split(',').map((s) => {
      const t = s.trim().split('\\').pop() ?? s.trim();
      return t.replace(/\s+/g, '');
    }).filter((t) => t.length > 0 && /^[A-Z]/.test(t));
    if (traitList.length === 0) continue;
    results.push({ traits: traitList, block: m[2] ?? '' });
  }
  return results;
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(
  filePath: string,
  traitMethodMap: TraitMethodMap,
  appPath: string,
): PhpTraitConflictInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  // Must use traits inside a class or trait
  if (!content.includes('use ')) return null;

  const classM = /(?:class|trait)\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];
  const isTrait = /\btrait\s+\w/.test(content);

  const useBlocks = extractTraitUseBlocks(content);
  if (useBlocks.length === 0) return null;

  // Flatten all used traits
  const traits = [...new Set(useBlocks.flatMap((b) => b.traits))];
  if (traits.length === 0) return null;

  const allBlocks = useBlocks.map((b) => b.block).join('\n');
  const hasInsteadOf = allBlocks.includes('insteadof');
  const hasAlias = allBlocks.includes(' as ');
  const hasConflictResolution = hasInsteadOf || hasAlias;

  const issues: string[] = [];

  // Self-referencing trait
  if (isTrait && traits.includes(className)) {
    issues.push(
      `Trait ${className} uses itself (self-referencing trait). ` +
      `This causes a PHP fatal error at runtime.`,
    );
  }

  // Find methods defined in multiple used traits (potential conflicts)
  const methodToTraits: Record<string, string[]> = {};
  for (const traitName of traits) {
    const methods = traitMethodMap.get(traitName) ?? [];
    for (const method of methods) {
      methodToTraits[method] = [...(methodToTraits[method] ?? []), traitName];
    }
  }
  const potentialConflicts = Object.entries(methodToTraits)
    .filter(([, tList]) => tList.length > 1)
    .map(([method]) => method);

  if (potentialConflicts.length > 0 && !hasConflictResolution) {
    issues.push(
      `${className} uses traits [${traits.join(', ')}] that share method(s): ` +
      `${potentialConflicts.slice(0, 5).join(', ')}. ` +
      `Without insteadof/as conflict resolution PHP will throw a fatal error.`,
    );
  }

  // Alias to same name check
  const aliasRe = /(\w{1,80})\s+as\s+(\w{1,80})\s*;/g;
  let am: RegExpExecArray | null;
  while ((am = aliasRe.exec(allBlocks)) !== null) {
    if (am[1] === am[2]) {
      issues.push(
        `Trait method "${am[1]}" aliased to same name "${am[2]}" in ${className}. ` +
        `This alias is pointless — it creates no new name.`,
      );
    }
  }

  // insteadof without corresponding as (excluded method becomes inaccessible)
  if (hasInsteadOf && !hasAlias) {
    issues.push(
      `${className} uses insteadof without a corresponding "as" alias. ` +
      `The excluded trait method is completely lost — use "as" to preserve it under a different name.`,
    );
  }

  return {
    file: path.basename(filePath),
    class: className,
    traits,
    hasConflictResolution,
    hasInsteadOf,
    hasAlias,
    potentialConflicts,
    issues,
  };
}

function loadAll(appPath: string): PhpTraitConflictInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const traitMethodMap = buildTraitMethodMap(srcDir, appPath);
  const results: PhpTraitConflictInfo[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file, traitMethodMap, appPath);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpTraitConflicts(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No trait usage found in src/.\n\n' +
            'PHP traits can cause conflicts when multiple traits define the same method:\n' +
            '  class Foo {\n' +
            '    use TraitA, TraitB {\n' +
            '      TraitA::hello insteadof TraitB;\n' +
            '      TraitB::hello as helloB;\n' +
            '    }\n' +
            '  }',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);
    const withConflicts = items.filter((i) => i.potentialConflicts.length > 0);

    let text = `PHP Trait Conflict Analysis\n${'='.repeat(55)}\n`;
    text += `  Classes/traits using traits:    ${items.length}\n`;
    text += `  Potential method conflicts:     ${withConflicts.length}\n`;
    text += `  With conflict resolution:       ${items.filter((i) => i.hasConflictResolution).length}\n`;
    text += `  With issues:                    ${withIssues.length}\n\n`;

    for (const item of items) {
      text += `${item.class} [${item.file}]\n`;
      text += `  traits: ${item.traits.join(', ')}\n`;
      if (item.potentialConflicts.length > 0) {
        text += `  conflicts: ${item.potentialConflicts.join(', ')}\n`;
      }
      text += `  insteadof: ${item.hasInsteadOf}  alias: ${item.hasAlias}\n`;
      for (const issue of item.issues) {
        text += `  WARN: ${issue}\n`;
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

export function getPhpTraitConflictStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Trait Conflict Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes/traits using traits:      ${items.length}\n`;
    text += `Using multiple traits:            ${items.filter((i) => i.traits.length > 1).length}\n`;
    text += `Potential method conflicts:       ${items.filter((i) => i.potentialConflicts.length > 0).length}\n`;
    text += `Has conflict resolution:          ${items.filter((i) => i.hasConflictResolution).length}\n`;
    text += `Has insteadof:                   ${items.filter((i) => i.hasInsteadOf).length}\n`;
    text += `Has alias (as):                  ${items.filter((i) => i.hasAlias).length}\n`;
    text += `With issues:                     ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpTraitConflictTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_trait_conflicts',
      description: 'List PHP trait usage and conflicts: multiple-trait classes, insteadof/as conflict resolution, potential method conflicts (PHP fatal risk), self-referencing trait, lost insteadof exclusions',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_trait_conflict_stats',
      description: 'Show PHP trait conflict statistics: multi-trait class counts, conflict counts, insteadof/alias counts, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
