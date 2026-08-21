/**
 * Database Schema Tool
 * Provides introspection into database schema inferred from Doctrine entities and migrations.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  listDatabaseTables,
  getTableStructure,
  getDatabaseStats,
  parseDatabaseUrl,
  getDisplayDatabaseUrl,
} from '../utils/db-connector.js';
import { parseEntities, classToTableName } from '../utils/symfony-parser.js';
import { McpToolResult } from '../server.js';

export async function listTables(appPath: string): Promise<McpToolResult> {
  try {
    const tables = await listDatabaseTables(appPath);

    if (tables.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No tables found. Make sure the app has Doctrine entities in src/Entity/ or migration files.',
        }],
      };
    }

    const entities = parseEntities(appPath);
    const entityMap = new Map(entities.map((e) => [e.tableName || classToTableName(e.name), e.name]));

    const tableList = tables.map((t) => {
      const entityName = entityMap.get(t);
      return entityName ? `  - ${t}  (entity: ${entityName})` : `  - ${t}`;
    }).join('\n');

    return {
      content: [{
        type: 'text',
        text: `Database Tables (${tables.length} total, derived from Doctrine entities):\n${tableList}`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing tables: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function getTableSchema(appPath: string, tableName: string): Promise<McpToolResult> {
  try {
    const table = await getTableStructure(appPath, tableName);

    if (!table) {
      const tables = await listDatabaseTables(appPath);
      const hint = tables.length > 0 ? `\nAvailable tables: ${tables.join(', ')}` : '';
      return {
        content: [{ type: 'text', text: `Table "${tableName}" not found.${hint}` }],
        isError: true,
      };
    }

    let schema = `Table: ${table.name}`;
    if (table.entityClass) schema += `  (entity: ${table.entityClass})`;
    schema += `\n\nColumns (${table.columns.length}):\n`;

    for (const col of table.columns) {
      let colInfo = `  - ${col.name}: ${col.type}`;
      if (!col.nullable) colInfo += ' NOT NULL';
      if (col.default !== undefined) colInfo += ` DEFAULT ${col.default}`;
      schema += `${colInfo}\n`;
    }

    if (table.indexes.length > 0) {
      schema += `\nIndexes (${table.indexes.length}):\n`;
      for (const idx of table.indexes) {
        let info = `  - ${idx.name}: ${idx.columns.join(', ')}`;
        if (idx.primary) info += ' [PRIMARY]';
        else if (idx.unique) info += ' [UNIQUE]';
        schema += `${info}\n`;
      }
    }

    if (table.foreignKeys.length > 0) {
      schema += `\nForeign Keys (${table.foreignKeys.length}):\n`;
      for (const fk of table.foreignKeys) {
        schema += `  - ${fk.name}: ${fk.column} → ${fk.referencedTable}(${fk.referencedColumn})\n`;
      }
    }

    return { content: [{ type: 'text', text: schema.trim() }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error getting table schema: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function getDatabaseInfo(appPath: string): Promise<McpToolResult> {
  try {
    const stats = await getDatabaseStats(appPath);
    const dbOptions = parseDatabaseUrl(appPath);
    const displayUrl = getDisplayDatabaseUrl(dbOptions);

    const info = `Database Information
====================
Type:           ${stats.type}
Host:           ${stats.host || 'N/A'}
Database:       ${stats.database || 'N/A'}
Connection URL: ${displayUrl}
Total Tables:   ${stats.tables}
Schema source:  ${stats.fromEntities ? 'Doctrine entities (src/Entity/)' : 'Migration files'}`;

    return { content: [{ type: 'text', text: info }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error getting database info: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function searchTables(appPath: string, query: string): Promise<McpToolResult> {
  try {
    const tables = await listDatabaseTables(appPath);
    const lowerQuery = query.toLowerCase();
    const matches = tables.filter((t) => t.toLowerCase().includes(lowerQuery));

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No tables found matching "${query}"` }] };
    }

    return {
      content: [{
        type: 'text',
        text: `Found ${matches.length} tables matching "${query}":\n${matches.map((t) => `  - ${t}`).join('\n')}`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error searching tables: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

/**
 * Validates entity-to-schema mapping by comparing entity properties to inferred schema.
 */
