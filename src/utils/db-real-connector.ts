// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Real Database Connector
 *
 * Provides actual database connectivity for live schema introspection.
 * Drivers are loaded via dynamic import() so they remain optional — the
 * server still works without them (falls back to entity-derived metadata).
 *
 * Supported drivers (install as needed):
 *   MySQL/MariaDB: npm install mysql2
 *   PostgreSQL:    npm install pg
 *   SQLite:        npm install better-sqlite3
 *
 * All executed queries are validated as read-only before execution.
 * Query results are cached for SYMFONY_MCP_CACHE_TTL_MS (default 5 min).
 *
 * Configuration:
 *   SYMFONY_MCP_DB_CONNECT=false — Disable live DB connections
 *   SYMFONY_MCP_DB_TIMEOUT_MS   — Connection timeout in ms (default: 10 000)
 */

import { parseDatabaseUrl, isQuerySafe, DbConnectionOptions } from './db-connector.js';
import { cacheManager } from './cache-manager.js';

const DB_CONNECT_ENABLED = process.env['SYMFONY_MCP_DB_CONNECT'] !== 'false';
const DB_TIMEOUT_MS = parseInt(process.env['SYMFONY_MCP_DB_TIMEOUT_MS'] ?? '10000', 10) || 10_000;
const CACHE_NS = 'db-query';
const QUERY_CACHE_TTL_MS = 60_000; // 1 minute — shorter than entity cache

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionTimeMs: number;
  fromCache: boolean;
}

export interface ConnectionTestResult {
  connected: boolean;
  type: string;
  host?: string;
  database?: string;
  responseTimeMs?: number;
  error?: string;
  driversAvailable: string[];
}

/**
 * Execute a read-only SQL query against the app's database.
 * Returns cached results if the same query was recently executed.
 */
export async function executeQuery(
  appPath: string,
  query: string,
  params: unknown[] = []
): Promise<QueryResult> {
  if (!DB_CONNECT_ENABLED) {
    throw new Error(
      'Live database connections are disabled. Set SYMFONY_MCP_DB_CONNECT=true to enable.'
    );
  }

  if (!isQuerySafe(query)) {
    throw new Error(
      'Query rejected: only SELECT, DESCRIBE, EXPLAIN, SHOW, and PRAGMA statements are allowed.'
    );
  }

  const cacheKey = `${appPath}:${query}:${JSON.stringify(params)}`;
  const cached = cacheManager.get<QueryResult>(CACHE_NS, cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const options = parseDatabaseUrl(appPath);
  const start = performance.now();
  let result: Omit<QueryResult, 'executionTimeMs' | 'fromCache'>;

  switch (options.type) {
    case 'mysql':
      result = await runMySql(options, query, params);
      break;
    case 'postgresql':
      result = await runPostgreSQL(options, query, params);
      break;
    case 'sqlite':
      result = await runSQLite(options, query, params);
      break;
    default:
      throw new Error(
        `Database type "${options.type}" is not supported for direct connection. ` +
        'Supported types: mysql, postgresql, sqlite.'
      );
  }

  const executionTimeMs = Math.round(performance.now() - start);
  const fullResult: QueryResult = { ...result, executionTimeMs, fromCache: false };
  cacheManager.set(CACHE_NS, cacheKey, fullResult, undefined, QUERY_CACHE_TTL_MS);
  return fullResult;
}

/**
 * Test whether a live database connection can be established.
 */
export async function testDatabaseConnection(appPath: string): Promise<ConnectionTestResult> {
  const available = await detectAvailableDrivers();
  const options = parseDatabaseUrl(appPath);

  if (!DB_CONNECT_ENABLED) {
    return {
      connected: false,
      type: options.type,
      host: options.host,
      database: options.database,
      error: 'Live DB connections disabled (SYMFONY_MCP_DB_CONNECT=false)',
      driversAvailable: available,
    };
  }

  const pingQuery = options.type === 'sqlite' ? 'SELECT 1 AS ok' : 'SELECT 1';

  try {
    const start = performance.now();
    await executeQuery(appPath, pingQuery);
    return {
      connected: true,
      type: options.type,
      host: options.host,
      database: options.database,
      responseTimeMs: Math.round(performance.now() - start),
      driversAvailable: available,
    };
  } catch (err) {
    return {
      connected: false,
      type: options.type,
      host: options.host,
      database: options.database,
      error: err instanceof Error ? err.message : String(err),
      driversAvailable: available,
    };
  }
}

/**
 * Retrieve live table list from the database (bypasses entity inference).
 */
export async function getLiveTables(appPath: string): Promise<string[]> {
  const options = parseDatabaseUrl(appPath);

  let query: string;
  switch (options.type) {
    case 'mysql':
      query = 'SHOW TABLES';
      break;
    case 'postgresql':
      query = `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      break;
    case 'sqlite':
      query = `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
      break;
    default:
      throw new Error(`Cannot list tables for database type "${options.type}"`);
  }

  const result = await executeQuery(appPath, query);
  return result.rows.map((row) => String(row[0]));
}

/**
 * Retrieve live column info for a table directly from the database.
 */
export async function getLiveTableColumns(
  appPath: string,
  tableName: string
): Promise<Array<{ name: string; type: string; nullable: boolean; key: string; default: string }>> {
  const options = parseDatabaseUrl(appPath);

  let query: string;
  switch (options.type) {
    case 'mysql':
      query = `DESCRIBE \`${tableName}\``;
      break;
    case 'postgresql':
      query = `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `;
      break;
    case 'sqlite':
      query = `PRAGMA table_info(${tableName})`;
      break;
    default:
      throw new Error(`Cannot describe table for database type "${options.type}"`);
  }

  const params = options.type === 'postgresql' ? [tableName] : [];
  const result = await executeQuery(appPath, query, params);

  return result.rows.map((row) => {
    if (options.type === 'mysql') {
      return {
        name: String(row[0]),
        type: String(row[1]),
        nullable: row[2] === 'YES',
        key: String(row[3] ?? ''),
        default: String(row[4] ?? ''),
      };
    }
    if (options.type === 'postgresql') {
      return {
        name: String(row[0]),
        type: String(row[1]),
        nullable: row[2] === 'YES',
        key: '',
        default: String(row[3] ?? ''),
      };
    }
    // SQLite: cid, name, type, notnull, dflt_value, pk
    return {
      name: String(row[1]),
      type: String(row[2]),
      nullable: row[3] === 0,
      key: row[5] === 1 ? 'PRI' : '',
      default: String(row[4] ?? ''),
    };
  });
}

// ─── Driver implementations ────────────────────────────────────────────────

async function runMySql(
  options: DbConnectionOptions,
  query: string,
  params: unknown[]
): Promise<Omit<QueryResult, 'executionTimeMs' | 'fromCache'>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mysql2: any;
  try {
    // @ts-expect-error — optional peer dependency
    mysql2 = await import('mysql2/promise');
  } catch {
    throw new Error('mysql2 driver not found. Install it: npm install mysql2');
  }

  const conn = await mysql2.createConnection({
    host: options.host ?? 'localhost',
    port: options.port ?? 3306,
    user: options.username,
    password: options.password,
    database: options.database,
    connectTimeout: DB_TIMEOUT_MS,
  });

  try {
    const [rows, fields] = await conn.execute(query, params);
    const columns = Array.isArray(fields)
      ? (fields as Array<{ name: string }>).map((f) => f.name)
      : [];
    const rowData = (rows as Array<Record<string, unknown>>).map((row) =>
      columns.map((col) => row[col])
    );
    return { columns, rows: rowData, rowCount: rowData.length };
  } finally {
    await conn.end();
  }
}

