/**
 * Database connector utilities
 * Reads Symfony app configuration and infers schema from Doctrine entities.
 * Does NOT establish live database connections - all data is read from source files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadEnvironmentVariables, parseYamlFile, parseEntities, classToTableName } from './symfony-parser.js';
import { sanitizeDatabaseUrl } from './security.js';
import { cacheManager } from './cache-manager.js';

export interface DbConnectionOptions {
  type: 'mysql' | 'postgresql' | 'sqlite' | 'mssql' | 'unknown';
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  path?: string;
  url?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  entityClass?: string;
}

export function parseDatabaseUrl(appPath: string): DbConnectionOptions {
  const env = loadEnvironmentVariables(appPath);
  const databaseUrl = env['DATABASE_URL'];

  if (!databaseUrl) {
    return { type: 'sqlite' };
  }

  try {
    const type = getDatabaseType(databaseUrl);

    // For sqlite:///%%kernel.project_dir%%/var/data.db style URLs
    if (type === 'sqlite') {
      const sqlitePath = databaseUrl.replace(/^sqlite:\/\/\//, '').replace(/%kernel\.project_dir%/g, appPath);
      return { type: 'sqlite', path: sqlitePath, url: databaseUrl };
    }

    // Remove the scheme and re-parse
    const withoutScheme = databaseUrl.replace(/^[^:]+:\/\//, '');
    const parsed = new URL('x://' + withoutScheme);

    const options: DbConnectionOptions = { type, url: databaseUrl };
    if (parsed.hostname) options.host = parsed.hostname;
    if (parsed.port) options.port = parseInt(parsed.port, 10);
    if (parsed.username) options.username = decodeURIComponent(parsed.username);
    if (parsed.password) options.password = parsed.password; // kept for display (will be redacted)

    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (dbName) options.database = dbName;

    return options;
  } catch {
    return { type: 'unknown', url: databaseUrl };
  }
}

function getDatabaseType(databaseUrl: string): DbConnectionOptions['type'] {
  if (databaseUrl.startsWith('mysql://') || databaseUrl.startsWith('mysql2://')) return 'mysql';
  if (databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')) return 'postgresql';
  if (databaseUrl.startsWith('sqlite://')) return 'sqlite';
  if (databaseUrl.startsWith('mssql://') || databaseUrl.startsWith('sqlsrv://')) return 'mssql';
  return 'unknown';
}

export function readDoctrineConfig(appPath: string): DbConnectionOptions {
  const configPath = path.join(appPath, 'config', 'packages', 'doctrine.yaml');
  const config = parseYamlFile(configPath) as Record<string, unknown> | null;

  if (!config || !config['doctrine']) {
    return parseDatabaseUrl(appPath);
  }

  const doctrine = config['doctrine'] as Record<string, unknown>;
  const dbal = doctrine['dbal'] as Record<string, unknown> | undefined;

  if (!dbal) return parseDatabaseUrl(appPath);

  const driver = (dbal['driver'] as string) || 'pdo_mysql';
  const typeMap: Record<string, DbConnectionOptions['type']> = {
    'pdo_mysql': 'mysql',
    'pdo_pgsql': 'postgresql',
    'pdo_sqlite': 'sqlite',
    'pdo_sqlsrv': 'mssql',
  };

  const options: DbConnectionOptions = { type: typeMap[driver] || 'mysql' };
  if (dbal['host']) options.host = dbal['host'] as string;
  if (dbal['port']) options.port = Number(dbal['port']);
  if (dbal['user']) options.username = dbal['user'] as string;
  if (dbal['password']) options.password = dbal['password'] as string;
  if (dbal['dbname']) options.database = dbal['dbname'] as string;
  if (dbal['path']) options.path = dbal['path'] as string;

  return options;
}

/**
 * Builds table info from Doctrine entity metadata.
 * This replaces the mock implementation with real entity-derived data.
 */
