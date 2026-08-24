// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Immutable Value Object Inspector
 *
 * Detects immutable value objects: no setters, wither methods, final class,
 * private/readonly properties only.
 *
 * Warns on: public non-readonly property, mutable collection property (array),
 * extends mutable class, __clone without deep copy.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ValueObject {
  file: string;
  className: string;
  isFinal: boolean;
  hasPublicMutableProps: boolean;
  witherCount: number;
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

function parseValueObject(filePath: string, appPath: string): ValueObject | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const classM = /\bclass\s+(\w{1,80})/m.exec(content);
  if (!classM) return null;
  const className = classM[1];

  // Must have private/readonly properties (at least one)
  const hasPrivateProps = /\b(?:private|protected)\s+(?:readonly\s+)?(?:\?\w{1,80}|\w{1,80})\s+\$\w{1,80}/m.test(content);
  const hasReadonlyProps = /\bpublic\s+readonly\s+/m.test(content);
  const hasConstructorPromotion = /\b(?:private|protected)\s+readonly\s+/m.test(content);

  if (!hasPrivateProps && !hasReadonlyProps && !hasConstructorPromotion) return null;

  // Must have no public setters
  const hasPublicSetters = /\bpublic\s+function\s+(?:set|update|change)\w{0,60}\s*\(/m.test(content);
  if (hasPublicSetters) return null;

  // Count wither methods: public function with*(...)... return new self|static
  const witherRegex = /\bpublic\s+function\s+with\w{1,60}\s*\([^)]{0,400}\)[^{]{0,100}\{[^}]{0,600}return\s+new\s+(?:self|static)\s*\(/gm;
  const witherMatches = content.match(witherRegex);
  const witherCount = witherMatches?.length ?? 0;

  // If no wither methods and no readonly, might not be a value object
  if (witherCount === 0 && !hasReadonlyProps && !hasConstructorPromotion) return null;

  const isFinal = /\bfinal\s+class\b/m.test(content);

  // Public non-readonly properties (truly mutable)
  const publicNonReadonlyProps = /\bpublic\s+(?!readonly\b)(?:\?\w{1,80}|\w{1,80})\s+\$\w{1,80}/m.test(content);
  const hasPublicMutableProps = publicNonReadonlyProps;

  const issues: string[] = [];

  if (hasPublicMutableProps) {
    issues.push(`${className}: has public non-readonly property — not truly immutable`);
  }

  // Mutable collection: array or ArrayCollection property
  if (/\b(?:private|protected|public)\s+(?:readonly\s+)?array\s+\$\w{1,80}/m.test(content)
    || content.includes('ArrayCollection')) {
    issues.push(`${className}: has mutable collection property (array/ArrayCollection) — clone or use immutable collection`);
  }

  // Extends non-readonly class (detect extends keyword)
  const extendsM = /\bclass\s+\w{1,80}\s+extends\s+(\w{1,80})/m.exec(content);
  if (extendsM) {
    const parent = extendsM[1];
    // Check if parent is AbstractValueObject, ValueObject, or similar
    if (!/(?:Abstract)?(?:Value)?Object|VO|ValueObject/i.test(parent)) {
      issues.push(`${className}: extends '${parent}' — parent may be mutable, violating value object immutability`);
    }
  }

  // __clone without deep copy of array/object properties
  if (content.includes('__clone') && !content.includes('clone $this->')) {
    issues.push(`${className}: implements __clone without deep-copying collection properties`);
  }

  return { file: path.relative(appPath, filePath), className, isFinal, hasPublicMutableProps, witherCount, issues };
}

export function listPhpImmutableValueObjects(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const vos: ValueObject[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const vo = parseValueObject(file, appPath);
      if (vo) vos.push(vo);
    }

    if (vos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No immutable value objects found in src/.\n\nExample:\n  final class Money\n  {\n    public function __construct(\n      private readonly int $amount,\n      private readonly string $currency,\n    ) {}\n    public function withAmount(int $amount): static { return new static($amount, $this->currency); }\n  }',
        }],
      };
    }

    const trulyImmutable = vos.filter((v) => !v.hasPublicMutableProps && v.issues.length === 0).length;
    const totalIssues = vos.reduce((s, v) => s + v.issues.length, 0);

    let text = `PHP Immutable Value Objects\n${'='.repeat(55)}\n`;
    text += `\nValue objects: ${vos.length}  Truly immutable: ${trulyImmutable}  Issues: ${totalIssues}\n`;
    text += `  Final:         ${vos.filter((v) => v.isFinal).length}\n`;
    text += `  With withers:  ${vos.filter((v) => v.witherCount > 0).length}\n`;

    for (const v of vos.sort((a, b) => b.issues.length - a.issues.length || a.className.localeCompare(b.className))) {
      const tags: string[] = [];
      if (v.isFinal) tags.push('final');
      if (v.witherCount > 0) tags.push(`withers:${v.witherCount}`);
      if (v.hasPublicMutableProps) tags.push('mutable-props');
      text += `\n  ${v.className.padEnd(35)} ${tags.join(', ')}\n`;
      text += `    ${v.file}\n`;
      for (const issue of v.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpImmutableValueObjectStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const vos: ValueObject[] = [];

    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const vo = parseValueObject(file, appPath);
        if (vo) vos.push(vo);
      }
    }

    const trulyImmutable = vos.filter((v) => !v.hasPublicMutableProps && v.issues.length === 0).length;

    let text = `PHP Immutable Value Object Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total value objects:     ${vos.length}\n`;
    text += `  Truly immutable:       ${trulyImmutable}\n`;
    text += `  Final:                 ${vos.filter((v) => v.isFinal).length}\n`;
    text += `  With wither methods:   ${vos.filter((v) => v.witherCount > 0).length}\n`;
    text += `  With public mut. props: ${vos.filter((v) => v.hasPublicMutableProps).length}\n`;
    text += `With issues:             ${vos.filter((v) => v.issues.length > 0).length}\n`;
    text += `Total issues:            ${vos.reduce((s, v) => s + v.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpImmutableValueObjectTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_immutable_value_objects',
      description: 'List PHP immutable value objects: final classes, readonly properties, wither methods, public mutable props warning, mutable collection warning, extends mutable class, __clone without deep copy',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_immutable_value_object_stats',
      description: 'Statistics for PHP immutable value objects: total, truly immutable, final, with withers, with issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
