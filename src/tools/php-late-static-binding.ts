/**
 * PHP Late Static Binding Inspector
 *
 * Scans src/ PHP for:
 *   - static:: (LSB), self:: (no LSB), parent:: in methods
 *   - get_called_class(), static::class, new static(), new self()
 *
 * Detects:
 *   - static:: vs self:: usage in classes with subclasses
 *   - new static() vs new self() in factory methods
 *
 * Warns:
 *   - new self() in method that should return child type (use new static())
 *   - self:: in method designed to be overridden (subclass cannot change behavior)
 *   - get_called_class() (deprecated in favor of static::class)
 *   - static:: in final class (LSB is pointless in final classes)
 *   - parent:: call without parent implementation check (may crash if parent doesn't have method)
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

interface PhpLateStaticBindingInfo {
  file: string;
  class: string;
  isFinal: boolean;
  hasSelf: boolean;
  hasStatic: boolean;
  hasParent: boolean;
  hasNewSelf: boolean;
  hasNewStatic: boolean;
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

// ─── Analysis ─────────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, appPath: string): PhpLateStaticBindingInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const hasLsbActivity =
    content.includes('static::') ||
    content.includes('self::') ||
    content.includes('parent::') ||
    content.includes('new static(') ||
    content.includes('new self(') ||
    content.includes('get_called_class(');

  if (!hasLsbActivity) return null;

  const classM = /(?:final\s+)?(?:abstract\s+)?class\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const isFinal = /\bfinal\s+class\b/.test(content);
  const hasStatic = content.includes('static::');
  const hasSelf = content.includes('self::');
  const hasParent = content.includes('parent::');
  const hasNewSelf = content.includes('new self(');
  const hasNewStatic = content.includes('new static(');
  const hasGetCalledClass = content.includes('get_called_class(');

  const issues: string[] = [];

  // new self() in factory-like method
  if (hasNewSelf) {
    // Heuristic: if class has extends (can be subclassed) and uses new self()
    const isExtendable = !isFinal && /\bclass\s+\w{1,80}\s+extends\b/.test(content);
    const hasParentClass = /\bextends\s+[\w\\]{1,100}/.test(content);

    // Check if new self() is inside a static factory method
    const staticFactoryRe = /static\s+function\s+\w{1,80}\s*\([^)]{0,300}\)\s*(?::\s*(?:static|self|[\w\\]{1,80})\s*)?\{([^}]{0,1000})\}/g;
    let fm: RegExpExecArray | null;
    while ((fm = staticFactoryRe.exec(content)) !== null) {
      if (fm[1] && fm[1].includes('new self(')) {
        issues.push(
          `${className}: new self() used in static factory method. ` +
          `Use new static() so subclasses return their own type (LSB).`,
        );
        break;
      }
    }

    if ((isExtendable || hasParentClass) && !issues.some((i) => i.includes('new self()'))) {
      issues.push(
        `${className}: new self() in an extendable class. ` +
        `If subclasses call this method, new self() creates the base class — use new static() for correct LSB.`,
      );
    }
  }

  // self:: in method that should use LSB
  if (hasSelf && !isFinal) {
    // Heuristic: self:: used in a protected/public static method (designed for override)
    const staticMethodWithSelf = /(?:public|protected)\s+static\s+function\s+(\w{1,80})\s*\([^)]{0,300}\)[^{]{0,80}\{([^}]{0,1000})\}/g;
    let sm: RegExpExecArray | null;
    while ((sm = staticMethodWithSelf.exec(content)) !== null) {
      if (sm[2] && /\bself::/.test(sm[2])) {
        issues.push(
          `${className}::${sm[1]}(): uses self:: in a public/protected static method. ` +
          `Subclasses that override this method cannot affect the self:: reference — use static:: for LSB.`,
        );
        break;
      }
    }
  }

  // get_called_class() deprecated
  if (hasGetCalledClass) {
    issues.push(
      `${className}: get_called_class() is deprecated in PHP 8.x. ` +
      `Replace with static::class for late static binding class name.`,
    );
  }

  // static:: in final class (pointless)
  if (isFinal && hasStatic) {
    issues.push(
      `${className}: static:: used in a final class. ` +
      `LSB is pointless in final classes — self:: is equivalent and communicates the intent.`,
    );
  }

  // parent:: usage: check if parent is called without guaranteed implementation
  if (hasParent) {
    // Look for parent:: calls in methods that are not __construct/__destruct
    const parentCallRe = /parent\s*::\s*(\w{1,80})\s*\(/g;
    let pc: RegExpExecArray | null;
    while ((pc = parentCallRe.exec(content)) !== null) {
      const methodName = pc[1];
      if (methodName === '__construct' || methodName === '__destruct') continue;
      // Heuristic: if the class doesn't extend anything, parent:: will crash
      if (!/\bextends\s+[\w\\]{1,100}/.test(content)) {
        issues.push(
          `${className}: parent::${methodName}() called but class does not extend any parent. ` +
          `This will throw a fatal error at runtime.`,
        );
        break;
      }
    }
  }

  const hasAnyIssue = issues.length > 0 || hasStatic || hasNewSelf || hasNewStatic;
  if (!hasAnyIssue && !hasGetCalledClass) return null;

  return {
    file: path.basename(filePath),
    class: className,
    isFinal,
    hasSelf,
    hasStatic,
    hasParent,
    hasNewSelf,
    hasNewStatic,
    issues,
  };
}

function loadAll(appPath: string): PhpLateStaticBindingInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: PhpLateStaticBindingInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file, appPath);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listPhpLateStaticBinding(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No late static binding usage found in src/.\n\n' +
            'PHP LSB example: static::create() returns child class in factory patterns.\n' +
            'Use static:: (LSB) instead of self:: when subclasses should control the referenced class.',
        }],
      };
    }

    const withIssues = items.filter((i) => i.issues.length > 0);

    let text = `PHP Late Static Binding Analysis\n${'='.repeat(55)}\n`;
    text += `  Classes with LSB activity: ${items.length}\n`;
    text += `  Uses static:::             ${items.filter((i) => i.hasStatic).length}\n`;
    text += `  Uses self:::               ${items.filter((i) => i.hasSelf).length}\n`;
    text += `  Uses new static():         ${items.filter((i) => i.hasNewStatic).length}\n`;
    text += `  Uses new self():           ${items.filter((i) => i.hasNewSelf).length}\n`;
    text += `  Final with static:::       ${items.filter((i) => i.isFinal && i.hasStatic).length}\n`;
    text += `  With issues:               ${withIssues.length}\n\n`;

    for (const item of withIssues) {
      text += `${item.class} [${item.file}]${item.isFinal ? '  [final]' : ''}\n`;
      text += `  self: ${item.hasSelf}  static: ${item.hasStatic}  parent: ${item.hasParent}  `;
      text += `new self: ${item.hasNewSelf}  new static: ${item.hasNewStatic}\n`;
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

export function getPhpLateStaticBindingStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    let text = `PHP Late Static Binding Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with LSB activity:  ${items.length}\n`;
    text += `Uses static:::              ${items.filter((i) => i.hasStatic).length}\n`;
    text += `Uses self:::                ${items.filter((i) => i.hasSelf).length}\n`;
    text += `Uses parent:::              ${items.filter((i) => i.hasParent).length}\n`;
    text += `Uses new static():          ${items.filter((i) => i.hasNewStatic).length}\n`;
    text += `Uses new self():            ${items.filter((i) => i.hasNewSelf).length}\n`;
    text += `Final classes:              ${items.filter((i) => i.isFinal).length}\n`;
    text += `Final with static:::        ${items.filter((i) => i.isFinal && i.hasStatic).length}\n`;
    text += `With issues:                ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getPhpLateStaticBindingTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_late_static_binding',
      description: 'List PHP late static binding (LSB) usage: static::/self:: detection, new self()/new static() in factory methods, get_called_class() deprecation, pointless LSB in final classes, parent:: without parent',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_late_static_binding_stats',
      description: 'Show PHP LSB statistics: static::/self::/parent:: counts, new self()/new static() counts, final class counts, issues count',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