export async function getTableStructure(appPath: string, tableName: string): Promise<TableInfo | null> {
  const cacheKey = `${appPath}:${tableName}`;
  const cached = cacheManager.get<TableInfo | null>('table-structure', cacheKey);
  if (cached !== null) return cached;

  const entities = parseEntities(appPath);
  const entity = entities.find((e) => e.tableName === tableName || classToTableName(e.name) === tableName);

  if (!entity) return null;

  const columns: ColumnInfo[] = [];
  const indexes: IndexInfo[] = [];
  const foreignKeys: ForeignKeyInfo[] = [];

  // Map entity properties to columns
  for (const prop of entity.properties) {
    const colName = prop.columnName || toSnakeCase(prop.name);
    columns.push({
      name: colName,
      type: mapDoctrineTypeToSql(prop.type),
      nullable: prop.nullable,
      maxLength: prop.type === 'string' ? 255 : undefined,
    });

    if (prop.isId) {
      indexes.push({
        name: 'PRIMARY',
        columns: [colName],
        unique: true,
        primary: true,
      });
    }
  }

  // Map relationships to foreign keys (ManyToOne owning side)
  for (const rel of entity.relationships) {
    if (rel.type === 'ManyToOne' || (rel.type === 'OneToOne' && rel.inversedBy)) {
      const fkColumn = toSnakeCase(rel.name) + '_id';
      const referencedTable = classToTableName(rel.targetEntity);

      columns.push({
        name: fkColumn,
        type: 'INT',
        nullable: true,
      });

      foreignKeys.push({
        name: `fk_${tableName}_${fkColumn}`,
        column: fkColumn,
        referencedTable,
        referencedColumn: 'id',
      });

      indexes.push({
        name: `idx_${tableName}_${fkColumn}`,
        columns: [fkColumn],
        unique: rel.type === 'OneToOne',
        primary: false,
      });
    }
  }

  const tableInfo: TableInfo = {
    name: tableName,
    columns,
    indexes,
    foreignKeys,
    entityClass: entity.name,
  };
  cacheManager.set('table-structure', cacheKey, tableInfo);
  return tableInfo;
}

/**
 * Lists all database tables inferred from Doctrine entities.
 */
export async function listDatabaseTables(appPath: string): Promise<string[]> {
  const cached = cacheManager.get<string[]>('db-tables', appPath);
  if (cached) return cached;

  const entities = parseEntities(appPath);

  let tables: string[] = [];
  if (entities.length > 0) {
    tables = entities.map((e) => e.tableName || classToTableName(e.name)).sort();
  } else {
    // Fallback: try to read migration files to discover table names
    const migrationTables = discoverTablesFromMigrations(appPath);
    if (migrationTables.length > 0) tables = migrationTables;
  }

  cacheManager.set('db-tables', appPath, tables);
  return tables;
}

/**
 * Scans migration files for CREATE TABLE statements to discover table names.
 */
function discoverTablesFromMigrations(appPath: string): string[] {
  const tables = new Set<string>();
  const migDirs = [
    path.join(appPath, 'migrations'),
    path.join(appPath, 'src', 'Migrations'),
    path.join(appPath, 'DoctrineMigrations'),
  ];

  for (const dir of migDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.php'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const matches = content.matchAll(/CREATE TABLE\s+[`"']?([\w]+)[`"']?/gi);
        for (const m of matches) {
          tables.add(m[1].toLowerCase());
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  return Array.from(tables).sort();
}

export function isQuerySafe(query: string): boolean {
  const upper = query.trim().toUpperCase();
  const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE'];

  for (const pattern of dangerous) {
    if (upper.startsWith(pattern)) return false;
  }

  const safe = ['SELECT', 'DESCRIBE', 'DESC', 'EXPLAIN', 'SHOW', 'PRAGMA'];
  return safe.some((p) => upper.startsWith(p));
}

export function getDisplayDatabaseUrl(options: DbConnectionOptions): string {
  if (!options.url) {
    switch (options.type) {
      case 'mysql': return `mysql://${options.host || 'localhost'}:${options.port || 3306}/${options.database || 'app'}`;
      case 'postgresql': return `postgresql://${options.host || 'localhost'}:${options.port || 5432}/${options.database || 'app'}`;
      case 'sqlite': return `sqlite://${options.path || 'var/app.db'}`;
      default: return 'Unknown database';
    }
  }
  return sanitizeDatabaseUrl(options.url);
}

export async function getDatabaseStats(appPath: string): Promise<{
  type: string;
  host?: string;
  database?: string;
  tables: number;
  fromEntities: boolean;
}> {
  const options = parseDatabaseUrl(appPath);
  const tables = await listDatabaseTables(appPath);
  const entities = parseEntities(appPath);

  return {
    type: options.type,
    host: options.host,
    database: options.database,
    tables: tables.length,
    fromEntities: entities.length > 0,
  };
}

// Helpers

function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

function mapDoctrineTypeToSql(doctrineType: string): string {
  const typeMap: Record<string, string> = {
    'integer': 'INT',
    'int': 'INT',
    'smallint': 'SMALLINT',
    'bigint': 'BIGINT',
    'string': 'VARCHAR(255)',
    'text': 'TEXT',
    'boolean': 'TINYINT(1)',
    'bool': 'TINYINT(1)',
    'decimal': 'DECIMAL(10,2)',
    'float': 'DOUBLE',
    'datetime': 'DATETIME',
    'datetime_immutable': 'DATETIME',
    'datetimetz': 'DATETIME',
    'date': 'DATE',
    'time': 'TIME',
    'json': 'JSON',
    'array': 'LONGTEXT',
    'object': 'LONGTEXT',
    'uuid': 'VARCHAR(36)',
    'ulid': 'VARCHAR(26)',
    'guid': 'VARCHAR(36)',
    'binary': 'BINARY',
    'blob': 'BLOB',
  };
  return typeMap[doctrineType.toLowerCase()] || doctrineType.toUpperCase();
}
