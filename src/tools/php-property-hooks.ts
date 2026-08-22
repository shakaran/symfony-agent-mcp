/**
 * PHP 8.4 Property Hooks Inspector
 *
 * Scans src/ PHP files for PHP 8.4 property hook syntax:
 *   - Property declarations with get { } and set { } blocks
 *   - Hooks with complex logic (>5 lines)
 *   - Hooks calling $this->propertyName directly (potential recursion)
 *   - Abstract property hooks
 *   - Hooks on readonly properties (invalid in PHP 8.4)
 *
 * Warns about:
 *   - get hook not returning a value (implicit null)
 *   - set hook not assigning to $field (value silently discarded)
 *   - hook on readonly property (PHP error)
 *   - very long hook body (extract to method)
 *   - abstract hook in non-abstract class
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PropertyHookEntry {
  name: string;
  hasGet: boolean;
  hasSet: boolean;
  getLines: number;
  setLines: number;
  isAbstract: boolean;
  isReadonly: boolean;
  issues: string[];
}

interface PropertyHookInfo {
  file: string;
  class: string;
  properties: PropertyHookEntry[];
  issues: string[];
}


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

function countLines(block: string): number {
  return block.split('\n').length;
}

function extractHookBlock(content: string, propName: string, hookType: 'get' | 'set'): string | null {
  // Match: get { ... } or set { ... } after property name
  const pattern = new RegExp(
    `\\$${propName}[^;{]{0,200}\\b${hookType}\\s*\\{`,
    's'
  );
  const start = pattern.exec(content);
  if (!start) return null;

  let depth = 0;
  let idx = start.index + start[0].length - 1;
  const end = Math.min(content.length, idx + 5000);
  for (; idx < end; idx++) {
    if (content[idx] === '{') depth++;
    else if (content[idx] === '}') {
      depth--;
      if (depth === 0) return content.substring(start.index, idx + 1);
    }
  }
  return null;
}

function parsePropertyHooks(filePath: string): PropertyHookInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Quick filter — must contain a hook keyword next to a property
  if (!/\b(get|set)\s*\{/.test(content)) return null;
  if (!/\bclass\s+/.test(content)) return null;

  const classMatch = /(?:abstract\s+)?class\s+(\w{1,100})/.exec(content);
  if (!classMatch) return null;

  const className = classMatch[1];
  const isAbstractClass = /\babstract\s+class\b/.test(content);

  // Detect property lines with hook blocks:
  // Pattern: (abstract|readonly)? (public|protected|private)? TYPE? $propName { get { } set { } }
  const propPattern = /(?:(?:abstract|readonly|public|protected|private|static)\s+){0,5}\$(\w{1,80})\s*\{[^}]{0,50}(?:get|set)\s*\{/gs;

  const properties: PropertyHookEntry[] = [];
  const classIssues: string[] = [];
  const seenProps = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = propPattern.exec(content)) !== null) {
    const propName = m[1];
    if (seenProps.has(propName)) continue;
    seenProps.add(propName);

    // Context around declaration (up to 400 chars before $propName)
    const ctxStart = Math.max(0, m.index - 400);
    const ctx = content.substring(ctxStart, m.index + m[0].length + 2000);

    const declLine = ((): string => {
      const lineStart = content.lastIndexOf('\n', m.index) + 1;
      return content.substring(lineStart, m.index + 200);
    })();

    const isReadonly = /\breadonly\b/.test(declLine);
    const isAbstract = /\babstract\b/.test(declLine);

    const getBlock = extractHookBlock(ctx, propName, 'get');
    const setBlock = extractHookBlock(ctx, propName, 'set');
    const hasGet = getBlock !== null;
    const hasSet = setBlock !== null;
    const getLines = getBlock ? countLines(getBlock) : 0;
    const setLines = setBlock ? countLines(setBlock) : 0;

    const propIssues: string[] = [];

    if (isReadonly && (hasGet || hasSet)) {
      propIssues.push(`$${propName}: hook on readonly property is invalid in PHP 8.4`);
    }
    if (isAbstract && !isAbstractClass) {
      propIssues.push(`$${propName}: abstract property hook in non-abstract class`);
    }
    if (hasGet && getLines > 7 && !isAbstract) {
      propIssues.push(`$${propName}: get hook body is ${getLines} lines — consider extracting to a method`);
    }
    if (hasSet && setLines > 7 && !isAbstract) {
      propIssues.push(`$${propName}: set hook body is ${setLines} lines — consider extracting to a method`);
    }
    // Detect potential recursion: $this->propName inside its own hook
    if (hasGet && getBlock && new RegExp(`\\$this->${propName}\\b`).test(getBlock)) {
      propIssues.push(`$${propName}: get hook references \\$this->${propName} directly — use \\$field to avoid infinite recursion`);
    }
    if (hasSet && setBlock && new RegExp(`\\$this->${propName}\\b`).test(setBlock)) {
      propIssues.push(`$${propName}: set hook references \\$this->${propName} directly — use \\$field to avoid infinite recursion`);
    }
    // get hook must return a value
    if (hasGet && getBlock && !isAbstract && !/\breturn\b/.test(getBlock)) {
      propIssues.push(`$${propName}: get hook has no return statement — will return null implicitly`);
    }
    // set hook should assign $field
    if (hasSet && setBlock && !isAbstract && !/\$field\b/.test(setBlock)) {
      propIssues.push(`$${propName}: set hook does not assign \\$field — incoming value may be silently discarded`);
    }

    properties.push({
      name: propName,
      hasGet,
      hasSet,
      getLines,
      setLines,
      isAbstract,
      isReadonly,
      issues: propIssues,
    });
  }

  if (properties.length === 0) return null;

  return {
    file: path.relative(path.dirname(path.dirname(filePath)), filePath),
    class: className,
    properties,
    issues: classIssues,
  };
}

function scanPropertyHooks(appPath: string): PropertyHookInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PropertyHookInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = parsePropertyHooks(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

export function listPhpPropertyHooks(appPath: string): McpToolResult {
  try {
    const infos = scanPropertyHooks(appPath);

    if (infos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP 8.4 property hooks detected in src/.\n\nProperty hooks (PHP 8.4+) syntax:\n  class User {\n    public string $name {\n      get { return strtoupper($this->name); }\n      set(string $value) { $field = trim($value); }\n    }\n  }',
        }],
      };
    }

    let text = `PHP 8.4 Property Hooks\n${'='.repeat(55)}\n`;
    let totalIssues = 0;

    for (const info of infos) {
      text += `\n${info.class} (${info.file})\n`;
      for (const prop of info.properties) {
        const hooks: string[] = [];
        if (prop.hasGet) hooks.push(`get(${prop.getLines}L)`);
        if (prop.hasSet) hooks.push(`set(${prop.setLines}L)`);
        const flags: string[] = [];
        if (prop.isAbstract) flags.push('abstract');
        if (prop.isReadonly) flags.push('readonly');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        text += `  $${prop.name}${flagStr}  ${hooks.join(', ')}\n`;
        for (const issue of prop.issues) {
          text += `    WARNING: ${issue}\n`;
          totalIssues++;
        }
      }
      for (const issue of info.issues) {
        text += `  WARNING: ${issue}\n`;
        totalIssues++;
      }
    }

    if (totalIssues === 0) {
      text += '\nNo issues detected.\n';
    } else {
      text += `\nTotal warnings: ${totalIssues}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpPropertyHookStats(appPath: string): McpToolResult {
  try {
    const infos = scanPropertyHooks(appPath);

    const allProps = infos.flatMap((i) => i.properties);
    const totalIssues = infos.reduce((s, i) => s + i.issues.length + i.properties.reduce((ps, p) => ps + p.issues.length, 0), 0);

    let text = `PHP 8.4 Property Hook Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with hooks:       ${infos.length}\n`;
    text += `Total hooked properties:  ${allProps.length}\n`;
    text += `  With get hook:          ${allProps.filter((p) => p.hasGet).length}\n`;
    text += `  With set hook:          ${allProps.filter((p) => p.hasSet).length}\n`;
    text += `  With both hooks:        ${allProps.filter((p) => p.hasGet && p.hasSet).length}\n`;
    text += `  Abstract hooks:         ${allProps.filter((p) => p.isAbstract).length}\n`;
    text += `  Readonly (invalid):     ${allProps.filter((p) => p.isReadonly).length}\n`;
    text += `Total warnings:           ${totalIssues}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpPropertyHookTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_property_hooks',
      description: 'List PHP 8.4 property hooks in src/: detect get/set hook blocks, recursion risk ($this->prop instead of $field), readonly+hook conflicts, abstract hooks in non-abstract classes, missing return in get hooks, missing $field assignment in set hooks',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_property_hook_stats',
      description: 'Statistics for PHP 8.4 property hooks: class count, property count by hook type (get/set/both), abstract hook count, invalid readonly count, total warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
