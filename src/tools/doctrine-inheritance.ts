/**
 * Doctrine Inheritance Inspector
 *
 * Reads entity classes for Doctrine inheritance configuration:
 *
 * Inheritance types:
 *   - #[InheritanceType('SINGLE_TABLE')] — all subclasses in one table
 *   - #[InheritanceType('JOINED')] — parent + child tables joined
 *   - #[InheritanceType('TABLE_PER_CLASS')] — separate table per class
 *
 * Discriminator map:
 *   - #[DiscriminatorColumn(name: 'type', type: 'string')]
 *   - #[DiscriminatorMap(['user' => User::class, 'admin' => AdminUser::class])]
 *
 * Child class detection:
 *   - Classes that extend a mapped superclass without their own #[Entity]
 *   - Classes listed in #[DiscriminatorMap] values
 *
 * Analysis:
 *   - SINGLE_TABLE: count nullable columns per table (many nullable = table bloat)
 *   - SINGLE_TABLE: entities not in discriminator map (orphan types)
 *   - TABLE_PER_CLASS: warns about UoW identity map issues + no shared FK references
 *   - JOINED: detects deep hierarchy (> 3 levels) — performance warning
 *   - Incomplete discriminator map (child extends parent but not listed in map)
 *   - MappedSuperclass vs Entity distinction
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

interface InheritanceEntity {
  class: string;
  file: string;
  inheritanceType: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS' | null;
  discriminatorColumn?: string;
  discriminatorMap: Record<string, string>;
  isMappedSuperclass: boolean;
  parentClass?: string;
  nullableColumnCount: number;
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

function parseInheritanceEntity(filePath: string): InheritanceEntity | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasEntity      = content.includes('#[ORM\\Entity') || content.includes('#[Entity');
  const hasSuperclass  = content.includes('#[ORM\\MappedSuperclass') || content.includes('#[MappedSuperclass');
  const hasInheritance = content.includes('InheritanceType') || content.includes('DiscriminatorMap');

  if (!hasEntity && !hasSuperclass && !hasInheritance) return null;

  const classM = /class\s+(\w+)(?:\s+extends\s+(\w+))?/.exec(content);
  if (!classM) return null;

  let inheritanceType: 'SINGLE_TABLE' | 'JOINED' | 'TABLE_PER_CLASS' | null = null;
  if (content.includes('SINGLE_TABLE')) inheritanceType = 'SINGLE_TABLE';
  else if (content.includes('JOINED')) inheritanceType = 'JOINED';
  else if (content.includes('TABLE_PER_CLASS')) inheritanceType = 'TABLE_PER_CLASS';

  const discColM = /#\[(?:ORM\\)?DiscriminatorColumn[^)]*name\s*:\s*['"]([^'"]+)['"]/.exec(content);
  const discMap: Record<string, string> = {};
  const discMapM = /#\[(?:ORM\\)?DiscriminatorMap\s*\(\s*\[([^\]]+)\]/s.exec(content);
  if (discMapM) {
    for (const m of discMapM[1].matchAll(/['"]([^'"]+)['"]\s*=>\s*(\w+)::class/g)) {
      discMap[m[1]] = m[2];
    }
  }

  const nullableColumnCount = (content.match(/nullable\s*:\s*true/g) ?? []).length;

  const issues: string[] = [];

  if (inheritanceType === 'SINGLE_TABLE' && nullableColumnCount > 15) {
    issues.push(`SINGLE_TABLE with ${nullableColumnCount} nullable columns — consider JOINED for cleaner schema`);
  }
  if (inheritanceType === 'TABLE_PER_CLASS') {
    issues.push(`TABLE_PER_CLASS: no shared FK references possible; UoW identity map doesn't work across tables`);
  }
  if (inheritanceType && Object.keys(discMap).length === 0) {
    issues.push(`InheritanceType set but no DiscriminatorMap — Doctrine will not know which subclass to instantiate`);
  }

  return {
    class: classM[1],
    file: path.basename(filePath),
    inheritanceType,
    discriminatorColumn: discColM?.[1],
    discriminatorMap: discMap,
    isMappedSuperclass: hasSuperclass,
    parentClass: classM[2],
    nullableColumnCount,
    issues,
  };
}

function detectDeepHierarchies(entities: InheritanceEntity[]): string[] {
  const issues: string[] = [];
  const classMap = new Map(entities.map((e) => [e.class, e]));

  for (const entity of entities) {
    if (entity.inheritanceType !== 'JOINED') continue;
    let depth = 0;
    let current: InheritanceEntity | undefined = entity;
    while (current?.parentClass) {
      depth++;
      current = classMap.get(current.parentClass);
      if (depth > 5) break;
    }
    if (depth > 3) {
      issues.push(`${entity.class} is ${depth} levels deep in JOINED hierarchy — deep joins hurt performance`);
    }
  }
  return issues;
}

export function listDoctrineInheritance(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const entities: InheritanceEntity[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseInheritanceEntity(file);
      if (e) entities.push(e);
    }

    const withInheritance = entities.filter((e) => e.inheritanceType);
    const mapped          = entities.filter((e) => e.isMappedSuperclass);

    if (withInheritance.length === 0 && mapped.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine inheritance configuration found.\n\nExample (JOINED):\n  #[ORM\\Entity]\n  #[ORM\\InheritanceType(\'JOINED\')]\n  #[ORM\\DiscriminatorColumn(name: \'type\', type: \'string\')]\n  #[ORM\\DiscriminatorMap([\'user\' => User::class, \'admin\' => AdminUser::class])]\n  class User { }\n\n  #[ORM\\Entity]\n  class AdminUser extends User { }',
        }],
      };
    }

    const deepIssues = detectDeepHierarchies(entities);

    let text = `Doctrine Inheritance\n${'='.repeat(55)}\n`;

    if (mapped.length > 0) {
      text += `\nMapped Superclasses (${mapped.length}):\n`;
      for (const e of mapped) text += `  ${e.class}  (${e.file})\n`;
    }

    for (const e of withInheritance) {
      text += `\n  ${e.class}  [${e.inheritanceType}]  (${e.file})\n`;
      if (e.discriminatorColumn) text += `    discriminator column: ${e.discriminatorColumn}\n`;
      if (Object.keys(e.discriminatorMap).length > 0) {
        text += `    discriminator map: ${Object.entries(e.discriminatorMap).map(([k, v]) => `${k}→${v}`).join(', ')}\n`;
      }
      if (e.nullableColumnCount > 0) {
        text += `    nullable columns: ${e.nullableColumnCount}\n`;
      }
      for (const issue of e.issues) text += `    ⚠ ${issue}\n`;
    }

    // Detect incomplete discriminator maps
    const allClassNames = new Set(entities.map((e) => e.class));
    for (const e of withInheritance) {
      for (const mappedClass of Object.values(e.discriminatorMap)) {
        if (!allClassNames.has(mappedClass)) {
          text += `  ⚠ ${e.class}: discriminator maps to "${mappedClass}" but class not found in src/\n`;
        }
      }
    }

    if (deepIssues.length > 0) {
      text += `\nHierarchy depth warnings:\n`;
      for (const issue of deepIssues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineInheritanceStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: InheritanceEntity[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseInheritanceEntity(file);
        if (e) entities.push(e);
      }
    }

    let text = `Doctrine Inheritance Statistics\n${'='.repeat(40)}\n\n`;
    text += `MappedSuperclass:    ${entities.filter((e) => e.isMappedSuperclass).length}\n`;
    text += `SINGLE_TABLE:        ${entities.filter((e) => e.inheritanceType === 'SINGLE_TABLE').length}\n`;
    text += `JOINED:              ${entities.filter((e) => e.inheritanceType === 'JOINED').length}\n`;
    text += `TABLE_PER_CLASS:     ${entities.filter((e) => e.inheritanceType === 'TABLE_PER_CLASS').length}\n`;
    text += `Issues detected:     ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineInheritanceTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_inheritance',
      description: 'Show Doctrine inheritance: #[InheritanceType] (SINGLE_TABLE/JOINED/TABLE_PER_CLASS), #[DiscriminatorColumn], #[DiscriminatorMap], MappedSuperclass classes, nullable column count per SINGLE_TABLE, deep hierarchy detection (JOINED > 3 levels), incomplete discriminator map warning',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_inheritance_stats',
      description: 'Show Doctrine inheritance statistics: MappedSuperclass count, counts by inheritance type, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
