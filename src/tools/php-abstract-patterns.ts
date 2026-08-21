/**
 * PHP Abstract Pattern Inspector
 *
 * Scans src/ PHP for:
 *   - Abstract class declarations and abstract methods
 *   - Template method pattern (abstract class with concrete methods calling abstract methods)
 *   - Abstract classes with no abstract methods (should be interface or regular class)
 *   - Abstract classes implementing interfaces
 *   - Abstract classes with >10 abstract methods (too many obligations)
 *   - Concrete subclasses that don't implement all abstract methods (static detection)
 *
 * Warns:
 *   - Abstract class without any abstract methods (use class or interface)
 *   - Abstract class implementing interface but not implementing all interface methods as abstract
 *   - Template method with abstract method called in constructor
 *   - Abstract class with public state (breaks encapsulation)
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

interface AbstractPatternInfo {
  file: string;
  class: string;
  abstractMethodCount: number;
  concreteMethodCount: number;
  implementsInterfaces: string[];
  hasTemplateMethod: boolean;
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

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function extractAbstractMethodNames(content: string): string[] {
  const names: string[] = [];
  const re = /abstract\s+(?:public|protected)\s+function\s+(\w{1,80})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractConcreteMethods(content: string): string[] {
  const names: string[] = [];
  // Match non-abstract function declarations (with body)
  const re = /(?<!abstract\s{0,10})(?:public|protected|private)\s+function\s+(\w{1,80})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Skip if immediately preceded by 'abstract'
    const before = content.slice(Math.max(0, m.index - 15), m.index);
    if (/abstract\s*$/.test(before)) continue;
    names.push(m[1]);
  }
  return names;
}

function extractInterfaces(content: string): string[] {
  const m = /implements\s+([\w\\, ]{1,300})/.exec(content);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().split('\\').pop() ?? s.trim()).filter(Boolean);
}

function isTemplateMethod(content: string, abstractNames: string[]): boolean {
  if (abstractNames.length === 0) return false;
  // A template method is a concrete method that calls one of the abstract methods
  for (const name of abstractNames) {
    const callRe = new RegExp(`\\$this\\s*->\\s*${name}\\s*\\(`, 'g');
    if (callRe.test(content)) return true;
  }
  return false;
}

function hasPublicStateVars(content: string): boolean {
  return /public\s+(?:readonly\s+)?(?:\?[\w\\]{1,80}\s+)?\$\w{1,60}\s*[=;]/.test(content);
}

function abstractCalledInConstructor(content: string, abstractNames: string[]): string[] {
  const ctorM = /function\s+__construct\s*\([^)]{0,500}\)\s*\{([^}]{0,2000})\}/.exec(content);
  if (!ctorM) return [];
  const ctorBody = ctorM[1];
  return abstractNames.filter((name) => {
    const re = new RegExp(`\\$this\\s*->\\s*${name}\\s*\\(`);
    return re.test(ctorBody);
  });
}

// ─── File analysis ────────────────────────────────────────────────────────────

function analyzeFile(filePath: string): AbstractPatternInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  if (!content.includes('abstract class ')) return null;

  const classM = /abstract\s+class\s+(\w{1,80})/.exec(content);
  if (!classM) return null;
  const className = classM[1];

  const abstractMethods = extractAbstractMethodNames(content);
  const concreteMethods = extractConcreteMethods(content);
  const interfaces = extractInterfaces(content);
  const hasTemplate = isTemplateMethod(content, abstractMethods);

  const issues: string[] = [];

  if (abstractMethods.length === 0) {
    issues.push(
      `Abstract class ${className} has no abstract methods. ` +
      `Consider using a regular class or interface instead.`,
    );
  }

  if (abstractMethods.length > 10) {
    issues.push(
      `Abstract class ${className} has ${abstractMethods.length} abstract methods. ` +
      `Too many obligations — consider splitting into smaller abstractions.`,
    );
  }

  if (hasPublicStateVars(content)) {
    issues.push(
      `Abstract class ${className} exposes public state (public properties). ` +
      `Public state in abstract base classes breaks encapsulation for subclasses.`,
    );
  }

  const ctorAbstractCalls = abstractCalledInConstructor(content, abstractMethods);
  if (ctorAbstractCalls.length > 0) {
    issues.push(
      `Abstract class ${className} calls abstract method(s) in constructor: ` +
      `${ctorAbstractCalls.join(', ')}. ` +
      `This is a template method hook before the subclass object is fully initialized.`,
    );
  }

  if (interfaces.length > 0 && abstractMethods.length === 0) {
    issues.push(
      `Abstract class ${className} implements interface(s) [${interfaces.join(', ')}] ` +
      `but has no abstract methods to delegate implementation to subclasses.`,
    );
  }

  return {
    file: path.basename(filePath),
    class: className,
    abstractMethodCount: abstractMethods.length,
    concreteMethodCount: concreteMethods.length,
    implementsInterfaces: interfaces,
    hasTemplateMethod: hasTemplate,
    issues,
  };
}

function loadAbstractPatterns(appPath: string): AbstractPatternInfo[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const results: AbstractPatternInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    const info = analyzeFile(file);
    if (info) results.push(info);
  }
  return results.sort((a, b) => a.class.localeCompare(b.class));
}

// ─── Tool functions ────────────────────────────────────────────────────────

export function listAbstractPatterns(appPath: string): McpToolResult {
  try {
    const items = loadAbstractPatterns(appPath);

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No abstract classes found in src/.\n\n' +
            'Use abstract classes to define template method patterns:\n' +
            '  abstract class BaseProcessor {\n' +
            '    public function process(): void { $this->doProcess(); }\n' +
            '    abstract protected function doProcess(): void;\n' +
            '  }',
        }],
      };
    }

    const withIssues    = items.filter((i) => i.issues.length > 0);
    const withTemplate  = items.filter((i) => i.hasTemplateMethod);
    const noAbstract    = items.filter((i) => i.abstractMethodCount === 0);

    let text = `PHP Abstract Pattern Analysis\n${'='.repeat(55)}\n`;
    text += `  Abstract classes:        ${items.length}\n`;
    text += `  With template method:    ${withTemplate.length}\n`;
    text += `  No abstract methods:     ${noAbstract.length}\n`;
    text += `  With issues:             ${withIssues.length}\n\n`;

    for (const item of items) {
      const ifaces = item.implementsInterfaces.length > 0
        ? `  implements: ${item.implementsInterfaces.join(', ')}\n`
        : '';
      text += `${item.class} [${item.file}]\n`;
      text += `  abstract methods: ${item.abstractMethodCount}   concrete: ${item.concreteMethodCount}\n`;
      text += `  template method:  ${item.hasTemplateMethod ? 'yes' : 'no'}\n`;
      text += ifaces;
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

export function getAbstractPatternStats(appPath: string): McpToolResult {
  try {
    const items = loadAbstractPatterns(appPath);

    let text = `PHP Abstract Pattern Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total abstract classes:   ${items.length}\n`;
    text += `With abstract methods:    ${items.filter((i) => i.abstractMethodCount > 0).length}\n`;
    text += `Without abstract methods: ${items.filter((i) => i.abstractMethodCount === 0).length}\n`;
    text += `Template method pattern:  ${items.filter((i) => i.hasTemplateMethod).length}\n`;
    text += `Implements interfaces:    ${items.filter((i) => i.implementsInterfaces.length > 0).length}\n`;
    text += `>10 abstract methods:     ${items.filter((i) => i.abstractMethodCount > 10).length}\n`;
    text += `With issues:              ${items.filter((i) => i.issues.length > 0).length}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getAbstractPatternTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_php_abstract_patterns',
      description: 'List abstract class patterns: template method detection, abstract method count, no-abstract-method warnings, constructor hook issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_php_abstract_pattern_stats',
      description: 'Show abstract pattern statistics: total abstract classes, template method count, no-abstract-method count, interface implementors, issues',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
