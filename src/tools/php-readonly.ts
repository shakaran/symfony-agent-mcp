/**
 * PHP Readonly Classes and Properties Inspector
 *
 * Analyzes PHP 8.1+ readonly properties and PHP 8.2+ readonly classes:
 *
 * readonly properties (PHP 8.1+):
 *   - public readonly string $name;
 *   - Constructor-promoted: __construct(public readonly string $name)
 *   - Can only be initialized once (in constructor or declaration)
 *   - Clone does not re-trigger initialization — clone + modify = runtime error
 *
 * readonly class (PHP 8.2+):
 *   - All properties implicitly readonly
 *   - Cannot have non-typed properties
 *   - Cannot be extended by non-readonly class
 *
 * DTO analysis:
 *   - All-readonly constructor-promoted = fully immutable value object
 *   - Wither methods: with*() returning new static(...) or clone pattern
 *   - Partial readonly: some readonly, some mutable (mixed design)
 *
 * Antipatterns:
 *   - readonly property with public setter (defeats immutability)
 *   - readonly class extending mutable class
 *   - Readonly property of mutable object type (readonly ref, mutable content)
 *   - serialize()/unserialize() on readonly class (PHP throws on __set)
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

interface ReadonlyInfo {
  class: string;
  file: string;
  isReadonlyClass: boolean;
  readonlyProps: number;
  totalProps: number;
  hasWitherMethods: boolean;
  hasPublicSetters: boolean;
  hasMutableObjectProps: boolean;
  hasSerialize: boolean;
  issues: string[];
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

const MUTABLE_OBJECT_TYPES = ['array', 'ArrayObject', 'SplStack', 'SplQueue', 'Collection', 'ArrayCollection'];

function parseReadonlyInfo(filePath: string, appPath: string): ReadonlyInfo | null {
  const content = safeRead(filePath, appPath);
  if (content === null) return null;

  const hasReadonly = content.includes('readonly') || /readonly\s+class\s+/.test(content);
  if (!hasReadonly) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /(?:readonly\s+)?class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const isReadonlyClass = /\breadonly\s+class\s+/.test(content);

  // Count readonly props
  const readonlyPropMatches = [...content.matchAll(/\breadonly\s+(?:\??\w+\s+)?\$\w+/g)];
  const readonlyProps = readonlyPropMatches.length;

  // Count total typed props (approximate)
  const propMatches = [...content.matchAll(/(?:public|protected|private)\s+(?:readonly\s+)?(?:\??\w+\s+)?\$\w+/g)];
  const totalProps  = propMatches.length;

  const hasWitherMethods = /function\s+with[A-Z]\w*\s*\(/.test(content) ||
                            /new\s+static\s*\(/.test(content) || /clone\s+\$this/.test(content);

  const hasPublicSetters = /function\s+set[A-Z]\w*\s*\(/.test(content) &&
                            /\breadonly\b/.test(content);

  const hasMutableObjectProps = MUTABLE_OBJECT_TYPES.some((t) => {
    const re = new RegExp(`\\breadonly\\s+(?:\\??${t})\\s+\\$`);
    return re.test(content);
  });

  const hasSerialize = content.includes('__sleep') || content.includes('__serialize') ||
                        content.includes('Serializable') || content.includes('serialize(');

  const issues: string[] = [];
  if (hasPublicSetters) {
    issues.push('Readonly property with public setter — defeats immutability');
  }
  if (hasMutableObjectProps) {
    issues.push('Readonly property holds a mutable object type — reference is readonly, but contents are mutable');
  }
  if (isReadonlyClass && hasSerialize) {
    issues.push('Readonly class with serialize/unserialize — PHP throws Error on __set during unserialize');
  }
  if (readonlyProps > 0 && totalProps > 0 && readonlyProps < totalProps && !isReadonlyClass) {
    const mutableCount = totalProps - readonlyProps;
    if (mutableCount > 0) {
      issues.push(`Mixed design: ${readonlyProps} readonly + ${mutableCount} mutable properties — consider full DTO or full entity`);
    }
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    isReadonlyClass,
    readonlyProps,
    totalProps,
    hasWitherMethods,
    hasPublicSetters,
    hasMutableObjectProps,
    hasSerialize,
    issues,
  };
}

export function listReadonlyClasses(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const classes: ReadonlyInfo[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const info = parseReadonlyInfo(file, appPath);
      if (info) classes.push(info);
    }

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No readonly properties or classes found.\n\nReadonly property (PHP 8.1+):\n  class UserDto\n  {\n    public function __construct(\n      public readonly string $name,\n      public readonly string $email,\n    ) {}\n  }\n\nReadonly class (PHP 8.2+):\n  readonly class Money\n  {\n    public function __construct(\n      public int $amount,\n      public string $currency,\n    ) {}\n  }',
        }],
      };
    }

    const readonlyClassCount = classes.filter((c) => c.isReadonlyClass).length;
    const withIssues         = classes.filter((c) => c.issues.length > 0);
    const totalIssues        = classes.reduce((s, c) => s + c.issues.length, 0);

    let text = `PHP Readonly Analysis\n${'='.repeat(55)}\n`;
    text += `\nClasses with readonly: ${classes.length}  readonly class: ${readonlyClassCount}  Issues: ${totalIssues}\n`;

    if (withIssues.length > 0) {
      text += `\nClasses with issues:\n`;
      for (const c of withIssues) {
        const label = c.isReadonlyClass ? 'readonly class' : `${c.readonlyProps}/${c.totalProps} readonly`;
        text += `  ${c.class}  [${label}]  (${c.file})\n`;
        for (const issue of c.issues) text += `    ⚠ ${issue}\n`;
      }
    }

    const immutable = classes.filter((c) => c.isReadonlyClass || (c.readonlyProps === c.totalProps && c.totalProps > 0));
    if (immutable.length > 0) {
      text += `\nFully immutable classes (${immutable.length}):\n`;
      for (const c of immutable.slice(0, 10)) {
        const wither = c.hasWitherMethods ? '  ✓ wither' : '';
        text += `  ${c.class}${wither}  (${c.file})\n`;
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

export function getReadonlyStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const classes: ReadonlyInfo[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const info = parseReadonlyInfo(file, appPath);
        if (info) classes.push(info);
      }
    }

    let text = `PHP Readonly Statistics\n${'='.repeat(40)}\n\n`;
    text += `Classes with readonly:   ${classes.length}\n`;
    text += `  readonly class (8.2+): ${classes.filter((c) => c.isReadonlyClass).length}\n`;
    text += `  Fully immutable:       ${classes.filter((c) => c.readonlyProps === c.totalProps && c.totalProps > 0).length}\n`;
    text += `  With wither methods:   ${classes.filter((c) => c.hasWitherMethods).length}\n`;
    text += `  Mixed (partial):       ${classes.filter((c) => c.readonlyProps > 0 && c.readonlyProps < c.totalProps).length}\n`;
    text += `Issues:                  ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getReadonlyTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_readonly_classes',
      description: 'Show PHP 8.1+ readonly property and 8.2+ readonly class analysis: fully immutable DTOs, wither/clone patterns, setter-on-readonly antipattern, mutable-object-in-readonly warning, serialize on readonly class, mixed readonly/mutable design',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_readonly_stats',
      description: 'Show readonly statistics: class count, readonly class count, fully immutable count, wither method count, mixed design count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
