// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Doctrine DBAL Custom Types Inspector
 *
 * Reads doctrine.dbal.types from config/packages/doctrine.yaml:
 *   - Registered custom type name → class mapping
 *
 * Scans entities for columns using custom types:
 *   - #[ORM\Column(type: 'money')] or type: 'uuid_binary', etc.
 *
 * Detects common community types (ramsey/uuid, brick/money, etc.)
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseYamlFile } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';


interface CustomType {
  name: string;
  class: string;
  shortClass: string;
  isThirdParty: boolean;
  category: string;
}

interface TypeUsage {
  entity: string;
  file: string;
  property: string;
  typeName: string;
}

// ─── Known community types ──────────────────────────────────────────────────

const COMMUNITY_TYPE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /uuid/i,        category: 'UUID' },
  { pattern: /money/i,       category: 'Money' },
  { pattern: /phone/i,       category: 'PhoneNumber' },
  { pattern: /carbon/i,      category: 'Carbon (dates)' },
  { pattern: /enum/i,        category: 'Enum' },
  { pattern: /json/i,        category: 'JSON' },
  { pattern: /point|geo/i,   category: 'Geolocation' },
  { pattern: /encrypted/i,   category: 'Encrypted' },
  { pattern: /binary/i,      category: 'Binary' },
  { pattern: /citext/i,      category: 'Case-insensitive text' },
];

function categorizeType(name: string, cls: string): string {
  const target = `${name} ${cls}`.toLowerCase();
  for (const { pattern, category } of COMMUNITY_TYPE_PATTERNS) {
    if (pattern.test(target)) return category;
  }
  return 'Custom';
}

// ─── Config loading ─────────────────────────────────────────────────────────

function loadCustomTypes(appPath: string): CustomType[] {
  const doctrineFile = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  const raw = parseYamlFile(doctrineFile) as Record<string, unknown> | null;
  if (!raw) return [];

  const doctrine = (raw['doctrine'] ?? raw) as Record<string, unknown>;
  const dbal = doctrine['dbal'] as Record<string, unknown> | undefined;
  if (!dbal) return [];

  const typesRaw = dbal['types'] as Record<string, unknown> | undefined;
  if (!typesRaw) return [];

  const types: CustomType[] = [];
  for (const [name, val] of Object.entries(typesRaw)) {
    const cls = typeof val === 'string' ? val : String((val as Record<string, unknown>)['class'] ?? val);
    const shortClass = cls.split('\\').pop() ?? cls;
    types.push({
      name,
      class: cls,
      shortClass,
      isThirdParty: cls.includes('Ramsey') || cls.includes('Brick') || cls.includes('Misd') || cls.includes('Fresh') || !cls.startsWith('App'),
      category: categorizeType(name, cls),
    });
  }

  return types.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Entity scanning ────────────────────────────────────────────────────────

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

function scanTypeUsages(appPath: string, knownTypeNames: Set<string>): TypeUsage[] {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return [];

  const usages: TypeUsage[] = [];

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (!content.includes('#[ORM\\Column') && !content.includes('@ORM\\Column')) continue;

    const classM = /class\s+(\w+)/.exec(content);
    if (!classM) continue;

    // #[ORM\Column(type: 'typename')] or type: Types::TYPENAME
    for (const m of content.matchAll(/#\[ORM\\Column\s*\(([^)]+)\)\]/g)) {
      const options = m[1];
      const typeM = /type\s*:\s*['"]([^'"]+)['"]/.exec(options);
      if (!typeM) continue;

      const typeName = typeM[1];
      // Only report if it's a known custom type or clearly non-standard
      const isStandard = ['string', 'integer', 'int', 'float', 'decimal', 'boolean', 'bool',
        'text', 'datetime', 'datetime_immutable', 'date', 'date_immutable', 'time',
        'time_immutable', 'array', 'json', 'object', 'binary', 'blob', 'bigint',
        'smallint', 'guid', 'simple_array', 'datetimetz', 'datetimetz_immutable'].includes(typeName);

      if (!isStandard || knownTypeNames.has(typeName)) {
        const after = content.slice(m.index ?? 0, (m.index ?? 0) + 200);
        const propM = /\$(\w+)/.exec(after);
        usages.push({
          entity: classM[1],
          file: path.basename(file),
          property: propM?.[1] ?? '?',
          typeName,
        });
      }
    }
  }

  return usages.sort((a, b) => a.entity.localeCompare(b.entity));
}

// ─── Tool functions ─────────────────────────────────────────────────────────

export function listDoctrineTypes(appPath: string): McpToolResult {
  try {
    const types = loadCustomTypes(appPath);
    const knownNames = new Set(types.map((t) => t.name));
    const usages = scanTypeUsages(appPath, knownNames);

    if (types.length === 0 && usages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No custom Doctrine DBAL types found.\n\nRegister custom types in config/packages/doctrine.yaml:\n  doctrine:\n    dbal:\n      types:\n        money: App\\Doctrine\\Type\\MoneyType\n        uuid:  Ramsey\\Uuid\\Doctrine\\UuidType',
        }],
      };
    }

    let text = `Doctrine DBAL Custom Types  (${types.length} registered)\n${'='.repeat(60)}\n`;

    if (types.length > 0) {
      const byCategory = new Map<string, CustomType[]>();
      for (const t of types) {
        const list = byCategory.get(t.category) ?? [];
        list.push(t);
        byCategory.set(t.category, list);
      }

      text += `\nRegistered types:\n`;
      for (const [cat, catTypes] of [...byCategory.entries()].sort()) {
        text += `  [${cat}]\n`;
        for (const t of catTypes) {
          const src = t.isThirdParty ? '  [third-party]' : '  [custom]';
          text += `    ${t.name.padEnd(25)} ${t.shortClass}${src}\n`;
        }
      }
    }

    if (usages.length > 0) {
      text += `\nUsages in entities (${usages.length}):\n`;
      for (const u of usages) {
        text += `  ${u.entity.padEnd(30)} $${u.property.padEnd(20)} type: ${u.typeName}\n`;
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

export function getDoctrineTypeStats(appPath: string): McpToolResult {
  try {
    const types = loadCustomTypes(appPath);
    const knownNames = new Set(types.map((t) => t.name));
    const usages = scanTypeUsages(appPath, knownNames);

    let text = `Doctrine DBAL Type Statistics\n${'='.repeat(40)}\n\n`;
    text += `Custom types registered: ${types.length}\n`;
    text += `Third-party types:       ${types.filter((t) => t.isThirdParty).length}\n`;
    text += `Own (App\\) types:         ${types.filter((t) => !t.isThirdParty).length}\n`;
    text += `Type usages in entities: ${usages.length}\n`;

    if (types.length > 0) {
      const categories = [...new Set(types.map((t) => t.category))];
      text += `\nCategories: ${categories.join(', ')}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getDoctrineTypeTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };
  return [
    {
      name: 'list_doctrine_types',
      description: 'List custom Doctrine DBAL types registered in doctrine.yaml with their class, category, and which entity columns use them',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_doctrine_type_stats',
      description: 'Show Doctrine custom type statistics: total registered, third-party vs own, entity usage count, categories',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