async function runPostgreSQL(
  options: DbConnectionOptions,
  query: string,
  params: unknown[]
): Promise<Omit<QueryResult, 'executionTimeMs' | 'fromCache'>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  try {
    // @ts-expect-error — optional peer dependency
    pg = await import('pg');
  } catch {
    throw new Error('pg driver not found. Install it: npm install pg');
  }

  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({
    host: options.host ?? 'localhost',
    port: options.port ?? 5432,
    user: options.username,
    password: options.password,
    database: options.database,
    connectionTimeoutMillis: DB_TIMEOUT_MS,
  });

  await client.connect();
  try {
    const res = await client.query(query, params.length > 0 ? params : undefined);
    const columns = res.fields.map((f: { name: string }) => f.name);
    const rows = (res.rows as Array<Record<string, unknown>>).map((row) =>
      columns.map((col: string) => row[col])
    );
    return { columns, rows, rowCount: res.rowCount ?? rows.length };
  } finally {
    await client.end();
  }
}

async function runSQLite(
  options: DbConnectionOptions,
  query: string,
  params: unknown[]
): Promise<Omit<QueryResult, 'executionTimeMs' | 'fromCache'>> {
  if (!options.path) {
    throw new Error('SQLite path is not configured in DATABASE_URL.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BetterSqlite3: any;
  try {
    // @ts-expect-error — optional peer dependency
    const mod = await import('better-sqlite3');
    BetterSqlite3 = mod.default ?? mod;
  } catch {
    throw new Error('better-sqlite3 driver not found. Install it: npm install better-sqlite3');
  }

  const db = new BetterSqlite3(options.path, { readonly: true });
  try {
    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { columns: [], rows: [], rowCount: 0 };
    const columns = Object.keys(rows[0]);
    const rowData = rows.map((row) => columns.map((col) => row[col]));
    return { columns, rows: rowData, rowCount: rowData.length };
  } finally {
    db.close();
  }
}

// ─── Driver detection ──────────────────────────────────────────────────────

async function detectAvailableDrivers(): Promise<string[]> {
  const available: string[] = [];
  const checks: Array<{ name: string; pkg: string }> = [
    { name: 'mysql2', pkg: 'mysql2/promise' },
    { name: 'pg', pkg: 'pg' },
    { name: 'better-sqlite3', pkg: 'better-sqlite3' },
  ];
  for (const { name, pkg } of checks) {
    try {
      await import(pkg);
      available.push(name);
    } catch {
      // Not installed
    }
  }
  return available;
}

export { detectAvailableDrivers };
