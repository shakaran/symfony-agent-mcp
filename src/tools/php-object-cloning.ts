/**
 * PHP Object Cloning Inspector
 *
 * Scans src/ PHP for clone usage patterns and issues:
 * - __clone() method definitions, clone $obj usage
 * - $copy = $obj (potential missing clone)
 * - Static clone factory methods
 *
 * Warnings:
 *   - clone of object with resource property
 *   - __clone() without parent::__clone() in inheritance chain
 *   - Shallow clone that doesn't deep-clone inner objects
 *   - Doctrine entity cloned without resetting identity fields
 *   - Object assigned without clone (heuristic)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpObjectCloningInfo {
  file: string;
  class: string;
  hasCloneMethod: boolean;
  hasSuperCloneCall: boolean;
  isClonedElsewhere: boolean;
  hasResourceProperty: boolean;
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
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

function parseObjectCloningFile(filePath: string, allContents: Map<string, string>): PhpObjectCloningInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('class ')) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const hasCloneMethod = /function\s+__clone\s*\(/.test(content);
  const hasSuperCloneCall = content.includes('parent::__clone()');

  // Check if this class is cloned elsewhere in codebase
  let isClonedElsewhere = false;
  const clonePattern = new RegExp(`clone\\s+\\$\\w{0,80}`, 'g');
  const cloneUsages = content.match(clonePattern) ?? [];
  if (cloneUsages.length > 0) {
    isClonedElsewhere = true;
  } else {
    // Check other files
    for (const [otherPath, otherContent] of allContents) {
      if (otherPath === filePath) continue;
      if (otherContent.includes(className) && /clone\s+\$\w{0,80}/.test(otherContent)) {
        isClonedElsewhere = true;
        break;
      }
    }
  }

  // Detect resource-type properties
  const resourcePatterns = [
    /\$\w{1,80}\s*=\s*fopen\s*\(/,
    /\$\w{1,80}\s*=\s*curl_init\s*\(/,
    /\$\w{1,80}\s*=\s*stream_socket/,
    /resource\s*\$/,
    /\bresource\b/,
  ];
  const hasResourceProperty = resourcePatterns.some((p) => p.test(content));

  const issues: string[] = [];

  // Warning: clone of object with resource property
  if (hasCloneMethod && hasResourceProperty) {
    issues.push('__clone() defined but class has resource-type property — resources are not cloneable');
  }

  // Warning: __clone() without parent::__clone() in inheritance chain
  const extendsMatch = /class\s+\w{1,100}\s+extends\s+(\w{1,100})/.exec(content);
  if (hasCloneMethod && extendsMatch && !hasSuperCloneCall) {
    issues.push(`__clone() does not call parent::__clone() — parent state may not be properly cloned (extends ${extendsMatch[1]})`);
  }

  // Warning: shallow clone — inner object properties not deep-cloned in __clone()
  if (hasCloneMethod) {
    const objectPropPattern = /\$this->\w{1,80}\s*=\s*new\s+\w{1,100}/;
    const cloneInClone = /function\s+__clone[\s\S]{0,500}clone\s+\$this->/;
    if (!cloneInClone.test(content) && objectPropPattern.test(content)) {
      issues.push('__clone() defined but inner object properties are not deep-cloned (shallow clone may share state)');
    }
  }

  // Warning: Doctrine entity cloned without resetting identity fields
  const isDoctrineEntity = content.includes('@ORM\\Entity') ||
    content.includes('#[ORM\\Entity') ||
    content.includes('#[Entity') ||
    content.includes('use Doctrine\\ORM\\Mapping');
  const hasIdField = /\$id\b|\$uuid\b/.test(content);
  if (isDoctrineEntity && hasIdField && isClonedElsewhere) {
    const cloneResetsId = /function\s+__clone[\s\S]{0,300}\$this->id\s*=/.test(content) ||
      /function\s+__clone[\s\S]{0,300}\$this->uuid\s*=/.test(content);
    if (!cloneResetsId) {
      issues.push('Doctrine entity cloned without resetting identity fields in __clone() — may confuse EntityManager');
    }
  }

  // Warning: object assigned without clone (heuristic: same-class property re-assigned)
  const assignWithoutClone = /\$\w{1,80}\s*=\s*\$\w{1,80};\s*\/\/.*copy/i;
  if (assignWithoutClone.test(content) && !content.includes('clone $')) {
    issues.push('Object assigned without clone (potential shallow copy) — use clone keyword for independent copy');
  }

  return {
    file: path.basename(filePath),
    class: className,
    hasCloneMethod,
    hasSuperCloneCall,
    isClonedElsewhere,
    hasResourceProperty,
    issues,
  };
}

export function listPhpObjectCloning(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const allFiles = getAllPhpFiles(srcDir);
    const allContents = new Map<string, string>();
    for (const f of allFiles) {
      const fc = safeRead(f, appPath); if (fc !== null) allContents.set(f, fc);
    }

    const results: PhpObjectCloningInfo[] = [];
    for (const f of allFiles) {
      const info = parseObjectCloningFile(f, allContents);
      if (info) results.push(info);
    }

    const withClone = results.filter((r) => r.hasCloneMethod || r.isClonedElsewhere);
    if (withClone.length === 0) {
      return { content: [{ type: 'text', text: 'No object cloning patterns found in src/.' }] };
    }

    withClone.sort((a, b) => a.class.localeCompare(b.class));
    const totalIssues = withClone.reduce((s, r) => s + r.issues.length, 0);

    let text = `PHP Object Cloning Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses with clone patterns: ${withClone.length}  Issues: ${totalIssues}\n`;

    for (const r of withClone) {
      const flags = [
        r.hasCloneMethod ? '[__clone]' : '',
        r.hasSuperCloneCall ? '[parent::__clone]' : '',
        r.isClonedElsewhere ? '[cloned]' : '',
        r.hasResourceProperty ? '[resource]' : '',
      ].filter(Boolean).join(' ');
      text += `\n  ${r.class.padEnd(45)} (${r.file}) ${flags}\n`;
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpObjectCloningStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const allFiles = getAllPhpFiles(srcDir);
    const allContents = new Map<string, string>();
    for (const f of allFiles) {
      const fc = safeRead(f, appPath); if (fc !== null) allContents.set(f, fc);
    }

    const results: PhpObjectCloningInfo[] = [];
    for (const f of allFiles) {
      const info = parseObjectCloningFile(f, allContents);
      if (info) results.push(info);
    }

    const withClone = results.filter((r) => r.hasCloneMethod || r.isClonedElsewhere);

    let text = `PHP Object Cloning Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total classes scanned:          ${results.length}\n`;
    text += `With __clone() method:          ${withClone.filter((r) => r.hasCloneMethod).length}\n`;
    text += `With parent::__clone() call:    ${withClone.filter((r) => r.hasSuperCloneCall).length}\n`;
    text += `Cloned elsewhere in codebase:   ${withClone.filter((r) => r.isClonedElsewhere).length}\n`;
    text += `With resource properties:       ${withClone.filter((r) => r.hasResourceProperty).length}\n`;
    text += `Total issues:                   ${withClone.reduce((s, r) => s + r.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpObjectCloningTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_object_cloning',
      description: 'Scan PHP classes for clone usage patterns: __clone() methods, clone $obj calls, shallow-clone leaks, Doctrine entity clone without identity reset, resource properties in cloneable objects, missing parent::__clone() in inheritance chains',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_object_cloning_stats',
      description: 'Get statistics on PHP object cloning: counts of __clone() methods, parent::__clone() calls, resource-bearing cloneable classes, and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
