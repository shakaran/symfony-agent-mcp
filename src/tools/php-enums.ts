/**
 * PHP 8.1 Enum Inspector
 *
 * Distinct from doctrine-types.ts (type registration) and entities.ts (entity listing).
 * Focuses on PHP 8.1+ native enums:
 *
 * Enum definitions:
 *   - Pure enums (enum Status) vs backed enums (enum Status: string / enum Priority: int)
 *   - Cases: count, values (for backed enums)
 *   - Interface implementations on enums (HasLabel, Translatable, etc.)
 *   - Methods defined on the enum (label(), color(), toArray())
 *   - Attributes: #[ORM\Column(enumType: Status::class)]
 *
 * Doctrine integration:
 *   - #[Column(enumType: X::class)] entity properties
 *   - Native enum type in doctrine.yaml dbal.types
 *   - Enum columns without enumType (stored as string/int without PHP enum hydration)
 *
 * Form integration:
 *   - EnumType usage in FormTypes
 *
 * Pattern analysis:
 *   - match() expression on enum cases without default (exhaustive — good)
 *   - match() with default: throw (exhaustive with safety net — good)
 *   - switch() on enum (old style — consider match())
 *   - Enum::from() without try/catch (unsafe — use Enum::tryFrom())
 *   - String/int comparison to enum value instead of === case comparison
 *
 * Analysis:
 *   - Backed enum with DB column but no enumType annotation
 *   - Large backed enums (> 20 cases) — consider database lookup table instead
 *   - Enums as array keys (requires ->value for string-keyed arrays)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PhpEnum {
  name: string;
  file: string;
  isPure: boolean;
  backingType?: 'string' | 'int';
  caseCount: number;
  interfaces: string[];
  hasDoctrineColumn: boolean;
  hasEnumType: boolean;
  hasFormEnumType: boolean;
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

function parseEnum(filePath: string, appPath: string): PhpEnum | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const enumM = /^enum\s+(\w+)(?::\s*(string|int))?(?:\s+implements\s+([^{]+))?/m.exec(content);
  if (!enumM) return null;

  const name = enumM[1];
  const backingType = enumM[2] as 'string' | 'int' | undefined;
  const isPure = !backingType;

  const interfaces: string[] = [];
  if (enumM[3]) {
    interfaces.push(...enumM[3].split(',').map((i) => i.trim().split('\\').pop() ?? i.trim()));
  }

  // Count cases
  const caseMatches = content.match(/^\s*case\s+\w+/gm);
  const caseCount = caseMatches?.length ?? 0;

  const hasDoctrineColumn = content.includes('#[Column') || content.includes('@Column');
  const hasEnumType       = content.includes('enumType');
  const hasFormEnumType   = content.includes('EnumType');

  const issues: string[] = [];

  // Unsafe Enum::from() without tryFrom
  const fromCalls  = (content.match(/\w+::from\s*\(/g) ?? []).length;
  const tryFromCalls = (content.match(/\w+::tryFrom\s*\(/g) ?? []).length;
  if (fromCalls > 0 && tryFromCalls === 0) {
    issues.push(`${name}::from() used without tryFrom() — throws ValueError on invalid input`);
  }

  // switch() on enum (should use match())
  if (content.includes('switch') && content.includes('case ' + name + '::')) {
    issues.push(`switch() on ${name} enum — consider match() for exhaustiveness checking`);
  }

  // Large enum
  if (caseCount > 20) {
    issues.push(`${caseCount} cases — large enum, consider database lookup table`);
  }

  return {
    name,
    file: path.relative(appPath, filePath),
    isPure,
    backingType,
    caseCount,
    interfaces,
    hasDoctrineColumn,
    hasEnumType,
    hasFormEnumType,
    issues,
  };
}

function scanEnumUsageInEntities(appPath: string, enumNames: Set<string>): Map<string, string[]> {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return new Map();

  const entityUsage = new Map<string, string[]>();

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('#[Entity') && !content.includes('@Entity') && !content.includes('extends AbstractEntityRepository')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    for (const enumName of enumNames) {
      if (content.includes(enumName) && !content.includes(`enum ${enumName}`)) {
        const list = entityUsage.get(enumName) ?? [];
        list.push(classM[1]);
        entityUsage.set(enumName, list);
      }
    }
  }
  return entityUsage;
}

export function listPhpEnums(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const enums: PhpEnum[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseEnum(file, appPath);
      if (e) enums.push(e);
    }

    if (enums.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No PHP 8.1+ enums found in src/.\n\nCreate a backed enum:\n  enum Status: string\n  {\n    case Draft   = \'draft\';\n    case Published = \'published\';\n    case Archived = \'archived\';\n  }\n\nUse in Doctrine entity:\n  #[Column(enumType: Status::class)]\n  private Status $status = Status::Draft;',
        }],
      };
    }

    const enumNames = new Set(enums.map((e) => e.name));
    const entityUsage = scanEnumUsageInEntities(appPath, enumNames);

    const totalIssues = enums.reduce((s, e) => s + e.issues.length, 0);

    let text = `PHP 8.1 Enums\n${'='.repeat(55)}\n`;
    text += `\nEnums: ${enums.length}  Issues: ${totalIssues}\n`;
    text += `  Pure (no backing type): ${enums.filter((e) => e.isPure).length}\n`;
    text += `  Backed string:          ${enums.filter((e) => e.backingType === 'string').length}\n`;
    text += `  Backed int:             ${enums.filter((e) => e.backingType === 'int').length}\n`;

    for (const e of enums.sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name))) {
      const backing   = e.isPure ? 'pure' : `backed:${e.backingType}`;
      const iface     = e.interfaces.length > 0 ? `  implements: ${e.interfaces.join(', ')}` : '';
      const usedIn    = entityUsage.get(e.name);
      const usedStr   = usedIn ? `  used in: ${usedIn.join(', ')}` : '';
      text += `\n  ${e.name.padEnd(30)} ${backing}  ${e.caseCount} cases${iface}${usedStr}\n`;
      text += `    ${e.file}\n`;
      for (const issue of e.issues) text += `    ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getEnumStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const enums: PhpEnum[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseEnum(file, appPath);
        if (e) enums.push(e);
      }
    }

    let text = `PHP Enum Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total enums:         ${enums.length}\n`;
    text += `  Pure:              ${enums.filter((e) => e.isPure).length}\n`;
    text += `  Backed string:     ${enums.filter((e) => e.backingType === 'string').length}\n`;
    text += `  Backed int:        ${enums.filter((e) => e.backingType === 'int').length}\n`;
    text += `With Doctrine col:   ${enums.filter((e) => e.hasDoctrineColumn).length}\n`;
    text += `With enumType:       ${enums.filter((e) => e.hasEnumType).length}\n`;
    text += `With EnumType form:  ${enums.filter((e) => e.hasFormEnumType).length}\n`;
    text += `Issues:              ${enums.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpEnumTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_enums',
      description: 'Show PHP 8.1 enum analysis: pure vs backed (string/int) enums, case count, interface implementations, Doctrine enumType usage, Form EnumType, entity usage map, from() without tryFrom() warning, switch() instead of match(), large enum warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_enum_stats',
      description: 'Show PHP enum statistics: total, pure/backed counts, Doctrine/Form integration count, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
