/**
 * PHP Custom Attributes Inspector
 *
 * Distinct from symfony-custom-constraints.ts (validator constraints) and
 * symfony-autowire-attributes.ts (DI autowiring attributes).
 * Focuses on user-defined PHP #[Attribute] classes in src/:
 *
 * Attribute definition:
 *   #[Attribute(Attribute::TARGET_CLASS | Attribute::TARGET_METHOD)]
 *   class MyAttribute
 *   {
 *     public function __construct(public readonly string $value) {}
 *   }
 *
 * Attribute targets (bitmask):
 *   - Attribute::TARGET_CLASS
 *   - Attribute::TARGET_FUNCTION
 *   - Attribute::TARGET_METHOD
 *   - Attribute::TARGET_PROPERTY
 *   - Attribute::TARGET_CLASS_CONSTANT
 *   - Attribute::TARGET_PARAMETER
 *   - Attribute::TARGET_ALL (default)
 *
 * Reader patterns:
 *   - ReflectionClass::getAttributes(MyAttribute::class)
 *   - ReflectionMethod::getAttributes()
 *   - Symfony AttributeAutoconfigurationPass
 *   - Doctrine annotation reader / attribute reader
 *
 * Analysis:
 *   - Attribute class defined but no reader code found in src/ (orphaned attribute)
 *   - Attribute without explicit target (TARGET_ALL — may be applied anywhere by mistake)
 *   - Attribute class without readonly constructor properties (mutable state in attribute)
 *   - IS_REPEATABLE flag check
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface CustomAttribute {
  class: string;
  file: string;
  targets: string[];
  isRepeatable: boolean;
  hasReadonlyProps: boolean;
  usageCount: number;
  hasReader: boolean;
  issues: string[];
}

const TARGET_MAP: Record<string, string> = {
  'TARGET_CLASS':          'class',
  'TARGET_FUNCTION':       'function',
  'TARGET_METHOD':         'method',
  'TARGET_PROPERTY':       'property',
  'TARGET_CLASS_CONSTANT': 'constant',
  'TARGET_PARAMETER':      'parameter',
  'TARGET_ALL':            'all',
};


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

function parseAttributeClass(filePath: string, appPath: string): CustomAttribute | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  // Must have #[Attribute] declaration
  if (!content.includes('#[Attribute') && !content.includes('#[\\Attribute')) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\') ||
      content.includes('namespace JMS\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  // Extract targets
  const attrDeclM = /#\[(?:\\?Attribute)\s*\(([^)]*)\)\]/.exec(content);
  const targets: string[] = [];
  const isRepeatable = attrDeclM ? attrDeclM[1].includes('IS_REPEATABLE') : false;

  if (attrDeclM) {
    for (const [flag, label] of Object.entries(TARGET_MAP)) {
      if (attrDeclM[1].includes(flag)) targets.push(label);
    }
  }
  if (targets.length === 0) targets.push('all'); // No args = TARGET_ALL

  const hasReadonlyProps = content.includes('readonly ') || /public\s+readonly/.test(content);

  const issues: string[] = [];
  if (targets.includes('all') && !attrDeclM?.[1]) {
    issues.push('No explicit target — Attribute::TARGET_ALL applies everywhere (consider restricting)');
  }
  if (!hasReadonlyProps) {
    issues.push('Attribute properties are not readonly — attribute instances should be immutable');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    targets,
    isRepeatable,
    hasReadonlyProps,
    usageCount: 0,
    hasReader: false,
    issues,
  };
}

export function listCustomPhpAttributes(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const attributes: CustomAttribute[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const a = parseAttributeClass(file, appPath);
      if (a) attributes.push(a);
    }

    if (attributes.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom PHP #[Attribute] classes found in src/.\n\nCreate a custom attribute:\n  #[Attribute(Attribute::TARGET_CLASS | Attribute::TARGET_METHOD)]\n  class SensitiveOperation\n  {\n    public function __construct(\n      public readonly string $level = \'info\',\n    ) {}\n  }',
        }],
      };
    }

    // Scan usage and reader patterns across all PHP files
    const allFiles = getAllPhpFiles(srcDir);
    for (const attr of attributes) {
      let usageCount = 0;
      let hasReader  = false;
      for (const file of allFiles) {
        if (file === path.join(appPath, attr.file)) continue;
        let content = '';
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        if (content.includes(`#[${attr.class}`) || content.includes(`#[\\${attr.class}`)) usageCount++;
        if (content.includes(`getAttributes(${attr.class}`) ||
            content.includes(`getAttributes(${attr.class}::class`) ||
            content.includes(`new ${attr.class}`)) {
          hasReader = true;
        }
      }
      attr.usageCount = usageCount;
      attr.hasReader  = hasReader;
      if (usageCount === 0) {
        attr.issues.push('Attribute class never used (no #[ClassName] found in src/)');
      }
      if (!hasReader && usageCount > 0) {
        attr.issues.push('Attribute is used but no reader/processor found — attribute has no runtime effect');
      }
    }

    const totalIssues = attributes.reduce((s, a) => s + a.issues.length, 0);

    let text = `Custom PHP Attributes\n${'='.repeat(55)}\n`;
    text += `\nCustom attributes: ${attributes.length}  Issues: ${totalIssues}\n`;

    for (const a of attributes.sort((x, y) => y.issues.length - x.issues.length || x.class.localeCompare(y.class))) {
      const rep    = a.isRepeatable ? '  repeatable' : '';
      const ro     = a.hasReadonlyProps ? '✓ readonly' : '⚠ mutable';
      const reader = a.hasReader ? '✓ reader' : '⚠ no reader';
      text += `  ${a.class.padEnd(35)} targets: ${a.targets.join('|').padEnd(20)} ${ro}  ${reader}  used: ${a.usageCount}x${rep}\n`;
      for (const issue of a.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomAttributeStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const attributes: CustomAttribute[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const a = parseAttributeClass(file, appPath);
        if (a) attributes.push(a);
      }
    }

    let text = `Custom Attribute Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom attributes:      ${attributes.length}\n`;
    text += `  With TARGET_ALL:      ${attributes.filter((a) => a.targets.includes('all')).length}\n`;
    text += `  Repeatable:           ${attributes.filter((a) => a.isRepeatable).length}\n`;
    text += `  With readonly props:  ${attributes.filter((a) => a.hasReadonlyProps).length}\n`;
    text += `Issues:                 ${attributes.reduce((s, a) => s + a.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getCustomAttributeTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_custom_php_attributes',
      description: 'Show user-defined PHP #[Attribute] classes in src/: target bitmask (class/method/property/parameter/all), IS_REPEATABLE, readonly property check, usage count scan, reader/processor detection; warns on TARGET_ALL, mutable attributes, never-used, used-but-no-reader',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_custom_attribute_stats',
      description: 'Show custom attribute statistics: total count, TARGET_ALL count, repeatable count, readonly-props count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
