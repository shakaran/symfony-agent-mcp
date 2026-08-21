/**
 * PHP 8.2 Readonly Class Inspector
 *
 * Detects readonly class declarations (PHP 8.2+).
 * Warns on readonly class with mutable static property,
 * readonly class implementing interface with setters,
 * readonly class extending non-readonly class,
 * readonly class in pre-PHP-8.2 project.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ReadonlyClass {
  file: string;
  className: string;
  isAbstract: boolean;
  hasStaticProperties: boolean;
  extendsNonReadonly: boolean;
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
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getPhpConstraint(appPath: string): string {
  const composerPath = path.join(appPath, 'composer.json');
  const raw = safeRead(composerPath, appPath);
  if (raw === null) return '';
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const require = obj['require'] as Record<string, string> | undefined;
    return require?.['php'] ?? '';
  } catch { return ''; }
}

function isPrePhp82(constraint: string): boolean {
  // Detect constraints like ^7.4, ^8.0, ^8.1, >=7.x <8.2, ~8.1
  const m = /[~^>=]{0,2}(\d+)\.(\d+)/.exec(constraint);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major < 8 || (major === 8 && minor < 2);
}

function parseReadonlyClass(filePath: string, appPath: string, phpConstraint: string): ReadonlyClass | null {
  const content = safeRead(filePath, appPath); if (content === null) return null;

  const classM = /\breadonly\s+(abstract\s+)?class\s+(\w{1,80})/m.exec(content);
  if (!classM) return null;

  const isAbstract = Boolean(classM[1]);
  const className = classM[2];

  // Check for static properties: static $foo or static readonly $foo
  const hasStaticProperties = /\bstatic\s+(?:readonly\s+)?(?:public|protected|private)?\s*\$\w{1,80}/m.test(content)
    || /\b(?:public|protected|private)\s+static\s+(?:readonly\s+)?\$\w{1,80}/m.test(content);

  // Detect extends clause
  const extendsM = /\bclass\s+\w{1,80}\s+extends\s+(\w{1,80})/m.exec(content);
  const parentClass = extendsM ? extendsM[1] : null;

  // Check if parent is non-readonly: we cannot inspect other files easily,
  // so we flag if extends is present and parent class name does not appear with readonly in the same file.
  let extendsNonReadonly = false;
  if (parentClass) {
    const parentReadonlyPattern = new RegExp(`\\breadonly\\s+(?:abstract\\s+)?class\\s+${parentClass}\\b`, 'm');
    if (!parentReadonlyPattern.test(content)) {
      extendsNonReadonly = true;
    }
  }

  // Check interfaces: look for setter-like method signatures (setX or withX returning void)
  const implementsM = /\bimplements\s+([^{]{1,200})/m.exec(content);
  const implementedInterfaces = implementsM ? implementsM[1] : '';

  const issues: string[] = [];

  if (hasStaticProperties) {
    issues.push(`${className}: readonly class has mutable static property`);
  }

  // Detect setter method patterns in the file (interface contracts included)
  const setterPattern = /\bfunction\s+set\w{1,80}\s*\(/m.test(content);
  if (setterPattern && implementedInterfaces.length > 0) {
    issues.push(`${className}: readonly class may implement interface with setter methods`);
  }

  if (extendsNonReadonly) {
    issues.push(`${className}: extends non-readonly class '${parentClass}' — only valid if parent has no properties`);
  }

  if (phpConstraint && isPrePhp82(phpConstraint)) {
    issues.push(`${className}: readonly class requires PHP 8.2+ but composer.json constraint is '${phpConstraint}'`);
  }

  return {
    file: path.relative(appPath, filePath),
    className,
    isAbstract,
    hasStaticProperties,
    extendsNonReadonly,
    issues,
  };
}

export function listPhpReadonlyClasses(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const phpConstraint = getPhpConstraint(appPath);
    const classes: ReadonlyClass[] = [];

    for (const file of getAllPhpFiles(srcDir)) {
      const rc = parseReadonlyClass(file, appPath, phpConstraint);
      if (rc) classes.push(rc);
    }

    if (classes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No readonly classes found in src/.\n\nExample (PHP 8.2+):\n  readonly class Money\n  {\n    public function __construct(\n      public int $amount,\n      public string $currency,\n    ) {}\n  }',
        }],
      };
    }

    const totalIssues = classes.reduce((s, c) => s + c.issues.length, 0);

    let text = `PHP 8.2 Readonly Classes\n${'='.repeat(55)}\n`;
    text += `\nReadonly classes: ${classes.length}  Issues: ${totalIssues}\n`;
    text += `  Abstract:       ${classes.filter((c) => c.isAbstract).length}\n`;
    text += `  With issues:    ${classes.filter((c) => c.issues.length > 0).length}\n`;

    for (const c of classes.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      const tags: string[] = [];
      if (c.isAbstract) tags.push('abstract');
      if (c.hasStaticProperties) tags.push('has-static-props');
      if (c.extendsNonReadonly) tags.push('extends-non-readonly');
      text += `\n  ${c.className.padEnd(35)} ${tags.join(', ')}\n`;
      text += `    ${c.file}\n`;
      for (const issue of c.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpReadonlyClassStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const phpConstraint = getPhpConstraint(appPath);
    const classes: ReadonlyClass[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const rc = parseReadonlyClass(file, appPath, phpConstraint);
        if (rc) classes.push(rc);
      }
    }

    let text = `PHP Readonly Class Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total readonly classes: ${classes.length}\n`;
    text += `  Abstract:             ${classes.filter((c) => c.isAbstract).length}\n`;
    text += `  With static props:    ${classes.filter((c) => c.hasStaticProperties).length}\n`;
    text += `  Extends non-readonly: ${classes.filter((c) => c.extendsNonReadonly).length}\n`;
    text += `  With issues:          ${classes.filter((c) => c.issues.length > 0).length}\n`;
    text += `Total issues:           ${classes.reduce((s, c) => s + c.issues.length, 0)}\n`;
    text += `PHP constraint:         ${phpConstraint || '(not set)'}\n`;
    text += `Pre-PHP-8.2 project:    ${phpConstraint && isPrePhp82(phpConstraint) ? 'yes' : 'no'}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpReadonlyClassTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_readonly_classes',
      description: 'List PHP 8.2 readonly class declarations with issues: mutable static properties, interface setter contracts, extends non-readonly class, pre-PHP-8.2 project constraint',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_readonly_class_stats',
      description: 'Statistics for PHP 8.2 readonly classes: total count, abstract count, static property count, issues count, PHP constraint',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