export async function validateSchemaMapping(appPath: string): Promise<McpToolResult> {
  try {
    const entities = parseEntities(appPath);

    if (entities.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No Doctrine entities found in src/Entity/. Cannot validate schema mapping.',
        }],
      };
    }

    const issues: string[] = [];
    const ok: string[] = [];

    for (const entity of entities) {
      const tableName = entity.tableName || classToTableName(entity.name);

      if (entity.properties.length === 0 && entity.relationships.length === 0) {
        issues.push(`⚠  ${entity.name}: No mapped properties found (check ORM attributes)`);
      } else {
        const hasId = entity.properties.some((p) => p.isId);
        if (!hasId) {
          issues.push(`⚠  ${entity.name} (table: ${tableName}): No @Id / #[ORM\\Id] property found`);
        } else {
          ok.push(`✓  ${entity.name} → ${tableName} (${entity.properties.length} columns, ${entity.relationships.length} relations)`);
        }
      }
    }

    let report = `Schema Mapping Validation
=========================
Entities checked: ${entities.length}

`;

    if (ok.length > 0) {
      report += `Valid mappings (${ok.length}):\n${ok.join('\n')}\n`;
    }

    if (issues.length > 0) {
      report += `\nIssues found (${issues.length}):\n${issues.join('\n')}\n`;
      report += `\nTo run full schema validation with Doctrine:\n  php bin/console doctrine:schema:validate\n  php bin/console doctrine:schema:update --dump-sql`;
    } else {
      report += '\nAll entity mappings look valid based on static analysis.';
    }

    return { content: [{ type: 'text', text: report }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error validating schema: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

interface MigrationFile {
  filename: string;
  version: string;
  date: string;
  description: string;
}

/**
 * Reads migration files from the project to show actual migration status.
 */
export function getMigrationStatus(appPath: string): McpToolResult {
  try {
    const migrations = findMigrationFiles(appPath);

    if (migrations.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No migration files found.\n\nExpected locations:\n  - migrations/\n  - src/Migrations/\n  - DoctrineMigrations/\n\nTo generate migrations:\n  php bin/console make:migration\n  php bin/console doctrine:migrations:diff`,
        }],
      };
    }

    const list = migrations.map((m) =>
      `  ${m.version}  ${m.date.padEnd(12)}  ${m.description}`
    ).join('\n');

    const text = `Migration Files (${migrations.length} found):\n\nVersion              Date          Description\n${'─'.repeat(70)}\n${list}\n\nTo check execution status:\n  php bin/console doctrine:migrations:status\n  php bin/console doctrine:migrations:list`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading migrations: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function findMigrationFiles(appPath: string): MigrationFile[] {
  const migrations: MigrationFile[] = [];
  const migDirs = [
    path.join(appPath, 'migrations'),
    path.join(appPath, 'src', 'Migrations'),
    path.join(appPath, 'DoctrineMigrations'),
  ];

  for (const dir of migDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.php') && /Version|Migration/i.test(f))
        .sort();

      for (const file of files) {
        const migration = parseMigrationFile(path.join(dir, file), file);
        if (migration) migrations.push(migration);
      }
    } catch {
      // Skip unreadable dir
    }
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

function parseMigrationFile(filePath: string, filename: string): MigrationFile | null {
  // Extract version from filename: Version20240115123456.php or 20240115123456.php
  const versionMatch = /(\d{14,})/.exec(filename);
  if (!versionMatch) return null;

  const version = versionMatch[1];
  const dateStr = version.slice(0, 8); // YYYYMMDD
  const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

  let description = '';
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Look for a getDescription() method
    const descMatch = /getDescription\s*\(\s*\)[^{]*{[^}]*return\s*['"](.*?)['"]/s.exec(content);
    if (descMatch) {
      description = descMatch[1].trim().slice(0, 60);
    }

    // Count up/down SQL statements
    const upMatch = content.match(/this->addSql\(/g);
    if (!description && upMatch) {
      description = `${upMatch.length} SQL statement(s)`;
    }
  } catch {
    description = '';
  }

  return { filename, version, date, description };
}

export function getDatabaseTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const appPathProp = {
    app_path: { type: 'string', description: 'Root path of the Symfony application' },
  };

  return [
    {
      name: 'list_tables',
      description: 'List all database tables inferred from Doctrine entities (src/Entity/) or migration files',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_table_schema',
      description: 'Get detailed schema for a table: columns (with types/nullable), indexes, and foreign keys derived from Doctrine entity mapping',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          table_name: { type: 'string', description: 'Name of the table to inspect' },
        },
        required: ['app_path', 'table_name'],
      },
    },
    {
      name: 'get_database_info',
      description: 'Get database type, host, database name, and total table count from DATABASE_URL or doctrine.yaml',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'search_tables',
      description: 'Search for tables by name (case-insensitive substring match)',
      inputSchema: {
        type: 'object',
        properties: {
          ...appPathProp,
          query: { type: 'string', description: 'Table name search query' },
        },
        required: ['app_path', 'query'],
      },
    },
    {
      name: 'validate_schema_mapping',
      description: 'Validate Doctrine entity mappings: checks each entity for an @Id property and mapped columns',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
    {
      name: 'get_migration_status',
      description: 'List all Doctrine migration files found in migrations/ directory with versions and dates',
      inputSchema: { type: 'object', properties: appPathProp, required: ['app_path'] },
    },
  ];
}
