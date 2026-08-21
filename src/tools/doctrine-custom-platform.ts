/**
 * Doctrine Custom Platform Inspector
 *
 * Scans src/**\/*.php for custom Doctrine DBAL platform implementations:
 *   - Classes extending AbstractPlatform, AbstractMySQLPlatform,
 *     PostgreSQLPlatform, SQLitePlatform
 *   - Methods overridden: getColumnDeclarationSQL, getDateTimeFormatString,
 *     getDateFormatString, getName, initializeDoctrineTypeMappings,
 *     getVarcharTypeDeclarationSQLSnippet
 *   - Classes implementing custom type mapping via AbstractType or Type::addType()
 *   - Type::overrideType( calls — overriding built-in types
 *   - Count overridden methods per platform class
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface DoctrineCustomPlatformEntry {
  file: string;
  class: string;
  parentClass: string;
  overriddenMethods: string[];
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
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

const PLATFORM_PARENT_CLASSES = [
  'AbstractPlatform',
  'AbstractMySQLPlatform',
  'PostgreSQLPlatform',
  'SQLitePlatform',
  'MariaDBPlatform',
  'MySQL80Platform',
  'MySQL57Platform',
  'OraclePlatform',
  'SQLServerPlatform',
];

const TRACKED_METHODS = [
  'getColumnDeclarationSQL',
  'getDateTimeFormatString',
  'getDateFormatString',
  'getTimeFormatString',
  'getName',
  'initializeDoctrineTypeMappings',
  'getVarcharTypeDeclarationSQLSnippet',
  'getBooleanTypeDeclarationSQL',
  'getIntegerTypeDeclarationSQL',
  'getBigIntTypeDeclarationSQL',
  'getSmallIntTypeDeclarationSQL',
  'getClobTypeDeclarationSQL',
  'getBlobTypeDeclarationSQL',
  'getListDatabasesSQL',
  'getListTablesSQL',
  'getListColumnsSQL',
  'getListIndexesSQL',
  'getDropTableSQL',
  'getCreateTableSQL',
  'getAlterTableSQL',
];

const TYPE_PARENT_CLASSES = [
  'AbstractType',
  'StringType',
  'IntegerType',
  'TextType',
  'FloatType',
  'BooleanType',
  'DateTimeType',
  'JsonType',
  'ArrayType',
  'GuidType',
  'ObjectType',
];

function extractParentClass(content: string): string | null {
  const m = /class\s+\w{1,120}\s+extends\s+([\w\\]{1,120})/.exec(content);
  return m ? m[1].trim() : null;
}

function extractClassName(content: string): string | null {
  const m = /class\s+(\w{1,120})/.exec(content);
  return m ? m[1] : null;
}

function findOverriddenMethods(content: string, methodNames: string[]): string[] {
  const found: string[] = [];
  for (const method of methodNames) {
    // Match function declaration for this method name (not in a comment)
    const methodRe = new RegExp(`function\\s+${method}\\s*\\(`, 'g');
    if (methodRe.test(content)) found.push(method);
  }
  return found;
}

function findTypeAddOverrideCalls(content: string): { addType: string[]; overrideType: string[] } {
  const addType: string[] = [];
  const overrideType: string[] = [];

  const addRe = /Type::addType\(\s*['"]([^'"]{1,120})['"]\s*,\s*['"]([^'"]{1,200})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(content)) !== null) {
    addType.push(`${m[1]} => ${m[2]}`);
  }

  const overrideRe = /Type::overrideType\(\s*['"]([^'"]{1,120})['"]/g;
  while ((m = overrideRe.exec(content)) !== null) {
    overrideType.push(m[1]);
  }

  return { addType, overrideType };
}

function buildCustomPlatformEntries(appPath: string): DoctrineCustomPlatformEntry[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const entries: DoctrineCustomPlatformEntry[] = [];

  for (const filePath of getAllPhpFiles(srcDir)) {
    const content = safeRead(filePath, appPath);
    if (!content) continue;

    // Skip Doctrine's own namespace
    if (content.includes('namespace Doctrine\\')) continue;

    const parentClass = extractParentClass(content);
    if (!parentClass) continue;

    const shortParent = parentClass.includes('\\')
      ? (parentClass.split('\\').pop() ?? parentClass)
      : parentClass;

    const isPlatform = PLATFORM_PARENT_CLASSES.includes(shortParent);
    const isType = TYPE_PARENT_CLASSES.includes(shortParent);

    if (!isPlatform && !isType) {
      // Still check for Type::addType / Type::overrideType calls anywhere in the file
      if (!content.includes('Type::addType') && !content.includes('Type::overrideType')) continue;
    }

    const className = extractClassName(content);
    if (!className) continue;

    const relPath = path.relative(appPath, filePath);
    const issues: string[] = [];
    let overriddenMethods: string[] = [];

    if (isPlatform) {
      overriddenMethods = findOverriddenMethods(content, TRACKED_METHODS);

      if (overriddenMethods.includes('getName')) {
        issues.push('getName() override detected — deprecated since DBAL 3.x; use getDatabasePlatform() identifier instead');
      }
      if (overriddenMethods.includes('initializeDoctrineTypeMappings')) {
        issues.push('initializeDoctrineTypeMappings() override — verify all native type names are correctly mapped');
      }
      if (overriddenMethods.length > 5) {
        issues.push(`${overriddenMethods.length} tracked methods overridden — heavy platform customization; test thoroughly on upgrades`);
      }
      if (overriddenMethods.includes('getDateTimeFormatString') || overriddenMethods.includes('getDateFormatString')) {
        issues.push('Date/time format string overridden — ensure Doctrine DateTime hydration matches database output format');
      }
    }

    if (isType) {
      overriddenMethods = findOverriddenMethods(content, [
        'getSQLDeclaration', 'convertToPHPValue', 'convertToDatabaseValue',
        'getName', 'requiresSQLCommentHint', 'getMappedDatabaseTypes',
        'convertToPHPValueSQL', 'convertToDatabaseValueSQL',
      ]);

      if (overriddenMethods.includes('getName')) {
        issues.push('getName() override on custom type — register type name consistently via Type::addType()');
      }
    }

    const { addType, overrideType } = findTypeAddOverrideCalls(content);
    if (overrideType.length > 0) {
      for (const ot of overrideType) {
        issues.push(`Type::overrideType('${ot}') called — overriding built-in Doctrine type can cause unexpected behavior across all entities using this type`);
      }
      overriddenMethods = [...overriddenMethods, ...overrideType.map((t) => `overrideType:${t}`)];
    }
    if (addType.length > 0) {
      overriddenMethods = [...overriddenMethods, ...addType.map((t) => `addType:${t}`)];
    }

    if (overriddenMethods.length === 0 && issues.length === 0) continue;

    entries.push({
      file: relPath,
      class: className,
      parentClass: shortParent,
      overriddenMethods,
      issues,
    });
  }

  return entries;
}

export function listDoctrineCustomPlatform(appPath: string): McpToolResult {
  try {
    const entries = buildCustomPlatformEntries(appPath);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No custom Doctrine platform or type classes found in src/.' }] };
    }

    const totalIssues = entries.reduce((s, e) => s + e.issues.length, 0);
    let text = `Doctrine Custom Platform Inspector\n${'='.repeat(55)}\n\n`;
    text += `Custom platform/type classes: ${entries.length}  Issues: ${totalIssues}\n\n`;

    const platforms = entries.filter((e) => PLATFORM_PARENT_CLASSES.includes(e.parentClass));
    const types = entries.filter((e) => TYPE_PARENT_CLASSES.includes(e.parentClass));
    const other = entries.filter((e) => !PLATFORM_PARENT_CLASSES.includes(e.parentClass) && !TYPE_PARENT_CLASSES.includes(e.parentClass));

    if (platforms.length > 0) {
      text += `Custom Platforms (${platforms.length}):\n`;
      for (const e of platforms.sort((a, b) => b.issues.length - a.issues.length)) {
        text += `  ${e.class} extends ${e.parentClass}\n`;
        text += `    File: ${e.file}\n`;
        if (e.overriddenMethods.length > 0) {
          const cleanMethods = e.overriddenMethods.filter((m) => !m.startsWith('addType:') && !m.startsWith('overrideType:'));
          if (cleanMethods.length > 0) {
            text += `    Overridden methods (${cleanMethods.length}): ${cleanMethods.join(', ')}\n`;
          }
        }
        for (const issue of e.issues) text += `    Issue: ${issue}\n`;
      }
      text += '\n';
    }

    if (types.length > 0) {
      text += `Custom Types (${types.length}):\n`;
      for (const e of types.sort((a, b) => b.issues.length - a.issues.length)) {
        text += `  ${e.class} extends ${e.parentClass}\n`;
        text += `    File: ${e.file}\n`;
        const cleanMethods = e.overriddenMethods.filter((m) => !m.startsWith('addType:') && !m.startsWith('overrideType:'));
        if (cleanMethods.length > 0) {
          text += `    Overridden methods: ${cleanMethods.join(', ')}\n`;
        }
        for (const issue of e.issues) text += `    Issue: ${issue}\n`;
      }
      text += '\n';
    }

    if (other.length > 0) {
      text += `Type registration files (${other.length}):\n`;
      for (const e of other) {
        text += `  ${e.class}  (${e.file})\n`;
        for (const m of e.overriddenMethods) text += `    ${m}\n`;
        for (const issue of e.issues) text += `    Issue: ${issue}\n`;
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineCustomPlatformStats(appPath: string): McpToolResult {
  try {
    const entries = buildCustomPlatformEntries(appPath);

    let text = `Doctrine Custom Platform Statistics\n${'='.repeat(45)}\n\n`;

    const platforms = entries.filter((e) => PLATFORM_PARENT_CLASSES.includes(e.parentClass));
    const types = entries.filter((e) => TYPE_PARENT_CLASSES.includes(e.parentClass));
    const withIssues = entries.filter((e) => e.issues.length > 0);
    const overrideTypeCalls = entries.reduce(
      (s, e) => s + e.overriddenMethods.filter((m) => m.startsWith('overrideType:')).length, 0
    );
    const addTypeCalls = entries.reduce(
      (s, e) => s + e.overriddenMethods.filter((m) => m.startsWith('addType:')).length, 0
    );
    const totalOverrides = entries.reduce(
      (s, e) => s + e.overriddenMethods.filter((m) => !m.startsWith('addType:') && !m.startsWith('overrideType:')).length, 0
    );

    text += `Custom platform classes:   ${platforms.length}\n`;
    text += `Custom type classes:       ${types.length}\n`;
    text += `Classes with issues:       ${withIssues.length}\n`;
    text += `Total method overrides:    ${totalOverrides}\n`;
    text += `Type::addType() calls:     ${addTypeCalls}\n`;
    text += `Type::overrideType() calls: ${overrideTypeCalls}${overrideTypeCalls > 0 ? ' (WARNING: overrides built-in types)' : ''}\n`;

    if (platforms.length > 0) {
      const mostOverridden = platforms.reduce(
        (a, b) => a.overriddenMethods.length > b.overriddenMethods.length ? a : b
      );
      const methodCount = mostOverridden.overriddenMethods.filter(
        (m) => !m.startsWith('addType:') && !m.startsWith('overrideType:')
      ).length;
      text += `Most overridden platform:  ${mostOverridden.class} (${methodCount} methods)\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineCustomPlatformTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_doctrine_custom_platform',
      description: 'Detect custom Doctrine DBAL platform classes (AbstractPlatform subclasses), overridden methods (getColumnDeclarationSQL, getDateTimeFormatString, getName, initializeDoctrineTypeMappings, etc.), custom Type classes, Type::addType() and Type::overrideType() calls with risk warnings',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_custom_platform_stats',
      description: 'Show Doctrine custom platform statistics: platform class count, type class count, total method overrides, addType/overrideType call counts, most-overridden platform class',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
