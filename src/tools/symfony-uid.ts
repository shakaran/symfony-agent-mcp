/**
 * Symfony UID Component Inspector
 *
 * Distinct from doctrine-types.ts (column type mapping) and entities.ts (entity listing).
 * Focuses on the Symfony UID component (symfony/uid):
 *
 * Entity UUID/ULID column analysis:
 *   - #[Column(type: 'uuid')] / type: 'ulid' in Doctrine entity
 *   - #[Column(type: 'uuid_binary')] / #[Column(type: 'uuid_binary_ordered_time')]
 *   - #[Id] with UUID type (surrogate vs natural key)
 *   - $id typed as Uuid / Ulid / UuidV4 / UuidV6 / UuidV7 (Symfony UID classes)
 *
 * Factory / DI usage:
 *   - UlidFactory / UuidFactory service injection
 *   - Uuid::v4() / Uuid::v6() / Uuid::v7() static calls
 *   - Ulid::generate() calls
 *
 * Version consistency:
 *   - Mixing UuidV4 and UuidV7 in different entities (inconsistent strategy)
 *   - Comparing UUIDs from different versions (not interoperable sort-order)
 *
 * Form integration:
 *   - UuidType / UlidType in form fields
 *
 * Analysis:
 *   - uuid column without doctrine/orm extension for uuid support
 *   - Uuid::v4() (random) instead of Uuid::v7() (time-ordered, better index performance)
 *   - UUIDs stored as VARCHAR instead of BINARY (performance)
 *   - Mixed UUID versions across primary keys
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

type UuidVersion = 'v4' | 'v6' | 'v7' | 'ulid' | 'other';

interface UidEntity {
  class: string;
  file: string;
  columnType: string;
  uidVersion: UuidVersion;
  isIdColumn: boolean;
  isBinaryStorage: boolean;
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

function detectUidVersion(content: string): UuidVersion {
  if (content.includes('UuidV7') || /Uuid::v7\(\)/.test(content)) return 'v7';
  if (content.includes('UuidV6') || /Uuid::v6\(\)/.test(content)) return 'v6';
  if (content.includes('UuidV4') || /Uuid::v4\(\)/.test(content)) return 'v4';
  if (content.includes('Ulid') || content.includes('ulid')) return 'ulid';
  return 'other';
}

function parseUidEntity(filePath: string, appPath: string): UidEntity | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasUid = content.includes("type: 'uuid'") || content.includes('type: "uuid"') ||
                 content.includes("type: 'ulid'") || content.includes('type: "ulid"') ||
                 content.includes('uuid_binary') || content.includes('Uuid') || content.includes('Ulid');
  if (!hasUid) return null;
  if (!content.includes('#[Entity') && !content.includes('@Entity') && !content.includes('extends ')) return null;
  if (content.includes('namespace Symfony\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const typeM = /type\s*:\s*['"]([^'"]*uuid[^'"]*|ulid)['"]/.exec(content);
  const columnType = typeM?.[1] ?? 'uuid';

  const isBinaryStorage = content.includes('uuid_binary');
  const isIdColumn = content.includes('#[Id]') || content.includes('@Id');
  const uidVersion = detectUidVersion(content);

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    columnType,
    uidVersion,
    isIdColumn,
    isBinaryStorage,
  };
}

function scanUidUsage(appPath: string): { factoryUsage: number; staticCalls: Record<string, number>; formUsage: number } {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return { factoryUsage: 0, staticCalls: {}, formUsage: 0 };

  let factoryUsage = 0;
  let formUsage = 0;
  const staticCalls: Record<string, number> = {};

  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!content.includes('Uuid') && !content.includes('Ulid')) continue;

    if (content.includes('UlidFactory') || content.includes('UuidFactory')) factoryUsage++;
    if (content.includes('UuidType') || content.includes('UlidType')) formUsage++;

    for (const ver of ['v4', 'v6', 'v7'] as const) {
      const regex = new RegExp(`Uuid::${ver}\\(\\)`, 'g');
      const matches = content.match(regex);
      if (matches) staticCalls[ver] = (staticCalls[ver] ?? 0) + matches.length;
    }
  }
  return { factoryUsage, staticCalls, formUsage };
}

export function listUidConfig(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const entities: UidEntity[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseUidEntity(file, appPath);
      if (e) entities.push(e);
    }

    const { factoryUsage, staticCalls, formUsage } = scanUidUsage(appPath);

    if (entities.length === 0 && factoryUsage === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Symfony UID usage detected.\n\nInstall:\n  composer require symfony/uid\n\nDoctrine entity example:\n  #[Id, Column(type: \'uuid\')]\n  private Uuid $id;\n\n  public function __construct()\n  {\n    $this->id = Uuid::v7();\n  }',
        }],
      };
    }

    const versions = entities.map((e) => e.uidVersion).filter((v) => v !== 'other' && v !== 'ulid');
    const mixedVersions = new Set(versions).size > 1;

    let text = `Symfony UID Configuration\n${'='.repeat(55)}\n`;
    text += `\nEntities with UUID/ULID columns: ${entities.length}\n`;
    text += `  As primary key:  ${entities.filter((e) => e.isIdColumn).length}\n`;
    text += `  Binary storage:  ${entities.filter((e) => e.isBinaryStorage).length}\n`;
    text += `Factory injections: ${factoryUsage}\n`;
    text += `Form UID fields:    ${formUsage}\n`;

    if (Object.keys(staticCalls).length > 0) {
      text += `\nStatic Uuid::vX() calls:\n`;
      for (const [ver, count] of Object.entries(staticCalls).sort()) {
        const note = ver === 'v4' ? ' (random — consider v7 for sortable IDs)' : '';
        text += `  Uuid::${ver}(): ${count}${note}\n`;
      }
    }

    if (entities.length > 0) {
      text += `\nUID entities:\n`;
      for (const e of entities.sort((a, b) => a.class.localeCompare(b.class))) {
        const id  = e.isIdColumn ? ' [primary key]' : '';
        const bin = e.isBinaryStorage ? ' [binary]' : '';
        text += `  ${e.class.padEnd(30)} ${e.columnType.padEnd(18)} ${e.uidVersion}${id}${bin}\n`;
      }
    }

    const issues: string[] = [];
    if (mixedVersions) issues.push(`Mixed UUID versions (${[...new Set(versions)].join(', ')}) across entities — inconsistent sort order`);
    const v4Count = staticCalls['v4'] ?? 0;
    if (v4Count > 0) issues.push(`Uuid::v4() (random) used ${v4Count} time(s) — Uuid::v7() is time-ordered and better for database indexing`);
    const nonBinaryPk = entities.filter((e) => e.isIdColumn && !e.isBinaryStorage && e.columnType.includes('uuid'));
    if (nonBinaryPk.length > 0) {
      issues.push(`${nonBinaryPk.length} UUID primary key(s) stored as VARCHAR — consider uuid_binary for better performance`);
    }

    if (issues.length > 0) {
      text += `\nIssues (${issues.length}):\n`;
      for (const issue of issues) text += `  ⚠ ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUidStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: UidEntity[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseUidEntity(file, appPath);
        if (e) entities.push(e);
      }
    }
    const { factoryUsage, staticCalls } = scanUidUsage(appPath);

    let text = `UID Statistics\n${'='.repeat(40)}\n\n`;
    text += `UID entities:        ${entities.length}\n`;
    text += `  Primary keys:      ${entities.filter((e) => e.isIdColumn).length}\n`;
    text += `  Binary storage:    ${entities.filter((e) => e.isBinaryStorage).length}\n`;
    text += `  ULID:              ${entities.filter((e) => e.uidVersion === 'ulid').length}\n`;
    text += `Factory usage:       ${factoryUsage}\n`;
    text += `Uuid::v4() calls:    ${staticCalls['v4'] ?? 0}\n`;
    text += `Uuid::v7() calls:    ${staticCalls['v7'] ?? 0}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getUidTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_uid_config',
      description: 'Show Symfony UID usage: UUID/ULID entity columns, primary key detection, binary vs VARCHAR storage, Uuid::v4/v6/v7 call sites, UlidFactory/UuidFactory DI injection, Form UID fields, mixed UUID version warning, v4 random UUID performance note',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_uid_stats',
      description: 'Show UID statistics: entity count, primary key count, binary storage count, ULID count, factory usage, v4/v7 call counts',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
